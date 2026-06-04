import type { Process, Sandbox } from '@cloudflare/sandbox';
import { GATEWAY_PORT } from '../config';
import type { OpenClawEnv } from '../types';
import {
  getRestoreStatus,
  restoreIfNeeded,
  signalRestoreNeeded,
  type RestoreStatus,
} from '../persistence';
import {
  ensureGateway,
  findExistingGatewayProcess,
  isGatewayPortOpen,
  isProcessNotFoundError,
  killGateway,
} from './process';

export type GatewayLifecycleStatus =
  | 'running'
  | 'starting'
  | 'restore_failed'
  | 'start_failed'
  | 'not_responding'
  | 'restarted';

export interface GatewayDiagnostics {
  processId: string;
  processStatus: string;
  processAgeMs: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface GatewayLifecycleResult {
  ok: boolean;
  status: GatewayLifecycleStatus;
  processId?: string | null;
  processStatus?: string | null;
  processAgeMs?: number | null;
  diagnostics?: GatewayDiagnostics;
  restoreError?: string | null;
  restoreStatus?: RestoreStatus;
  error?: string;
  reason?: string;
}

export interface EnsureGatewayLifecycleOptions {
  startIfNeeded?: boolean;
  restoreBeforeStart?: boolean;
  waitForReady?: boolean;
  readinessTimeoutMs?: number;
  diagnosticsDelayMs?: number;
  restartStuckAfterMs?: number;
}

const GATEWAY_READY_LOG_RE = /(?:^|\n).*\[gateway\]\s+ready\b/;
const GATEWAY_LISTENING_LOG = '[gateway] listening on ws://';
let gatewayStartInFlight: Promise<Process | null> | null = null;

function getProcessAgeMs(process: {
  id: string;
  startTime?: string | number | Date;
}): number | null {
  if (process.startTime) {
    const startedAt =
      process.startTime instanceof Date
        ? process.startTime.getTime()
        : typeof process.startTime === 'number'
          ? process.startTime
          : Date.parse(process.startTime);
    if (Number.isFinite(startedAt)) return Math.max(0, Date.now() - startedAt);
  }

  const match = /^proc_(\d+)_/.exec(process.id);
  if (!match) return null;
  const startedAt = Number(match[1]);
  return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null;
}

export async function getGatewayProcessDiagnostics(
  process: {
    id: string;
    status: string;
    startTime?: string | number | Date;
    exitCode?: number | null;
    getStatus?: () => Promise<string>;
    getLogs?: () => Promise<{ stdout?: string; stderr?: string }>;
  },
  waitMs = 0,
): Promise<GatewayDiagnostics> {
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  let status = process.status;
  let logs: { stdout?: string; stderr?: string } = { stdout: '', stderr: '' };
  try {
    status = process.getStatus ? await process.getStatus() : process.status;
  } catch (err) {
    if (!isProcessNotFoundError(err)) throw err;
    status = 'not_found';
  }

  try {
    logs = process.getLogs ? await process.getLogs() : logs;
  } catch (err) {
    if (!isProcessNotFoundError(err)) throw err;
  }

  return {
    processId: process.id,
    processStatus: status,
    processAgeMs: getProcessAgeMs(process),
    exitCode: process.exitCode ?? null,
    stdout: logs.stdout?.slice(-4000) ?? '',
    stderr: logs.stderr?.slice(-4000) ?? '',
  };
}

function diagnosticsIndicateGatewayReady(diagnostics?: GatewayDiagnostics): boolean {
  if (!diagnostics) return false;
  const logs = `${diagnostics.stdout}\n${diagnostics.stderr}`;

  return GATEWAY_READY_LOG_RE.test(logs) || logs.includes(GATEWAY_LISTENING_LOG);
}

async function isGatewayReady(
  sandbox: Sandbox,
  process: Process | null,
  timeoutMs: number,
): Promise<boolean> {
  if (process) {
    try {
      await process.waitForPort(GATEWAY_PORT, { mode: 'tcp', timeout: timeoutMs });
      return true;
    } catch (err) {
      if (!isProcessNotFoundError(err)) {
        console.log('[gateway/lifecycle] waitForPort did not report ready:', err);
      }
    }
  }

  try {
    return await isGatewayPortOpen(sandbox);
  } catch (err) {
    console.log('[gateway/lifecycle] port probe failed:', err);
    return false;
  }
}

function runningResult(
  process: Process | null,
  diagnostics?: GatewayDiagnostics,
  restoreError: string | null = null,
  restoreStatus?: RestoreStatus,
): GatewayLifecycleResult {
  return {
    ok: true,
    status: 'running',
    restoreError,
    ...(restoreStatus ? { restoreStatus } : {}),
    processId: diagnostics?.processId ?? process?.id ?? null,
    processStatus: diagnostics?.processStatus ?? process?.status ?? null,
    processAgeMs: diagnostics?.processAgeMs ?? (process ? getProcessAgeMs(process) : null),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function startGatewayOnce(
  sandbox: Sandbox,
  env: OpenClawEnv,
  options: {
    waitForReady: boolean;
    onContainerReplaced: () => Promise<void>;
  },
): Promise<Process | null> {
  if (gatewayStartInFlight) {
    console.log('[gateway/lifecycle] Gateway start already in flight; waiting for it');
    return gatewayStartInFlight;
  }

  gatewayStartInFlight = ensureGateway(sandbox, env, options).finally(() => {
    gatewayStartInFlight = null;
  });
  return gatewayStartInFlight;
}

async function restoreGatewayStateIfNeeded(
  sandbox: Sandbox,
  bucket: R2Bucket,
  process: Process | null,
): Promise<{
  process: Process | null;
  restoreError: string | null;
  restoreStatus?: RestoreStatus;
  failed: boolean;
}> {
  const restoreStatus = await getRestoreStatus(sandbox, bucket);
  if (restoreStatus.hasBackup && !restoreStatus.restored) {
    console.log(
      '[gateway/lifecycle] Sandbox has not restored latest backup; restoring before gateway use',
    );
    if (process) await killGateway(sandbox);
    try {
      await restoreIfNeeded(sandbox, bucket);
      const postRestoreStatus = await getRestoreStatus(sandbox, bucket);
      if (postRestoreStatus.hasBackup && !postRestoreStatus.restored) {
        const restoreError = `Latest backup ${postRestoreStatus.backupId} was not marked restored after restore attempt`;
        console.error('[gateway/lifecycle] Restore verification failed:', restoreError);
        return {
          process: null,
          restoreError,
          restoreStatus: postRestoreStatus,
          failed: true,
        };
      }
      return {
        process: null,
        restoreError: null,
        restoreStatus: postRestoreStatus,
        failed: false,
      };
    } catch (err) {
      const restoreError = err instanceof Error ? err.message : String(err);
      console.error('[gateway/lifecycle] Restore failed:', restoreError);
      return { process: null, restoreError, restoreStatus, failed: true };
    }
  }

  if (!process) {
    try {
      await restoreIfNeeded(sandbox, bucket);
      const postRestoreStatus = await getRestoreStatus(sandbox, bucket);
      if (postRestoreStatus.hasBackup && !postRestoreStatus.restored) {
        const restoreError = `Latest backup ${postRestoreStatus.backupId} was not marked restored after restore attempt`;
        console.error('[gateway/lifecycle] Restore verification failed:', restoreError);
        return {
          process,
          restoreError,
          restoreStatus: postRestoreStatus,
          failed: true,
        };
      }
      return { process, restoreError: null, restoreStatus: postRestoreStatus, failed: false };
    } catch (err) {
      const restoreError = err instanceof Error ? err.message : String(err);
      console.error('[gateway/lifecycle] Restore before gateway start failed:', restoreError);
      return { process, restoreError, restoreStatus, failed: true };
    }
  }

  return { process, restoreError: null, restoreStatus, failed: false };
}

export async function ensureGatewayLifecycle(
  sandbox: Sandbox,
  env: OpenClawEnv,
  options: EnsureGatewayLifecycleOptions = {},
): Promise<GatewayLifecycleResult> {
  const startIfNeeded = options.startIfNeeded !== false;
  const restoreBeforeStart = options.restoreBeforeStart !== false;
  const waitForReady = options.waitForReady === true;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? (waitForReady ? 30_000 : 1000);
  const diagnosticsDelayMs = options.diagnosticsDelayMs ?? 0;
  const restartStuckAfterMs = options.restartStuckAfterMs;
  let restoreError: string | null = null;
  let restoreStatus: RestoreStatus | undefined;

  let process = await findExistingGatewayProcess(sandbox);

  if (restoreBeforeStart) {
    const restored = await restoreGatewayStateIfNeeded(sandbox, env.BACKUP_BUCKET, process);
    process = restored.process;
    restoreError = restored.restoreError;
    restoreStatus = restored.restoreStatus;
    if (restored.failed) {
      return {
        ok: false,
        status: 'restore_failed',
        restoreError,
        restoreStatus: restored.restoreStatus,
      };
    }
  }

  if (await isGatewayReady(sandbox, process, Math.min(readinessTimeoutMs, 1000))) {
    return runningResult(process, undefined, restoreError, restoreStatus);
  }

  if (!startIfNeeded) {
    const diagnostics = process ? await getGatewayProcessDiagnostics(process) : undefined;
    if (diagnosticsIndicateGatewayReady(diagnostics)) {
      return runningResult(process, diagnostics, restoreError, restoreStatus);
    }

    return {
      ok: false,
      status: diagnostics ? 'not_responding' : 'starting',
      restoreError,
      ...(restoreStatus ? { restoreStatus } : {}),
      processId: diagnostics?.processId ?? process?.id ?? null,
      processStatus: diagnostics?.processStatus ?? process?.status ?? null,
      processAgeMs: diagnostics?.processAgeMs ?? (process ? getProcessAgeMs(process) : null),
      ...(diagnostics ? { diagnostics } : {}),
    };
  }

  try {
    const ensured = await startGatewayOnce(sandbox, env, {
      waitForReady,
      onContainerReplaced: () => signalRestoreNeeded(env.BACKUP_BUCKET),
    });
    process = ensured ?? (await findExistingGatewayProcess(sandbox));
  } catch (err) {
    if (await isGatewayReady(sandbox, process, 1000)) {
      return runningResult(process, undefined, restoreError, restoreStatus);
    }
    const error = err instanceof Error ? err.message : String(err);
    console.error('[gateway/lifecycle] Gateway start failed:', error);
    return {
      ok: false,
      status: 'start_failed',
      restoreError,
      ...(restoreStatus ? { restoreStatus } : {}),
      error,
    };
  }

  if (await isGatewayReady(sandbox, process, readinessTimeoutMs)) {
    return runningResult(process, undefined, restoreError, restoreStatus);
  }

  const diagnostics = process
    ? await getGatewayProcessDiagnostics(process, diagnosticsDelayMs)
    : undefined;

  if (await isGatewayReady(sandbox, process, 1000)) {
    return runningResult(process, diagnostics, restoreError, restoreStatus);
  }

  if (diagnosticsIndicateGatewayReady(diagnostics)) {
    return runningResult(process, diagnostics, restoreError, restoreStatus);
  }

  if (
    diagnostics &&
    diagnostics.processStatus !== 'running' &&
    diagnostics.processStatus !== 'starting'
  ) {
    if (diagnosticsIndicateGatewayReady(diagnostics)) {
      return runningResult(process, diagnostics, restoreError, restoreStatus);
    }

    return {
      ok: false,
      status: 'start_failed',
      error: `Gateway exited with status ${diagnostics.processStatus}`,
      restoreError,
      ...(restoreStatus ? { restoreStatus } : {}),
      diagnostics,
      processId: diagnostics.processId,
      processStatus: diagnostics.processStatus,
      processAgeMs: diagnostics.processAgeMs,
    };
  }

  if (
    restartStuckAfterMs !== undefined &&
    diagnostics?.processStatus === 'running' &&
    diagnostics.processAgeMs !== null &&
    diagnostics.processAgeMs > restartStuckAfterMs
  ) {
    console.error(
      '[gateway/lifecycle] Gateway process is running but not listening; restarting:',
      diagnostics,
    );
    await killGateway(sandbox);
    let restartRestoreError: string | null = null;
    try {
      await restoreIfNeeded(sandbox, env.BACKUP_BUCKET);
    } catch (err) {
      restartRestoreError = err instanceof Error ? err.message : String(err);
      console.error(
        '[gateway/lifecycle] Restore after stuck gateway kill failed:',
        restartRestoreError,
      );
    }
    const restarted = await startGatewayOnce(sandbox, env, {
      waitForReady: false,
      onContainerReplaced: () => signalRestoreNeeded(env.BACKUP_BUCKET),
    });
    return {
      ok: false,
      status: 'restarted',
      reason: 'gateway process was running but not listening',
      restoreError: restartRestoreError,
      ...(restoreStatus ? { restoreStatus } : {}),
      processId: restarted?.id ?? null,
      processStatus: restarted?.status ?? null,
      diagnostics,
    };
  }

  return {
    ok: false,
    status: process ? 'not_responding' : 'starting',
    restoreError,
    ...(restoreStatus ? { restoreStatus } : {}),
    processId: diagnostics?.processId ?? process?.id ?? null,
    processStatus: diagnostics?.processStatus ?? process?.status ?? null,
    processAgeMs: diagnostics?.processAgeMs ?? (process ? getProcessAgeMs(process) : null),
    ...(diagnostics ? { diagnostics } : {}),
  };
}
