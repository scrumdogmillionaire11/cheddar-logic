const fs = require('fs');
const path = require('path');
const { resolveDatabasePath } = require('@cheddar-logic/data');

/**
 * Automatic database backup utility
 * Creates timestamped backups before critical operations
 */

const getDbPath = () => resolveDatabasePath().dbPath;

const getBackupDir = () => {
  const dbPath = getDbPath();
  const dbDir = path.dirname(path.resolve(dbPath));
  return path.join(dbDir, 'backups');
};

const ensureBackupDir = () => {
  const dir = getBackupDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

const BACKUP_RETENTION_HOURS = Math.max(
  1,
  Number(process.env.CHEDDAR_DB_BACKUP_RETENTION_HOURS) || 24,
);
const MAX_BACKUP_FILES = Math.max(
  2,
  Number(process.env.CHEDDAR_DB_BACKUP_MAX_FILES) || 12,
);
const MIN_FREE_SPACE_BUFFER_BYTES = Math.max(
  0,
  Number(process.env.CHEDDAR_DB_BACKUP_MIN_FREE_BYTES) || 512 * 1024 * 1024,
);

const getBackupFiles = (backupDir) => {
  if (!fs.existsSync(backupDir)) return [];

  return fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const full = path.join(backupDir, f);
      const stats = fs.statSync(full);
      return {
        name: f,
        path: full,
        stats,
      };
    })
    .sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs);
};

const getFreeBytes = (targetPath) => {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stat = fs.statfsSync(targetPath);
    const blockSize = Number(stat.bsize || stat.frsize || 0);
    const availableBlocks = Number(stat.bavail || 0);
    if (!Number.isFinite(blockSize) || !Number.isFinite(availableBlocks)) {
      return null;
    }
    return blockSize * availableBlocks;
  } catch {
    return null;
  }
};

const deleteBackupFile = (file) => {
  try {
    fs.unlinkSync(file.path);
    return true;
  } catch {
    return false;
  }
};

const pruneBackups = (backupDir, { reserveSlots = 0, requiredFreeBytes = 0 } = {}) => {
  let files = getBackupFiles(backupDir);
  let pruned = 0;
  const cutoff = Date.now() - BACKUP_RETENTION_HOURS * 60 * 60 * 1000;

  for (const file of [...files]) {
    if (file.stats.mtimeMs >= cutoff) continue;
    if (deleteBackupFile(file)) {
      pruned += 1;
    }
  }

  files = getBackupFiles(backupDir);
  const maxAllowed = Math.max(0, MAX_BACKUP_FILES - reserveSlots);
  while (files.length > maxAllowed) {
    const oldest = files.shift();
    if (!oldest) break;
    if (deleteBackupFile(oldest)) {
      pruned += 1;
    }
    files = getBackupFiles(backupDir);
  }

  let freeBytes = getFreeBytes(backupDir);
  while (
    Number.isFinite(freeBytes) &&
    freeBytes < requiredFreeBytes &&
    files.length > 0
  ) {
    const oldest = files.shift();
    if (!oldest) break;
    if (deleteBackupFile(oldest)) {
      pruned += 1;
    }
    files = getBackupFiles(backupDir);
    freeBytes = getFreeBytes(backupDir);
  }

  if (pruned > 0) {
    console.log(
      `[DBBackup] Pruned ${pruned} backup(s) older than ${BACKUP_RETENTION_HOURS}h / above cap ${MAX_BACKUP_FILES}`,
    );
  }

  return {
    pruned,
    remaining: files.length,
    freeBytes,
  };
};

const backupDatabase = (label = '') => {
  const dbPath = path.resolve(getDbPath());

  if (!fs.existsSync(dbPath)) {
    console.log('[DBBackup] Database not found, skipping backup');
    return null;
  }

  const backupDir = ensureBackupDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `cheddar-${label || 'backup'}-${timestamp}.db`;
  const backupPath = path.join(backupDir, backupName);
  const dbStats = fs.statSync(dbPath);
  const requiredFreeBytes = dbStats.size + MIN_FREE_SPACE_BUFFER_BYTES;

  try {
    pruneBackups(backupDir, { reserveSlots: 1, requiredFreeBytes });
    fs.copyFileSync(dbPath, backupPath);
    const stats = fs.statSync(backupPath);
    console.log(
      `[DBBackup] ✓ Backed up to ${backupName} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`
    );
    pruneBackups(backupDir);
    return backupPath;
  } catch (err) {
    if (err && err.code === 'ENOSPC') {
      console.warn('[DBBackup] ENOSPC during backup, pruning backups and retrying once');
      try {
        pruneBackups(backupDir, { reserveSlots: 1, requiredFreeBytes });
        fs.copyFileSync(dbPath, backupPath);
        const stats = fs.statSync(backupPath);
        console.log(
          `[DBBackup] ✓ Backed up to ${backupName} after retry (${(stats.size / 1024 / 1024).toFixed(1)}MB)`
        );
        pruneBackups(backupDir);
        return backupPath;
      } catch (retryErr) {
        console.error(`[DBBackup] ✗ Backup failed after ENOSPC retry: ${retryErr.message}`);
        return null;
      }
    }
    // Backup is best-effort — a transient filesystem error (e.g. concurrent test cleanup,
    // ENOENT race, or permission issue) must not abort the calling job.
    console.error(`[DBBackup] ✗ Backup failed (non-fatal): ${err.message}`);
    return null;
  }
};

const listBackups = () => {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) return [];

  return fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .sort()
    .reverse()
    .slice(0, 10) // Last 10
    .map((f) => ({
      name: f,
      path: path.join(backupDir, f),
      stats: fs.statSync(path.join(backupDir, f))
    }));
};

const restoreFromBackup = (backupName) => {
  const backupDir = getBackupDir();
  const backupPath = path.join(backupDir, backupName);
  const dbPath = path.resolve(getDbPath());

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup not found: ${backupName}`);
  }

  try {
    fs.copyFileSync(backupPath, dbPath);
    console.log(`[DBBackup] ✓ Restored from ${backupName}`);
    return dbPath;
  } catch (err) {
    console.error(`[DBBackup] ✗ Restore failed: ${err.message}`);
    throw err;
  }
};

module.exports = {
  backupDatabase,
  listBackups,
  restoreFromBackup,
  getBackupDir,
  getBackupFiles,
  pruneBackups,
};
