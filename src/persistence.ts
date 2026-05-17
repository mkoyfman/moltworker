import type { Sandbox } from '@cloudflare/sandbox';

const BACKUP_DIR = '/home/openclaw';
const HANDLE_KEY = 'backup-handle.json';
const RESTORE_MARKER_PATH = `${BACKUP_DIR}/.moltworker-restore.json`;
const BACKUP_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const RESTORE_NEEDED_KEY = 'restore-needed';

// Per-isolate flag for fast path (avoid R2 read on every request)
let restored = false;

export interface BackupHandle {
  id: string;
  dir: string;
  createdAt?: string;
}

export interface RestoreStatus {
  hasBackup: boolean;
  backupId: string | null;
  restored: boolean;
  localBackupId: string | null;
}

/**
 * Signal that a restore is needed (e.g. after gateway restart).
 * Writes a marker to R2 so ALL Worker isolates will re-restore,
 * not just the one that handled the restart request.
 */
export async function signalRestoreNeeded(bucket: R2Bucket): Promise<void> {
  restored = false;
  await bucket.put(RESTORE_NEEDED_KEY, '1');
}

export async function restoreAfterSandboxReplacement(
  sandbox: Sandbox,
  bucket: R2Bucket,
): Promise<void> {
  await signalRestoreNeeded(bucket);
  await restoreIfNeeded(sandbox, bucket);
}

// Backward compat alias
export function clearPersistenceCache(): void {
  restored = false;
}

async function getStoredHandle(bucket: R2Bucket): Promise<BackupHandle | null> {
  const obj = await bucket.get(HANDLE_KEY);
  if (!obj) return null;
  return obj.json();
}

async function storeHandle(bucket: R2Bucket, handle: BackupHandle): Promise<void> {
  await bucket.put(HANDLE_KEY, JSON.stringify(handle));
}

async function deleteHandle(bucket: R2Bucket): Promise<void> {
  await bucket.delete(HANDLE_KEY);
}

function isExpiredOrMissingBackupError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.name}\n${error.message}`
      : typeof error === 'string'
        ? error
        : JSON.stringify(error);
  return /BACKUP_(?:EXPIRED|NOT_FOUND)|Backup(?:Expired|NotFound)Error|has expired|backup .*not found/i.test(
    text,
  );
}

async function readLocalRestoreMarker(sandbox: Sandbox): Promise<{ backupId?: string } | null> {
  try {
    const result = await sandbox.exec(`cat ${RESTORE_MARKER_PATH} 2>/dev/null || true`);
    const raw = result.stdout?.trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeLocalRestoreMarker(sandbox: Sandbox, handle: BackupHandle): Promise<void> {
  const script = `
const fs = require('fs');
const path = require('path');
const markerPath = ${JSON.stringify(RESTORE_MARKER_PATH)};
fs.mkdirSync(path.dirname(markerPath), { recursive: true });
fs.writeFileSync(markerPath, JSON.stringify({
  backupId: ${JSON.stringify(handle.id)},
  restoredAt: new Date().toISOString()
}, null, 2) + '\\n');
`;
  await sandbox.exec(`node -e ${JSON.stringify(script)}`);
}

export async function getRestoreStatus(sandbox: Sandbox, bucket: R2Bucket): Promise<RestoreStatus> {
  const handle = await getStoredHandle(bucket);
  if (!handle) {
    return {
      hasBackup: false,
      backupId: null,
      restored: true,
      localBackupId: null,
    };
  }
  const localMarker = await readLocalRestoreMarker(sandbox);
  const localBackupId = localMarker?.backupId ?? null;
  return {
    hasBackup: true,
    backupId: handle.id,
    restored: localBackupId === handle.id,
    localBackupId,
  };
}

/**
 * Restore the most recent backup if one exists and hasn't been restored yet.
 *
 * IMPORTANT: This must only be called from the catch-all route (gateway proxy)
 * and /api/status — NOT from admin routes like sync or debug/cli. The Sandbox
 * SDK's createBackup() resets the FUSE overlay, wiping any upper-layer writes.
 * If restoreIfNeeded mounts an overlay before createBackup runs, the backup
 * will lose files written to the upper layer.
 *
 * The backup handle is read from R2 (persisted across Worker isolate restarts).
 * An in-memory flag prevents redundant restores within the same isolate.
 */
export async function restoreIfNeeded(sandbox: Sandbox, bucket: R2Bucket): Promise<void> {
  if (restored) {
    // Fast path: this isolate already restored. But check if another
    // isolate signaled a restore is needed (e.g. after gateway restart).
    const marker = await bucket.head(RESTORE_NEEDED_KEY);
    if (!marker) {
      const handle = await getStoredHandle(bucket);
      if (!handle) return;
      const localMarker = await readLocalRestoreMarker(sandbox);
      if (localMarker?.backupId === handle.id) return;
      console.log('[persistence] Restore flag was set, but local restore marker is stale/missing');
    } else {
      console.log('[persistence] Restore signal found in R2, re-restoring...');
    }
    restored = false;
  }

  const handle = await getStoredHandle(bucket);
  if (!handle) {
    console.log('[persistence] No backup handle found in R2, skipping restore');
    await bucket.delete(RESTORE_NEEDED_KEY);
    restored = true;
    return;
  }

  // Unmount any stale overlay with whiteout entries before re-mounting
  try {
    await sandbox.exec(`umount ${BACKUP_DIR} 2>/dev/null; true`);
  } catch {
    // May not be mounted
  }

  console.log(`[persistence] Restoring backup ${handle.id}...`);
  const t0 = Date.now();
  try {
    await sandbox.restoreBackup(handle);
    try {
      await writeLocalRestoreMarker(sandbox, handle);
    } catch (markerErr) {
      console.warn('[persistence] Could not write local restore marker:', markerErr);
    }
    // Clear the restore signal and set the per-isolate flag
    await bucket.delete(RESTORE_NEEDED_KEY);
    restored = true;
    console.log(`[persistence] Restore complete in ${Date.now() - t0}ms`);
  } catch (err: unknown) {
    if (isExpiredOrMissingBackupError(err)) {
      console.log(`[persistence] Backup ${handle.id} expired/gone, clearing handle`);
      await deleteHandle(bucket);
      await bucket.delete(RESTORE_NEEDED_KEY);
      restored = true;
    } else {
      console.error(`[persistence] Restore failed:`, err);
      throw err;
    }
  }
}

/**
 * Create a new snapshot of /home/openclaw (config + workspace + skills).
 *
 * Creates the new backup before deleting the previous backup objects. This
 * preserves the last known-good snapshot if backup creation fails.
 *
 * The Sandbox SDK only allows backup of directories under /home, /workspace,
 * /tmp, or /var/tmp. The Dockerfile sets HOME=/home/openclaw and symlinks
 * /root/.openclaw and /root/clawd there.
 */
export async function createSnapshot(sandbox: Sandbox, bucket: R2Bucket): Promise<BackupHandle> {
  const previousHandle = await getStoredHandle(bucket);
  if (previousHandle) {
    const localMarker = await readLocalRestoreMarker(sandbox);
    if (localMarker?.backupId !== previousHandle.id) {
      throw new Error(
        `Refusing to create snapshot before restoring last backup ${previousHandle.id}. Restart the gateway or load /api/status first, then retry backup.`,
      );
    }
  }

  // Log directory contents before backup so we can verify what's captured
  try {
    const lsResult = await sandbox.exec(`ls ${BACKUP_DIR}/clawd/ 2>&1 || echo "(empty)"`);
    console.log(`[persistence] Pre-backup ${BACKUP_DIR}/clawd/:`, lsResult.stdout?.trim());
  } catch {
    // non-fatal
  }

  console.log('[persistence] Creating backup...');
  const t0 = Date.now();
  const handle = await sandbox.createBackup({
    dir: BACKUP_DIR,
    ttl: BACKUP_TTL_SECONDS,
  });

  const storedHandle = {
    ...handle,
    createdAt: new Date().toISOString(),
  };

  await storeHandle(bucket, storedHandle);
  // createBackup can reset the mounted filesystem overlay. Do not mark the
  // live sandbox as restored to the new backup; force the next gateway start
  // to restore the just-created snapshot.
  restored = false;
  await bucket.put(RESTORE_NEEDED_KEY, '1');

  if (previousHandle && previousHandle.id !== storedHandle.id) {
    try {
      await bucket.delete(`backups/${previousHandle.id}/data.sqsh`);
      await bucket.delete(`backups/${previousHandle.id}/meta.json`);
    } catch (err) {
      console.warn(`[persistence] Could not delete previous backup ${previousHandle.id}:`, err);
    }
  }

  console.log(`[persistence] Backup ${storedHandle.id} created in ${Date.now() - t0}ms`);
  return storedHandle;
}

/**
 * Get the last stored backup handle (for status reporting).
 */
export async function getLastBackupId(bucket: R2Bucket): Promise<string | null> {
  const handle = await getStoredHandle(bucket);
  return handle?.id ?? null;
}

/**
 * Get the last stored backup metadata (for status reporting).
 */
export async function getLastBackupInfo(bucket: R2Bucket): Promise<BackupHandle | null> {
  return getStoredHandle(bucket);
}
