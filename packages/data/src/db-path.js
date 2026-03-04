'use strict';

const path = require('path');

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

function resolveDatabasePath({ env = process.env, cwd = process.cwd() } = {}) {
  const recordPath = normalizePath(env.RECORD_DATABASE_PATH, cwd);
  const canonical = normalizePath(env.CHEDDAR_DB_PATH, cwd);
  const legacyPath = normalizePath(env.DATABASE_PATH, cwd);
  const fromUrl = parseSqliteUrl(env.DATABASE_URL, cwd);

  const explicitCandidates = [
    recordPath ? { source: 'RECORD_DATABASE_PATH', value: recordPath } : null,
    canonical ? { source: 'CHEDDAR_DB_PATH', value: canonical } : null,
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

  if (recordPath) return { dbPath: recordPath, source: 'RECORD_DATABASE_PATH', isExplicitFile: true };
  if (canonical) return { dbPath: canonical, source: 'CHEDDAR_DB_PATH', isExplicitFile: true };
  if (legacyPath) return { dbPath: legacyPath, source: 'DATABASE_PATH', isExplicitFile: true };
  if (fromUrl) return { dbPath: fromUrl, source: 'DATABASE_URL', isExplicitFile: true };

  const dataDir = normalizePath(env.CHEDDAR_DATA_DIR, cwd);
  if (dataDir) {
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
