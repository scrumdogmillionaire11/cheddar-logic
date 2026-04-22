import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import dataPackage from '../../../packages/data/index.js';

const { closeDatabase, runMigrations } = dataPackage;
const WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const APP_ROOT_LINKS = [
  '.env.local',
  '.env.production',
  'next-env.d.ts',
  'next.config.ts',
  'node_modules',
  'package.json',
  'postcss.config.mjs',
  'public',
  'scripts',
  'src',
  'tsconfig.json',
];

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

async function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        address && typeof address === 'object' ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error('Failed to allocate a test port'));
          return;
        }
        resolve(port);
      });
    });
  });
}

function createTempNextAppRoot(label) {
  const tempAppRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `cheddar-next-${sanitizeLabel(label)}-`),
  );

  for (const name of APP_ROOT_LINKS) {
    const sourcePath = path.join(WEB_ROOT, name);
    if (!fs.existsSync(sourcePath)) continue;
    const targetPath = path.join(tempAppRoot, name);
    if (name === 'node_modules') {
      fs.symlinkSync(sourcePath, targetPath);
      continue;
    }

    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      fs.cpSync(sourcePath, targetPath, { recursive: true });
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }

  return tempAppRoot;
}

function startNextServer(port, dbPath, appRoot, extraEnv = {}) {
  const nextBin = path.join(
    appRoot,
    'node_modules',
    'next',
    'dist',
    'bin',
    'next',
  );
  const child = spawn(
    process.execPath,
    [
      nextBin,
      'dev',
      '--webpack',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        ...extraEnv,
        CHEDDAR_DB_PATH: dbPath,
        CHEDDAR_DB_AUTODISCOVER: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  const collectOutput = (chunk) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-12_000);
  };
  child.stdout.on('data', collectOutput);
  child.stderr.on('data', collectOutput);
  return { child, getOutput: () => output };
}

export async function startIsolatedNextServer({
  dbPath,
  label = 'web-test',
  readinessPath = '/',
  env = {},
  timeoutMs = 45_000,
}) {
  const appRoot = createTempNextAppRoot(label);
  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverHandle = startNextServer(port, dbPath, appRoot, env);
  let cleanedUp = false;

  async function stop() {
    if (cleanedUp) return;
    cleanedUp = true;
    if (serverHandle.child.exitCode === null) {
      await new Promise((resolve) => {
        serverHandle.child.once('exit', resolve);
        serverHandle.child.kill('SIGTERM');
        setTimeout(() => {
          if (serverHandle.child.exitCode === null) {
            serverHandle.child.kill('SIGKILL');
          }
        }, 5000).unref();
      });
    }
    fs.rmSync(appRoot, { recursive: true, force: true });
  }

  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (serverHandle.child.exitCode !== null) {
      await stop();
      throw new Error(
        `Next dev server exited before readiness (code=${serverHandle.child.exitCode})\n${serverHandle.getOutput()}`,
      );
    }

    try {
      const response = await fetch(`${baseUrl}${readinessPath}`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.status < 500) {
        return {
          baseUrl,
          appRoot,
          stop,
          getOutput: serverHandle.getOutput,
        };
      }
      lastError = new Error(`Readiness probe returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }

  const output = serverHandle.getOutput();
  await stop();
  throw new Error(
    `Timed out waiting for isolated Next dev server at ${readinessPath}. ` +
      `Last error: ${lastError?.message || lastError || 'unknown'}\n${output}`,
  );
}
