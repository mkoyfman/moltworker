import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sandbox } from '@cloudflare/sandbox';
import { createMockExecResult } from './test-utils';
import { getRestoreStatus, restoreIfNeeded, type BackupHandle } from './persistence';

function createBucket(handle: BackupHandle | null): R2Bucket {
  return {
    get: vi.fn(async (key: string) => {
      if (key !== 'backup-handle.json' || !handle) return null;
      return { json: vi.fn(async () => handle) };
    }),
    put: vi.fn(),
    delete: vi.fn(),
    head: vi.fn(async () => null),
  } as unknown as R2Bucket;
}

function createSandbox(marker: { backupId?: string } | null = null): Sandbox {
  return {
    exec: vi.fn(async (command: string) => {
      if (command.includes('/tmp/moltworker-restore.json')) {
        if (!marker) return createMockExecResult('', { exitCode: 1 });
        return createMockExecResult(`${JSON.stringify(marker)}\n`);
      }
      return createMockExecResult();
    }),
    restoreBackup: vi.fn(async (handle: BackupHandle) => ({
      success: true,
      id: handle.id,
      dir: handle.dir,
    })),
    writeFile: vi.fn(async () => ({
      success: true,
      path: '/tmp/moltworker-restore.json',
      timestamp: new Date().toISOString(),
    })),
  } as unknown as Sandbox;
}

describe('persistence restore markers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports the latest backup restored when the local marker matches', async () => {
    const handle = { id: 'backup-1', dir: '/home/openclaw' };
    const status = await getRestoreStatus(
      createSandbox({ backupId: 'backup-1' }),
      createBucket(handle),
    );

    expect(status).toEqual({
      hasBackup: true,
      backupId: 'backup-1',
      restored: true,
      localBackupId: 'backup-1',
    });
  });

  it('writes a restore marker after a successful SDK restore', async () => {
    const handle = { id: 'backup-1', dir: '/home/openclaw' };
    const sandbox = createSandbox();

    await restoreIfNeeded(sandbox, createBucket(handle));

    expect(sandbox.restoreBackup).toHaveBeenCalledWith(handle);
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      '/tmp/moltworker-restore.json',
      expect.stringContaining('"backupId": "backup-1"'),
    );
  });

  it('fails restore when the local marker cannot be written', async () => {
    const handle = { id: 'backup-1', dir: '/home/openclaw' };
    const sandbox = createSandbox();
    vi.mocked(sandbox.writeFile).mockResolvedValueOnce({
      success: false,
      path: '/tmp/moltworker-restore.json',
      timestamp: new Date().toISOString(),
      exitCode: 13,
    });

    await expect(restoreIfNeeded(sandbox, createBucket(handle))).rejects.toThrow(
      'Failed to write restore marker /tmp/moltworker-restore.json (exitCode=13)',
    );
  });
});
