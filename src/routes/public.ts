import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { GATEWAY_PORT } from '../config';
import { ensureGateway, findExistingGatewayProcess } from '../gateway';
import { restoreIfNeeded } from '../persistence';

async function getProcessDiagnostics(
  process: {
    id: string;
    status: string;
    exitCode?: number | null;
    getStatus?: () => Promise<string>;
    getLogs?: () => Promise<{ stdout?: string; stderr?: string }>;
  },
  waitMs = 0,
) {
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  const status = process.getStatus ? await process.getStatus() : process.status;
  const logs = process.getLogs ? await process.getLogs() : { stdout: '', stderr: '' };
  return {
    processId: process.id,
    processStatus: status,
    exitCode: process.exitCode ?? null,
    stdout: logs.stdout?.slice(-4000) ?? '',
    stderr: logs.stderr?.slice(-4000) ?? '',
  };
}

/**
 * Public routes - NO Cloudflare Access authentication required
 *
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'openclaw-sandbox',
    gateway_port: GATEWAY_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    let process = await findExistingGatewayProcess(sandbox);
    console.log('[api/status] existing process:', process?.id ?? 'none', process?.status ?? '');
    if (!process) {
      // Restore synchronously — restoreBackup is a fast RPC call (~1-3s).
      // This MUST happen before ensureGateway or the gateway starts without
      // the FUSE overlay.
      let restoreError: string | null = null;
      try {
        await restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET);
      } catch (err) {
        restoreError = err instanceof Error ? err.message : String(err);
        console.error('[api/status] Restore failed:', restoreError);
      }

      // Start the gateway but DON'T wait for it to be ready.
      // ensureGateway with waitForReady:false just starts the process
      // (fast RPC, ~2-5s) without blocking on waitForPort (which takes
      // up to 180s and would exceed the 30s Worker CPU limit).
      // The loading page polls every 2s — subsequent polls will find
      // the process and check if the port is up.
      console.log('[api/status] No process found, starting gateway...');
      try {
        const started = await ensureGateway(sandbox, c.env, { waitForReady: false });
        if (started) {
          const diagnostics = await getProcessDiagnostics(started, 3000);
          if (diagnostics.processStatus !== 'running' && diagnostics.processStatus !== 'starting') {
            console.error('[api/status] Gateway exited during startup:', diagnostics);
            return c.json({
              ok: false,
              status: 'start_failed',
              error: `Gateway exited during startup with status ${diagnostics.processStatus}`,
              restoreError,
              diagnostics,
            });
          }
          return c.json({
            ok: false,
            status: 'starting',
            restoreError,
            processId: diagnostics.processId,
            processStatus: diagnostics.processStatus,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[api/status] Gateway start failed:', msg);
        return c.json({ ok: false, status: 'start_failed', error: msg, restoreError });
      }
      return c.json({ ok: false, status: 'starting', restoreError });
    }

    // Process exists. ensureGateway performs a cheap config drift check and
    // restarts old containers that still point at Claude after a deploy.
    process = await ensureGateway(sandbox, c.env, { waitForReady: false });
    if (!process) {
      return c.json({ ok: false, status: 'starting', restoreError: null });
    }

    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({ ok: true, status: 'running', processId: process.id });
    } catch {
      const diagnostics = await getProcessDiagnostics(process);
      if (diagnostics.processStatus !== 'running' && diagnostics.processStatus !== 'starting') {
        return c.json({
          ok: false,
          status: 'start_failed',
          error: `Gateway exited with status ${diagnostics.processStatus}`,
          diagnostics,
        });
      }
      return c.json({
        ok: false,
        status: 'not_responding',
        processId: process.id,
        processStatus: diagnostics.processStatus,
      });
    }
  } catch (err) {
    return c.json({
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

export { publicRoutes };
