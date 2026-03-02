/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');

/**
 * Automatic database backup utility
 * Creates timestamped backups before critical operations
 */

const getDbPath = () => process.env.DATABASE_PATH || '../../packages/data/cheddar.db';

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
