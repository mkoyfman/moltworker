import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { ensureGateway, findExistingGatewayProcess, killGateway, waitForProcess } from '../gateway';
import {
  createSnapshot,
  getLastBackupInfo,
  getRestoreStatus,
  restoreAfterSandboxReplacement,
  restoreIfNeeded,
  signalRestoreNeeded,
} from '../persistence';

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseJsonFromCliOutput(stdout: string): unknown {
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  return JSON.parse(jsonMatch[0]);
}

function listDevicesCommand(): string {
  // Do not pass --url here. OpenClaw's devices CLI has a same-host local
  // fallback for pairing state, but explicit --url disables that fallback.
  return 'openclaw devices list --json';
}

function approveDeviceCommand(requestId: string): string {
  return `openclaw devices approve ${shellQuote(requestId)} --json`;
}

/**
 * API routes
 * - /api/admin/* - Protected admin API routes (Cloudflare Access required)
 *
 * Note: /api/status is now handled by publicRoutes (no auth required)
 */
const api = new Hono<AppEnv>();

/**
 * Admin API routes - all protected by Cloudflare Access
 */
const adminApi = new Hono<AppEnv>();

async function restoreThenEnsureGateway(
  sandbox: AppEnv['Variables']['sandbox'],
  env: AppEnv['Bindings'],
) {
  const existingProcess = await findExistingGatewayProcess(sandbox);
  const restoreStatus = await getRestoreStatus(sandbox, env.BACKUP_BUCKET);
  if (restoreStatus.hasBackup && !restoreStatus.restored) {
    console.log(
      '[Admin API] Sandbox has not restored latest backup; replacing before gateway start',
    );
    if (existingProcess) await killGateway(sandbox);
    await sandbox.destroy();
    await restoreAfterSandboxReplacement(sandbox, env.BACKUP_BUCKET);
  } else if (!existingProcess) {
    try {
      await restoreIfNeeded(sandbox, env.BACKUP_BUCKET);
    } catch (err) {
      console.error('[Admin API] Restore before gateway start failed:', err);
    }
  }
  return ensureGateway(sandbox, env, {
    onContainerReplaced: () => restoreAfterSandboxReplacement(sandbox, env.BACKUP_BUCKET),
  });
}

async function snapshotBestEffort(
  sandbox: AppEnv['Variables']['sandbox'],
  bucket: R2Bucket,
  reason: string,
) {
  try {
    const handle = await createSnapshot(sandbox, bucket);
    console.log(`[Admin API] Snapshot after ${reason}:`, handle.id);
    return handle;
  } catch (err) {
    console.error(`[Admin API] Snapshot after ${reason} failed:`, err);
    return null;
  }
}

// Middleware: Verify Cloudflare Access JWT for all admin routes
adminApi.use('*', createAccessMiddleware({ type: 'json' }));

// GET /api/admin/devices - List pending and paired devices
adminApi.get('/devices', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Restore before starting the gateway so paired-device state survives redeploys.
    await restoreThenEnsureGateway(sandbox, c.env);

    // Run OpenClaw CLI to list devices. Use local fallback instead of
    // explicit --url so admin pairing keeps working with OpenClaw 2026.5.x.
    const proc = await sandbox.startProcess(listDevicesCommand());
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Try to parse JSON output
    try {
      const data = parseJsonFromCliOutput(stdout);
      if (data) {
        return c.json(data);
      }

      // If no JSON found, return raw output for debugging
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
      });
    } catch {
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
        parseError: 'Failed to parse CLI output',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/:requestId/approve - Approve a pending device
adminApi.post('/devices/:requestId/approve', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('requestId');

  if (!requestId) {
    return c.json({ error: 'requestId is required' }, 400);
  }

  try {
    // Restore before starting the gateway so approvals are applied to persisted state.
    await restoreThenEnsureGateway(sandbox, c.env);

    // Run OpenClaw CLI to approve the device. Use local fallback instead of
    // explicit --url so the CLI can approve against the gateway state store.
    const proc = await sandbox.startProcess(approveDeviceCommand(requestId));
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    let approvalResult: unknown = null;
    try {
      approvalResult = parseJsonFromCliOutput(stdout);
    } catch {
      // Keep raw stdout/stderr below for diagnostics.
    }

    let stillPending = false;
    let after: unknown = null;
    if (proc.exitCode === 0) {
      const listProc = await sandbox.startProcess(listDevicesCommand());
      await waitForProcess(listProc, CLI_TIMEOUT_MS);
      const listLogs = await listProc.getLogs();
      try {
        after = parseJsonFromCliOutput(listLogs.stdout || '');
        const pending = Array.isArray((after as { pending?: unknown[] } | null)?.pending)
          ? ((after as { pending?: unknown[] }).pending ?? [])
          : [];
        stillPending = pending.some(
          (device) =>
            typeof device === 'object' &&
            device !== null &&
            (device as { requestId?: unknown }).requestId === requestId,
        );
      } catch {
        // If verification parsing fails, preserve the approval command result.
      }
    }

    const success = proc.exitCode === 0 && !stillPending;

    return c.json({
      success,
      requestId,
      message: success
        ? 'Device approved'
        : stillPending
          ? 'Approval command completed, but the request is still pending'
          : 'Approval failed',
      stdout,
      stderr,
      result: approvalResult,
      after,
      backup: success
        ? await snapshotBestEffort(sandbox, c.env.BACKUP_BUCKET, 'device approval')
        : null,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/approve-all - Approve all pending devices
adminApi.post('/devices/approve-all', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Restore before starting the gateway so approvals are applied to persisted state.
    await restoreThenEnsureGateway(sandbox, c.env);

    // First, get the list of pending devices.
    const listProc = await sandbox.startProcess(listDevicesCommand());
    await waitForProcess(listProc, CLI_TIMEOUT_MS);

    const listLogs = await listProc.getLogs();
    const stdout = listLogs.stdout || '';

    // Parse pending devices
    let pending: Array<{ requestId: string }> = [];
    try {
      const data = parseJsonFromCliOutput(stdout) as { pending?: Array<{ requestId: string }> };
      pending = data?.pending || [];
    } catch {
      return c.json({ error: 'Failed to parse device list', raw: stdout }, 500);
    }

    if (pending.length === 0) {
      return c.json({ approved: [], message: 'No pending devices to approve' });
    }

    // Approve each pending device
    const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

    for (const device of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential device approval required
        const approveProc = await sandbox.startProcess(approveDeviceCommand(device.requestId));
        // eslint-disable-next-line no-await-in-loop
        await waitForProcess(approveProc, CLI_TIMEOUT_MS);

        // eslint-disable-next-line no-await-in-loop
        const approveLogs = await approveProc.getLogs();
        const success = approveProc.exitCode === 0;

        results.push({
          requestId: device.requestId,
          success,
          error: success
            ? undefined
            : approveLogs.stderr || approveLogs.stdout || 'Approval failed',
        });
      } catch (err) {
        results.push({
          requestId: device.requestId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const approvedCount = results.filter((r) => r.success).length;
    const backup =
      approvedCount > 0
        ? await snapshotBestEffort(sandbox, c.env.BACKUP_BUCKET, 'bulk device approval')
        : null;
    return c.json({
      approved: results.filter((r) => r.success).map((r) => r.requestId),
      failed: results.filter((r) => !r.success),
      message: `Approved ${approvedCount} of ${pending.length} device(s)`,
      backup,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/storage - Get backup/restore status
adminApi.get('/storage', async (c) => {
  const hasCredentials = !!(
    c.env.R2_ACCESS_KEY_ID &&
    c.env.R2_SECRET_ACCESS_KEY &&
    c.env.CLOUDFLARE_ACCOUNT_ID
  );

  const missing: string[] = [];
  if (!c.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!c.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!c.env.CLOUDFLARE_ACCOUNT_ID) missing.push('CLOUDFLARE_ACCOUNT_ID');

  const lastBackup = hasCredentials ? await getLastBackupInfo(c.env.BACKUP_BUCKET) : null;
  const restoreStatus = hasCredentials
    ? await getRestoreStatus(c.get('sandbox'), c.env.BACKUP_BUCKET)
    : null;

  return c.json({
    configured: hasCredentials,
    missing: missing.length > 0 ? missing : undefined,
    lastBackupId: lastBackup?.id ?? null,
    lastBackupAt: lastBackup?.createdAt ?? null,
    restoreStatus,
    message: hasCredentials
      ? 'R2 storage is configured. Your data will persist across container restarts via SDK snapshots.'
      : 'R2 storage is not configured. Paired devices and conversations will be lost when the container restarts.',
  });
});

// POST /api/admin/storage/sync - Create a new snapshot
adminApi.post('/storage/sync', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Log mount state before backup for diagnostics
    let mountState = 'unknown';
    let dirContents = 'unknown';
    try {
      const mnt = await sandbox.exec('mount | grep openclaw || echo "NO_OVERLAY"');
      mountState = mnt.stdout?.trim() ?? 'empty';
      const ls = await sandbox.exec('ls /home/openclaw/clawd/ 2>&1 || echo "(empty)"');
      dirContents = ls.stdout?.trim() ?? 'empty';
    } catch {
      // non-fatal
    }
    const handle = await createSnapshot(sandbox, c.env.BACKUP_BUCKET);
    try {
      await killGateway(sandbox);
    } catch (killError) {
      console.warn('[Admin API] Could not stop gateway after snapshot:', killError);
    }
    try {
      await sandbox.destroy();
    } catch (destroyError) {
      console.warn('[Admin API] Could not destroy sandbox after snapshot:', destroyError);
    }
    return c.json({
      success: true,
      message:
        'Snapshot created successfully; gateway container was replaced and will restore it on the next status check',
      backupId: handle.id,
      lastBackupAt: handle.createdAt,
      debug: { mountState, dirContents },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const status =
      errorMessage.includes('not configured') || errorMessage.includes('Missing') ? 400 : 500;
    return c.json(
      {
        success: false,
        error: errorMessage,
      },
      status,
    );
  }
});

// POST /api/admin/gateway/restart - Kill the current gateway and start a new one
adminApi.post('/gateway/restart', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Kill the gateway process (shared logic with crash retry)
    const existingProcess = await findExistingGatewayProcess(sandbox);
    console.log('[Restart] Killing gateway, existing process:', existingProcess?.id ?? 'none');
    await killGateway(sandbox);
    await sandbox.destroy();

    // Signal that all Worker isolates need to re-restore from R2.
    // This writes a marker to R2 that restoreIfNeeded checks, ensuring
    // the FUSE overlay is mounted even if a different isolate handles
    // the next request (e.g. browser WebSocket reconnect).
    await signalRestoreNeeded(c.env.BACKUP_BUCKET);

    return c.json({
      success: true,
      message: existingProcess
        ? 'Gateway container destroyed, will restart on next request'
        : 'Gateway container destroyed, will start on next request',
      previousProcessId: existingProcess?.id,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/gateway/model-state - Inspect sanitized OpenClaw model state
adminApi.get('/gateway/model-state', async (c) => {
  const sandbox = c.get('sandbox');
  let gatewayStartError: string | null = null;
  try {
    await restoreThenEnsureGateway(sandbox, c.env);
  } catch (err) {
    gatewayStartError = err instanceof Error ? err.message : String(err);
    console.error('[Model State] Gateway restore/start before inspection failed:', err);
  }

  const script = `
const fs = require('fs');
const path = require('path');
const configDir = '/home/openclaw/.openclaw';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findFilesNamed(root, name) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const visit = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name === name) out.push(full);
    }
  };
  visit(root);
  return out;
}

function summarizeProviders(providers) {
  const out = {};
  for (const [id, provider] of Object.entries(providers || {})) {
    out[id] = {
      baseUrl: typeof provider?.baseUrl === 'string' ? provider.baseUrl : null,
      api: typeof provider?.api === 'string' ? provider.api : null,
      hasApiKey: typeof provider?.apiKey === 'string' && provider.apiKey.length > 0,
      models: Array.isArray(provider?.models)
        ? provider.models.map((model) => ({
            id: model?.id ?? null,
            api: model?.api ?? null,
            contextWindow: model?.contextWindow ?? null,
            maxTokens: model?.maxTokens ?? null,
          }))
        : [],
    };
  }
  return out;
}

function summarizeSessions(store) {
  const out = {};
  for (const [key, entry] of Object.entries(store || {})) {
    out[key] = {
      providerOverride: entry?.providerOverride,
      modelOverride: entry?.modelOverride,
      modelOverrideSource: entry?.modelOverrideSource,
      modelProvider: entry?.modelProvider,
      model: entry?.model,
      authProfileOverride: entry?.authProfileOverride,
      fallbackNoticeSelectedModel: entry?.fallbackNoticeSelectedModel,
      fallbackNoticeActiveModel: entry?.fallbackNoticeActiveModel,
      claudeCliSessionId: entry?.claudeCliSessionId ? '[present]' : undefined,
      cliSessionIds: entry?.cliSessionIds ? Object.keys(entry.cliSessionIds) : undefined,
      cliSessionBindings: entry?.cliSessionBindings ? Object.keys(entry.cliSessionBindings) : undefined,
    };
  }
  return out;
}

function hasClaude(value) {
  return /cloudflare-ai-gateway\\/claude|claude-sonnet|anthropic\\/claude/i.test(JSON.stringify(value));
}

function hasStaleWorkersAiGatewayProvider(value) {
  return /cloudflare-ai-gateway-workers-ai/i.test(JSON.stringify(value));
}

function summarizeAuthProfiles(store) {
  const out = {};
  for (const [profileId, profile] of Object.entries(store?.profiles || {})) {
    out[profileId] = {
      type: profile?.type ?? null,
      provider: profile?.provider ?? null,
      hasKey: typeof profile?.key === 'string' && profile.key.length > 0,
      hasKeyRef: Boolean(profile?.keyRef),
      metadataKeys: profile?.metadata && typeof profile.metadata === 'object' ? Object.keys(profile.metadata) : [],
    };
  }
  return out;
}

const config = readJson(path.join(configDir, 'openclaw.json'));
const moltworkerState = readJson(path.join(configDir, 'moltworker-state.json'));
const modelsJson = findFilesNamed(configDir, 'models.json').map((file) => {
  const parsed = readJson(file);
  return {
    file,
    providers: summarizeProviders(parsed?.providers),
    hasClaude: hasClaude(parsed),
    hasStaleWorkersAiGatewayProvider: hasStaleWorkersAiGatewayProvider(parsed),
  };
});
const sessions = findFilesNamed(configDir, 'sessions.json').map((file) => {
  const parsed = readJson(file);
  return {
    file,
    sessions: summarizeSessions(parsed),
    hasClaude: hasClaude(parsed),
    hasStaleWorkersAiGatewayProvider: hasStaleWorkersAiGatewayProvider(parsed),
  };
});
const authProfiles = findFilesNamed(configDir, 'auth-profiles.json').map((file) => {
  const parsed = readJson(file);
  return {
    file,
    profiles: summarizeAuthProfiles(parsed),
    hasClaude: hasClaude(parsed),
    hasStaleWorkersAiGatewayProvider: hasStaleWorkersAiGatewayProvider(parsed),
  };
});

console.log(JSON.stringify({
  openclawJson: {
    exists: Boolean(config),
    hasMoltworkerRootKey: Object.prototype.hasOwnProperty.call(config || {}, 'moltworker'),
    modelsMode: config?.models?.mode ?? null,
    defaultModel: config?.agents?.defaults?.model ?? null,
    allowedModels: Object.keys(config?.agents?.defaults?.models || {}),
    providers: summarizeProviders(config?.models?.providers),
    authProfiles: summarizeAuthProfiles({ profiles: config?.auth?.profiles }),
    authOrderProviders: Object.keys(config?.auth?.order || {}),
    hasClaude: hasClaude(config),
    hasStaleWorkersAiGatewayProvider: hasStaleWorkersAiGatewayProvider(config),
  },
  moltworkerState: {
    exists: Boolean(moltworkerState),
    patchVersion: moltworkerState?.aiGatewayModelPatchVersion ?? null,
    selectedModelRef: moltworkerState?.selectedModelRef ?? null,
  },
  modelsJson,
  sessions,
  authProfiles,
}, null, 2));
`;

  try {
    const scriptPath = `/tmp/moltworker-model-state-${Date.now()}.js`;
    await sandbox.writeFile(scriptPath, script);
    const proc = await sandbox.startProcess(`node ${scriptPath}`);
    await waitForProcess(proc, CLI_TIMEOUT_MS);
    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    let state: unknown = null;
    try {
      state = JSON.parse(stdout);
    } catch {
      state = { raw: stdout };
    }
    const runOpenClawJson = async (command: string) => {
      try {
        const cliProc = await sandbox.startProcess(command);
        await waitForProcess(cliProc, CLI_TIMEOUT_MS);
        const cliLogs = await cliProc.getLogs();
        const cliStdout = cliLogs.stdout || '';
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(cliStdout);
        } catch {
          parsed = { raw: cliStdout };
        }
        return {
          exitCode: cliProc.exitCode,
          stdout: parsed,
          stderr: cliLogs.stderr || '',
        };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };
    const openclawCli = {
      version: await runOpenClawJson('openclaw --version'),
      modelsList: await runOpenClawJson('openclaw models list --json'),
      modelsListAll: await runOpenClawJson('openclaw models list --all --json'),
      modelsStatus: await runOpenClawJson('openclaw models status --json'),
      gatewayModelsListConfigured: await runOpenClawJson(
        `openclaw gateway call models.list --url ws://localhost:18789${
          c.env.MOLTBOT_GATEWAY_TOKEN ? ` --token ${shellQuote(c.env.MOLTBOT_GATEWAY_TOKEN)}` : ''
        } --json --params ${shellQuote(JSON.stringify({ view: 'configured' }))}`,
      ),
    };
    return c.json({
      env: {
        hasCloudflareAiGatewayApiKey: !!c.env.CLOUDFLARE_AI_GATEWAY_API_KEY,
        hasCfAiGatewayAccountId: !!c.env.CF_AI_GATEWAY_ACCOUNT_ID,
        hasCfAiGatewayGatewayId: !!c.env.CF_AI_GATEWAY_GATEWAY_ID,
        cfAiGatewayModel: c.env.CF_AI_GATEWAY_MODEL || null,
        hasAnthropicApiKey: !!c.env.ANTHROPIC_API_KEY,
        hasOpenaiApiKey: !!c.env.OPENAI_API_KEY,
        hasLegacyAiGateway: !!(c.env.AI_GATEWAY_API_KEY && c.env.AI_GATEWAY_BASE_URL),
      },
      state,
      stderr: logs.stderr || '',
      exitCode: proc.exitCode,
      openclawCli,
      gatewayStartError,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
