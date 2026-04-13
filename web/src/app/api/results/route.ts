import { NextRequest, NextResponse } from 'next/server';
import {
  deriveLockedMarketContext,
  formatMarketSelectionLabel,
  getDatabaseReadOnly,
  closeReadOnlyInstance,
} from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  performSecurityChecks,
  addRateLimitHeaders,
} from '../../../lib/api-security';
import {
  buildProjectionSummaries,
  deriveResultCardMode,
  deriveCardFamily,
  deriveModelFamily,
  deriveModelVersion,
  PROJECTION_TRACKING_CARD_TYPES,
  shouldTrackInResults,
} from './projection-metrics';

const ALLOWED_SPORTS = ['NHL', 'NBA', 'NCAAM', 'MLB', 'NFL'] as const;
const ALLOWED_CATEGORIES = ['driver', 'call'] as const;
const ALLOWED_MARKETS = ['moneyline', 'spread', 'total'] as const;
const DEFAULT_EXCLUDED_SPORT = 'NCAAM';

type ActionableSourceRow = {
  id: string;
  sport: string;
  card_type: string;
  recommended_bet_type: string | null;
  result: string | null;
  pnl_units: number | null;
  payload_data: string | null;
  game_result_metadata: string | null;
  clv_pct: number | null;
};

type DecisionSegmentId = 'play' | 'slight_edge';
type DecisionTierStatus = 'PLAY' | 'LEAN' | 'PASS_OR_OTHER';

type DecisionSegmentMeta = {
  id: DecisionSegmentId;
  label: string;
  canonicalStatus: 'PLAY' | 'LEAN';
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
  game_time_utc: string | null;
  created_at: string | null;
  payload_data: string | null;
  payload_id: string | null;
  game_home_team: string | null;
  game_away_team: string | null;
  market_period_token: string | null;
  clv_odds_at_pick: number | null;
  clv_closing_odds: number | null;
  clv_pct: number | null;
  clv_recorded_at: string | null;
  clv_closed_at: string | null;
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

function parseBooleanLikeParam(
  value: string | null,
  fallback: boolean,
): boolean {
  if (value === null) return fallback;
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
  return fallback;
}

function safeJsonParse(payload: string | null) {
  if (!payload) return { data: null, error: false, missing: true };
  try {
    return { data: JSON.parse(payload), error: false, missing: false };
  } catch {
    return { data: null, error: true, missing: false };
  }
}

function addSettlementCoverageHeader(
  response: NextResponse,
  settled: number,
  displayed: number,
) {
  response.headers.set('X-Settlement-Coverage', `${settled}/${displayed}`);
  return response;
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
const DECISION_SEGMENTS: DecisionSegmentMeta[] = [
  { id: 'play', label: 'PLAY', canonicalStatus: 'PLAY' },
  { id: 'slight_edge', label: 'SLIGHT EDGE', canonicalStatus: 'LEAN' },
];

const CALL_SUFFIXES = CALL_PATTERNS.map((pattern) =>
  pattern.replace('%', '').toLowerCase(),
);

function getNestedString(
  payload: Record<string, unknown> | null,
  path: string[],
): string | null {
  let current: unknown = payload;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : null;
}

function normalizeStatusToken(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function resolveDecisionTier(
  payload: Record<string, unknown> | null,
): DecisionTierStatus {
  const officialStatus = normalizeStatusToken(
    getNestedString(payload, ['play', 'decision_v2', 'official_status']) ||
      getNestedString(payload, ['decision_v2', 'official_status']),
  );
  if (officialStatus === 'PLAY') return 'PLAY';
  if (officialStatus === 'LEAN') return 'LEAN';
  if (officialStatus === 'PASS') return 'PASS_OR_OTHER';

  const fallbackSignals = [
    getNestedString(payload, ['decision', 'status']),
    getNestedString(payload, ['status']),
    getNestedString(payload, ['play', 'status']),
    getNestedString(payload, ['action']),
    getNestedString(payload, ['play', 'action']),
    getNestedString(payload, ['decision', 'action']),
  ];

  for (const signal of fallbackSignals) {
    const normalized = normalizeStatusToken(signal);
    if (normalized === 'FIRE' || normalized === 'PLAY') return 'PLAY';
    if (
      normalized === 'WATCH' ||
      normalized === 'HOLD' ||
      normalized === 'LEAN'
    ) {
      return 'LEAN';
    }
    if (normalized === 'PASS') return 'PASS_OR_OTHER';
  }

  return 'PASS_OR_OTHER';
}

function deriveDecisionSegment(tier: 'PLAY' | 'LEAN'): DecisionSegmentMeta {
  return tier === 'PLAY' ? DECISION_SEGMENTS[0] : DECISION_SEGMENTS[1];
}

function deriveCardCategoryFromType(cardType: string | null | undefined) {
  const normalized = String(cardType || '').toLowerCase();
  return CALL_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
    ? 'call'
    : 'driver';
}

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

function buildSportFilter(
  sport: string | null,
  sportExpr: string,
): { sql: string; params: string[] } {
  if (sport) {
    return {
      sql: `AND UPPER(${sportExpr}) = ?`,
      params: [sport],
    };
  }

  return {
    sql: `AND UPPER(${sportExpr}) != '${DEFAULT_EXCLUDED_SPORT}'`,
    params: [],
  };
}

// NOTE: ensureCardDisplayLogSchema removed — worker owns all DB writes (single-writer architecture).

export async function GET(request: NextRequest) {
  // Without Odds Mode: settlement is disabled, so there are no results to show.
  if (process.env.ENABLE_WITHOUT_ODDS_MODE === 'true') {
    return NextResponse.json(
      {
        success: true,
        withoutOddsMode: true,
        data: null,
      },
      { status: 200 },
    );
  }

  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;
  try {
    // Security checks: rate limiting, input validation
    const securityCheck = performSecurityChecks(request, '/api/results');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    await ensureDbReady();
    db = getDatabaseReadOnly();

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
              totalPnlUnits: null,
              winRate: 0,
              avgPnl: null,
              avgClvPct: null,
            },
            segments: [],
            segmentFamilies: DECISION_SEGMENTS.map((segment) => ({
              segmentId: segment.id,
              segmentLabel: segment.label,
              settledCards: 0,
            })),
            projectionSummaries: [],
            ledger: [],
          },
        },
        { headers: { 'Content-Type': 'application/json' } },
      );
      return addRateLimitHeaders(
        addSettlementCoverageHeader(response, 0, 0),
        request,
      );
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
    const hasClvLedger = Boolean(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='clv_ledger'`,
        )
        .get(),
    );
    const hasMarketKeyColumn = cardResultsColumns.has('market_key');
    const hasMarketTypeColumn = cardResultsColumns.has('market_type');
    const hasSelectionColumn = cardResultsColumns.has('selection');
    const hasLineColumn = cardResultsColumns.has('line');
    const hasLockedPriceColumn = cardResultsColumns.has('locked_price');
    const marketKeyValueExpr = hasMarketKeyColumn ? 'cr.market_key' : 'NULL';
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
    const clvOddsAtPickSelect = hasClvLedger
      ? 'clv.odds_at_pick AS clv_odds_at_pick'
      : 'NULL AS clv_odds_at_pick';
    const clvClosingOddsSelect = hasClvLedger
      ? 'clv.closing_odds AS clv_closing_odds'
      : 'NULL AS clv_closing_odds';
    const clvPctSelect = hasClvLedger
      ? 'clv.clv_pct AS clv_pct'
      : 'NULL AS clv_pct';
    const clvRecordedAtSelect = hasClvLedger
      ? 'clv.recorded_at AS clv_recorded_at'
      : 'NULL AS clv_recorded_at';
    const clvClosedAtSelect = hasClvLedger
      ? 'clv.closed_at AS clv_closed_at'
      : 'NULL AS clv_closed_at';
    const clvJoin = hasClvLedger
      ? 'LEFT JOIN clv_ledger clv ON clv.card_id = cr.card_id'
      : '';

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
    const includeOrphaned = false;
    const dedupe = parseBooleanLikeParam(searchParams.get('dedupe'), true);

    // Build filter SQL fragments
    const sportFilter = buildSportFilter(
      sport,
      'COALESCE(cdl.sport, cr.sport)',
    );

    const categoryFilter = buildCardCategoryFilter(cardCategory, 'cr');
    const confidenceExpr = `COALESCE(CAST(json_extract(cp.payload_data, '$.confidence_pct') AS REAL), CAST(json_extract(cp.payload_data, '$.confidence') AS REAL) * 100.0)`;
    const confidenceFilter =
      minConfidence !== null ? `AND ${confidenceExpr} >= ?` : '';
    const confidenceParams = minConfidence !== null ? [minConfidence] : [];

    const marketFilter = market ? `AND LOWER(cr.recommended_bet_type) = ?` : '';
    const marketParams = market ? [market] : [];

    const filteredCteSql = `
      WITH display_log_ranked AS (
        SELECT
          cdl.id,
          cdl.pick_id,
          cdl.game_id,
          cdl.sport,
          cdl.displayed_at,
          cdl.api_endpoint,
          ROW_NUMBER() OVER (
            PARTITION BY cdl.pick_id
            ORDER BY
              datetime(COALESCE(cdl.displayed_at, '1970-01-01T00:00:00Z')) DESC,
              cdl.id DESC
          ) AS rn
        FROM card_display_log cdl
      ),
      display_log_latest AS (
        SELECT
          id,
          pick_id,
          game_id,
          sport,
          displayed_at,
          api_endpoint
        FROM display_log_ranked
        WHERE rn = 1
      ),
      filtered AS (
        SELECT
          cr.id,
          cr.game_id,
          cr.card_type,
          cdl.id AS display_log_id,
          cdl.pick_id AS pick_id,
          cdl.displayed_at AS displayed_at,
          cr.recommended_bet_type,
          ${marketKeySelect},
          ${marketTypeSelect},
          ${selectionSelect},
          ${lineSelect},
          ${lockedPriceSelect},
          CASE
            WHEN json_extract(cr.metadata, '$.market_period_token') IS NOT NULL
              THEN json_extract(cr.metadata, '$.market_period_token')
            WHEN COALESCE(${marketKeyValueExpr}, '') LIKE '%:1P:%'
              OR UPPER(COALESCE(json_extract(cp.payload_data, '$.period'), '')) IN ('1P', 'P1', 'FIRST_PERIOD', '1ST_PERIOD')
              OR UPPER(COALESCE(json_extract(cp.payload_data, '$.play.period'), '')) IN ('1P', 'P1', 'FIRST_PERIOD', '1ST_PERIOD')
              OR UPPER(COALESCE(cr.card_type, '')) LIKE '%1P%'
            THEN '1P'
            ELSE 'FULL_GAME'
          END AS market_period_token,
          LOWER(COALESCE(json_extract(cp.payload_data, '$.play.prop_type'), json_extract(cp.payload_data, '$.prop_type'), '')) AS prop_type_token,
          COALESCE(
            CAST(json_extract(cp.payload_data, '$.play.player_id') AS TEXT),
            LOWER(COALESCE(json_extract(cp.payload_data, '$.play.player_name'), json_extract(cp.payload_data, '$.player_name'), '')),
            ''
          ) AS prop_player_token,
          cr.settled_at,
          ${confidenceExpr} AS confidence_pct
        FROM card_results cr
        INNER JOIN display_log_latest cdl ON cr.card_id = cdl.pick_id
        LEFT JOIN card_payloads cp ON cr.card_id = cp.id
        WHERE cr.status = 'settled'
          ${sportFilter.sql}
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
              PARTITION BY
                game_id,
                COALESCE(recommended_bet_type, ''),
                COALESCE(market_type, ''),
                COALESCE(selection, ''),
                COALESCE(market_period_token, 'FULL_GAME'),
                COALESCE(prop_type_token, ''),
                COALESCE(prop_player_token, '')
              ORDER BY
                COALESCE(confidence_pct, -1.0) DESC,
                datetime(COALESCE(displayed_at, settled_at, '1970-01-01T00:00:00Z')) DESC,
                COALESCE(display_log_id, 0) DESC,
                pick_id DESC,
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
      ...sportFilter.params,
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

    const totalSettledSportFilter = buildSportFilter(sport, 'cr.sport');
    const totalSettledRow = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM card_results cr
        WHERE cr.status = 'settled'
          ${totalSettledSportFilter.sql}
      `,
      )
      .get(...totalSettledSportFilter.params) as { count: number } | null;
    const displayedSettledSportFilter = buildSportFilter(
      sport,
      'COALESCE(cdl.sport, cr.sport)',
    );
    const displayedSettledRow = db
      .prepare(
        `
        SELECT COUNT(DISTINCT cr.id) AS count
        FROM card_results cr
        INNER JOIN card_display_log cdl ON cr.card_id = cdl.pick_id
        WHERE cr.status = 'settled'
          ${displayedSettledSportFilter.sql}
      `,
      )
      .get(...displayedSettledSportFilter.params) as { count: number } | null;
    const totalSettled = Number(totalSettledRow?.count || 0);
    const withPayloadSettled = Number(displayedSettledRow?.count || 0);
    const orphanedSettled = totalSettled - withPayloadSettled;
    const displayedFinalSportFilter = buildSportFilter(
      sport,
      'COALESCE(cdl.sport, gr.sport)',
    );
    const displayedFinalRow = db
      .prepare(
        `
        SELECT COUNT(DISTINCT cdl.pick_id) AS count
        FROM card_display_log cdl
        INNER JOIN game_results gr ON gr.game_id = cdl.game_id
        WHERE gr.status = 'final'
          ${displayedFinalSportFilter.sql}
      `,
      )
      .get(...displayedFinalSportFilter.params) as { count: number } | null;
    const settledFinalDisplayedSportFilter = buildSportFilter(
      sport,
      'COALESCE(cdl.sport, cr.sport, gr.sport)',
    );
    const settledFinalDisplayedRow = db
      .prepare(
        `
        SELECT COUNT(DISTINCT cdl.pick_id) AS count
        FROM card_display_log cdl
        INNER JOIN card_results cr ON cr.card_id = cdl.pick_id
        INNER JOIN game_results gr ON gr.game_id = cdl.game_id
        WHERE gr.status = 'final'
          AND cr.status = 'settled'
          ${settledFinalDisplayedSportFilter.sql}
      `,
      )
      .get(...settledFinalDisplayedSportFilter.params) as {
        count: number;
      } | null;
    const displayedFinal = Number(displayedFinalRow?.count || 0);
    const settledFinalDisplayed = Number(settledFinalDisplayedRow?.count || 0);
    const missingFinalDisplayed = Math.max(
      0,
      displayedFinal - settledFinalDisplayed,
    );

    const placeholders = dedupedIdRows.map(() => '?').join(',');
    const clvByCardCte = hasClvLedger
      ? `
        WITH clv_by_card AS (
          SELECT card_id, AVG(clv_pct) AS clv_pct
          FROM clv_ledger
          WHERE clv_pct IS NOT NULL
          GROUP BY card_id
        )
      `
      : `
        WITH clv_by_card AS (
          SELECT NULL AS card_id, NULL AS clv_pct
          WHERE 0
        )
      `;

    if (dedupedIdRows.length === 0) {
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
              totalPnlUnits: null,
              winRate: 0,
              avgPnl: null,
              avgClvPct: null,
            },
            segments: [],
            segmentFamilies: DECISION_SEGMENTS.map((segment) => ({
              segmentId: segment.id,
              segmentLabel: segment.label,
              settledCards: 0,
            })),
            projectionSummaries: [],
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
              displayedFinal,
              settledFinalDisplayed,
              missingFinalDisplayed,
              filteredCount,
              returnedCount: 0,
              includeOrphaned,
              dedupe,
            },
          },
        },
        { headers: { 'Content-Type': 'application/json' } },
      );
      return addRateLimitHeaders(
        addSettlementCoverageHeader(
          response,
          settledFinalDisplayed,
          displayedFinal,
        ),
        request,
      );
    }

    const ids = dedupedIdRows.map((r) => r.id);

    const actionableSourceStmt = db.prepare(
      `
      ${clvByCardCte}
      SELECT
        cr.id,
        cr.sport,
        cr.card_type,
        cr.recommended_bet_type,
        cr.result,
        cr.pnl_units,
        cp.payload_data,
        gr.metadata AS game_result_metadata,
        clv_by_card.clv_pct
      FROM card_results cr
      LEFT JOIN card_payloads cp ON cp.id = cr.card_id
      LEFT JOIN game_results gr ON gr.game_id = cr.game_id
      LEFT JOIN clv_by_card ON clv_by_card.card_id = cr.card_id
      WHERE cr.id IN (${placeholders})
    `,
    );

    // Projection card types (mlb-f5, mlb-pitcher-k, nhl-player-shots, etc.) are
    // never shown in the betting UI so they never appear in card_display_log.
    // They also are not in status='settled' in card_results (settled as pending/error).
    // Fetch them directly from card_results joined on completed game_results so
    // buildProjectionSummaries can track model accuracy independently of the
    // betting ledger path.
    const projTrackingPlaceholders = PROJECTION_TRACKING_CARD_TYPES.map(() => '?').join(',');
    const projTrackingSportFilter = buildSportFilter(sport, 'cr.sport');
    const projectionActualSelect = (
      db.prepare('PRAGMA table_info(card_payloads)').all() as Array<{ name: string }>
    ).some((row) => row.name === 'actual_result')
      ? 'cp.actual_result AS actual_result'
      : 'NULL AS actual_result';
    const projectionTrackingStmt = db.prepare(
      `
      SELECT
        cr.sport,
        cr.card_type,
        cp.payload_data,
        ${projectionActualSelect},
        gr.metadata AS game_result_metadata
      FROM card_results cr
      LEFT JOIN card_payloads cp ON cp.id = cr.card_id
      INNER JOIN game_results gr ON gr.game_id = cr.game_id
      WHERE cr.card_type IN (${projTrackingPlaceholders})
        AND gr.status = 'final'
        ${projTrackingSportFilter.sql}
    `,
    );

    const projectionSummaries = buildProjectionSummaries(
      (function* () {
        for (const row of projectionTrackingStmt.iterate(
          ...PROJECTION_TRACKING_CARD_TYPES,
          ...projTrackingSportFilter.params,
        ) as Iterable<{
          sport: string;
          card_type: string;
          payload_data: string;
          actual_result: string | null;
          game_result_metadata: string;
        }>) {
          yield {
            sport: row.sport,
            cardType: row.card_type,
            payload: safeJsonParse(row.payload_data)
              .data as Record<string, unknown> | null,
            actualResult: row.actual_result,
            gameResultMetadata: safeJsonParse(row.game_result_metadata)
              .data as Record<string, unknown> | null,
          };
        }
      })(),
    );
    const oddsBackedLedgerIds: string[] = [];

    const segmentMap = new Map<
      string,
      {
        sport: string;
        cardType: string;
        cardFamily: string;
        modelFamily: string;
        modelVersion: string;
        cardCategory: string;
        recommendedBetType: string;
        settledCards: number;
        wins: number;
        losses: number;
        pushes: number;
        pnlSum: number;
        hasPnl: boolean;
        segmentId: DecisionSegmentId;
        segmentLabel: string;
        decisionTier: 'PLAY' | 'LEAN';
      }
    >();

    let wins = 0;
    let losses = 0;
    let pushes = 0;
    let settledCards = 0;
    let totalCards = 0;
    let totalPnlSum = 0;
    let hasTotalPnl = false;
    let totalClvPctSum = 0;
    let totalClvPctCount = 0;

    for (const row of actionableSourceStmt.iterate(
      ...ids,
    ) as Iterable<ActionableSourceRow>) {
      if (!shouldTrackInResults(row.card_type)) {
        continue;
      }

      const parsed = safeJsonParse(row.payload_data);
      const payload = parsed.data as Record<string, unknown> | null;
      if (deriveResultCardMode(payload, row.card_type) !== 'ODDS_BACKED') {
        continue;
      }

      oddsBackedLedgerIds.push(row.id);

      const decisionTier = resolveDecisionTier(payload);
      if (decisionTier !== 'PLAY' && decisionTier !== 'LEAN') {
        continue;
      }

      const decisionSegment = deriveDecisionSegment(decisionTier);
      const cardFamily = deriveCardFamily(row.sport, row.card_type);
      const modelFamily = deriveModelFamily(row.sport, row.card_type);
      const modelVersion = deriveModelVersion(row.sport, row.card_type);

      totalCards += 1;
      settledCards += 1;
      if (row.result === 'win') wins += 1;
      else if (row.result === 'loss') losses += 1;
      else if (row.result === 'push') pushes += 1;
      if (typeof row.pnl_units === 'number' && Number.isFinite(row.pnl_units)) {
        totalPnlSum += row.pnl_units;
        hasTotalPnl = true;
      }
      if (typeof row.clv_pct === 'number' && Number.isFinite(row.clv_pct)) {
        totalClvPctSum += row.clv_pct;
        totalClvPctCount += 1;
      }

      const cardCategory = deriveCardCategoryFromType(row.card_type);
      const recommendedBetType = row.recommended_bet_type || 'unknown';
      // Key on cardFamily (canonical market bucket) instead of raw card_type.
      // This merges driver types (nhl-pace-totals) and call types (nhl-totals-call)
      // into a single NHL_TOTAL row rather than producing duplicate table rows.
      const key = [
        decisionSegment.id,
        row.sport,
        cardFamily,
        recommendedBetType,
      ].join('||');
      const existing = segmentMap.get(key);
      if (!existing) {
        segmentMap.set(key, {
          sport: row.sport,
          cardType: row.card_type,
          cardFamily,
          modelFamily,
          modelVersion,
          cardCategory,
          recommendedBetType,
          settledCards: 1,
          wins: row.result === 'win' ? 1 : 0,
          losses: row.result === 'loss' ? 1 : 0,
          pushes: row.result === 'push' ? 1 : 0,
          pnlSum:
            typeof row.pnl_units === 'number' && Number.isFinite(row.pnl_units)
              ? row.pnl_units
              : 0,
          hasPnl:
            typeof row.pnl_units === 'number' && Number.isFinite(row.pnl_units),
          segmentId: decisionSegment.id,
          segmentLabel: decisionSegment.label,
          decisionTier,
        });
      } else {
        existing.settledCards += 1;
        if (row.result === 'win') existing.wins += 1;
        else if (row.result === 'loss') existing.losses += 1;
        else if (row.result === 'push') existing.pushes += 1;
        if (typeof row.pnl_units === 'number' && Number.isFinite(row.pnl_units)) {
          existing.pnlSum += row.pnl_units;
          existing.hasPnl = true;
        }
      }
    }

    const segmentRows = Array.from(segmentMap.values())
      .map((row) => ({
        sport: row.sport,
        cardType: row.cardType,
        cardFamily: row.cardFamily,
        modelFamily: row.modelFamily,
        modelVersion: row.modelVersion,
        cardCategory: row.cardCategory,
        recommendedBetType: row.recommendedBetType,
        settledCards: row.settledCards,
        wins: row.wins,
        losses: row.losses,
        pushes: row.pushes,
        totalPnlUnits: row.hasPnl ? row.pnlSum : null,
        segmentId: row.segmentId,
        segmentLabel: row.segmentLabel,
        decisionTier: row.decisionTier,
      }))
      .sort((a, b) => {
        if (a.segmentId !== b.segmentId) {
          return a.segmentId.localeCompare(b.segmentId);
        }
        if (a.sport !== b.sport) return a.sport.localeCompare(b.sport);
        if (a.cardFamily !== b.cardFamily) return a.cardFamily.localeCompare(b.cardFamily);
        return a.recommendedBetType.localeCompare(b.recommendedBetType);
      });

    const segmentFamilies = DECISION_SEGMENTS.map((segment) => ({
      segmentId: segment.id,
      segmentLabel: segment.label,
      settledCards: segmentRows
        .filter((row) => row.segmentId === segment.id)
        .reduce((sum, row) => sum + row.settledCards, 0),
    }));

    const totalPnlUnits = hasTotalPnl ? totalPnlSum : null;
    const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;
    const avgPnl =
      totalPnlUnits !== null && settledCards > 0
        ? totalPnlUnits / settledCards
        : null;
    const avgClvPct =
      totalClvPctCount > 0 ? totalClvPctSum / totalClvPctCount : null;

    const ledger = oddsBackedLedgerIds.length
      ? (db
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
        g.game_time_utc,
        cdl.displayed_at,
        cdl.api_endpoint,
        cp.id AS payload_id,
        cdl.displayed_at AS created_at,
        cp.payload_data,
        g.home_team AS game_home_team,
        g.away_team AS game_away_team,
        CASE
          WHEN json_extract(cr.metadata, '$.market_period_token') IS NOT NULL
            THEN json_extract(cr.metadata, '$.market_period_token')
          WHEN COALESCE(${marketKeyValueExpr}, '') LIKE '%:1P:%'
            OR UPPER(COALESCE(json_extract(cp.payload_data, '$.period'), '')) IN ('1P', 'P1', 'FIRST_PERIOD', '1ST_PERIOD')
            OR UPPER(COALESCE(json_extract(cp.payload_data, '$.play.period'), '')) IN ('1P', 'P1', 'FIRST_PERIOD', '1ST_PERIOD')
            OR UPPER(COALESCE(cr.card_type, '')) LIKE '%1P%'
          THEN '1P'
          ELSE 'FULL_GAME'
        END AS market_period_token,
        ${clvOddsAtPickSelect},
        ${clvClosingOddsSelect},
        ${clvPctSelect},
        ${clvRecordedAtSelect},
        ${clvClosedAtSelect}
      FROM card_results cr
      INNER JOIN (
        SELECT id, pick_id, displayed_at, api_endpoint
        FROM (
          SELECT
            id,
            pick_id,
            displayed_at,
            api_endpoint,
            ROW_NUMBER() OVER (
              PARTITION BY pick_id
              ORDER BY
                datetime(COALESCE(displayed_at, '1970-01-01T00:00:00Z')) DESC,
                id DESC
            ) AS rn
          FROM card_display_log
        ) ranked_display
        WHERE rn = 1
      ) cdl ON cr.card_id = cdl.pick_id
      LEFT JOIN card_payloads cp ON cr.card_id = cp.id
      LEFT JOIN games g ON g.game_id = cr.game_id
      ${clvJoin}
      WHERE cr.id IN (${oddsBackedLedgerIds.map(() => '?').join(',')})
      ORDER BY cdl.displayed_at DESC
      LIMIT ${limit}
    `,
          )
          .all(...oddsBackedLedgerIds) as LedgerRow[])
      : [];

    const ledgerRows = ledger.flatMap((row) => {
      if (!shouldTrackInResults(row.card_type)) {
        return [];
      }

      const parsed = safeJsonParse(row.payload_data);
      const payload = parsed.data as Record<string, unknown> | null;
      if (deriveResultCardMode(payload, row.card_type) !== 'ODDS_BACKED') {
        return [];
      }

      const cardFamily = deriveCardFamily(row.sport, row.card_type);
      const modelFamily = deriveModelFamily(row.sport, row.card_type);

      const tier =
        payload && typeof payload.tier === 'string' ? payload.tier : null;
      const decisionTier = resolveDecisionTier(payload);
      const decisionLabel =
        decisionTier === 'PLAY'
          ? 'PLAY'
          : decisionTier === 'LEAN'
            ? 'SLIGHT EDGE'
            : null;
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

      // WI-0383: Extract 1P and full-game projection totals for NHL cards
      let projection1p: number | null = null;
      let projectionTotal: number | null = null;
      if (row.sport === 'NHL' && payload) {
        const model = payload.model as Record<string, unknown> | null | undefined;
        const fp = payload.first_period_model as Record<string, unknown> | null | undefined;
        projectionTotal =
          typeof model?.expectedTotal === 'number' ? (model.expectedTotal as number) : null;
        projection1p =
          typeof model?.expected1pTotal === 'number'
            ? (model.expected1pTotal as number)
            : typeof fp?.projection_final === 'number'
              ? (fp.projection_final as number)
              : null;
      }

      const clv =
        row.clv_recorded_at !== null ||
        row.clv_closed_at !== null ||
        row.clv_odds_at_pick !== null ||
        row.clv_closing_odds !== null ||
        row.clv_pct !== null
          ? {
              oddsAtPick: row.clv_odds_at_pick,
              closingOdds: row.clv_closing_odds,
              clvPct: row.clv_pct,
              recordedAt: row.clv_recorded_at,
              closedAt: row.clv_closed_at,
            }
          : null;

      return [
        {
          id: row.id,
          gameId: row.game_id,
          sport: row.sport,
          cardType: row.card_type,
          cardFamily,
          modelFamily,
          result: row.result,
          pnlUnits: row.pnl_units,
          settledAt: row.settled_at,
          gameTimeUtc: row.game_time_utc,
          createdAt: row.created_at,
          prediction,
          tier,
          decisionTier:
            decisionTier === 'PLAY' || decisionTier === 'LEAN'
              ? decisionTier
              : null,
          decisionLabel,
          market,
          marketType,
          selection,
          marketSelectionLabel,
          homeTeam,
          awayTeam,
          marketPeriodToken: row.market_period_token,
          line,
          marketKey,
          price: lockedPrice,
          confidencePct,
          payloadParseError: parsed.error,
          payloadMissing: parsed.missing || row.payload_id === null,
          projection1p,
          projectionTotal,
          clv,
        },
      ];
    });

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
            avgClvPct,
          },
          segments: segmentRows,
          segmentFamilies,
          projectionSummaries,
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
            displayedFinal,
            settledFinalDisplayed,
            missingFinalDisplayed,
            filteredCount,
            returnedCount: dedupedIdRows.length,
            includeOrphaned,
            dedupe,
          },
        },
      },
      { headers: { 'Content-Type': 'application/json' } },
    );
    return addRateLimitHeaders(
      addSettlementCoverageHeader(
        response,
        settledFinalDisplayed,
        displayedFinal,
      ),
      request,
    );
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
      closeReadOnlyInstance(db);
    }
  }
}
