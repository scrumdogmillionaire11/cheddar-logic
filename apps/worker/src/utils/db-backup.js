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

const BACKUP_RETENTION_HOURS = 72;

const pruneOldBackups = (backupDir) => {
  const cutoff = Date.now() - BACKUP_RETENTION_HOURS * 60 * 60 * 1000;
  let pruned = 0;
  for (const f of fs.readdirSync(backupDir)) {
    if (!f.endsWith('.db')) continue;
    const full = path.join(backupDir, f);
    try {
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime < cutoff) {
        fs.unlinkSync(full);
        pruned++;
      }
    } catch {
      // ignore individual file errors
    }
  }
  if (pruned > 0) {
    console.log(`[DBBackup] Pruned ${pruned} backup(s) older than ${BACKUP_RETENTION_HOURS}h`);
  }
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

  try {
    fs.copyFileSync(dbPath, backupPath);
    const stats = fs.statSync(backupPath);
    console.log(
      `[DBBackup] ✓ Backed up to ${backupName} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`
    );
    pruneOldBackups(backupDir);
    return backupPath;
  } catch (err) {
    console.error(`[DBBackup] ✗ Backup failed: ${err.message}`);
    throw err;
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
  getBackupDir
};
