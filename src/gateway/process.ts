import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { OpenClawEnv } from '../types';
import { GATEWAY_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars } from './env';

const EXPECTED_MODEL_REF = 'cf-ai-gw-workers-ai/@cf/moonshotai/kimi-k2.6';
const EXPECTED_PROVIDER_ID = 'cf-ai-gw-workers-ai';
const EXPECTED_MODEL_PATCH_VERSION = 2;

/**
 * Force kill the gateway process and clean up lock files.
 *
 * start-openclaw.sh execs into "openclaw" which forks "openclaw-gateway".
 * Process.kill() only kills the tracked PID, but the forked child keeps
 * port 18789. We use multiple strategies to ensure everything is dead.
 */
export async function killGateway(sandbox: Sandbox): Promise<void> {
  // Strategy 1: pgrep by exact name (most precise)
  // Strategy 2: pkill by pattern (broader match)
  // Strategy 3: ss to find PID by port (most reliable but needs ss)
  try {
    await sandbox.exec(
      [
        'kill -9 $(pgrep -x "openclaw-gateway" 2>/dev/null) $(pgrep -x "openclaw" 2>/dev/null) 2>/dev/null',
        'pkill -9 -f "openclaw" 2>/dev/null',
        `kill -9 $(ss -tlnp sport = :${GATEWAY_PORT} 2>/dev/null | grep -oP "pid=\\K[0-9]+") 2>/dev/null`,
        'true',
      ].join('; '),
    );
  } catch {
    // Process may not exist or tools not available
  }

  // Also kill via the Process API
  const process = await findExistingGatewayProcess(sandbox);
  if (process) {
    try {
      await process.kill();
    } catch {
      // may already be dead
    }
  }

  // Clean up lock files that prevent restart
  try {
    await sandbox.exec(
      'rm -f /tmp/openclaw-gateway.lock /root/.openclaw/gateway.lock /home/openclaw/.openclaw/gateway.lock 2>/dev/null; true',
    );
  } catch {
    // ignore
  }

  // Wait for process to fully die
  await new Promise((r) => setTimeout(r, 2000));
}

/**
 * Check if the gateway port is already listening via a TCP probe.
 * Used as a safety net when listProcesses() fails to detect the gateway.
 */
export async function isGatewayPortOpen(sandbox: Sandbox): Promise<boolean> {
  const result = await sandbox.exec(`nc -z localhost ${GATEWAY_PORT}`);
  return result.exitCode === 0;
}

/**
 * Check whether the on-disk OpenClaw config has been patched to the expected
 * Workers AI model. This catches long-lived containers whose gateway process
 * survived a Worker deploy and therefore never reran start-openclaw.sh.
 */
export async function isGatewayModelConfigCurrent(sandbox: Sandbox): Promise<boolean> {
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const configDir = '/root/.openclaw';",
    "const config = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));",
    `const expectedModel = ${JSON.stringify(EXPECTED_MODEL_REF)};`,
    `const expectedProvider = ${JSON.stringify(EXPECTED_PROVIDER_ID)};`,
    `const expectedPatchVersion = ${EXPECTED_MODEL_PATCH_VERSION};`,
    'const primary = config.agents?.defaults?.model?.primary;',
    'const allowed = config.agents?.defaults?.models || {};',
    'const providers = config.models?.providers || {};',
    'const provider = providers[expectedProvider];',
    'const model = Array.isArray(provider?.models) ? provider.models.find((entry) => entry?.id === "@cf/moonshotai/kimi-k2.6") : null;',
    'function findFilesNamed(root, name) { const out = []; if (!fs.existsSync(root)) return out; const visit = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) visit(full); else if (entry.isFile() && entry.name === name) out.push(full); } }; visit(root); return out; }',
    'function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }',
    'function hasStaleClaude(value) { return /cloudflare-ai-gateway\\/claude|cloudflare-ai-gateway-workers-ai|claude-sonnet|anthropic\\/claude/i.test(JSON.stringify(value)); }',
    'const modelsJsonPaths = findFilesNamed(path.join(configDir, "agents"), "models.json");',
    'const mainModelsJsonPath = path.join(configDir, "agents", "main", "agent", "models.json");',
    'if (!modelsJsonPaths.includes(mainModelsJsonPath) && fs.existsSync(mainModelsJsonPath)) modelsJsonPaths.push(mainModelsJsonPath);',
    'const modelsJsonCurrent = modelsJsonPaths.length > 0 && modelsJsonPaths.every((file) => { const parsed = readJson(file); const p = parsed?.providers?.[expectedProvider]; const m = Array.isArray(p?.models) ? p.models.find((entry) => entry?.id === "@cf/moonshotai/kimi-k2.6") : null; return p?.baseUrl?.includes("/workers-ai/v1") && p?.api === "openai-completions" && Boolean(m); });',
    'const sessionStores = findFilesNamed(path.join(configDir, "agents"), "sessions.json").map(readJson).filter(Boolean);',
    'const staleClaude = hasStaleClaude(config) || modelsJsonPaths.map(readJson).filter(Boolean).some(hasStaleClaude) || sessionStores.some(hasStaleClaude);',
    'const patchCurrent = config.moltworker?.aiGatewayModelPatchVersion === expectedPatchVersion && config.moltworker?.selectedModelRef === expectedModel;',
    'const validModel = model?.api === "openai-completions" && typeof model?.reasoning === "boolean" && Boolean(model?.cost) && Number.isFinite(model?.contextWindow) && Number.isFinite(model?.maxTokens);',
    'const ok = patchCurrent && primary === expectedModel && Boolean(allowed[expectedModel]) && Boolean(provider) && validModel && modelsJsonCurrent && !staleClaude;',
    'process.exit(ok ? 0 : 1);',
  ].join(' ');
  const result = await sandbox.exec(`node -e ${JSON.stringify(script)}`);
  return result.exitCode === 0;
}

async function replaceStaleGatewayContainer(
  sandbox: Sandbox,
  process: Process | null,
): Promise<void> {
  console.log('Replacing stale gateway container so the latest image startup script runs...');
  if (process) {
    try {
      await process.kill();
    } catch (killError) {
      console.log('Failed to kill stale gateway process before container destroy:', killError);
    }
  }
  await killGateway(sandbox);
  try {
    await sandbox.destroy();
  } catch (destroyError) {
    console.log('Failed to destroy stale gateway container after killing process:', destroyError);
  }
}

/**
 * Find an existing OpenClaw gateway process
 *
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingGatewayProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      // Match gateway process (openclaw gateway or legacy clawdbot gateway)
      // Don't match CLI commands like "openclaw devices list"
      const isGatewayProcess =
        proc.command.includes('start-openclaw.sh') ||
        proc.command.includes('/usr/local/bin/start-openclaw.sh') ||
        proc.command.includes('openclaw gateway') ||
        // Legacy: match old startup script during transition
        proc.command.includes('start-moltbot.sh') ||
        proc.command.includes('clawdbot gateway');
      const isCliCommand =
        proc.command.includes('openclaw devices') ||
        proc.command.includes('openclaw --version') ||
        proc.command.includes('openclaw onboard') ||
        proc.command.includes('clawdbot devices') ||
        proc.command.includes('clawdbot --version');

      if (isGatewayProcess && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Ensure the OpenClaw gateway is running
 *
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Wait for it to be ready, or start a new one
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @param options.waitForReady - If false, start the process but don't wait for port.
 *        Used by /api/status to avoid exceeding the Worker CPU limit. Default: true.
 * @returns The running gateway process, or null if the gateway is up but we
 *          don't have a process handle (detected via port probe only)
 */
export async function ensureGateway(
  sandbox: Sandbox,
  env: OpenClawEnv,
  options?: { waitForReady?: boolean },
): Promise<Process | null> {
  const waitForReady = options?.waitForReady !== false;
  // Check if gateway is already running or starting
  const existingProcess = await findExistingGatewayProcess(sandbox);
  if (existingProcess) {
    if (existingProcess.status === 'running') {
      try {
        if (await isGatewayPortOpen(sandbox)) {
          const configCurrent = await isGatewayModelConfigCurrent(sandbox);
          if (!configCurrent) {
            console.log('Existing gateway model config is stale, replacing container...');
            await replaceStaleGatewayContainer(sandbox, existingProcess);
            return ensureGateway(sandbox, env, options);
          }
        } else {
          console.log(
            'Existing gateway process is running but port is not ready; skipping config drift check for now',
          );
        }
      } catch (e) {
        console.log('Could not verify gateway model config, continuing with existing process:', e);
      }
    }

    console.log(
      'Found existing gateway process:',
      existingProcess.id,
      'status:',
      existingProcess.status,
    );

    if (!waitForReady) {
      return existingProcess;
    }

    // Always use full startup timeout - a process can be "running" but not ready yet
    // (e.g., just started by another concurrent request). Using a shorter timeout
    // causes race conditions where we kill processes that are still initializing.
    try {
      console.log('Waiting for gateway on port', GATEWAY_PORT, 'timeout:', STARTUP_TIMEOUT_MS);
      await existingProcess.waitForPort(GATEWAY_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      console.log('Gateway is reachable');
      return existingProcess;
      // eslint-disable-next-line no-unused-vars
    } catch (_e) {
      // Timeout waiting for port - process is likely dead or stuck, kill and restart
      console.log('Existing process not reachable after full timeout, killing and restarting...');
      try {
        await existingProcess.kill();
      } catch (killError) {
        console.log('Failed to kill process:', killError);
      }
    }
  }

  // Safety net: the process wasn't found by listProcesses() (e.g. the command
  // string didn't match any known pattern), but the gateway may still be running.
  // Probe the port directly — if it's open, the gateway is up and we're done.
  try {
    if (await isGatewayPortOpen(sandbox)) {
      try {
        const configCurrent = await isGatewayModelConfigCurrent(sandbox);
        if (!configCurrent) {
          console.log('Undetected gateway has stale model config, replacing container...');
          await replaceStaleGatewayContainer(sandbox, null);
          return ensureGateway(sandbox, env, options);
        }
      } catch (e) {
        console.log('Could not verify undetected gateway model config, keeping open port:', e);
      }

      console.log(
        `Port ${GATEWAY_PORT} already open — gateway running but undetected by listProcesses(), skipping spawn`,
      );
      return null;
    }
  } catch (e) {
    console.log('Port probe failed, proceeding to start gateway:', e);
  }

  // Start a new OpenClaw gateway
  console.log('Starting new OpenClaw gateway...');
  const envVars = buildEnvVars(env);
  const command = '/usr/local/bin/start-openclaw.sh';

  console.log('Starting process with command:', command);
  console.log('Environment vars being passed:', Object.keys(envVars));

  let process: Process;
  try {
    process = await sandbox.startProcess(command, {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    console.log('Process started with id:', process.id, 'status:', process.status);
  } catch (startErr) {
    console.error('Failed to start process:', startErr);
    throw startErr;
  }

  if (waitForReady) {
    // Wait for the gateway to be ready
    try {
      console.log('[Gateway] Waiting for OpenClaw gateway to be ready on port', GATEWAY_PORT);
      await process.waitForPort(GATEWAY_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      console.log('[Gateway] OpenClaw gateway is ready!');

      const logs = await process.getLogs();
      if (logs.stdout) console.log('[Gateway] stdout:', logs.stdout);
      if (logs.stderr) console.log('[Gateway] stderr:', logs.stderr);
    } catch (e) {
      console.error('[Gateway] waitForPort failed:', e);
      try {
        const logs = await process.getLogs();
        console.error('[Gateway] startup failed. Stderr:', logs.stderr);
        console.error('[Gateway] startup failed. Stdout:', logs.stdout);
        throw new Error(`OpenClaw gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`, {
          cause: e,
        });
      } catch (logErr) {
        console.error('[Gateway] Failed to get logs:', logErr);
        throw e;
      }
    }
  } else {
    console.log('[Gateway] Process started (not waiting for ready):', process.id);
  }

  // Verify gateway is actually responding
  console.log('[Gateway] Verifying gateway health...');

  return process;
}
