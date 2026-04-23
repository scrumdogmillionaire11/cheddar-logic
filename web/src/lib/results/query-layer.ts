import type { getDatabaseReadOnly } from '@cheddar-logic/data';

export type ResultsDb = ReturnType<typeof getDatabaseReadOnly>;

export type ResultsRequestFilters = {
  limit: number;
  sport: string | null;
  cardCategory: string | null;
  minConfidence: number | null;
  market: string | null;
  includeOrphaned: false;
  dedupe: boolean;
  diagnosticsEnabled: boolean;
};

type SqlFilter = { sql: string; params: string[] };

export type ResultsSchemaInfo = {
  hasClvLedger: boolean;
  marketKeyValueExpr: string;
  marketKeySelect: string;
  marketTypeSelect: string;
  selectionSelect: string;
  lineSelect: string;
  lockedPriceSelect: string;
  clvOddsAtPickSelect: string;
  clvClosingOddsSelect: string;
  clvPctSelect: string;
  clvRecordedAtSelect: string;
  clvClosedAtSelect: string;
  clvJoin: string;
};

export type ActionableSourceRow = {
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

export type LedgerRow = {
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

/**
 * Scalar fields extracted from card_payloads.payload_data via json_extract() in SQL.
 * This avoids fetching the full JSON blob (avg ~8KB per row) into the Node.js process
 * and eliminates the JSON.parse() cost in buildProjectionSummaries (WI-1136 perf fix).
 */
export type ProjectionTrackingRow = {
  sport: string;
  card_type: string;
  actual_result: string | null;
  game_result_metadata: string | null;
  // Projection value candidates (COALESCE'd in SQL; first non-null wins)
  proj_value: number | null;
  // Direction signal
  direction_token: string | null;
  // Decision tier signals
  official_status: string | null;
  fallback_status: string | null;
  // Period token for 1P vs full-game distinction
  period_token: string | null;
  // Player identity (for player prop lookups in game_result_metadata)
  player_id: string | null;
  player_name: string | null;
  // Card family disambiguation
  canonical_market_key: string | null;
  prop_type: string | null;
};

export type ResultsQueryData = {
  actionableRows: ActionableSourceRow[];
  projectionTrackingRows: ProjectionTrackingRow[];
  ledgerRows: LedgerRow[];
  meta: {
    totalSettled: number;
    withPayloadSettled: number;
    orphanedSettled: number;
    displayedFinal: number;
    settledFinalDisplayed: number;
    missingFinalDisplayed: number;
    filteredCount: number | null;
    returnedCount: number;
  };
};

const ALLOWED_SPORTS = ['NHL', 'NBA', 'NCAAM', 'MLB', 'NFL'] as const;
const ALLOWED_CATEGORIES = ['driver', 'call'] as const;
const ALLOWED_MARKETS = ['moneyline', 'spread', 'total'] as const;
export const DEFAULT_EXCLUDED_SPORT = 'NCAAM';

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

function clampNumber(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
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

export function parseResultsRequestFilters(
  searchParams: URLSearchParams,
): ResultsRequestFilters {
  const rawSport = searchParams.get('sport');
  const sport =
    rawSport &&
    (ALLOWED_SPORTS as readonly string[]).includes(rawSport.toUpperCase())
      ? rawSport.toUpperCase()
      : null;

  const rawCategory = searchParams.get('card_category');
  const cardCategory =
    rawCategory &&
    (ALLOWED_CATEGORIES as readonly string[]).includes(
      rawCategory.toLowerCase(),
    )
      ? rawCategory.toLowerCase()
      : null;

  const rawConfidence = searchParams.get('min_confidence');
  const minConfidence =
    rawConfidence !== null
      ? Math.min(Math.max(Number.parseFloat(rawConfidence), 0), 100)
      : null;

  const rawMarket = searchParams.get('market');
  const market =
    rawMarket &&
    (ALLOWED_MARKETS as readonly string[]).includes(rawMarket.toLowerCase())
      ? rawMarket.toLowerCase()
      : null;

  return {
    limit: clampNumber(searchParams.get('limit'), 50, 1, 200),
    sport,
    cardCategory,
    minConfidence,
    market,
    includeOrphaned: false,
    dedupe: parseBooleanLikeParam(searchParams.get('dedupe'), true),
    diagnosticsEnabled: searchParams.has('_diag'),
  };
}

export function buildCardCategoryFilter(
  category: string | null,
  alias: string,
): SqlFilter {
  if (!category) return { sql: '', params: [] };

  if (category === 'driver') {
    const conditions = DRIVER_PATTERNS.map(
      () => `${alias}.card_type LIKE ?`,
    ).join(' OR ');
    return { sql: `AND (${conditions})`, params: DRIVER_PATTERNS };
  }

  const conditions = CALL_PATTERNS.map(
    () => `${alias}.card_type LIKE ?`,
  ).join(' OR ');
  return { sql: `AND (${conditions})`, params: CALL_PATTERNS };
}

export function buildSportFilter(
  sport: string | null,
  sportExpr: string,
): SqlFilter {
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

export function hasResultsReportingTables(db: ResultsDb): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='game_results'`,
      )
      .get(),
  );
}

function getResultsSchemaInfo(db: ResultsDb): ResultsSchemaInfo {
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

  return {
    hasClvLedger,
    marketKeyValueExpr: hasMarketKeyColumn ? 'cr.market_key' : 'NULL',
    marketKeySelect: hasMarketKeyColumn
      ? 'cr.market_key AS market_key'
      : 'NULL AS market_key',
    marketTypeSelect: hasMarketTypeColumn
      ? 'cr.market_type AS market_type'
      : 'NULL AS market_type',
    selectionSelect: hasSelectionColumn
      ? 'cr.selection AS selection'
      : 'NULL AS selection',
    lineSelect: hasLineColumn ? 'cr.line AS line' : 'NULL AS line',
    lockedPriceSelect: hasLockedPriceColumn
      ? 'cr.locked_price AS locked_price'
      : 'NULL AS locked_price',
    clvOddsAtPickSelect: hasClvLedger
      ? 'clv.odds_at_pick AS clv_odds_at_pick'
      : 'NULL AS clv_odds_at_pick',
    clvClosingOddsSelect: hasClvLedger
      ? 'clv.closing_odds AS clv_closing_odds'
      : 'NULL AS clv_closing_odds',
    clvPctSelect: hasClvLedger
      ? 'clv.clv_pct AS clv_pct'
      : 'NULL AS clv_pct',
    clvRecordedAtSelect: hasClvLedger
      ? 'clv.recorded_at AS clv_recorded_at'
      : 'NULL AS clv_recorded_at',
    clvClosedAtSelect: hasClvLedger
      ? 'clv.closed_at AS clv_closed_at'
      : 'NULL AS clv_closed_at',
    clvJoin: hasClvLedger
      ? 'LEFT JOIN clv_ledger clv ON clv.card_id = cr.card_id'
      : '',
  };
}

function buildFilteredResultsCte(
  filters: ResultsRequestFilters,
  schema: ResultsSchemaInfo,
): { sql: string; params: unknown[] } {
  const sportFilter = buildSportFilter(
    filters.sport,
    'COALESCE(cdl.sport, cr.sport)',
  );
  const categoryFilter = buildCardCategoryFilter(filters.cardCategory, 'cr');
  const confidenceExpr = `COALESCE(CAST(json_extract(cp.payload_data, '$.confidence_pct') AS REAL), CAST(json_extract(cp.payload_data, '$.confidence') AS REAL) * 100.0)`;
  const confidenceFilter =
    filters.minConfidence !== null ? `AND ${confidenceExpr} >= ?` : '';
  const confidenceParams =
    filters.minConfidence !== null ? [filters.minConfidence] : [];
  const marketFilter = filters.market
    ? `AND LOWER(cr.recommended_bet_type) = ?`
    : '';
  const marketParams = filters.market ? [filters.market] : [];

  return {
    sql: `
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
          ${schema.marketKeySelect},
          ${schema.marketTypeSelect},
          ${schema.selectionSelect},
          ${schema.lineSelect},
          ${schema.lockedPriceSelect},
          CASE
            WHEN json_extract(cr.metadata, '$.market_period_token') IS NOT NULL
              THEN json_extract(cr.metadata, '$.market_period_token')
            WHEN COALESCE(${schema.marketKeyValueExpr}, '') LIKE '%:1P:%'
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
    `,
    params: [
      ...sportFilter.params,
      ...categoryFilter.params,
      ...confidenceParams,
      ...marketParams,
    ],
  };
}

function buildDedupedIdsSql(
  filteredCteSql: string,
  dedupe: boolean,
): string {
  if (!dedupe) {
    return `
      ${filteredCteSql}
      SELECT id
      FROM filtered
    `;
  }

  return `
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
  `;
}

function countSettledRows(
  db: ResultsDb,
  filters: ResultsRequestFilters,
): {
  totalSettled: number;
  withPayloadSettled: number;
  orphanedSettled: number;
} {
  const totalSettledSportFilter = buildSportFilter(filters.sport, 'cr.sport');
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
    filters.sport,
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

  return {
    totalSettled,
    withPayloadSettled,
    orphanedSettled: totalSettled - withPayloadSettled,
  };
}

function countFinalDisplayRows(
  db: ResultsDb,
  filters: ResultsRequestFilters,
): {
  displayedFinal: number;
  settledFinalDisplayed: number;
  missingFinalDisplayed: number;
} {
  const displayedFinalSportFilter = buildSportFilter(
    filters.sport,
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
    filters.sport,
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

  return {
    displayedFinal,
    settledFinalDisplayed,
    missingFinalDisplayed: Math.max(0, displayedFinal - settledFinalDisplayed),
  };
}

function countFilteredRowsForDiagnostics(
  db: ResultsDb,
  filteredCteSql: string,
  params: unknown[],
): number {
  const filteredCountRow = db
    .prepare(
      `
      ${filteredCteSql}
      SELECT COUNT(*) AS count
      FROM filtered
    `,
    )
    .get(...params) as { count: number } | null;

  return Number(filteredCountRow?.count || 0);
}

function queryProjectionTrackingRows(
  db: ResultsDb,
  filters: ResultsRequestFilters,
  projectionTrackingCardTypes: readonly string[],
): ProjectionTrackingRow[] {
  const placeholders = projectionTrackingCardTypes.map(() => '?').join(',');
  if (!placeholders) return [];

  const projTrackingSportFilter = buildSportFilter(filters.sport, 'cr.sport');
  const projectionActualSelect = (
    db.prepare('PRAGMA table_info(card_payloads)').all() as Array<{
      name: string;
    }>
  ).some((row) => row.name === 'actual_result')
    ? 'cp.actual_result AS actual_result'
    : 'NULL AS actual_result';

  // WI-1136: Extract only scalar fields via json_extract() instead of fetching the full
  // payload_data blob. The old approach transferred ~79MB of JSON text into the Node.js
  // process (9927 rows × 7.9KB avg) and triggered JSON.parse() on all of them, causing
  // a 202MB heap spike per request — close to the 614MB production heap cap. With scalar
  // extraction, SQLite does the parsing and only the needed numeric/string values are
  // returned, reducing heap pressure to ~14MB for the same row set.
  return db
    .prepare(
      `
      SELECT
        cr.sport,
        cr.card_type,
        ${projectionActualSelect},
        gr.metadata AS game_result_metadata,
        CAST(COALESCE(
          json_extract(cp.payload_data, '$.numeric_projection'),
          json_extract(cp.payload_data, '$.projection.k_mean'),
          json_extract(cp.payload_data, '$.projection.total'),
          json_extract(cp.payload_data, '$.projection.projected_total'),
          json_extract(cp.payload_data, '$.decision.model_projection'),
          json_extract(cp.payload_data, '$.decision.projection'),
          json_extract(cp.payload_data, '$.model.expected1pTotal'),
          json_extract(cp.payload_data, '$.model.expectedTotal'),
          json_extract(cp.payload_data, '$.first_period_model.projection_final')
        ) AS REAL) AS proj_value,
        COALESCE(
          json_extract(cp.payload_data, '$.recommended_direction'),
          json_extract(cp.payload_data, '$.play.selection.side'),
          json_extract(cp.payload_data, '$.selection.side'),
          json_extract(cp.payload_data, '$.play.decision_v2.direction'),
          json_extract(cp.payload_data, '$.decision_v2.direction'),
          json_extract(cp.payload_data, '$.decision.direction'),
          json_extract(cp.payload_data, '$.prediction')
        ) AS direction_token,
        COALESCE(
          json_extract(cp.payload_data, '$.play.decision_v2.official_status'),
          json_extract(cp.payload_data, '$.decision_v2.official_status')
        ) AS official_status,
        COALESCE(
          json_extract(cp.payload_data, '$.decision.status'),
          json_extract(cp.payload_data, '$.status'),
          json_extract(cp.payload_data, '$.play.status'),
          json_extract(cp.payload_data, '$.action'),
          json_extract(cp.payload_data, '$.play.action'),
          json_extract(cp.payload_data, '$.decision.action')
        ) AS fallback_status,
        COALESCE(
          json_extract(cp.payload_data, '$.play.period'),
          json_extract(cp.payload_data, '$.period'),
          json_extract(cp.payload_data, '$.time_period')
        ) AS period_token,
        COALESCE(
          json_extract(cp.payload_data, '$.play.player_id'),
          json_extract(cp.payload_data, '$.player_id')
        ) AS player_id,
        COALESCE(
          json_extract(cp.payload_data, '$.play.player_name'),
          json_extract(cp.payload_data, '$.player_name')
        ) AS player_name,
        COALESCE(
          json_extract(cp.payload_data, '$.play.canonical_market_key'),
          json_extract(cp.payload_data, '$.canonical_market_key')
        ) AS canonical_market_key,
        COALESCE(
          json_extract(cp.payload_data, '$.play.prop_type'),
          json_extract(cp.payload_data, '$.prop_type')
        ) AS prop_type
      FROM card_results cr
      LEFT JOIN card_payloads cp ON cp.id = cr.card_id
      INNER JOIN game_results gr ON gr.game_id = cr.game_id
      WHERE cr.card_type IN (${placeholders})
        AND gr.status = 'final'
        ${projTrackingSportFilter.sql}
    `,
    )
    .all(...projectionTrackingCardTypes, ...projTrackingSportFilter.params) as ProjectionTrackingRow[];
}

function queryActionableRows(
  db: ResultsDb,
  ids: string[],
  schema: ResultsSchemaInfo,
): ActionableSourceRow[] {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const clvByCardCte = schema.hasClvLedger
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

  return db
    .prepare(
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
    )
    .all(...ids) as ActionableSourceRow[];
}

export function queryLedgerRowsForIds(
  db: ResultsDb,
  ids: string[],
  schema: ResultsSchemaInfo,
  limit: number,
): LedgerRow[] {
  if (ids.length === 0) return [];

  return db
    .prepare(
      `
      SELECT
        cr.id,
        cr.game_id,
        cr.sport,
        cr.card_type,
        cr.recommended_bet_type,
        ${schema.marketKeySelect},
        ${schema.marketTypeSelect},
        ${schema.selectionSelect},
        ${schema.lineSelect},
        ${schema.lockedPriceSelect},
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
          WHEN COALESCE(${schema.marketKeyValueExpr}, '') LIKE '%:1P:%'
            OR UPPER(COALESCE(json_extract(cp.payload_data, '$.period'), '')) IN ('1P', 'P1', 'FIRST_PERIOD', '1ST_PERIOD')
            OR UPPER(COALESCE(json_extract(cp.payload_data, '$.play.period'), '')) IN ('1P', 'P1', 'FIRST_PERIOD', '1ST_PERIOD')
            OR UPPER(COALESCE(cr.card_type, '')) LIKE '%1P%'
          THEN '1P'
          ELSE 'FULL_GAME'
        END AS market_period_token,
        ${schema.clvOddsAtPickSelect},
        ${schema.clvClosingOddsSelect},
        ${schema.clvPctSelect},
        ${schema.clvRecordedAtSelect},
        ${schema.clvClosedAtSelect}
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
      ${schema.clvJoin}
      WHERE cr.id IN (${ids.map(() => '?').join(',')})
      ORDER BY cdl.displayed_at DESC
      LIMIT ${limit}
    `,
    )
    .all(...ids) as LedgerRow[];
}

export function queryResultsReportingData(
  db: ResultsDb,
  filters: ResultsRequestFilters,
  projectionTrackingCardTypes: readonly string[],
): Omit<ResultsQueryData, 'ledgerRows'> & {
  schema: ResultsSchemaInfo;
  dedupedIds: string[];
} {
  const schema = getResultsSchemaInfo(db);
  const filtered = buildFilteredResultsCte(filters, schema);
  const dedupedIdRows = db
    .prepare(buildDedupedIdsSql(filtered.sql, filters.dedupe))
    .all(...filtered.params) as { id: string }[];
  const dedupedIds = dedupedIdRows.map((row) => row.id);
  const settled = countSettledRows(db, filters);
  const finalDisplay = countFinalDisplayRows(db, filters);
  const filteredCount = filters.diagnosticsEnabled
    ? countFilteredRowsForDiagnostics(db, filtered.sql, filtered.params)
    : null;

  return {
    schema,
    dedupedIds,
    actionableRows: queryActionableRows(db, dedupedIds, schema),
    projectionTrackingRows:
      dedupedIds.length > 0
        ? queryProjectionTrackingRows(db, filters, projectionTrackingCardTypes)
        : [],
    meta: {
      ...settled,
      ...finalDisplay,
      filteredCount,
      returnedCount: dedupedIds.length,
    },
  };
}
