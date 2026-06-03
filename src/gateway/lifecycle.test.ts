import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Process } from '@cloudflare/sandbox';
import { createMockEnv, createMockSandbox } from '../test-utils';
import { ensureGatewayLifecycle } from './lifecycle';
import {
  ensureGateway,
  findExistingGatewayProcess,
  isGatewayPortOpen,
  killGateway,
} from './process';
import { getRestoreStatus, restoreIfNeeded, signalRestoreNeeded } from '../persistence';

vi.mock('./process', () => ({
  ensureGateway: vi.fn(),
  findExistingGatewayProcess: vi.fn(),
  isGatewayPortOpen: vi.fn(),
  isProcessNotFoundError: vi.fn(
    (err: unknown) => err instanceof Error && /not found/i.test(err.message),
  ),
  killGateway: vi.fn(),
}));

vi.mock('../persistence', () => ({
  getRestoreStatus: vi.fn(),
  restoreIfNeeded: vi.fn(),
  signalRestoreNeeded: vi.fn(),
}));

const mockEnsureGateway = vi.mocked(ensureGateway);
const mockFindExistingGatewayProcess = vi.mocked(findExistingGatewayProcess);
const mockIsGatewayPortOpen = vi.mocked(isGatewayPortOpen);
const mockKillGateway = vi.mocked(killGateway);
const mockGetRestoreStatus = vi.mocked(getRestoreStatus);
const mockRestoreIfNeeded = vi.mocked(restoreIfNeeded);
const mockSignalRestoreNeeded = vi.mocked(signalRestoreNeeded);

function createLifecycleProcess(overrides: Partial<Process> = {}): Process {
  return {
    id: 'proc_1780022208236_test',
    command: 'openclaw gateway --port 18789',
    status: 'running',
    startTime: Date.now() - 1000,
    endTime: undefined,
    exitCode: undefined,
    waitForPort: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn(),
    getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    getStatus: vi.fn().mockResolvedValue('running'),
    ...overrides,
  } as Process;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('ensureGatewayLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRestoreStatus.mockResolvedValue({
      hasBackup: false,
      backupId: null,
      restored: true,
      localBackupId: null,
    });
    mockRestoreIfNeeded.mockResolvedValue(undefined);
    mockSignalRestoreNeeded.mockResolvedValue(undefined);
    mockIsGatewayPortOpen.mockResolvedValue(false);
  });

  it('returns running for an existing process whose gateway port is ready', async () => {
    const process = createLifecycleProcess();
    const { sandbox } = createMockSandbox();
    const env = createMockEnv();

    mockFindExistingGatewayProcess.mockResolvedValue(process);

    const result = await ensureGatewayLifecycle(sandbox, env);

    expect(result).toMatchObject({
      ok: true,
      status: 'running',
      processId: process.id,
    });
    expect(process.waitForPort).toHaveBeenCalledWith(18789, { mode: 'tcp', timeout: 1000 });
    expect(mockEnsureGateway).not.toHaveBeenCalled();
  });

  it('treats an open gateway port as authoritative when the process handle is gone', async () => {
    const process = createLifecycleProcess({
      waitForPort: vi.fn().mockRejectedValue(new Error('Process not found')),
    });
    const { sandbox } = createMockSandbox();
    const env = createMockEnv();

    mockFindExistingGatewayProcess.mockResolvedValue(process);
    mockIsGatewayPortOpen.mockResolvedValue(true);

    const result = await ensureGatewayLifecycle(sandbox, env);

    expect(result).toMatchObject({
      ok: true,
      status: 'running',
    });
    expect(mockEnsureGateway).not.toHaveBeenCalled();
  });

  it('uses the OpenClaw ready log as a readiness fallback for status and HTML proxy checks', async () => {
    const process = createLifecycleProcess({
      waitForPort: vi.fn().mockRejectedValue(new Error('timeout waiting for port')),
      getLogs: vi.fn().mockResolvedValue({
        stdout: '2026-05-29T02:36:53.564+00:00 [gateway] ready\n',
        stderr: '',
      }),
    });
    const { sandbox } = createMockSandbox();
    const env = createMockEnv();

    mockFindExistingGatewayProcess.mockResolvedValue(process);

    const result = await ensureGatewayLifecycle(sandbox, env, {
      startIfNeeded: false,
      readinessTimeoutMs: 500,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'running',
      diagnostics: expect.objectContaining({
        processStatus: 'running',
      }),
    });
    expect(mockEnsureGateway).not.toHaveBeenCalled();
  });

  it('uses the OpenClaw listening log as a readiness fallback when the startup wrapper was killed', async () => {
    const process = createLifecycleProcess({
      status: 'failed',
      exitCode: 137,
      waitForPort: vi.fn().mockRejectedValue(new Error('Process exited before ready')),
      getStatus: vi.fn().mockResolvedValue('failed'),
      getLogs: vi.fn().mockResolvedValue({
        stdout:
          '2026-06-02T20:04:20.084+00:00 [gateway] listening on ws://0.0.0.0:18789 (PID 15993)\n',
        stderr: 'bash: line 25722: 15946 Killed /tmp/moltworker-start-openclaw-current.sh\n',
      }),
    });
    const { sandbox } = createMockSandbox();
    const env = createMockEnv();

    mockFindExistingGatewayProcess.mockResolvedValue(process);

    const result = await ensureGatewayLifecycle(sandbox, env, {
      startIfNeeded: false,
      readinessTimeoutMs: 500,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'running',
      diagnostics: expect.objectContaining({
        processStatus: 'failed',
      }),
    });
    expect(mockEnsureGateway).not.toHaveBeenCalled();
  });

  it('shares one gateway start across concurrent lifecycle calls', async () => {
    const started = createLifecycleProcess({ id: 'proc_started' });
    const { sandbox } = createMockSandbox();
    const env = createMockEnv();
    const start = createDeferred<Process>();

    mockFindExistingGatewayProcess.mockResolvedValue(null);
    mockEnsureGateway.mockReturnValue(start.promise);

    const first = ensureGatewayLifecycle(sandbox, env);
    const second = ensureGatewayLifecycle(sandbox, env);

    await Promise.resolve();
    start.resolve(started);

    const results = await Promise.all([first, second]);

    expect(mockEnsureGateway).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      expect.objectContaining({ ok: true, status: 'running', processId: started.id }),
      expect.objectContaining({ ok: true, status: 'running', processId: started.id }),
    ]);
  });

  it('restores the latest backup before starting a new gateway', async () => {
    const started = createLifecycleProcess({ id: 'proc_started' });
    const { sandbox } = createMockSandbox();
    const env = createMockEnv();
    const restoreStatus = {
      hasBackup: true,
      backupId: 'backup-1',
      restored: false,
      localBackupId: null,
    };

    mockFindExistingGatewayProcess.mockResolvedValue(null);
    mockGetRestoreStatus.mockResolvedValue(restoreStatus);
    mockEnsureGateway.mockResolvedValue(started);

    const result = await ensureGatewayLifecycle(sandbox, env, {
      waitForReady: true,
      readinessTimeoutMs: 1000,
    });

    expect(mockRestoreIfNeeded).toHaveBeenCalledWith(sandbox, env.BACKUP_BUCKET);
    expect(mockEnsureGateway).toHaveBeenCalledWith(
      sandbox,
      env,
      expect.objectContaining({ waitForReady: true }),
    );
    expect(result).toMatchObject({
      ok: true,
      status: 'running',
      processId: started.id,
      restoreStatus,
    });
  });

  it('kills an unrestored existing process before restoring backup state', async () => {
    const existing = createLifecycleProcess({ id: 'proc_existing' });
    const started = createLifecycleProcess({ id: 'proc_started' });
    const { sandbox } = createMockSandbox();
    const env = createMockEnv();

    mockFindExistingGatewayProcess.mockResolvedValueOnce(existing);
    mockGetRestoreStatus.mockResolvedValue({
      hasBackup: true,
      backupId: 'backup-1',
      restored: false,
      localBackupId: null,
    });
    mockEnsureGateway.mockResolvedValue(started);

    await ensureGatewayLifecycle(sandbox, env);

    expect(mockKillGateway).toHaveBeenCalledWith(sandbox);
    expect(mockRestoreIfNeeded).toHaveBeenCalledWith(sandbox, env.BACKUP_BUCKET);
  });

  it('does not start the gateway when startIfNeeded is false', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv();

    mockFindExistingGatewayProcess.mockResolvedValue(null);

    const result = await ensureGatewayLifecycle(sandbox, env, {
      startIfNeeded: false,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'starting',
    });
    expect(mockEnsureGateway).not.toHaveBeenCalled();
  });
});
