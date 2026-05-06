import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { ensureGateway, findExistingGatewayProcess, killGateway, waitForProcess } from '../gateway';
import {
  createSnapshot,
  getLastBackupInfo,
  restoreIfNeeded,
  signalRestoreNeeded,
} from '../persistence';

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;

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
  if (!existingProcess) {
    try {
      await restoreIfNeeded(sandbox, env.BACKUP_BUCKET);
    } catch (err) {
      console.error('[Admin API] Restore before gateway start failed:', err);
    }
  }
  return ensureGateway(sandbox, env);
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

    // Run OpenClaw CLI to list devices
    // Must specify --url and --token (OpenClaw v2026.2.3 requires explicit credentials with --url)
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const proc = await sandbox.startProcess(
      `openclaw devices list --json --url ws://localhost:18789${tokenArg}`,
    );
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Try to parse JSON output
    try {
      // Find JSON in output (may have other log lines)
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
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

    // Run OpenClaw CLI to approve the device
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const proc = await sandbox.startProcess(
      `openclaw devices approve ${requestId} --url ws://localhost:18789${tokenArg}`,
    );
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Check for success indicators (case-insensitive, CLI outputs "Approved ...")
    const success = stdout.toLowerCase().includes('approved') || proc.exitCode === 0;

    return c.json({
      success,
      requestId,
      message: success ? 'Device approved' : 'Approval may have failed',
      stdout,
      stderr,
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

    // First, get the list of pending devices
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const listProc = await sandbox.startProcess(
      `openclaw devices list --json --url ws://localhost:18789${tokenArg}`,
    );
    await waitForProcess(listProc, CLI_TIMEOUT_MS);

    const listLogs = await listProc.getLogs();
    const stdout = listLogs.stdout || '';

    // Parse pending devices
    let pending: Array<{ requestId: string }> = [];
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        pending = data.pending || [];
      }
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
        const approveProc = await sandbox.startProcess(
          `openclaw devices approve ${device.requestId} --url ws://localhost:18789${tokenArg}`,
        );
        // eslint-disable-next-line no-await-in-loop
        await waitForProcess(approveProc, CLI_TIMEOUT_MS);

        // eslint-disable-next-line no-await-in-loop
        const approveLogs = await approveProc.getLogs();
        const success =
          approveLogs.stdout?.toLowerCase().includes('approved') || approveProc.exitCode === 0;

        results.push({ requestId: device.requestId, success });
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

  return c.json({
    configured: hasCredentials,
    missing: missing.length > 0 ? missing : undefined,
    lastBackupId: lastBackup?.id ?? null,
    lastBackupAt: lastBackup?.createdAt ?? null,
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
    return c.json({
      success: true,
      message: 'Snapshot created successfully',
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
  const script = `
const fs = require('fs');
const path = require('path');
const configDir = '/root/.openclaw';

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
  return /cloudflare-ai-gateway\\/claude|cloudflare-ai-gateway-workers-ai|claude-sonnet|anthropic\\/claude/i.test(JSON.stringify(value));
}

const config = readJson(path.join(configDir, 'openclaw.json'));
const modelsJson = findFilesNamed(path.join(configDir, 'agents'), 'models.json').map((file) => {
  const parsed = readJson(file);
  return {
    file,
    providers: summarizeProviders(parsed?.providers),
    hasClaude: hasClaude(parsed),
  };
});
const sessions = findFilesNamed(path.join(configDir, 'agents'), 'sessions.json').map((file) => {
  const parsed = readJson(file);
  return {
    file,
    sessions: summarizeSessions(parsed),
    hasClaude: hasClaude(parsed),
  };
});

console.log(JSON.stringify({
  openclawJson: {
    exists: Boolean(config),
    patchVersion: config?.moltworker?.aiGatewayModelPatchVersion ?? null,
    selectedModelRef: config?.moltworker?.selectedModelRef ?? null,
    modelsMode: config?.models?.mode ?? null,
    defaultModel: config?.agents?.defaults?.model ?? null,
    allowedModels: Object.keys(config?.agents?.defaults?.models || {}),
    providers: summarizeProviders(config?.models?.providers),
    hasClaude: hasClaude(config),
  },
  modelsJson,
  sessions,
}, null, 2));
`;

  try {
    const proc = await sandbox.startProcess(`node -e ${JSON.stringify(script)}`);
    await waitForProcess(proc, CLI_TIMEOUT_MS);
    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    let state: unknown = null;
    try {
      state = JSON.parse(stdout);
    } catch {
      state = { raw: stdout };
    }
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
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
