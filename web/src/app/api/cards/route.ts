/**
 * GET /api/cards
 *
 * Returns betting dashboard cards (NBA, NHL, SOCCER, NCAAM).
 * FPL projections are served from cheddar-fpl-sage backend.
 *
 * Cards are automatically sorted by game start time (soonest first).
 *
 * Query params:
 * - sport: optional sport filter (case-insensitive)
 * - card_type: optional card type filter
 * - game_id: optional game ID filter
 * - include_expired: optional (true/false), default false
 * - dedupe: optional (default latest_per_game_type, use none for raw history)
 * - limit: optional (default 20, max 100)
 * - offset: optional (default 0, max 1000)
 *
 * Response:
 * {
 *   success: boolean,
 *   data: [
 *     {
 *       id: string,
 *       gameId: string,
 *       sport: string,
 *       cardType: string,
 *       cardTitle: string,
 *       createdAt: string,
 *       expiresAt: string | null,
 *       payloadData: object | null,
 *       payloadParseError: boolean,
 *       modelOutputIds: string | null
 *     }
 *   ],
 *   error?: string
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { initDb, getDatabase, closeDatabase } from '@cheddar-logic/data';
import {
  performSecurityChecks,
  addRateLimitHeaders,
} from '../../../lib/api-security';

const ENABLE_WELCOME_HOME =
  process.env.ENABLE_WELCOME_HOME === 'true' ||
  process.env.NEXT_PUBLIC_ENABLE_WELCOME_HOME === 'true';

interface CardRow {
  id: string;
  game_id: string;
  sport: string;
  card_type: string;
  card_title: string;
  created_at: string;
  expires_at: string | null;
  payload_data: string;
  model_output_ids: string | null;
}

interface CardDisplayLogPayload {
  pickId: string;
  runId?: string | null;
  gameId?: string | null;
  sport?: string | null;
  marketType?: string | null;
  selection?: string | null;
  line?: number | null;
  odds?: number | null;
  oddsBook?: string | null;
  confidencePct?: number | null;
  endpoint: '/api/cards' | '/api/games';
}

function clampNumber(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseBoolean(value: string | null) {
  if (!value) return false;
  return ['true', '1', 'yes'].includes(value.toLowerCase());
}

function safeJsonParse(payload: string | null) {
  if (!payload) return { data: null, error: true };
  try {
    return { data: JSON.parse(payload), error: false };
  } catch {
    return { data: null, error: true };
  }
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function normalizeConfidencePct(value: number | null) {
  if (value === null) return null;
  if (value >= 0 && value <= 1) return Number((value * 100).toFixed(2));
  return value;
}

function logCardDisplay(
  db: ReturnType<typeof getDatabase>,
  payload: CardDisplayLogPayload,
) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO card_display_log (
      pick_id,
      run_id,
      game_id,
      sport,
      market_type,
      selection,
      line,
      odds,
      odds_book,
      confidence_pct,
      displayed_at,
      api_endpoint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    payload.pickId,
    payload.runId ?? null,
    payload.gameId ?? null,
    payload.sport ?? null,
    payload.marketType ?? null,
    payload.selection ?? null,
    payload.line ?? null,
    payload.odds ?? null,
    payload.oddsBook ?? null,
    normalizeConfidencePct(payload.confidencePct ?? null),
    new Date().toISOString(),
    payload.endpoint,
  );
}

function ensureCardDisplayLogSchema(db: ReturnType<typeof getDatabase>) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_display_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pick_id TEXT UNIQUE NOT NULL,
      run_id TEXT,
      game_id TEXT,
      sport TEXT,
      market_type TEXT,
      selection TEXT,
      line REAL,
      odds REAL,
      odds_book TEXT,
      confidence_pct REAL,
      displayed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      api_endpoint TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_card_display_log_run_game
      ON card_display_log (run_id, game_id);
    CREATE INDEX IF NOT EXISTS idx_card_display_log_game_sport
      ON card_display_log (game_id, sport);
    CREATE INDEX IF NOT EXISTS idx_card_display_log_displayed_at
      ON card_display_log (displayed_at DESC);
  `);
}

function ensureRunStateSchema(db: ReturnType<typeof getDatabase>) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_state (
      id TEXT PRIMARY KEY,
      current_run_id TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO run_state (id, current_run_id, updated_at)
    VALUES ('singleton', NULL, CURRENT_TIMESTAMP);
  `);

  const columns = db.prepare(`PRAGMA table_info(card_payloads)`).all() as Array<{
    name?: string;
  }>;
  const hasRunId = columns.some(
    (column) => String(column.name || '').toLowerCase() === 'run_id',
  );
  if (!hasRunId) {
    db.exec(`ALTER TABLE card_payloads ADD COLUMN run_id TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_card_payloads_run_id ON card_payloads(run_id)`,
  );

  const runIdCountRow = db
    .prepare(
      `SELECT COUNT(*) AS count FROM card_payloads WHERE run_id IS NOT NULL AND TRIM(run_id) != ''`,
    )
    .get() as { count?: number } | undefined;
  if (Number(runIdCountRow?.count || 0) === 0) {
    db.exec(`UPDATE card_payloads SET run_id = 'bootstrap-initial' WHERE run_id IS NULL`);
    db.prepare(
      `UPDATE run_state SET current_run_id = 'bootstrap-initial', updated_at = CURRENT_TIMESTAMP WHERE id = 'singleton'`,
    ).run();
  }
}

function getActiveRunIds(db: ReturnType<typeof getDatabase>): string[] {
  // Prefer per-sport rows (added by migration 021); fall back to singleton
  try {
    const sportRows = db
      .prepare(
        `SELECT current_run_id FROM run_state WHERE id != 'singleton' AND current_run_id IS NOT NULL AND TRIM(current_run_id) != ''`,
      )
      .all() as Array<{ current_run_id: string }>;
    if (sportRows.length > 0) {
      return [...new Set(sportRows.map((r) => r.current_run_id))];
    }
  } catch {
    // fall through to singleton
  }
  const row = db
    .prepare(`SELECT current_run_id FROM run_state WHERE id = 'singleton' LIMIT 1`)
    .get() as { current_run_id?: string | null } | undefined;
  return row?.current_run_id ? [row.current_run_id] : [];
}

function getRunStatus(
  db: ReturnType<typeof getDatabase>,
  runId: string | null,
): string {
  if (!runId) return 'NONE';
  try {
    const stmt = db.prepare(
      `SELECT status FROM job_runs WHERE id = ? ORDER BY started_at DESC LIMIT 1`,
    );
    const row = stmt.get(runId) as { status?: string | null } | undefined;
    return row?.status ? String(row.status).toUpperCase() : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

export async function GET(request: NextRequest) {
  try {
    // Security checks: rate limiting, input validation
    const securityCheck = performSecurityChecks(request, '/api/cards');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    await initDb();

    // AUTH DISABLED: Commenting out auth walls to allow public access
    // const access = requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD);
    // if (!access.ok) {
    //   return NextResponse.json(
    //     { success: false, error: access.error },
    //     { status: access.status }
    //   );
    // }

    const { searchParams } = request.nextUrl;
    const sportParam = searchParams.get('sport');
    const sport = sportParam ? sportParam.toUpperCase() : null;
    const cardType = searchParams.get('card_type');
    const gameId = searchParams.get('game_id');
    const includeExpired = parseBoolean(searchParams.get('include_expired'));
    const dedupe = searchParams.get('dedupe');
    const limit = clampNumber(searchParams.get('limit'), 20, 1, 100);
    const offset = clampNumber(searchParams.get('offset'), 0, 0, 1000);

    const db = getDatabase();
    ensureRunStateSchema(db);
    const activeRunIds = getActiveRunIds(db);
    const currentRunId = activeRunIds[0] ?? null;
    const runStatus = getRunStatus(db, currentRunId);

    // Check if database is empty or uninitialized
    const tableCheckStmt = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='card_payloads'`,
    );
    const hasCardsTable = tableCheckStmt.get();

    if (!hasCardsTable) {
      // Database is not initialized - return empty data
      const response = NextResponse.json(
        {
          success: true,
          data: [],
          meta: {
            current_run_id: currentRunId,
            generated_at: new Date().toISOString(),
            run_status: runStatus,
            items_count: 0,
          },
        },
        { headers: { 'Content-Type': 'application/json' } },
      );
      return addRateLimitHeaders(response, request);
    }

    const where: string[] = [];
    const params: Array<string | number> = [];

    if (sport) {
      where.push('cp.sport = ?');
      params.push(sport);
    }

    if (cardType) {
      where.push('cp.card_type = ?');
      params.push(cardType);
    }

    if (gameId) {
      where.push('cp.game_id = ?');
      params.push(gameId);
    }

    if (!includeExpired) {
      where.push(
        "(cp.expires_at IS NULL OR datetime(cp.expires_at) > datetime('now'))",
      );
    }

    // Exclude FPL cards - they are served from cheddar-fpl-sage backend
    where.push("cp.sport != 'FPL'");
    if (!ENABLE_WELCOME_HOME) {
      where.push("cp.card_type != 'welcome-home-v2'");
    }
    const runIdPlaceholders = activeRunIds.length > 0 ? activeRunIds.map(() => '?').join(', ') : 'NULL';
    where.push(`cp.run_id IN (${runIdPlaceholders})`);
    params.push(...activeRunIds);

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const dedupeMode = dedupe === 'none' ? 'none' : 'latest_per_game_type';
    const sql =
      dedupeMode === 'none'
        ? `
        SELECT cp.* FROM card_payloads cp
        LEFT JOIN games g ON cp.game_id = g.game_id
        ${whereSql}
        ORDER BY COALESCE(g.game_time_utc, cp.created_at) ASC, cp.created_at DESC
        LIMIT ? OFFSET ?
      `
        : `
        WITH ranked AS (
          SELECT cp.*,
            g.game_time_utc,
            ROW_NUMBER() OVER (
              PARTITION BY cp.game_id, cp.card_type
              ORDER BY cp.created_at DESC
            ) AS rn
          FROM card_payloads cp
          LEFT JOIN games g ON cp.game_id = g.game_id
          ${whereSql}
        )
        SELECT * FROM ranked
        WHERE rn = 1
        ORDER BY COALESCE(game_time_utc, created_at) ASC
        LIMIT ? OFFSET ?
      `;

    const stmt = db.prepare(sql);

    const rows = stmt.all(...params, limit, offset) as CardRow[];

    const response = rows.map((card) => {
      const parsed = safeJsonParse(card.payload_data);
      return {
        id: card.id,
        gameId: card.game_id,
        sport: card.sport,
        cardType: card.card_type,
        cardTitle: card.card_title,
        createdAt: card.created_at,
        expiresAt: card.expires_at,
        payloadData: parsed.data,
        payloadParseError: parsed.error,
        modelOutputIds: card.model_output_ids,
      };
    });

    ensureCardDisplayLogSchema(db);

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const parsedPayload = response[index]?.payloadData as
        | Record<string, unknown>
        | null;

      logCardDisplay(db, {
        pickId: row.id,
        runId: firstString(parsedPayload?.run_id),
        gameId: row.game_id,
        sport: row.sport,
        marketType: firstString(parsedPayload?.market_type),
        selection: firstString(
          (parsedPayload?.selection as Record<string, unknown> | undefined)
            ?.side,
          parsedPayload?.prediction,
        ),
        line: firstNumber(parsedPayload?.line),
        odds: firstNumber(parsedPayload?.price, parsedPayload?.odds),
        oddsBook: firstString(parsedPayload?.odds_book),
        confidencePct: firstNumber(parsedPayload?.confidence),
        endpoint: '/api/cards',
      });
    }

    const apiResponse = NextResponse.json(
      {
        success: true,
        data: response,
        meta: {
          current_run_id: currentRunId,
          generated_at: new Date().toISOString(),
          run_status: runStatus,
          items_count: response.length,
        },
      },
      { headers: { 'Content-Type': 'application/json' } },
    );
    return addRateLimitHeaders(apiResponse, request);
  } catch (error) {
    console.error('[API] Error fetching cards:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const errorResponse = NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
    return addRateLimitHeaders(errorResponse, request);
  } finally {
    closeDatabase();
  }
}
