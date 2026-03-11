'use strict';

const path = require('path');
const fs = require('fs');

const DEFAULT_DATABASE_PATH = path.resolve(__dirname, '..', 'cheddar.db');

function normalizePath(inputPath, cwd = process.cwd()) {
  if (!inputPath || typeof inputPath !== 'string') return null;
  const trimmed = inputPath.trim();
  if (!trimmed) return null;
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
}

function parseSqliteUrl(value, cwd = process.cwd()) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !trimmed.toLowerCase().startsWith('sqlite:')) return null;

  // Supports common forms:
  // - sqlite:////abs/path.db
  // - sqlite:///abs/path.db
  // - sqlite:./relative/path.db
  const raw = trimmed.slice('sqlite:'.length);
  if (!raw) return null;

  if (raw.startsWith('//')) {
    const absolute = `/${raw.replace(/^\/+/, '')}`;
    return path.normalize(absolute);
  }

  return normalizePath(raw, cwd);
}

function hasCardPayloads(dbPath) {
  try {
    if (!fs.existsSync(dbPath)) return false;
    
    // Quick check: just look at file size. If file is 0 bytes, it's a new empty DB
    const stats = fs.statSync(dbPath);
    if (stats.size === 0) return false;
    
    // For non-empty files, do a limited read to check for the table
    // Read only first 500KB to avoid hanging on large files
    const maxBytesToRead = 500 * 1024;
    const buffer = Buffer.alloc(Math.min(stats.size, maxBytesToRead));
    const fd = fs.openSync(dbPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, buffer.length);
      const fileContent = buffer.toString('utf8');
      return fileContent.includes('card_payloads');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // Log errors but don't throw - just return false
    if (process.env.DEBUG_DB_PATH) {
      console.error(`[DB-Path] Error checking ${dbPath}: ${err.message}`);
    }
    return false;
  }
}

function findBestDatabase(dataDir) {
  try {
    if (!fs.existsSync(dataDir)) return null;
    
    const files = fs.readdirSync(dataDir);
    const dbFiles = files.filter(f => f.endsWith('.db'));
    
    if (dbFiles.length === 0) return null;
    
    // Check which databases have card_payloads
    const validDbs = dbFiles
      .map(f => path.join(dataDir, f))
      .filter(hasCardPayloads);
    
    if (validDbs.length === 0) return null;
    
    // Prefer databases with -prod in the name
    const prodDb = validDbs.find(db => path.basename(db).includes('-prod'));
    if (prodDb) return prodDb;
    
    // Fall back to first valid database
    return validDbs[0];
  } catch (err) {
    return null;
  }
}

function resolveDatabasePath({ env = process.env, cwd = process.cwd() } = {}) {
  const canonical = normalizePath(env.CHEDDAR_DB_PATH, cwd);
  const recordPath = normalizePath(env.RECORD_DATABASE_PATH, cwd);
  const legacyPath = normalizePath(env.DATABASE_PATH, cwd);
  const fromUrl = parseSqliteUrl(env.DATABASE_URL, cwd);

  const explicitCandidates = [
    canonical ? { source: 'CHEDDAR_DB_PATH', value: canonical } : null,
    recordPath ? { source: 'RECORD_DATABASE_PATH', value: recordPath } : null,
    legacyPath ? { source: 'DATABASE_PATH', value: legacyPath } : null,
    fromUrl ? { source: 'DATABASE_URL', value: fromUrl } : null,
  ].filter(Boolean);

  const uniqueExplicit = [...new Set(explicitCandidates.map((candidate) => candidate.value))];
  if (uniqueExplicit.length > 1) {
    const details = explicitCandidates
      .map((candidate) => `${candidate.source}=${candidate.value}`)
      .join(', ');
    const error = new Error(
      `[DB] Conflicting explicit DB paths detected. Set one source of truth only. (${details})`
    );
    error.code = 'DB_PATH_CONFLICT';
    throw error;
  }

  if (canonical) return { dbPath: canonical, source: 'CHEDDAR_DB_PATH', isExplicitFile: true };
  if (recordPath) return { dbPath: recordPath, source: 'RECORD_DATABASE_PATH', isExplicitFile: true };
  if (legacyPath) return { dbPath: legacyPath, source: 'DATABASE_PATH', isExplicitFile: true };
  if (fromUrl) return { dbPath: fromUrl, source: 'DATABASE_URL', isExplicitFile: true };

  // In production, CHEDDAR_DB_PATH must be set explicitly as the single source of truth.
  // Reaching this point in production means the env is misconfigured — fail loudly rather
  // than silently resolving to a guessed filename (e.g. "cheddar.db" when the production
  // file is named "cheddar-prod.db").
  if ((env.NODE_ENV || '').toLowerCase() === 'production') {
    const error = new Error(
      '[DB] Production requires CHEDDAR_DB_PATH to be set explicitly. ' +
      'Do not rely on CHEDDAR_DATA_DIR or DEFAULT fallback in production — ' +
      'the guessed filename "cheddar.db" will not match your production DB file. ' +
      'Set CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db (or your canonical path) in .env.production.'
    );
    error.code = 'DB_PATH_MISSING_IN_PRODUCTION';
    throw error;
  }

  const dataDir = normalizePath(env.CHEDDAR_DATA_DIR, cwd);
  if (dataDir) {
    // Try to find the best database with card_payloads, preferring -prod
    const bestDb = findBestDatabase(dataDir);
    if (bestDb) {
      return {
        dbPath: bestDb,
        source: 'CHEDDAR_DATA_DIR (auto-discovered)',
        isExplicitFile: true,
      };
    }
    // Fall back to default cheddar.db in the directory
    return {
      dbPath: path.join(dataDir, 'cheddar.db'),
      source: 'CHEDDAR_DATA_DIR',
      isExplicitFile: false,
    };
  }

  return { dbPath: DEFAULT_DATABASE_PATH, source: 'DEFAULT', isExplicitFile: false };
}

module.exports = {
  DEFAULT_DATABASE_PATH,
  parseSqliteUrl,
  resolveDatabasePath,
};
