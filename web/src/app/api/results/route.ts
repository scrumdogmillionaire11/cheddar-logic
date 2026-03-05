import { NextRequest, NextResponse } from 'next/server';
import {
  deriveLockedMarketContext,
  formatMarketSelectionLabel,
  initDb,
  getDatabase,
  closeDatabase,
} from '@cheddar-logic/data';
import {
  performSecurityChecks,
  addRateLimitHeaders,
} from '../../../lib/api-security';

const ALLOWED_SPORTS = ['NHL', 'NBA', 'NCAAM', 'MLB', 'NFL'] as const;
const ALLOWED_CATEGORIES = ['driver', 'call'] as const;
const ALLOWED_MARKETS = ['moneyline', 'spread', 'total'] as const;

type SummaryRow = {
  total_cards: number;
  settled_cards: number;
  wins: number;
  losses: number;
  pushes: number;
  total_pnl_units: number | null;
};

type SegmentRow = {
  sport: string;
  card_category: string;
  recommended_bet_type: string;
  settled_cards: number;
  wins: number;
  losses: number;
  pushes: number;
  total_pnl_units: number | null;
};

type LedgerRow = {
  id: string;
  game_id: string;
  sport: string;
  card_type: string;
  recommended_bet_type: string | null;
  market_key: string | null;
  market_type: string | null;
  selection: string | null;
  line: number | null;
  locked_price: number | null;
  result: string | null;
  pnl_units: number | null;
  settled_at: string | null;
  created_at: string | null;
  payload_data: string | null;
  payload_id: string | null;
  game_home_team: string | null;
  game_away_team: string | null;
};

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

function parseBooleanParam(value: string | null, defaultValue: boolean) {
  if (value === null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  ) {
    return true;
  }
  if (
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'off'
  ) {
    return false;
  }
  return defaultValue;
}

function safeJsonParse(payload: string | null) {
  if (!payload) return { data: null, error: false, missing: true };
  try {
    return { data: JSON.parse(payload), error: false, missing: false };
  } catch {
    return { data: null, error: true, missing: false };
  }
}

// card_type patterns for driver vs call categories
const DRIVER_PATTERNS = [
  '%-projection',
  '%-advantage',
  '%-goalie',
  '%-model-output',
  '%-synergy',
  '%-pace-totals',
  '%-pace-1p',
  '%-matchup-style',
  '%-blowout-risk',
];

const CALL_PATTERNS = ['%-totals-call', '%-spread-call'];

function buildCardCategoryFilter(
  category: string | null,
  alias: string,
): { sql: string; params: string[] } {
  if (!category) return { sql: '', params: [] };

  if (category === 'driver') {
    const conditions = DRIVER_PATTERNS.map(
      () => `${alias}.card_type LIKE ?`,
    ).join(' OR ');
    return { sql: `AND (${conditions})`, params: DRIVER_PATTERNS };
  } else {
    // call
    const conditions = CALL_PATTERNS.map(
      () => `${alias}.card_type LIKE ?`,
    ).join(' OR ');
    return { sql: `AND (${conditions})`, params: CALL_PATTERNS };
  }
}

export async function GET(request: NextRequest) {
  let db: ReturnType<typeof getDatabase> | null = null;
  try {
    // Security checks: rate limiting, input validation
    const securityCheck = performSecurityChecks(request, '/api/results');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    await initDb();
    db = getDatabase();

    // Check if database is empty or uninitialized
    const tableCheckStmt = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='game_results'`,
    );
    const hasResultsTable = tableCheckStmt.get();

    if (!hasResultsTable) {
      // Database is not initialized - return empty data with proper structure
      const response = NextResponse.json(
        {
          success: true,
          data: {
            summary: {
              totalCards: 0,
              settledCards: 0,
              wins: 0,
              losses: 0,
              pushes: 0,
              totalPnlUnits: 0,
              winRate: 0,
              avgPnl: 0,
            },
            segments: [],
            ledger: [],
          },
        },
        { headers: { 'Content-Type': 'application/json' } },
      );
      return addRateLimitHeaders(response, request);
    }

    const cardResultsColumns = new Set(
      (
        db.prepare(`PRAGMA table_info(card_results)`).all() as Array<{
          name?: string;
        }>
      )
        .map((row) => String(row.name || '').toLowerCase())
        .filter(Boolean),
    );
    const hasMarketKeyColumn = cardResultsColumns.has('market_key');
    const hasMarketTypeColumn = cardResultsColumns.has('market_type');
    const hasSelectionColumn = cardResultsColumns.has('selection');
    const hasLineColumn = cardResultsColumns.has('line');
    const hasLockedPriceColumn = cardResultsColumns.has('locked_price');
    const marketKeySelect = hasMarketKeyColumn
      ? 'cr.market_key AS market_key'
      : 'NULL AS market_key';
    const marketTypeSelect = hasMarketTypeColumn
      ? 'cr.market_type AS market_type'
      : 'NULL AS market_type';
    const selectionSelect = hasSelectionColumn
      ? 'cr.selection AS selection'
      : 'NULL AS selection';
    const lineSelect = hasLineColumn ? 'cr.line AS line' : 'NULL AS line';
    const lockedPriceSelect = hasLockedPriceColumn
      ? 'cr.locked_price AS locked_price'
      : 'NULL AS locked_price';

    const { searchParams } = request.nextUrl;
    const limit = clampNumber(searchParams.get('limit'), 50, 1, 200);

    // Parse and sanitize filter params
    const rawSport = searchParams.get('sport');
    const sport: string | null =
      rawSport &&
      (ALLOWED_SPORTS as readonly string[]).includes(rawSport.toUpperCase())
        ? rawSport.toUpperCase()
        : null;

    const rawCategory = searchParams.get('card_category');
    const cardCategory: string | null =
      rawCategory &&
      (ALLOWED_CATEGORIES as readonly string[]).includes(
        rawCategory.toLowerCase(),
      )
        ? rawCategory.toLowerCase()
        : null;

    const rawConfidence = searchParams.get('min_confidence');
    const minConfidence: number | null =
      rawConfidence !== null
        ? Math.min(Math.max(Number.parseFloat(rawConfidence), 0), 100)
        : null;

    const rawMarket = searchParams.get('market');
    const market: string | null =
      rawMarket &&
      (ALLOWED_MARKETS as readonly string[]).includes(rawMarket.toLowerCase())
        ? rawMarket.toLowerCase()
        : null;
    // Always enforce payload-backed rows in results.
    const includeOrphaned = false;
    const dedupe = parseBooleanParam(searchParams.get('dedupe'), true);

    // Build filter SQL fragments
    const sportFilter = sport ? `AND UPPER(cr.sport) = ?` : '';
    const sportParams = sport ? [sport] : [];

    const categoryFilter = buildCardCategoryFilter(cardCategory, 'cr');
    const confidenceExpr = `COALESCE(CAST(json_extract(cp.payload_data, '$.confidence_pct') AS REAL), CAST(json_extract(cp.payload_data, '$.confidence') AS REAL) * 100.0)`;
    const confidenceFilter =
      minConfidence !== null ? `AND ${confidenceExpr} >= ?` : '';
    const confidenceParams = minConfidence !== null ? [minConfidence] : [];

    const marketFilter = market ? `AND LOWER(cr.recommended_bet_type) = ?` : '';
    const marketParams = market ? [market] : [];
    const orphanedFilter = includeOrphaned ? '' : 'AND cp.id IS NOT NULL';
    const passFilter = `
      AND (
        json_extract(cp.payload_data, '$.recommendation.type') IS NULL
        OR json_extract(cp.payload_data, '$.recommendation.type') != 'PASS'
      )
    `;

    const filteredCteSql = `
      WITH filtered AS (
        SELECT
          cr.id,
          cr.game_id,
          cr.recommended_bet_type,
          ${marketKeySelect},
          ${marketTypeSelect},
          ${selectionSelect},
          ${lineSelect},
          ${lockedPriceSelect},
          cr.settled_at,
          ${confidenceExpr} AS confidence_pct
        FROM card_results cr
        LEFT JOIN card_payloads cp ON cr.card_id = cp.id
        WHERE cr.status = 'settled'
          ${orphanedFilter}
          ${passFilter}
          ${sportFilter}
          ${categoryFilter.sql}
          ${confidenceFilter}
          ${marketFilter}
      )
    `;

    const dedupSql = dedupe
      ? `
        ${filteredCteSql},
        ranked AS (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(market_key, game_id || ':' || recommended_bet_type)
              ORDER BY
                CASE WHEN confidence_pct IS NULL THEN 1 ELSE 0 END ASC,
                confidence_pct DESC,
                settled_at DESC,
                id DESC
            ) AS rn
          FROM filtered
        )
        SELECT id
        FROM ranked
        WHERE rn = 1
      `
      : `
        ${filteredCteSql}
        SELECT id
        FROM filtered
      `;

    const dedupParams = [
      ...sportParams,
      ...categoryFilter.params,
      ...confidenceParams,
      ...marketParams,
    ];

    const dedupedIdRows = db.prepare(dedupSql).all(...dedupParams) as {
      id: string;
    }[];

    const filteredCountSql = `
      ${filteredCteSql}
      SELECT COUNT(*) AS count
      FROM filtered
    `;
    const filteredCountRow = db
      .prepare(filteredCountSql)
      .get(...dedupParams) as { count: number } | null;
    const filteredCount = Number(filteredCountRow?.count || 0);

    const totalSettledRow = db
      .prepare(
        `SELECT COUNT(*) AS count FROM card_results WHERE status = 'settled'`,
      )
      .get() as { count: number } | null;
    const orphanedSettledRow = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM card_results cr
        LEFT JOIN card_payloads cp ON cr.card_id = cp.id
        WHERE cr.status = 'settled' AND cp.id IS NULL
      `,
      )
      .get() as { count: number } | null;
    const totalSettled = Number(totalSettledRow?.count || 0);
    const orphanedSettled = Number(orphanedSettledRow?.count || 0);
    const withPayloadSettled = totalSettled - orphanedSettled;

    const placeholders = dedupedIdRows.map(() => '?').join(',');

    if (dedupedIdRows.length === 0) {
      return NextResponse.json(
        {
          success: true,
          data: {
            summary: {
              totalCards: 0,
              settledCards: 0,
              wins: 0,
              losses: 0,
              pushes: 0,
              totalPnlUnits: 0,
              winRate: 0,
              avgPnl: 0,
            },
            segments: [],
            ledger: [],
            filters: {
              sport,
              cardCategory,
              minConfidence,
              market,
              includeOrphaned,
              dedupe,
            },
            meta: {
              totalSettled,
              withPayloadSettled,
              orphanedSettled,
              filteredCount,
              returnedCount: 0,
              includeOrphaned,
              dedupe,
            },
          },
        },
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    const ids = dedupedIdRows.map((r) => r.id);

    const summary = db
      .prepare(
        `
      SELECT
        COUNT(*) AS total_cards,
        SUM(CASE WHEN cr.status = 'settled' THEN 1 ELSE 0 END) AS settled_cards,
        SUM(CASE WHEN cr.result = 'win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN cr.result = 'loss' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN cr.result = 'push' THEN 1 ELSE 0 END) AS pushes,
        SUM(COALESCE(cr.pnl_units, 0)) AS total_pnl_units
      FROM card_results cr
      WHERE cr.id IN (${placeholders})
    `,
      )
      .get(...ids) as SummaryRow;

    // card_category CASE expression for segments
    const cardCaseSql = `
      CASE
        WHEN cr.card_type LIKE '%-totals-call' OR cr.card_type LIKE '%-spread-call'
          THEN 'call'
        ELSE 'driver'
      END AS card_category
    `;

    const segments = db
      .prepare(
        `
      SELECT
        cr.sport,
        ${cardCaseSql},
        cr.recommended_bet_type,
        COUNT(*) AS settled_cards,
        SUM(CASE WHEN cr.result = 'win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN cr.result = 'loss' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN cr.result = 'push' THEN 1 ELSE 0 END) AS pushes,
        SUM(COALESCE(cr.pnl_units, 0)) AS total_pnl_units
      FROM card_results cr
      WHERE cr.id IN (${placeholders})
      GROUP BY cr.sport, card_category, cr.recommended_bet_type
      ORDER BY cr.sport ASC, card_category ASC, cr.recommended_bet_type ASC
    `,
      )
      .all(...ids) as SegmentRow[];

    const ledger = db
      .prepare(
        `
      SELECT
        cr.id,
        cr.game_id,
        cr.sport,
        cr.card_type,
        cr.recommended_bet_type,
        ${marketKeySelect},
        ${marketTypeSelect},
        ${selectionSelect},
        ${lineSelect},
        ${lockedPriceSelect},
        cr.result,
        cr.pnl_units,
        cr.settled_at,
        cp.id AS payload_id,
        cp.created_at,
        cp.payload_data,
        g.home_team AS game_home_team,
        g.away_team AS game_away_team
      FROM card_results cr
      LEFT JOIN card_payloads cp ON cr.card_id = cp.id
      LEFT JOIN games g ON g.game_id = cr.game_id
      WHERE cr.id IN (${placeholders})
      ORDER BY cr.settled_at DESC
      LIMIT ${limit}
    `,
      )
      .all(...ids) as LedgerRow[];

    const ledgerRows = ledger.map((row) => {
      const parsed = safeJsonParse(row.payload_data);
      const payload = parsed.data as Record<string, unknown> | null;
      const tier =
        payload && typeof payload.tier === 'string' ? payload.tier : null;
      const market =
        payload && typeof payload.recommended_bet_type === 'string'
          ? payload.recommended_bet_type
          : row.recommended_bet_type;
      let marketType = row.market_type;
      let selection = row.selection;
      let line = row.line ?? null;
      let marketKey = row.market_key;
      let lockedPrice =
        typeof row.locked_price === 'number' ? row.locked_price : null;

      // homeTeam / awayTeam
      const homeTeam =
        payload && typeof payload.home_team === 'string'
          ? payload.home_team
          : row.game_home_team;
      const awayTeam =
        payload && typeof payload.away_team === 'string'
          ? payload.away_team
          : row.game_away_team;

      if (
        (!marketType ||
          !selection ||
          marketKey == null ||
          lockedPrice == null) &&
        payload &&
        typeof payload === 'object'
      ) {
        try {
          const derived = deriveLockedMarketContext(payload, {
            gameId: row.game_id,
            homeTeam,
            awayTeam,
            requirePrice: true,
            requireLineForMarket: true,
          });
          if (derived) {
            marketType = derived.marketType;
            selection = derived.selection;
            line = derived.line;
            marketKey = derived.marketKey;
            lockedPrice = derived.lockedPrice;
          }
        } catch {
          // Keep DB-backed values when payload contract cannot be derived.
        }
      }

      let prediction: string | null = selection ?? null;
      let marketSelectionLabel: string | null = null;
      if (marketType && selection) {
        try {
          marketSelectionLabel = formatMarketSelectionLabel(
            marketType,
            selection,
          );
          prediction = selection;
        } catch {
          marketSelectionLabel = null;
        }
      }

      // Legacy display fallback for historical rows that predate locked market fields.
      const recType =
        payload &&
        typeof (
          payload.recommendation as Record<string, unknown> | null | undefined
        )?.['type'] === 'string'
          ? ((payload.recommendation as Record<string, unknown>)[
              'type'
            ] as string)
          : null;

      if (!prediction && payload && typeof payload.prediction === 'string') {
        prediction = payload.prediction;
      }

      if (!marketSelectionLabel) {
        if (recType === 'ML_HOME') marketSelectionLabel = 'ML/Home';
        else if (recType === 'ML_AWAY') marketSelectionLabel = 'ML/Away';
        else if (recType === 'SPREAD_HOME')
          marketSelectionLabel = 'Spread/Home';
        else if (recType === 'SPREAD_AWAY')
          marketSelectionLabel = 'Spread/Away';
        else if (recType === 'TOTAL_OVER') marketSelectionLabel = 'Total/Over';
        else if (recType === 'TOTAL_UNDER')
          marketSelectionLabel = 'Total/Under';
        else if (market && prediction)
          marketSelectionLabel = `${String(market).toUpperCase()}/${prediction}`;
      }

      if (
        lockedPrice == null &&
        payload &&
        payload.odds_context &&
        typeof payload.odds_context === 'object'
      ) {
        const oddsCtx = payload.odds_context as Record<string, unknown>;
        if (recType === 'ML_HOME') {
          lockedPrice =
            typeof oddsCtx.h2h_home === 'number' ? oddsCtx.h2h_home : null;
        } else if (recType === 'ML_AWAY') {
          lockedPrice =
            typeof oddsCtx.h2h_away === 'number' ? oddsCtx.h2h_away : null;
        } else if (recType === 'TOTAL_OVER') {
          lockedPrice =
            typeof oddsCtx.total_price_over === 'number'
              ? oddsCtx.total_price_over
              : null;
        } else if (recType === 'TOTAL_UNDER') {
          lockedPrice =
            typeof oddsCtx.total_price_under === 'number'
              ? oddsCtx.total_price_under
              : null;
        } else if (recType === 'SPREAD_HOME') {
          lockedPrice =
            typeof oddsCtx.spread_price_home === 'number'
              ? oddsCtx.spread_price_home
              : null;
        } else if (recType === 'SPREAD_AWAY') {
          lockedPrice =
            typeof oddsCtx.spread_price_away === 'number'
              ? oddsCtx.spread_price_away
              : null;
        } else if (prediction === 'HOME') {
          lockedPrice =
            typeof oddsCtx.h2h_home === 'number' ? oddsCtx.h2h_home : null;
        } else if (prediction === 'AWAY') {
          lockedPrice =
            typeof oddsCtx.h2h_away === 'number' ? oddsCtx.h2h_away : null;
        } else if (prediction === 'OVER') {
          lockedPrice =
            typeof oddsCtx.total_price_over === 'number'
              ? oddsCtx.total_price_over
              : null;
        } else if (prediction === 'UNDER') {
          lockedPrice =
            typeof oddsCtx.total_price_under === 'number'
              ? oddsCtx.total_price_under
              : null;
        }
      }

      // confidencePct — prefer confidence_pct, fall back to confidence * 100
      let confidencePct: number | null = null;
      if (payload) {
        if (typeof payload.confidence_pct === 'number') {
          confidencePct = Math.round(payload.confidence_pct * 10) / 10;
        } else if (typeof payload.confidence === 'number') {
          confidencePct = Math.round(payload.confidence * 100 * 10) / 10;
        }
      }

      return {
        id: row.id,
        gameId: row.game_id,
        sport: row.sport,
        cardType: row.card_type,
        result: row.result,
        pnlUnits: row.pnl_units,
        settledAt: row.settled_at,
        createdAt: row.created_at,
        prediction,
        tier,
        market,
        marketType,
        selection,
        marketSelectionLabel,
        homeTeam,
        awayTeam,
        line,
        marketKey,
        price: lockedPrice,
        confidencePct,
        payloadParseError: parsed.error,
        payloadMissing: parsed.missing || row.payload_id === null,
      };
    });

    const wins = Number(summary.wins || 0);
    const losses = Number(summary.losses || 0);
    const pushes = Number(summary.pushes || 0);
    const settledCards = Number(summary.settled_cards || 0);
    const totalCards = Number(summary.total_cards || 0);
    const totalPnlUnits = Number(summary.total_pnl_units || 0);

    const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;
    const avgPnl = settledCards > 0 ? totalPnlUnits / settledCards : 0;

    const response = NextResponse.json(
      {
        success: true,
        data: {
          summary: {
            totalCards,
            settledCards,
            wins,
            losses,
            pushes,
            totalPnlUnits,
            winRate,
            avgPnl,
          },
          segments: segments.map((row) => ({
            sport: row.sport,
            cardCategory: row.card_category,
            recommendedBetType: row.recommended_bet_type || 'unknown',
            settledCards: Number(row.settled_cards || 0),
            wins: Number(row.wins || 0),
            losses: Number(row.losses || 0),
            pushes: Number(row.pushes || 0),
            totalPnlUnits: Number(row.total_pnl_units || 0),
          })),
          ledger: ledgerRows,
          filters: {
            sport,
            cardCategory,
            minConfidence,
            market,
            includeOrphaned,
            dedupe,
          },
          meta: {
            totalSettled,
            withPayloadSettled,
            orphanedSettled,
            filteredCount,
            returnedCount: dedupedIdRows.length,
            includeOrphaned,
            dedupe,
          },
        },
      },
      { headers: { 'Content-Type': 'application/json' } },
    );
    return addRateLimitHeaders(response, request);
  } catch (error) {
    console.error('[API] Error fetching results:', error);
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    }
    const errorResponse = NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
    return addRateLimitHeaders(errorResponse, request);
  } finally {
    if (db) {
      closeDatabase();
    }
  }
}
