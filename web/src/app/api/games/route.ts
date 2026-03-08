/**
 * GET /api/games
 *
 * Returns all upcoming games from the odds API, joined with the latest
 * odds snapshot per game, plus any active driver play calls from card_payloads.
 * Games with no card_payloads still appear.
 *
 * Query window:
 *   - Production default: datetime(game_time_utc) >= midnight today America/New_York
 *   - Dev override (optional): include recent past games via lookback window
 * Sort: game_time_utc ASC
 * Limit: 200
 *
 * Response:
 * {
 *   success: boolean,
 *   data: Array<{
 *     id: string,
 *     gameId: string,
 *     sport: string,
 *     homeTeam: string,
 *     awayTeam: string,
 *     gameTimeUtc: string,
 *     status: string,
 *     createdAt: string,
 *     odds: {
 *       h2hHome: number | null,
 *       h2hAway: number | null,
 *       total: number | null,
 *       spreadHome: number | null,
 *       spreadAway: number | null,
 *       spreadPriceHome: number | null,
 *       spreadPriceAway: number | null,
 *       totalPriceOver: number | null,
 *       totalPriceUnder: number | null,
 *       capturedAt: string | null,
 *     } | null,
 *     plays: Play[],
 *   }>,
 *   error?: string,
 * }
 */

import { NextResponse, NextRequest } from 'next/server';
import { getDatabaseReadOnly, closeReadOnlyInstance } from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  performSecurityChecks,
  addRateLimitHeaders,
} from '../../../lib/api-security';

const ENABLE_WELCOME_HOME =
  process.env.ENABLE_WELCOME_HOME === 'true' ||
  process.env.NEXT_PUBLIC_ENABLE_WELCOME_HOME === 'true';

const ENABLE_DEV_PAST_GAMES =
  process.env.ENABLE_DEV_PAST_GAMES === 'true' ||
  process.env.CHEDDAR_DEV_INCLUDE_PAST_GAMES === 'true';

const DEV_GAMES_LOOKBACK_HOURS = Number.parseInt(
  process.env.DEV_GAMES_LOOKBACK_HOURS ||
    process.env.CHEDDAR_DEV_GAMES_LOOKBACK_HOURS ||
    '24',
  10,
);

interface GameRow {
  id: string;
  game_id: string;
  sport: string;
  home_team: string;
  away_team: string;
  game_time_utc: string;
  status: string;
  created_at: string;
  h2h_home: number | null;
  h2h_away: number | null;
  total: number | null;
  spread_home: number | null;
  spread_away: number | null;
  spread_price_home: number | null;
  spread_price_away: number | null;
  total_price_over: number | null;
  total_price_under: number | null;
  odds_captured_at: string | null;
}

interface CardPayloadRow {
  id: string;
  game_id: string;
  card_type: string;
  card_title: string;
  payload_data: string;
}

interface Play {
  source_card_id?: string;
  cardType: string;
  cardTitle: string;
  prediction: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';
  confidence: number;
  tier: 'SUPER' | 'BEST' | 'WATCH' | null;
  reasoning: string;
  evPassed: boolean;
  driverKey: string;
  projectedTotal: number | null;
  edge: number | null;
  model_prob?: number | null;
  status?: 'FIRE' | 'WATCH' | 'PASS';
  kind?: 'PLAY' | 'EVIDENCE';
  market_type?:
    | 'MONEYLINE'
    | 'SPREAD'
    | 'TOTAL'
    | 'PUCKLINE'
    | 'TEAM_TOTAL'
    | 'PROP'
    | 'INFO';
  selection?: { side: string; team?: string };
  line?: number;
  price?: number;
  reason_codes?: string[];
  tags?: string[];
  consistency?: {
    total_bias?:
      | 'OK'
      | 'INSUFFICIENT_DATA'
      | 'CONFLICTING_SIGNALS'
      | 'VOLATILE_ENV'
      | 'UNKNOWN';
  };
  // Canonical decision fields
  classification?: 'BASE' | 'LEAN' | 'PASS';
  action?: 'FIRE' | 'HOLD' | 'PASS';
  pass_reason_code?: string | null;
  // Prop-specific fields
  run_id?: string;
  created_at?: string;
  player_id?: string;
  player_name?: string;
  team_abbr?: string;
  game_id?: string;
  mu?: number | null;
  suggested_line?: number | null;
  threshold?: number | null;
  is_trending?: boolean;
  role_gate_pass?: boolean;
  data_quality?: string | null;
  l5_sog?: number[] | null;
  l5_mean?: number | null;
  // Legacy repair fields
  repair_applied?: boolean;
  repair_rule_id?: string;
}

type MarketType = NonNullable<Play['market_type']>;

const REPAIR_ALLOWLIST = new Set([
  'nba-totals-call',
  'nba-spread-call',
  'nhl-totals-call',
  'nhl-spread-call',
  'nba-total-projection',
  'nhl-pace-totals',
  'nhl-pace-1p',
  'nhl-rest-advantage',
  'ncaam-base-projection',
  'ncaam-rest-advantage',
  'ncaam-matchup-style',
  'nba-base-projection',
  'nba-rest-advantage',
  'nba-matchup-style',
]);

function inferMarketCandidatesFromTitle(title: string): MarketType[] {
  const titleLower = title.toLowerCase();
  const candidates = new Set<MarketType>();
  if (
    titleLower.includes('total') ||
    titleLower.includes('o/u') ||
    titleLower.includes('over') ||
    titleLower.includes('under')
  ) {
    candidates.add('TOTAL');
  }
  if (titleLower.includes('spread') || titleLower.includes('line')) {
    candidates.add('SPREAD');
  }
  if (
    titleLower.includes('moneyline') ||
    titleLower.includes('ml') ||
    titleLower.includes('projection') ||
    titleLower.includes('rest') ||
    titleLower.includes('matchup')
  ) {
    candidates.add('MONEYLINE');
  }
  return Array.from(candidates);
}

function hasMinimumViability(play: Play, marketType: MarketType): boolean {
  const side = play.selection?.side;
  const hasPrice =
    typeof play.price === 'number' && Number.isFinite(play.price);
  if (marketType === 'TOTAL') {
    // Price is sourced from odds snapshot at display time — only require side + line.
    return (
      (side === 'OVER' || side === 'UNDER') &&
      typeof play.line === 'number'
    );
  }
  if (marketType === 'SPREAD') {
    return (
      (side === 'HOME' || side === 'AWAY') &&
      typeof play.line === 'number' &&
      hasPrice
    );
  }
  if (marketType === 'MONEYLINE') {
    return (side === 'HOME' || side === 'AWAY') && hasPrice;
  }
  return true;
}

function normalizeMarketType(value: unknown): Play['market_type'] | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();

  if (
    upper === 'MONEYLINE' ||
    upper === 'SPREAD' ||
    upper === 'TOTAL' ||
    upper === 'PUCKLINE' ||
    upper === 'TEAM_TOTAL' ||
    upper === 'PROP' ||
    upper === 'INFO'
  ) {
    return upper as Play['market_type'];
  }

  if (upper === 'PUCK_LINE') return 'PUCKLINE';
  if (upper === 'TEAMTOTAL') return 'TEAM_TOTAL';
  return undefined;
}

function normalizeTier(value: unknown): Play['tier'] {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  if (upper === 'SUPER') return 'SUPER';
  if (upper === 'BEST' || upper === 'HOT') return 'BEST';
  if (upper === 'WATCH') return 'WATCH';
  return null;
}

function normalizeAction(value: unknown): Play['action'] | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (upper === 'FIRE' || upper === 'HOLD' || upper === 'PASS') {
    return upper as Play['action'];
  }
  if (upper === 'WATCH') return 'HOLD';
  return undefined;
}

function normalizeStatus(value: unknown): Play['status'] | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (upper === 'FIRE' || upper === 'WATCH' || upper === 'PASS') {
    return upper as Play['status'];
  }
  if (upper === 'HOLD') return 'WATCH';
  return undefined;
}

function normalizeClassification(
  value: unknown,
): Play['classification'] | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (upper === 'BASE' || upper === 'LEAN' || upper === 'PASS') {
    return upper as Play['classification'];
  }
  return undefined;
}

function actionFromClassification(
  classification?: Play['classification'],
): Play['action'] | undefined {
  if (classification === 'BASE') return 'FIRE';
  if (classification === 'LEAN') return 'HOLD';
  if (classification === 'PASS') return 'PASS';
  return undefined;
}

function classificationFromAction(
  action?: Play['action'],
): Play['classification'] | undefined {
  if (action === 'FIRE') return 'BASE';
  if (action === 'HOLD') return 'LEAN';
  if (action === 'PASS') return 'PASS';
  return undefined;
}

function statusFromAction(action?: Play['action']): Play['status'] | undefined {
  if (action === 'FIRE') return 'FIRE';
  if (action === 'HOLD') return 'WATCH';
  if (action === 'PASS') return 'PASS';
  return undefined;
}

function normalizeSelectionSide(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (
    upper === 'HOME' ||
    upper === 'AWAY' ||
    upper === 'OVER' ||
    upper === 'UNDER' ||
    upper === 'FAV' ||
    upper === 'DOG' ||
    upper === 'NONE' ||
    upper === 'NEUTRAL'
  ) {
    return upper;
  }
  return undefined;
}

function normalizePrediction(value: unknown): Play['prediction'] | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (
    upper === 'HOME' ||
    upper === 'AWAY' ||
    upper === 'OVER' ||
    upper === 'UNDER' ||
    upper === 'NEUTRAL'
  ) {
    return upper as Play['prediction'];
  }
  if (upper.includes(' OVER ')) return 'OVER';
  if (upper.includes(' UNDER ')) return 'UNDER';
  return undefined;
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function impliedProbFromAmericanOdds(rawOdds: unknown): number | undefined {
  if (typeof rawOdds !== 'number' || !Number.isFinite(rawOdds) || rawOdds === 0)
    return undefined;
  if (rawOdds < 0) return -rawOdds / (-rawOdds + 100);
  return 100 / (rawOdds + 100);
}

function normalizeNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.filter(
    (item) => typeof item === 'number' && Number.isFinite(item),
  ) as number[];
  return numbers.length > 0 ? numbers : undefined;
}

function normalizeConfidencePct(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) return Number((value * 100).toFixed(2));
  return value;
}

function getActiveRunIds(db: ReturnType<typeof getDatabaseReadOnly>): string[] {
  // Prefer per-sport rows (added by migration 021); fall back to singleton
  try {
    const successRows = db
      .prepare(
        `SELECT rs.current_run_id
         FROM run_state rs
         WHERE id != 'singleton'
           AND rs.current_run_id IS NOT NULL
           AND TRIM(rs.current_run_id) != ''
           AND EXISTS (
             SELECT 1
             FROM job_runs jr
             WHERE jr.id = rs.current_run_id
               AND LOWER(jr.status) = 'success'
           )
         ORDER BY datetime(rs.updated_at) DESC, rs.id ASC`,
      )
      .all() as Array<{ current_run_id: string }>;
    if (successRows.length > 0) {
      return [...new Set(successRows.map((r) => r.current_run_id))];
    }

    const sportRows = db
      .prepare(
        `SELECT current_run_id
         FROM run_state
         WHERE id != 'singleton'
           AND current_run_id IS NOT NULL
           AND TRIM(current_run_id) != ''
         ORDER BY datetime(updated_at) DESC, id ASC`,
      )
      .all() as Array<{ current_run_id: string }>;
    if (sportRows.length > 0) {
      return [...new Set(sportRows.map((r) => r.current_run_id))];
    }
  } catch {
    // fall through to singleton
  }
  try {
    const row = db
      .prepare(`SELECT current_run_id FROM run_state WHERE id = 'singleton' LIMIT 1`)
      .get() as { current_run_id?: string | null } | undefined;
    return row?.current_run_id ? [row.current_run_id] : [];
  } catch {
    return [];
  }
}

function getRunStatus(
  db: ReturnType<typeof getDatabaseReadOnly>,
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

function extractShotsFromRecentGames(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const shots = value
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      const row = item as Record<string, unknown>;
      const direct = row.shots;
      if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
      if (typeof direct === 'string') {
        const parsed = Number(direct);
        if (Number.isFinite(parsed)) return parsed;
      }
      return undefined;
    })
    .filter(
      (num): num is number => typeof num === 'number' && Number.isFinite(num),
    );

  return shots.length > 0 ? shots : undefined;
}

export async function GET(request: NextRequest) {
  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;
  try {
    // Security checks: rate limiting, input validation
    const securityCheck = performSecurityChecks(request, '/api/games');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    await ensureDbReady();

    // AUTH DISABLED: Commenting out auth walls to allow public access
    // const access = requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD);
    // if (!access.ok) {
    //   return NextResponse.json(
    //     { success: false, error: access.error },
    //     { status: access.status }
    //   );
    // }

    db = getDatabaseReadOnly();
    const activeRunIds = getActiveRunIds(db);
    const currentRunId = activeRunIds[0] ?? null;
    const runStatus = getRunStatus(db, currentRunId);

    // Check if database is empty or uninitialized
    const tableCheckStmt = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='games'`,
    );
    const hasGamesTable = tableCheckStmt.get();

    if (!hasGamesTable) {
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

    // Compute midnight America/New_York as a UTC string for the SQL param.
    // en-CA locale gives YYYY-MM-DD; shortOffset gives "GMT-5" / "GMT-4" (DST-aware).
    const now = new Date();
    const etDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
    }).format(now); // e.g. "2026-02-28"
    const tzPart = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'shortOffset',
    })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')!.value; // e.g. "GMT-5"
    const offsetHours = parseInt(tzPart.replace('GMT', '') || '-5', 10);
    const sign = offsetHours < 0 ? '-' : '+';
    const absHours = Math.abs(offsetHours).toString().padStart(2, '0');
    const localMidnight = new Date(
      `${etDateStr}T00:00:00${sign}${absHours}:00`,
    );
    // Truncate to seconds — SQLite datetime() strips sub-second precision, so
    // "05:00:00.000" would be > "05:00:00" and exclude games at exactly midnight.
    const todayUtc = localMidnight
      .toISOString()
      .substring(0, 19)
      .replace('T', ' ');

    const isNonProd = process.env.NODE_ENV !== 'production';
    const shouldUseDevLookback =
      isNonProd &&
      ENABLE_DEV_PAST_GAMES &&
      Number.isFinite(DEV_GAMES_LOOKBACK_HOURS) &&
      DEV_GAMES_LOOKBACK_HOURS > 0;

    const lookbackUtc = shouldUseDevLookback
      ? new Date(now.getTime() - DEV_GAMES_LOOKBACK_HOURS * 60 * 60 * 1000)
          .toISOString()
          .substring(0, 19)
          .replace('T', ' ')
      : null;

    const gamesStartUtc = lookbackUtc ?? todayUtc;

    const sql = `
      WITH latest_odds AS (
        SELECT
          id, game_id, sport, captured_at,
          h2h_home, h2h_away, total,
          spread_home, spread_away,
          spread_price_home, spread_price_away,
          total_price_over, total_price_under,
          moneyline_home, moneyline_away,
          ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY captured_at DESC) AS rn
        FROM odds_snapshots
      )
      SELECT
        g.id,
        g.game_id,
        g.sport,
        g.home_team,
        g.away_team,
        g.game_time_utc,
        g.status,
        g.created_at,
        o.h2h_home,
        o.h2h_away,
        o.total,
        o.spread_home,
        o.spread_away,
        o.spread_price_home,
        o.spread_price_away,
        o.total_price_over,
        o.total_price_under,
        o.captured_at AS odds_captured_at
      FROM games g
      INNER JOIN latest_odds o ON o.game_id = g.game_id AND o.rn = 1
      WHERE datetime(g.game_time_utc) >= ?
      ORDER BY g.game_time_utc ASC
      LIMIT 200
    `;

    const stmt = db.prepare(sql);
    let rows = stmt.all(gamesStartUtc) as GameRow[];

    if (isNonProd && rows.length === 0 && !shouldUseDevLookback) {
      const fallbackLookbackHours = Number(process.env.DEV_GAMES_FALLBACK_HOURS || 72);
      if (Number.isFinite(fallbackLookbackHours) && fallbackLookbackHours > 0) {
        const fallbackStartUtc = new Date(
          now.getTime() - fallbackLookbackHours * 60 * 60 * 1000,
        )
          .toISOString()
          .substring(0, 19)
          .replace('T', ' ');
        rows = stmt.all(fallbackStartUtc) as GameRow[];
      }
    }

    // Collect all game IDs for the card_payloads query
    const gameIds = rows.map((r) => r.game_id);

    // Build a plays map keyed by canonical game_id
    const playsMap = new Map<string, Play[]>();
    const gameConsistencyMap = new Map<string, Play['consistency']>();
    let repairedPlayCount = 0;
    let totalPlayCount = 0;
    let missingMarketTypeBeforeRepair = 0;
    let legacyTitleInferenceUsedCount = 0;
    const marketTypeCounts = new Map<string, number>();
    const reasonCodeCounts = new Map<string, number>();

    // STEP 1 FIX: Resolve external game IDs (ESPN, etc.) that map to our canonical game_ids
    // This allows props stored with external IDs to be joined to games with canonical IDs
    const externalToCanonicalMap = new Map<string, string>(); // external_game_id -> canonical game_id
    const allQueryableIds: string[] = [...gameIds]; // Start with canonical IDs

    if (gameIds.length > 0) {
      // Look up external game IDs that map to our canonical game IDs
      const idMapPlaceholders = gameIds.map(() => '?').join(', ');
      const idMapSql = `
        SELECT game_id, external_game_id
        FROM game_id_map
        WHERE game_id IN (${idMapPlaceholders})
      `;
      const idMapStmt = db.prepare(idMapSql);
      const idMapRows = idMapStmt.all(...gameIds) as Array<{
        game_id: string;
        external_game_id: string;
      }>;

      for (const row of idMapRows) {
        externalToCanonicalMap.set(row.external_game_id, row.game_id);
        allQueryableIds.push(row.external_game_id);
      }

      // SQLite doesn't support array binding; build placeholders for ALL IDs (canonical + external)
      const placeholders = allQueryableIds.map(() => '?').join(', ');
      const runIdPlaceholders =
        activeRunIds.length > 0 ? activeRunIds.map(() => '?').join(', ') : '';
      const runIdClause = activeRunIds.length > 0
        ? `AND run_id IN (${runIdPlaceholders})`
        : '';
      const buildCardsSql = (runClause: string) => `
        SELECT id, game_id, card_type, card_title, payload_data
        FROM card_payloads
        WHERE game_id IN (${placeholders})
          ${runClause}
          AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
          ${ENABLE_WELCOME_HOME ? '' : "AND card_type != 'welcome-home-v2'"}
        ORDER BY created_at DESC, id DESC
      `;
      let cardRows: CardPayloadRow[] = [];
      try {
        const cardsStmt = db.prepare(buildCardsSql(runIdClause));
        const cardsParams =
          activeRunIds.length > 0
            ? [...allQueryableIds, ...activeRunIds]
            : [...allQueryableIds];
        cardRows = cardsStmt.all(...cardsParams) as CardPayloadRow[];
        if (activeRunIds.length > 0 && cardRows.length === 0) {
          const fallbackStmt = db.prepare(buildCardsSql(''));
          cardRows = fallbackStmt.all(...allQueryableIds) as CardPayloadRow[];
        }
      } catch {
        // card_payloads table not yet created; plays will be empty
      }

      for (const cardRow of cardRows) {
        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(cardRow.payload_data) as Record<string, unknown>;
        } catch {
          // Skip malformed rows silently
          continue;
        }

        const driverInputs =
          payload.driver !== null &&
          typeof payload.driver === 'object' &&
          'inputs' in (payload.driver as object)
            ? ((payload.driver as Record<string, unknown>).inputs as Record<
                string,
                unknown
              >)
            : null;

        const payloadPlay = toObject(payload.play);
        const payloadSelection =
          toObject(payload.selection) ?? toObject(payloadPlay?.selection);
        const normalizedSelectionSide =
          normalizeSelectionSide(
            payloadSelection?.side ?? payloadPlay?.side ?? payload.prediction,
          ) ?? 'NONE';
        const normalizedAction = normalizeAction(
          payload.action ?? payloadPlay?.action,
        );
        const normalizedStatus = normalizeStatus(
          payload.status ?? payloadPlay?.status,
        );
        const normalizedClassification = normalizeClassification(
          payload.classification ?? payloadPlay?.classification,
        );
        const normalizedTier = normalizeTier(payload.tier ?? payloadPlay?.tier);
        const normalizedPrediction =
          normalizePrediction(payload.prediction) ??
          normalizePrediction(payloadPlay?.prediction) ??
          (normalizedSelectionSide === 'HOME' ||
          normalizedSelectionSide === 'AWAY' ||
          normalizedSelectionSide === 'OVER' ||
          normalizedSelectionSide === 'UNDER'
            ? normalizedSelectionSide
            : undefined) ??
          'NEUTRAL';
        const normalizedConfidence = firstNumber(
          payload.confidence,
          payloadPlay?.confidence,
        );
        const normalizedMarketType = normalizeMarketType(
          payload.market_type ?? payloadPlay?.market_type,
        );
        const normalizedPlayerName = firstString(
          payloadSelection?.player_name,
          payloadPlay?.player_name,
          (payload as Record<string, unknown>).player_name,
        );
        const normalizedSelectionTeam = firstString(
          normalizedPlayerName,
          payloadSelection?.team,
          payloadPlay?.team,
        );
        const normalizedLine = firstNumber(
          payload.line,
          (payload.market as Record<string, unknown>)?.line,
          payloadPlay?.line,
          payloadSelection?.line,
        );
        const normalizedPrice = firstNumber(
          payload.price,
          payloadPlay?.price,
          payloadSelection?.price,
        );
        const normalizedRunId = firstString(
          (payload as Record<string, unknown>).run_id,
          payloadPlay?.run_id,
        );
        const normalizedCreatedAt = firstString(
          (payload as Record<string, unknown>).created_at,
          payloadPlay?.created_at,
        );
        const normalizedPlayerId = firstString(
          payloadSelection?.player_id,
          payloadPlay?.player_id,
          (payload as Record<string, unknown>).player_id,
        );
        const normalizedTeamAbbr = firstString(
          (payload as Record<string, unknown>).team_abbr,
          payloadSelection?.team_abbr,
          payloadPlay?.team_abbr,
        );
        const normalizedGameId = firstString(
          (payload as Record<string, unknown>).game_id,
          payloadPlay?.game_id,
        );
        const normalizedMu = firstNumber(
          (payload as Record<string, unknown>).mu,
          payloadPlay?.mu,
          (payload.projection as Record<string, unknown>)?.mu,
          (payload.projection as Record<string, unknown>)?.total,
          driverInputs?.mu,
          driverInputs?.projected_total,
        );
        const normalizedSuggestedLine = firstNumber(
          (payload as Record<string, unknown>).suggested_line,
          payloadPlay?.suggested_line,
          normalizedLine,
        );
        const normalizedThreshold = firstNumber(
          (payload as Record<string, unknown>).threshold,
          payloadPlay?.threshold,
        );
        const normalizedIsTrending =
          typeof (payload as Record<string, unknown>).is_trending === 'boolean'
            ? ((payload as Record<string, unknown>).is_trending as boolean)
            : typeof payloadPlay?.is_trending === 'boolean'
              ? (payloadPlay.is_trending as boolean)
              : undefined;
        const normalizedRoleGatePass =
          typeof (payload as Record<string, unknown>).role_gate_pass ===
          'boolean'
            ? ((payload as Record<string, unknown>).role_gate_pass as boolean)
            : typeof payloadPlay?.role_gate_pass === 'boolean'
              ? (payloadPlay.role_gate_pass as boolean)
              : undefined;
        const normalizedDataQuality = firstString(
          (payload as Record<string, unknown>).data_quality,
          payloadPlay?.data_quality,
        );
        const payloadDrivers: Record<string, unknown> | null =
          payload.drivers && typeof payload.drivers === 'object'
            ? (payload.drivers as Record<string, unknown>)
            : null;
        const normalizedL5Sog =
          normalizeNumberArray((payload as Record<string, unknown>).l5_sog) ??
          normalizeNumberArray(payloadPlay?.l5_sog) ??
          normalizeNumberArray(payloadDrivers?.l5_sog) ??
          normalizeNumberArray(
            (payload as Record<string, unknown>).last5_sog,
          ) ??
          normalizeNumberArray(
            (payload as Record<string, unknown>).last5Shots,
          ) ??
          normalizeNumberArray((payload as Record<string, unknown>).l5) ??
          extractShotsFromRecentGames(
            (payload as Record<string, unknown>).last5Games,
          ) ??
          extractShotsFromRecentGames(
            (payload as Record<string, unknown>).recent_games,
          ) ??
          extractShotsFromRecentGames(payloadPlay?.last5Games) ??
          extractShotsFromRecentGames(payloadPlay?.recent_games);
        const normalizedL5Mean = firstNumber(
          (payload as Record<string, unknown>).l5_mean,
          payloadPlay?.l5_mean,
          payloadDrivers?.l5_avg,
          (payload as Record<string, unknown>).last5_mean,
          payloadPlay?.last5_mean,
          (payload as Record<string, unknown>).last5_avg,
          payloadPlay?.last5_avg,
          normalizedL5Sog && normalizedL5Sog.length > 0
            ? normalizedL5Sog.reduce((acc, value) => acc + value, 0) /
                normalizedL5Sog.length
            : undefined,
        );
        const payloadProjection = toObject(payload.projection);
        const payloadPlayObj = toObject(payloadPlay);
        const payloadPlayProjection = toObject(payloadPlayObj?.projection);
        const normalizedEdge = firstNumber(
          payload.edge,
          payloadPlayObj?.edge,
          driverInputs?.edge,
        );
        const projectionWinProbHome = firstNumber(
          payloadProjection?.win_prob_home,
          payloadPlayProjection?.win_prob_home,
        );
        let modelProbInferredFromEdge = false;
        let normalizedModelProb = firstNumber(
          (payload as Record<string, unknown>).model_prob,
          payloadPlayObj?.model_prob,
          (payload as Record<string, unknown>).p_fair,
          payloadPlayObj?.p_fair,
        );
        if (
          normalizedModelProb === undefined &&
          normalizedMarketType === 'MONEYLINE' &&
          typeof projectionWinProbHome === 'number'
        ) {
          normalizedModelProb =
            normalizedSelectionSide === 'AWAY'
              ? 1 - projectionWinProbHome
              : projectionWinProbHome;
        }
        if (normalizedModelProb === undefined) {
          const impliedProb = impliedProbFromAmericanOdds(normalizedPrice);
          if (
            typeof impliedProb === 'number' &&
            typeof normalizedEdge === 'number'
          ) {
            normalizedModelProb = impliedProb + normalizedEdge;
            modelProbInferredFromEdge = true;
          }
        }
        if (
          typeof normalizedModelProb === 'number' &&
          (!Number.isFinite(normalizedModelProb) ||
            normalizedModelProb < 0 ||
            normalizedModelProb > 1)
        ) {
          normalizedModelProb = undefined;
          modelProbInferredFromEdge = false;
        }
        const combinedReasonCodes = [
          ...(Array.isArray(payload.reason_codes) ? payload.reason_codes : []),
          ...(Array.isArray(payloadPlay?.reason_codes)
            ? payloadPlay.reason_codes
            : []),
        ].map((value) => String(value));
        const combinedTags = [
          ...(Array.isArray(payload.tags) ? payload.tags : []),
          ...(Array.isArray(payloadPlay?.tags) ? payloadPlay.tags : []),
        ].map((value) => String(value));
        if (modelProbInferredFromEdge) {
          combinedTags.push('PROXY_MODEL_PROB_INFERRED');
          combinedReasonCodes.push('PROXY_MODEL_PROB_INFERRED');
        }

        const inferredActionFromTierOrConfidence: Play['action'] | undefined =
          normalizedTier === 'SUPER' || normalizedTier === 'BEST'
            ? 'FIRE'
            : normalizedTier === 'WATCH'
              ? 'HOLD'
              : typeof normalizedConfidence === 'number' &&
                  normalizedConfidence >= 0.75
                ? 'FIRE'
                : typeof normalizedConfidence === 'number' &&
                    normalizedConfidence >= 0.6
                  ? 'HOLD'
                  : undefined;
        const resolvedAction: Play['action'] | undefined =
          normalizedAction ??
          actionFromClassification(normalizedClassification) ??
          (normalizedStatus === 'FIRE'
            ? 'FIRE'
            : normalizedStatus === 'WATCH'
              ? 'HOLD'
              : normalizedStatus === 'PASS'
                ? 'PASS'
                : undefined) ??
          inferredActionFromTierOrConfidence;
        const resolvedClassification: Play['classification'] | undefined =
          normalizedClassification ?? classificationFromAction(resolvedAction);
        const resolvedStatus: Play['status'] | undefined =
          statusFromAction(resolvedAction) ?? normalizedStatus;

        const play: Play = {
          source_card_id: cardRow.id,
          cardType: cardRow.card_type,
          cardTitle: cardRow.card_title,
          prediction: normalizedPrediction,
          confidence: normalizedConfidence ?? 0,
          tier: normalizedTier,
          reasoning:
            typeof payload.reasoning === 'string'
              ? payload.reasoning
              : typeof payloadPlay?.reasoning === 'string'
                ? payloadPlay.reasoning
                : '',
          evPassed:
            payload.ev_passed === true || payloadPlay?.ev_passed === true,
          driverKey:
            payload.driver !== null &&
            typeof payload.driver === 'object' &&
            'key' in (payload.driver as object)
              ? String((payload.driver as Record<string, unknown>).key)
              : '',
          projectedTotal:
            typeof (payload.projection as Record<string, unknown>)?.total ===
            'number'
              ? ((payload.projection as Record<string, unknown>)
                  .total as number)
              : typeof driverInputs?.projected_total === 'number'
                ? (driverInputs.projected_total as number)
                : null,
          edge: typeof normalizedEdge === 'number' ? normalizedEdge : null,
          model_prob: normalizedModelProb,
          status: resolvedStatus,
          // Canonical decision fields (preferred over legacy status field)
          classification: resolvedClassification,
          action: resolvedAction,
          pass_reason_code:
            typeof payload.pass_reason_code === 'string'
              ? payload.pass_reason_code
              : typeof payloadPlay?.pass_reason_code === 'string'
                ? payloadPlay.pass_reason_code
                : null,
          kind:
            payload.kind === 'PLAY' || payload.kind === 'EVIDENCE'
              ? (payload.kind as 'PLAY' | 'EVIDENCE')
              : payloadPlay?.kind === 'PLAY' || payloadPlay?.kind === 'EVIDENCE'
                ? (payloadPlay.kind as 'PLAY' | 'EVIDENCE')
                : undefined,
          market_type:
            normalizedMarketType !== undefined
              ? normalizedMarketType
              : typeof (payload.recommendation as Record<string, unknown>)
                    ?.type === 'string'
                ? (() => {
                    const recommendationType = String(
                      (payload.recommendation as Record<string, unknown>).type,
                    ).toLowerCase();
                    if (recommendationType.includes('total')) return 'TOTAL';
                    if (recommendationType.includes('spread')) return 'SPREAD';
                    if (
                      recommendationType.includes('moneyline') ||
                      recommendationType.includes('ml')
                    )
                      return 'MONEYLINE';
                    if (
                      recommendationType.includes('prop') ||
                      recommendationType.includes('player')
                    )
                      return 'PROP';
                    return undefined;
                  })()
                : typeof payload.recommended_bet_type === 'string'
                  ? (() => {
                      const betType = String(
                        payload.recommended_bet_type,
                      ).toLowerCase();
                      if (betType === 'total') return 'TOTAL';
                      if (betType === 'spread') return 'SPREAD';
                      if (betType === 'moneyline' || betType === 'ml')
                        return 'MONEYLINE';
                      if (betType === 'prop' || betType === 'player_prop')
                        return 'PROP';
                      return undefined;
                    })()
                  : // Check legacy 'market' field
                    payload.market === 'ML' || payload.market === 'MONEYLINE'
                    ? 'MONEYLINE'
                    : payload.market === 'SPREAD'
                      ? 'SPREAD'
                      : payload.market === 'TOTAL'
                        ? 'TOTAL'
                        : // Infer from selection side
                          normalizedSelectionSide === 'OVER' ||
                            normalizedSelectionSide === 'UNDER'
                          ? 'TOTAL'
                          : normalizedSelectionSide === 'HOME' ||
                              normalizedSelectionSide === 'AWAY'
                            ? 'SPREAD'
                            : undefined,
          selection: {
            side: normalizedSelectionSide,
            team: normalizedSelectionTeam,
          },
          line: normalizedLine,
          price: normalizedPrice,
          reason_codes: combinedReasonCodes,
          tags: combinedTags,
          run_id: normalizedRunId,
          created_at: normalizedCreatedAt,
          player_id: normalizedPlayerId,
          player_name: normalizedPlayerName,
          team_abbr: normalizedTeamAbbr,
          game_id: normalizedGameId ?? cardRow.game_id,
          mu: normalizedMu ?? null,
          suggested_line: normalizedSuggestedLine ?? null,
          threshold: normalizedThreshold ?? null,
          is_trending: normalizedIsTrending,
          role_gate_pass: normalizedRoleGatePass,
          data_quality: normalizedDataQuality ?? null,
          l5_sog: normalizedL5Sog ?? null,
          l5_mean: normalizedL5Mean ?? null,
          consistency:
            payload.consistency && typeof payload.consistency === 'object'
              ? {
                  total_bias:
                    (payload.consistency as Record<string, unknown>)
                      .total_bias === 'OK' ||
                    (payload.consistency as Record<string, unknown>)
                      .total_bias === 'INSUFFICIENT_DATA' ||
                    (payload.consistency as Record<string, unknown>)
                      .total_bias === 'CONFLICTING_SIGNALS' ||
                    (payload.consistency as Record<string, unknown>)
                      .total_bias === 'VOLATILE_ENV' ||
                    (payload.consistency as Record<string, unknown>)
                      .total_bias === 'UNKNOWN'
                      ? ((payload.consistency as Record<string, unknown>)
                          .total_bias as
                          | 'OK'
                          | 'INSUFFICIENT_DATA'
                          | 'CONFLICTING_SIGNALS'
                          | 'VOLATILE_ENV'
                          | 'UNKNOWN')
                      : undefined,
                }
              : payloadPlay?.consistency &&
                  typeof payloadPlay.consistency === 'object'
                ? {
                    total_bias:
                      (payloadPlay.consistency as Record<string, unknown>)
                        .total_bias === 'OK' ||
                      (payloadPlay.consistency as Record<string, unknown>)
                        .total_bias === 'INSUFFICIENT_DATA' ||
                      (payloadPlay.consistency as Record<string, unknown>)
                        .total_bias === 'CONFLICTING_SIGNALS' ||
                      (payloadPlay.consistency as Record<string, unknown>)
                        .total_bias === 'VOLATILE_ENV' ||
                      (payloadPlay.consistency as Record<string, unknown>)
                        .total_bias === 'UNKNOWN'
                        ? ((payloadPlay.consistency as Record<string, unknown>)
                            .total_bias as
                            | 'OK'
                            | 'INSUFFICIENT_DATA'
                            | 'CONFLICTING_SIGNALS'
                            | 'VOLATILE_ENV'
                            | 'UNKNOWN')
                        : undefined,
                  }
                : undefined,
          repair_applied: payload.repair_applied === true,
          repair_rule_id:
            typeof payload.repair_rule_id === 'string'
              ? payload.repair_rule_id
              : undefined,
        };

        if (!play.kind) {
          play.kind = play.market_type === 'INFO' ? 'EVIDENCE' : 'PLAY';
        }

        if (!play.consistency?.total_bias) {
          const totalDecision =
            payload.all_markets &&
            typeof payload.all_markets === 'object' &&
            (payload.all_markets as Record<string, unknown>).TOTAL &&
            typeof (payload.all_markets as Record<string, unknown>).TOTAL ===
              'object'
              ? ((payload.all_markets as Record<string, unknown>)
                  .TOTAL as Record<string, unknown>)
              : null;
          const decisionStatus =
            typeof totalDecision?.status === 'string'
              ? totalDecision.status
              : null;
          const decisionLine =
            typeof (
              totalDecision?.best_candidate as
                | Record<string, unknown>
                | undefined
            )?.line === 'number';
          const decisionEdge = typeof totalDecision?.edge === 'number';
          play.consistency = {
            total_bias:
              decisionStatus &&
              decisionStatus !== 'PASS' &&
              decisionLine &&
              decisionEdge
                ? 'OK'
                : 'INSUFFICIENT_DATA',
          };
        }

        if (!play.market_type) {
          missingMarketTypeBeforeRepair += 1;
          play.reason_codes = Array.from(
            new Set([...(play.reason_codes ?? []), 'PASS_MISSING_MARKET_TYPE']),
          );
          const isAllowlisted = REPAIR_ALLOWLIST.has(cardRow.card_type);
          const candidates = inferMarketCandidatesFromTitle(cardRow.card_title);
          const uniqueCandidates = Array.from(new Set(candidates));
          const unambiguous = uniqueCandidates.length === 1;
          const inferredCandidate = uniqueCandidates[0];

          if (
            isAllowlisted &&
            unambiguous &&
            hasMinimumViability(play, inferredCandidate)
          ) {
            play.market_type = inferredCandidate;
            play.repair_applied = true;
            play.repair_rule_id = 'R001';
            play.tags = Array.from(
              new Set([
                ...(play.tags ?? []),
                'LEGACY_REPAIR',
                'LEGACY_TITLE_INFERENCE_USED',
                'PROXY_LEGACY_MARKET_INFERRED',
              ]),
            );
            play.reason_codes = Array.from(
              new Set([
                ...(play.reason_codes ?? []),
                'REPAIRED_LEGACY_CARD',
                'LEGACY_TITLE_INFERENCE_USED',
              ]),
            );
            legacyTitleInferenceUsedCount += 1;
          } else {
            play.market_type = 'INFO';
            play.kind = 'EVIDENCE';
            play.reason_codes = Array.from(
              new Set([
                ...(play.reason_codes ?? []),
                'PASS_UNREPAIRABLE_LEGACY',
                'LEGACY_TITLE_INFERENCE_USED',
              ]),
            );
            play.tags = Array.from(
              new Set([
                ...(play.tags ?? []),
                'LEGACY_TITLE_INFERENCE_USED',
                'PROXY_LEGACY_MARKET_INFERRED',
              ]),
            );
          }
        }

        if (!hasMinimumViability(play, play.market_type)) {
          play.market_type = 'INFO';
          play.kind = 'EVIDENCE';
          play.reason_codes = Array.from(
            new Set([...(play.reason_codes ?? []), 'PASS_UNREPAIRABLE_LEGACY']),
          );
        }

        totalPlayCount += 1;
        if (play.repair_applied) repairedPlayCount += 1;
        marketTypeCounts.set(
          play.market_type,
          (marketTypeCounts.get(play.market_type) ?? 0) + 1,
        );
        for (const reasonCode of play.reason_codes ?? []) {
          reasonCodeCounts.set(
            reasonCode,
            (reasonCodeCounts.get(reasonCode) ?? 0) + 1,
          );
        }

        // Map external game_id to canonical game_id for proper association
        const canonicalGameId =
          externalToCanonicalMap.get(cardRow.game_id) ?? cardRow.game_id;

        if (!gameConsistencyMap.has(canonicalGameId)) {
          gameConsistencyMap.set(
            canonicalGameId,
            play.consistency ?? { total_bias: 'UNKNOWN' },
          );
        }

        const existing = playsMap.get(canonicalGameId);
        if (existing) {
          existing.push(play);
        } else {
          playsMap.set(canonicalGameId, [play]);
        }
      }
    }

    const data = rows.map((row) => {
      const hasOdds =
        row.h2h_home !== null ||
        row.h2h_away !== null ||
        row.total !== null ||
        row.spread_home !== null ||
        row.spread_away !== null;

      return {
        id: row.id,
        gameId: row.game_id,
        sport: row.sport,
        homeTeam: row.home_team,
        awayTeam: row.away_team,
        gameTimeUtc: row.game_time_utc,
        status: row.status,
        createdAt: row.created_at,
        odds: hasOdds
          ? {
              h2hHome: row.h2h_home,
              h2hAway: row.h2h_away,
              total: row.total,
              spreadHome: row.spread_home,
              spreadAway: row.spread_away,
              spreadPriceHome: row.spread_price_home,
              spreadPriceAway: row.spread_price_away,
              totalPriceOver: row.total_price_over,
              totalPriceUnder: row.total_price_under,
              capturedAt: row.odds_captured_at,
            }
          : null,
        consistency: gameConsistencyMap.get(row.game_id) ?? {
          total_bias: 'UNKNOWN',
        },
        plays: playsMap.get(row.game_id) ?? [],
      };
    });

    // NOTE: card_display_log writes intentionally removed.
    // Worker owns all DB writes (single-writer architecture).

    const repairRatio =
      totalPlayCount > 0 ? repairedPlayCount / totalPlayCount : 0;
    const repairCap = 0.2;

    // Join diagnostics for game ID mapping (dev mode only)
    const isDev = process.env.NODE_ENV !== 'production';
    const joinDebug = isDev
      ? {
          canonical_game_ids_queried: gameIds.length,
          external_ids_resolved: externalToCanonicalMap.size,
          total_queryable_ids: allQueryableIds.length,
          plays_found: totalPlayCount,
          games_with_plays: playsMap.size,
        }
      : undefined;

    const response = NextResponse.json(
      {
        success: true,
        data,
        meta: {
          current_run_id: currentRunId,
          generated_at: new Date().toISOString(),
          run_status: runStatus,
          items_count: data.length,
        },
        warning: repairRatio > repairCap,
        ...(joinDebug ? { join_debug: joinDebug } : {}),
        repair_stats: {
          repaired_count: repairedPlayCount,
          total_count: totalPlayCount,
          ratio: Number(repairRatio.toFixed(4)),
          cap: repairCap,
        },
        contract_stats: {
          missing_market_type_before_repair: missingMarketTypeBeforeRepair,
          legacy_title_inference_used_count: legacyTitleInferenceUsedCount,
          market_type_counts: Object.fromEntries(marketTypeCounts.entries()),
          top_reason_codes: Object.fromEntries(
            Array.from(reasonCodeCounts.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5),
          ),
        },
      },
      { headers: { 'Content-Type': 'application/json' } },
    );
    return addRateLimitHeaders(response, request);
  } catch (error) {
    console.error('[API] Error fetching games:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const response = NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
    return addRateLimitHeaders(response, request);
  } finally {
    if (db) closeReadOnlyInstance(db);
  }
}
