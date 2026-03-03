/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Import Historical Settled Results
 *
 * One-off reconciliation job that imports settled card history from a source SQLite DB
 * into the active DB source-of-truth.
 *
 * Safety properties:
 * - Default mode is dry-run (no writes)
 * - Apply mode creates a DB backup before writing
 * - Idempotent by card_results.id (existing settled rows are skipped)
 * - Writes happen in-memory and flush once at the end (no partial on-disk writes on failure)
 *
 * Usage:
 *   node src/jobs/import_historical_settled_results.js --dry-run --source /abs/path/source.db
 *   node src/jobs/import_historical_settled_results.js --apply --source /abs/path/source.db
 *   node src/jobs/import_historical_settled_results.js --apply --source /abs/path/source.db --no-market-repair
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbBackup = require('../utils/db-backup.js');
const {
  deriveLockedMarketContext,
  resolveDatabasePath,
  withDb,
} = require('@cheddar-logic/data');
const dataPackageRoot = path.dirname(require.resolve('@cheddar-logic/data/package.json'));
const initSqlJs = require(path.join(dataPackageRoot, 'node_modules/sql.js/dist/sql-asm.js'));

function parseArgs(argv) {
  const args = {
    sourcePath: null,
    apply: false,
    dryRun: true,
    marketRepair: true,
    limit: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source') {
      args.sourcePath = argv[i + 1] || null;
      i++;
      continue;
    }
    if (arg === '--apply') {
      args.apply = true;
      args.dryRun = false;
      continue;
    }
    if (arg === '--dry-run') {
      args.apply = false;
      args.dryRun = true;
      continue;
    }
    if (arg === '--no-market-repair') {
      args.marketRepair = false;
      continue;
    }
    if (arg === '--limit') {
      const parsed = Number.parseInt(argv[i + 1] || '', 10);
      args.limit = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      i++;
    }
  }

  return args;
}

function stableId(prefix, input) {
  const digest = crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, 12);
  return `${prefix}-${digest}`;
}

function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const hasRow = stmt.step();
  const row = hasRow ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function normalizeText(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value);
  return text;
}

function buildSyntheticPayload({ gameId, sport, recommendedBetType, homeTeam, awayTeam }) {
  return {
    historical_import: true,
    payload_stub: true,
    game_id: gameId,
    sport: sport || 'unknown',
    recommended_bet_type: recommendedBetType || 'unknown',
    home_team: homeTeam || null,
    away_team: awayTeam || null,
  };
}

async function importHistoricalSettledResults({
  sourcePath,
  dryRun = true,
  marketRepair = true,
  limit = null,
} = {}) {
  const activeResolution = resolveDatabasePath();
  const activePath = path.resolve(activeResolution.dbPath);
  const resolvedSource = sourcePath ? path.resolve(process.cwd(), sourcePath) : null;

  if (!resolvedSource) {
    throw new Error('Missing required --source <path-to-source-db>');
  }
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Source DB not found: ${resolvedSource}`);
  }
  if (!fs.existsSync(activePath)) {
    throw new Error(`Active DB not found: ${activePath}`);
  }
  if (resolvedSource === activePath) {
    throw new Error('Source DB path must be different from active DB path');
  }

  console.log('[ImportHistory] Active DB:', activePath);
  console.log('[ImportHistory] Source DB:', resolvedSource);
  console.log('[ImportHistory] Mode:', dryRun ? 'DRY_RUN' : 'APPLY');
  if (limit) {
    console.log('[ImportHistory] Limit:', limit);
  }

  // Ensure migrations are applied before direct SQL.js reads/writes.
  await withDb(async () => {});

  if (!dryRun) {
    dbBackup.backupDatabase('before-import-historical-settled');
  }

  const SQL = await initSqlJs();
  const activeDb = new SQL.Database(fs.readFileSync(activePath));
  const sourceDb = new SQL.Database(fs.readFileSync(resolvedSource));

  const settledRows = queryAll(
    sourceDb,
    `
      SELECT
        id, card_id, game_id, sport, card_type, recommended_bet_type,
        result, settled_at, pnl_units, metadata, created_at, updated_at
      FROM card_results
      WHERE status = 'settled'
      ORDER BY settled_at ASC, created_at ASC
    `
  );
  const sourceGames = queryAll(sourceDb, 'SELECT * FROM games');
  const sourcePayloads = queryAll(sourceDb, 'SELECT * FROM card_payloads');
  const sourceGameResults = queryAll(sourceDb, 'SELECT * FROM game_results');

  const sourceGameByGameId = new Map(sourceGames.map((row) => [String(row.game_id), row]));
  const sourcePayloadById = new Map(sourcePayloads.map((row) => [String(row.id), row]));
  const sourceGameResultByGameId = new Map(sourceGameResults.map((row) => [String(row.game_id), row]));

  const rowsToProcess = limit ? settledRows.slice(0, limit) : settledRows;

  const stats = {
    sourceSettled: rowsToProcess.length,
    insertedGames: 0,
    insertedPayloadsReal: 0,
    insertedPayloadsStub: 0,
    insertedGameResults: 0,
    updatedGameResults: 0,
    insertedResults: 0,
    skippedExistingResults: 0,
    marketRowsChecked: 0,
    marketRowsRepaired: 0,
    marketRowsRepairFailed: 0,
  };

  for (const row of rowsToProcess) {
    const resultId = normalizeText(row.id);
    const cardId = normalizeText(row.card_id);
    const gameId = normalizeText(row.game_id);
    const sport = normalizeText(row.sport, 'unknown');
    const cardType = normalizeText(row.card_type, 'historical-settled');
    const recommendedBetType = normalizeText(row.recommended_bet_type, 'unknown');

    if (!resultId || !cardId || !gameId) {
      throw new Error(`Invalid settled source row: id/card_id/game_id missing (${JSON.stringify(row)})`);
    }

    const existingResult = queryOne(
      activeDb,
      'SELECT 1 AS ok FROM card_results WHERE id = ? LIMIT 1',
      [resultId]
    );
    if (existingResult) {
      stats.skippedExistingResults++;
      continue;
    }

    const sourceGame = sourceGameByGameId.get(gameId) || null;
    const existingGame = queryOne(
      activeDb,
      'SELECT 1 AS ok FROM games WHERE game_id = ? LIMIT 1',
      [gameId]
    );
    if (!existingGame) {
      const homeTeam = normalizeText(sourceGame?.home_team, 'Unknown Home');
      const awayTeam = normalizeText(sourceGame?.away_team, 'Unknown Away');
      const gameTimeUtc = normalizeText(
        sourceGame?.game_time_utc,
        normalizeText(row.settled_at, normalizeText(row.created_at, new Date().toISOString()))
      );
      const gameStatus = normalizeText(sourceGame?.status, 'final');
      const createdAt = normalizeText(sourceGame?.created_at, normalizeText(row.created_at, new Date().toISOString()));
      const updatedAt = normalizeText(sourceGame?.updated_at, normalizeText(row.updated_at, createdAt));
      const gamePkId = stableId('game', gameId);

      activeDb.run(
        `
          INSERT INTO games (
            id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [gamePkId, sport, gameId, homeTeam, awayTeam, gameTimeUtc, gameStatus, createdAt, updatedAt]
      );
      stats.insertedGames++;
    }

    const existingPayload = queryOne(
      activeDb,
      'SELECT 1 AS ok FROM card_payloads WHERE id = ? LIMIT 1',
      [cardId]
    );
    if (!existingPayload) {
      const sourcePayload = sourcePayloadById.get(cardId) || null;
      if (sourcePayload) {
        activeDb.run(
          `
            INSERT INTO card_payloads (
              id, game_id, sport, card_type, card_title, created_at, expires_at,
              payload_data, model_output_ids, metadata, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            normalizeText(sourcePayload.id),
            normalizeText(sourcePayload.game_id, gameId),
            normalizeText(sourcePayload.sport, sport),
            normalizeText(sourcePayload.card_type, cardType),
            normalizeText(sourcePayload.card_title, `Historical Settled ${cardType}`),
            normalizeText(sourcePayload.created_at, normalizeText(row.created_at, new Date().toISOString())),
            sourcePayload.expires_at == null ? null : normalizeText(sourcePayload.expires_at),
            normalizeText(sourcePayload.payload_data, '{}'),
            sourcePayload.model_output_ids == null ? null : normalizeText(sourcePayload.model_output_ids),
            sourcePayload.metadata == null ? null : normalizeText(sourcePayload.metadata),
            normalizeText(sourcePayload.updated_at, normalizeText(sourcePayload.created_at, new Date().toISOString())),
          ]
        );
        stats.insertedPayloadsReal++;
      } else {
        const syntheticPayload = buildSyntheticPayload({
          gameId,
          sport,
          recommendedBetType,
          homeTeam: normalizeText(sourceGame?.home_team, null),
          awayTeam: normalizeText(sourceGame?.away_team, null),
        });
        activeDb.run(
          `
            INSERT INTO card_payloads (
              id, game_id, sport, card_type, card_title, created_at, expires_at,
              payload_data, model_output_ids, metadata, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            cardId,
            gameId,
            sport,
            cardType,
            `Historical Settled ${cardType}`.trim(),
            normalizeText(row.created_at, normalizeText(row.settled_at, new Date().toISOString())),
            null,
            JSON.stringify(syntheticPayload),
            null,
            JSON.stringify({
              source: 'historical-import-job',
              payload_stub: true,
              imported_at: new Date().toISOString(),
            }),
            normalizeText(row.updated_at, normalizeText(row.created_at, new Date().toISOString())),
          ]
        );
        stats.insertedPayloadsStub++;
      }
    }

    const sourceGameResult = sourceGameResultByGameId.get(gameId) || null;
    if (sourceGameResult) {
      const existingGameResult = queryOne(
        activeDb,
        'SELECT 1 AS ok FROM game_results WHERE game_id = ? LIMIT 1',
        [gameId]
      );
      const sportValue = normalizeText(sourceGameResult.sport, sport);
      const finalHome = sourceGameResult.final_score_home == null ? null : Number(sourceGameResult.final_score_home);
      const finalAway = sourceGameResult.final_score_away == null ? null : Number(sourceGameResult.final_score_away);
      const statusValue = normalizeText(sourceGameResult.status, 'final');
      const resultSource = normalizeText(sourceGameResult.result_source, 'historical-import');
      const settledAt = sourceGameResult.settled_at == null ? null : normalizeText(sourceGameResult.settled_at);
      const metadata = sourceGameResult.metadata == null ? null : normalizeText(sourceGameResult.metadata);
      const createdAt = normalizeText(sourceGameResult.created_at, normalizeText(row.created_at, new Date().toISOString()));
      const updatedAt = normalizeText(sourceGameResult.updated_at, normalizeText(row.updated_at, createdAt));

      if (!existingGameResult) {
        activeDb.run(
          `
            INSERT INTO game_results (
              id, game_id, sport, final_score_home, final_score_away, status,
              result_source, settled_at, metadata, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            stableId('gr', gameId),
            gameId,
            sportValue,
            finalHome,
            finalAway,
            statusValue,
            resultSource,
            settledAt,
            metadata,
            createdAt,
            updatedAt,
          ]
        );
        stats.insertedGameResults++;
      } else {
        activeDb.run(
          `
            UPDATE game_results
            SET final_score_home = ?, final_score_away = ?, status = ?, result_source = ?,
                settled_at = ?, metadata = ?, updated_at = ?
            WHERE game_id = ?
          `,
          [finalHome, finalAway, statusValue, resultSource, settledAt, metadata, updatedAt, gameId]
        );
        stats.updatedGameResults++;
      }
    }

    activeDb.run(
      `
        INSERT INTO card_results (
          id, card_id, game_id, sport, card_type, recommended_bet_type,
          status, result, settled_at, pnl_units, metadata, created_at, updated_at,
          market_key, market_type, selection, line, locked_price
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        resultId,
        cardId,
        gameId,
        sport,
        cardType,
        recommendedBetType || 'unknown',
        'settled',
        row.result == null ? null : normalizeText(row.result),
        row.settled_at == null ? null : normalizeText(row.settled_at),
        row.pnl_units == null ? null : Number(row.pnl_units),
        row.metadata == null ? null : normalizeText(row.metadata),
        normalizeText(row.created_at, new Date().toISOString()),
        normalizeText(row.updated_at, normalizeText(row.created_at, new Date().toISOString())),
        null,
        null,
        null,
        null,
        null,
      ]
    );
    stats.insertedResults++;
  }

  if (marketRepair) {
    const repairCandidates = queryAll(
      activeDb,
      `
        SELECT
          cr.id,
          cr.game_id,
          cp.payload_data,
          g.home_team,
          g.away_team
        FROM card_results cr
        INNER JOIN card_payloads cp ON cp.id = cr.card_id
        LEFT JOIN games g ON g.game_id = cr.game_id
        WHERE cr.market_key IS NULL
      `
    );

    for (const row of repairCandidates) {
      stats.marketRowsChecked++;
      try {
        const payload = typeof row.payload_data === 'string'
          ? JSON.parse(row.payload_data)
          : row.payload_data;

        if (payload && payload.payload_stub) {
          continue;
        }

        const locked = deriveLockedMarketContext(payload, {
          gameId: row.game_id,
          homeTeam: row.home_team || null,
          awayTeam: row.away_team || null,
          requirePrice: true,
          requireLineForMarket: true,
        });

        if (!locked) continue;

        activeDb.run(
          `
            UPDATE card_results
            SET market_key = ?, market_type = ?, selection = ?, line = ?, locked_price = ?
            WHERE id = ?
          `,
          [locked.marketKey, locked.marketType, locked.selection, locked.line, locked.lockedPrice, row.id]
        );
        stats.marketRowsRepaired++;
      } catch {
        stats.marketRowsRepairFailed++;
      }
    }
  }

  const summary = queryOne(
    activeDb,
    `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='settled' THEN 1 ELSE 0 END) AS settled,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errored
      FROM card_results
    `
  );
  const settledGames = queryOne(
    activeDb,
    `SELECT COUNT(DISTINCT game_id) AS c FROM card_results WHERE status='settled'`
  );
  const settledMissingMarketKey = queryOne(
    activeDb,
    `SELECT COUNT(*) AS c FROM card_results WHERE status='settled' AND market_key IS NULL`
  );
  const settledWithPayload = queryOne(
    activeDb,
    `
      SELECT COUNT(*) AS c
      FROM card_results cr
      INNER JOIN card_payloads cp ON cp.id = cr.card_id
      WHERE cr.status='settled'
    `
  );

  if (!dryRun) {
    const serialized = Buffer.from(activeDb.export());
    fs.writeFileSync(activePath, serialized);
  }

  console.log('[ImportHistory] Stats:', stats);
  console.log('[ImportHistory] Summary:', summary);
  console.log('[ImportHistory] Settled games:', settledGames?.c || 0);
  console.log('[ImportHistory] Settled with payload:', settledWithPayload?.c || 0);
  console.log('[ImportHistory] Settled missing market_key:', settledMissingMarketKey?.c || 0);

  return {
    success: true,
    dryRun,
    stats,
    summary,
    settledGames: settledGames?.c || 0,
    settledWithPayload: settledWithPayload?.c || 0,
    settledMissingMarketKey: settledMissingMarketKey?.c || 0,
    activeDbPath: activePath,
    sourceDbPath: resolvedSource,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  importHistoricalSettledResults({
    sourcePath: args.sourcePath,
    dryRun: args.dryRun,
    marketRepair: args.marketRepair,
    limit: args.limit,
  })
    .then((result) => {
      if (!result.success) process.exit(1);
      process.exit(0);
    })
    .catch((error) => {
      console.error('[ImportHistory] Failed:', error.message);
      console.error(error.stack);
      process.exit(1);
    });
}

module.exports = {
  importHistoricalSettledResults,
};
