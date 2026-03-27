import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dataPackage from '../../../packages/data/index.js';

const { closeDatabase, runMigrations } = dataPackage;

const AMBIENT_DB_ENV_KEYS = [
  'CHEDDAR_DB_PATH',
  'RECORD_DATABASE_PATH',
  'DATABASE_PATH',
  'DATABASE_URL',
  'CHEDDAR_DATA_DIR',
];

const CLEARED_DB_ENV_KEYS = [
  'RECORD_DATABASE_PATH',
  'DATABASE_PATH',
  'DATABASE_URL',
  'CHEDDAR_DATA_DIR',
  'CHEDDAR_DB_AUTODISCOVER',
];

function resolveConfiguredPath(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  if (trimmed.toLowerCase().startsWith('sqlite:')) {
    const rawPath = trimmed.slice('sqlite:'.length);
    if (!rawPath) return null;
    if (rawPath.startsWith('//')) {
      return path.normalize(`/${rawPath.replace(/^\/+/, '')}`);
    }
    return path.resolve(rawPath);
  }

  if (trimmed.includes('://')) {
    return null;
  }

  return path.isAbsolute(trimmed)
    ? path.normalize(trimmed)
    : path.resolve(trimmed);
}

function isProductionLikePath(candidatePath) {
  const normalized = path.normalize(candidatePath);
  const lowerPath = normalized.toLowerCase();
  const lowerBaseName = path.basename(lowerPath);

  return (
    lowerPath === '/opt/data' ||
    lowerPath.startsWith('/opt/data/') ||
    lowerPath === '/opt/cheddar-logic' ||
    lowerPath.startsWith('/opt/cheddar-logic/') ||
    lowerBaseName === 'cheddar-prod.db'
  );
}

function assertSafeAmbientDbConfig() {
  const unsafeConfigs = [];

  for (const envKey of AMBIENT_DB_ENV_KEYS) {
    const rawValue = process.env[envKey];
    const resolvedPath = resolveConfiguredPath(rawValue);
    if (!resolvedPath) continue;

    if (isProductionLikePath(resolvedPath)) {
      unsafeConfigs.push(`${envKey}=${resolvedPath}`);
    }
  }

  if (unsafeConfigs.length > 0) {
    throw new Error(
      '[DB Test Safety] Refusing to run mutating web tests with a production-like DB path: ' +
        unsafeConfigs.join(', '),
    );
  }
}

function sanitizeLabel(label) {
  return String(label || 'web-test')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'web-test';
}

export async function setupIsolatedTestDb(label) {
  assertSafeAmbientDbConfig();

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `cheddar-${sanitizeLabel(label)}-`),
  );
  const dbPath = path.join(tempDir, 'cheddar-test.db');
  let cleanedUp = false;

  const exitCleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      closeDatabase();
    } catch {
      // Best-effort close for exit-path cleanup.
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for temp artifacts.
    }
  };

  process.on('exit', exitCleanup);

  for (const envKey of CLEARED_DB_ENV_KEYS) {
    delete process.env[envKey];
  }
  process.env.CHEDDAR_DB_PATH = dbPath;

  try {
    closeDatabase();
    await runMigrations();
  } catch (error) {
    exitCleanup();
    process.removeListener('exit', exitCleanup);
    throw error;
  }

  console.log(`[DB Test Runtime] Using isolated temp DB: ${dbPath}`);

  return {
    dbPath,
    tempDir,
    cleanup() {
      if (cleanedUp) return;
      process.removeListener('exit', exitCleanup);
      exitCleanup();
    },
  };
}
