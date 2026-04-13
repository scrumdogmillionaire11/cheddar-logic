/**
 * /api/results sport filter regression tests
 *
 * Verifies:
 * 1. Default responses exclude NCAAM rows
 * 2. Explicit sport=NCAAM requests still expose archival NCAAM rows
 */

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import db from '../../../packages/data/src/db.js';
import { setupIsolatedTestDb } from './db-test-runtime.js';

const TEST_PREFIX = 'test-results-sport-filter';
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

function insertSettledResultFixture(client, sport, suffix, createdAt) {
  const gameId = `${TEST_PREFIX}-${suffix}-game`;
  const cardId = `${TEST_PREFIX}-${suffix}-card`;

  client
    .prepare(
      `INSERT INTO games
       (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${TEST_PREFIX}-${suffix}-game-row`,
      sport.toLowerCase(),
      gameId,
      `${sport} Home`,
      `${sport} Away`,
      createdAt,
      'final',
      createdAt,
      createdAt,
    );

  client
    .prepare(
      `INSERT INTO card_payloads
       (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cardId,
      gameId,
      sport.toLowerCase(),
      `${sport.toLowerCase()}-totals-call`,
      `${sport} Totals`,
      createdAt,
      JSON.stringify({
        confidence_pct: 61.5,
        play: {
          decision_v2: {
            official_status: 'PLAY',
          },
        },
        recommended_bet_type: 'total',
        selection: 'OVER',
      }),
      `${TEST_PREFIX}-run`,
    );

  client
    .prepare(
      `INSERT INTO card_display_log
       (pick_id, run_id, game_id, sport, market_type, selection, line, odds, confidence_pct, displayed_at, api_endpoint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cardId,
      `${TEST_PREFIX}-run`,
      gameId,
      sport,
      'total',
      'OVER',
      5.5,
      -110,
      61.5,
      createdAt,
      '/api/cards',
    );

  client
    .prepare(
      `INSERT INTO card_results
       (id, card_id, game_id, sport, card_type, recommended_bet_type, status, result, settled_at, pnl_units, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${TEST_PREFIX}-${suffix}-result`,
      cardId,
      gameId,
      sport.toLowerCase(),
      `${sport.toLowerCase()}-totals-call`,
      'total',
      'settled',
      'win',
      createdAt,
      1,
      createdAt,
      createdAt,
    );

  client
    .prepare(
      `INSERT INTO game_results
       (id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${TEST_PREFIX}-${suffix}-game-result`,
      gameId,
      sport.toLowerCase(),
      4,
      2,
      'final',
      'manual',
      createdAt,
      createdAt,
      createdAt,
    );
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

function startNextServer(port, dbPath, appRoot) {
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
        CHEDDAR_DB_PATH: dbPath,
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

async function waitForResultsServer(baseUrl, serverHandle) {
  const deadline = Date.now() + 30_000;
  let lastError = null;

  while (Date.now() < deadline) {
    if (serverHandle.child.exitCode !== null) {
      throw new Error(
        `Next dev server exited before readiness (code=${serverHandle.child.exitCode})\n${serverHandle.getOutput()}`,
      );
    }

    try {
      const response = await fetch(`${baseUrl}/api/results?limit=1`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) return;
      lastError = new Error(`Readiness probe returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }

  throw new Error(
    `Timed out waiting for Next dev server. Last error: ${lastError?.message || lastError || 'unknown'}\n${serverHandle.getOutput()}`,
  );
}

async function stopNextServer(serverHandle) {
  if (!serverHandle) return;
  if (serverHandle.child.exitCode !== null) return;

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

async function getResultsPayload(baseUrl, queryString) {
  const response = await fetch(`${baseUrl}/api/results${queryString}`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.strictEqual(
    response.ok,
    true,
    `Expected 2xx response for ${queryString}`,
  );
  return response.json();
}

async function runTests() {
  console.log('🧪 Starting /api/results sport filter tests...\n');
  const testRuntime = await setupIsolatedTestDb('api-results-sport-filter');
  const tempAppRoot = createTempAppRoot();
  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverHandle = startNextServer(port, testRuntime.dbPath, tempAppRoot);

  try {
    const client = db.getDatabase();
    const createdAt = new Date().toISOString();

    insertSettledResultFixture(client, 'NBA', 'nba', createdAt);
    insertSettledResultFixture(client, 'MLB', 'mlb', createdAt);
    insertSettledResultFixture(client, 'NCAAM', 'ncaam', createdAt);
    await waitForResultsServer(baseUrl, serverHandle);

    const defaultPayload = await getResultsPayload(baseUrl, '?limit=50');
    assert.strictEqual(
      defaultPayload.success,
      true,
      'default response success=false',
    );
    assert.ok(defaultPayload.data, 'default response missing data');
    assert.strictEqual(
      defaultPayload.data.summary?.settledCards,
      2,
      'default summary should include MLB and NBA while excluding NCAAM rows',
    );
    assert.strictEqual(
      defaultPayload.data.meta?.totalSettled,
      2,
      'default meta totalSettled should include MLB and NBA while excluding NCAAM rows',
    );
    assert.strictEqual(
      defaultPayload.data.meta?.returnedCount,
      2,
      'default meta returnedCount should include MLB and NBA while excluding NCAAM rows',
    );
    assert.ok(
      defaultPayload.data.segments.every(
        (segment) => String(segment.sport || '').toUpperCase() !== 'NCAAM',
      ),
      'default segments unexpectedly include NCAAM',
    );
    assert.deepStrictEqual(
      defaultPayload.data.ledger
        .map((row) => String(row.sport || '').toUpperCase())
        .sort(),
      ['MLB', 'NBA'],
      'default ledger should return MLB and NBA fixture rows only',
    );

    const mlbPayload = await getResultsPayload(baseUrl, '?limit=50&sport=MLB');
    assert.strictEqual(
      mlbPayload.success,
      true,
      'MLB response success=false',
    );
    assert.ok(mlbPayload.data, 'MLB response missing data');
    assert.strictEqual(
      mlbPayload.data.summary?.settledCards,
      1,
      'sport=MLB summary should include MLB rows',
    );
    assert.strictEqual(
      mlbPayload.data.filters?.sport,
      'MLB',
      'sport=MLB filter should be preserved in response metadata',
    );
    assert.deepStrictEqual(
      mlbPayload.data.ledger.map((row) => String(row.sport || '').toUpperCase()),
      ['MLB'],
      'sport=MLB should return only MLB fixture rows',
    );
    assert.ok(
      mlbPayload.data.segments.every(
        (segment) => String(segment.sport || '').toUpperCase() === 'MLB',
      ),
      'sport=MLB segments should only contain MLB',
    );

    const ncaamPayload = await getResultsPayload(
      baseUrl,
      '?limit=50&sport=NCAAM',
    );
    assert.strictEqual(
      ncaamPayload.success,
      true,
      'NCAAM response success=false',
    );
    assert.ok(ncaamPayload.data, 'NCAAM response missing data');
    assert.strictEqual(
      ncaamPayload.data.summary?.settledCards,
      1,
      'sport=NCAAM summary should include archived NCAAM rows',
    );
    assert.strictEqual(
      ncaamPayload.data.filters?.sport,
      'NCAAM',
      'sport=NCAAM filter should be preserved in response metadata',
    );
    assert.deepStrictEqual(
      ncaamPayload.data.ledger.map((row) =>
        String(row.sport || '').toUpperCase(),
      ),
      ['NCAAM'],
      'sport=NCAAM should return only NCAAM fixture rows',
    );
    assert.ok(
      ncaamPayload.data.segments.every(
        (segment) => String(segment.sport || '').toUpperCase() === 'NCAAM',
      ),
      'sport=NCAAM segments should only contain NCAAM',
    );

    console.log('✅ /api/results sport filter tests passed\n');
  } finally {
    await stopNextServer(serverHandle);
    fs.rmSync(tempAppRoot, { recursive: true, force: true });
    testRuntime.cleanup();
  }
}

runTests().catch((error) => {
  console.error('❌ /api/results sport filter tests failed');
  console.error(error);
  process.exit(1);
});
function createTempAppRoot() {
  const tempAppRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'cheddar-results-app-'),
  );

  for (const name of APP_ROOT_LINKS) {
    const sourcePath = path.join(process.cwd(), name);
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
