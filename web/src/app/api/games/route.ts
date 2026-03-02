/**
 * GET /api/games
 *
 * Returns all upcoming games from the odds API, joined with the latest
 * odds snapshot per game, plus any active driver play calls from card_payloads.
 * Games with no card_payloads still appear.
 *
 * Query window: datetime(game_time_utc) >= midnight today America/New_York (today + future games only)
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

import { NextResponse } from 'next/server';
import { initDb, getDatabase, closeDatabase } from '@cheddar-logic/data';

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
  game_id: string;
  card_type: string;
  card_title: string;
  payload_data: string;
}

interface Play {
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
  status?: 'FIRE' | 'WATCH' | 'PASS';
  kind?: 'PLAY' | 'EVIDENCE';
  market_type?: 'MONEYLINE' | 'SPREAD' | 'TOTAL' | 'PUCKLINE' | 'TEAM_TOTAL' | 'PROP' | 'INFO';
  selection?: { side: string; team?: string };
  line?: number;
  price?: number;
  reason_codes?: string[];
  tags?: string[];
  consistency?: {
    total_bias?: 'OK' | 'INSUFFICIENT_DATA' | 'CONFLICTING_SIGNALS' | 'VOLATILE_ENV' | 'UNKNOWN';
  };
  // Canonical decision fields
  classification?: 'BASE' | 'LEAN' | 'PASS';
  action?: 'FIRE' | 'HOLD' | 'PASS';
  pass_reason_code?: string | null;
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
  if (titleLower.includes('total') || titleLower.includes('o/u') || titleLower.includes('over') || titleLower.includes('under')) {
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
  if (marketType === 'TOTAL') {
    return (side === 'OVER' || side === 'UNDER') && typeof play.line === 'number';
  }
  if (marketType === 'SPREAD') {
    return (side === 'HOME' || side === 'AWAY') && typeof play.line === 'number';
  }
  if (marketType === 'MONEYLINE') {
    return side === 'HOME' || side === 'AWAY';
  }
  return true;
}
export async function GET() {
  try {
    await initDb();

    // AUTH DISABLED: Commenting out auth walls to allow public access
    // const access = requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD);
    // if (!access.ok) {
    //   return NextResponse.json(
    //     { success: false, error: access.error },
    //     { status: access.status }
    //   );
    // }

    const db = getDatabase();

    // Check if database is empty or uninitialized
    const tableCheckStmt = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='games'`
    );
    const hasGamesTable = tableCheckStmt.get();

    if (!hasGamesTable) {
      // Database is not initialized - return empty data
      return NextResponse.json(
        { success: true, data: [] },
        { headers: { 'Content-Type': 'application/json' } }
      );
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
    const localMidnight = new Date(`${etDateStr}T00:00:00${sign}${absHours}:00`);
    // Truncate to seconds — SQLite datetime() strips sub-second precision, so
    // "05:00:00.000" would be > "05:00:00" and exclude games at exactly midnight.
    const todayUtc = localMidnight.toISOString().substring(0, 19).replace('T', ' ');

    const sql = `
      WITH latest_odds AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY captured_at DESC) AS rn
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
      LEFT JOIN latest_odds o ON o.game_id = g.game_id AND o.rn = 1
      WHERE datetime(g.game_time_utc) >= ?
      ORDER BY g.game_time_utc ASC
      LIMIT 200
    `;

    const stmt = db.prepare(sql);
    const rows = stmt.all(todayUtc) as GameRow[];

    // Collect all game IDs for the card_payloads query
    const gameIds = rows.map((r) => r.game_id);

    // Build a plays map keyed by game_id
    const playsMap = new Map<string, Play[]>();
    const gameConsistencyMap = new Map<string, Play['consistency']>();
    let repairedPlayCount = 0;
    let totalPlayCount = 0;
    let missingMarketTypeBeforeRepair = 0;
    let legacyTitleInferenceUsedCount = 0;
    const marketTypeCounts = new Map<string, number>();
    const reasonCodeCounts = new Map<string, number>();

    if (gameIds.length > 0) {
      // SQLite doesn't support array binding; build placeholders manually
      const placeholders = gameIds.map(() => '?').join(', ');
      const cardsSql = `
        SELECT game_id, card_type, card_title, payload_data
        FROM card_payloads
        WHERE game_id IN (${placeholders})
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY created_at DESC
      `;
      const cardsStmt = db.prepare(cardsSql);
      const cardRows = cardsStmt.all(...gameIds) as CardPayloadRow[];

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
            ? (payload.driver as Record<string, unknown>).inputs as Record<string, unknown>
            : null;

        const play: Play = {
          cardType: cardRow.card_type,
          cardTitle: cardRow.card_title,
          prediction: (payload.prediction as 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL') ?? 'NEUTRAL',
          confidence: typeof payload.confidence === 'number' ? payload.confidence : 0,
          tier: (payload.tier as 'SUPER' | 'BEST' | 'WATCH' | null) ?? null,
          reasoning: typeof payload.reasoning === 'string' ? payload.reasoning : '',
          evPassed: payload.ev_passed === true,
          driverKey:
            payload.driver !== null &&
            typeof payload.driver === 'object' &&
            'key' in (payload.driver as object)
              ? String((payload.driver as Record<string, unknown>).key)
              : '',
          projectedTotal:
            typeof (payload.projection as Record<string, unknown>)?.total === 'number'
              ? (payload.projection as Record<string, unknown>).total as number
              : typeof driverInputs?.projected_total === 'number'
                ? driverInputs.projected_total as number
                : null,
          edge:
            typeof payload.edge === 'number'
              ? payload.edge as number
              : typeof driverInputs?.edge === 'number'
                ? driverInputs.edge as number
                : null,
          status:
            payload.status === 'FIRE' || payload.status === 'WATCH' || payload.status === 'PASS'
              ? payload.status
              : payload.action === 'HOLD' ? 'WATCH'
              : payload.action === 'FIRE' ? 'FIRE'
              : undefined,
          // Canonical decision fields (preferred over legacy status field)
          classification:
            payload.classification === 'BASE' || payload.classification === 'LEAN' || payload.classification === 'PASS'
              ? (payload.classification as 'BASE' | 'LEAN' | 'PASS')
              : undefined,
          action:
            payload.action === 'FIRE' || payload.action === 'HOLD' || payload.action === 'PASS'
              ? (payload.action as 'FIRE' | 'HOLD' | 'PASS')
              : undefined,
          pass_reason_code:
            typeof payload.pass_reason_code === 'string' ? payload.pass_reason_code : null,
          kind:
            payload.kind === 'PLAY' || payload.kind === 'EVIDENCE'
              ? payload.kind as 'PLAY' | 'EVIDENCE'
              : undefined,
          market_type:
            typeof payload.market_type === 'string'
              ? (payload.market_type as Play['market_type'])
              : typeof (payload.recommendation as Record<string, unknown>)?.type === 'string'
                ? (() => {
                    const recommendationType = String((payload.recommendation as Record<string, unknown>).type).toLowerCase();
                    if (recommendationType.includes('total')) return 'TOTAL';
                    if (recommendationType.includes('spread')) return 'SPREAD';
                    if (recommendationType.includes('moneyline') || recommendationType.includes('ml')) return 'MONEYLINE';
                    return undefined;
                  })()
                : typeof payload.recommended_bet_type === 'string'
                  ? (() => {
                      const betType = String(payload.recommended_bet_type).toLowerCase();
                      if (betType === 'total') return 'TOTAL';
                      if (betType === 'spread') return 'SPREAD';
                      if (betType === 'moneyline' || betType === 'ml') return 'MONEYLINE';
                      return undefined;
                    })()
                  : undefined,
          selection:
            payload.selection && typeof payload.selection === 'object'
              ? {
                  side: String((payload.selection as Record<string, unknown>).side ?? 'NONE'),
                  team:
                    typeof (payload.selection as Record<string, unknown>).team === 'string'
                      ? String((payload.selection as Record<string, unknown>).team)
                      : undefined,
                }
              : {
                  side: String((payload.prediction as string) ?? 'NONE'),
                },
          line:
            typeof payload.line === 'number'
              ? payload.line as number
              : typeof (payload.market as Record<string, unknown>)?.line === 'number'
                ? (payload.market as Record<string, unknown>).line as number
                : undefined,
          price:
            typeof payload.price === 'number'
              ? payload.price as number
              : undefined,
          reason_codes: Array.isArray(payload.reason_codes)
            ? payload.reason_codes.map((value) => String(value))
            : [],
          tags: Array.isArray(payload.tags)
            ? payload.tags.map((value) => String(value))
            : [],
          consistency:
            payload.consistency && typeof payload.consistency === 'object'
              ? {
                  total_bias:
                    (payload.consistency as Record<string, unknown>).total_bias === 'OK' ||
                    (payload.consistency as Record<string, unknown>).total_bias === 'INSUFFICIENT_DATA' ||
                    (payload.consistency as Record<string, unknown>).total_bias === 'CONFLICTING_SIGNALS' ||
                    (payload.consistency as Record<string, unknown>).total_bias === 'VOLATILE_ENV' ||
                    (payload.consistency as Record<string, unknown>).total_bias === 'UNKNOWN'
                          ? (payload.consistency as Record<string, unknown>).total_bias as 'OK' | 'INSUFFICIENT_DATA' | 'CONFLICTING_SIGNALS' | 'VOLATILE_ENV' | 'UNKNOWN'
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
            typeof (payload.all_markets as Record<string, unknown>).TOTAL === 'object'
              ? (payload.all_markets as Record<string, unknown>).TOTAL as Record<string, unknown>
              : null;
          const decisionStatus = typeof totalDecision?.status === 'string' ? totalDecision.status : null;
          const decisionLine = typeof (totalDecision?.best_candidate as Record<string, unknown> | undefined)?.line === 'number';
          const decisionEdge = typeof totalDecision?.edge === 'number';
          play.consistency = {
            total_bias:
              decisionStatus && decisionStatus !== 'PASS' && decisionLine && decisionEdge
                ? 'OK'
                : 'INSUFFICIENT_DATA',
          };
        }

        if (!play.market_type) {
          missingMarketTypeBeforeRepair += 1;
          const isAllowlisted = REPAIR_ALLOWLIST.has(cardRow.card_type);
          const candidates = inferMarketCandidatesFromTitle(cardRow.card_title);
          const uniqueCandidates = Array.from(new Set(candidates));
          const unambiguous = uniqueCandidates.length === 1;
          const inferredCandidate = uniqueCandidates[0];

          if (isAllowlisted && unambiguous && hasMinimumViability(play, inferredCandidate)) {
            play.market_type = inferredCandidate;
            play.repair_applied = true;
            play.repair_rule_id = 'R001';
            play.tags = Array.from(new Set([...(play.tags ?? []), 'LEGACY_REPAIR']));
            play.reason_codes = Array.from(new Set([...(play.reason_codes ?? []), 'REPAIRED_LEGACY_CARD']));
            legacyTitleInferenceUsedCount += 1;
          } else {
            play.market_type = 'INFO';
            play.kind = 'EVIDENCE';
            play.reason_codes = Array.from(
              new Set([...(play.reason_codes ?? []), 'PASS_UNREPAIRABLE_LEGACY'])
            );
          }
        }

        if (!hasMinimumViability(play, play.market_type)) {
          play.market_type = 'INFO';
          play.kind = 'EVIDENCE';
          play.reason_codes = Array.from(new Set([...(play.reason_codes ?? []), 'PASS_UNREPAIRABLE_LEGACY']));
        }

        totalPlayCount += 1;
        if (play.repair_applied) repairedPlayCount += 1;
        marketTypeCounts.set(play.market_type, (marketTypeCounts.get(play.market_type) ?? 0) + 1);
        for (const reasonCode of play.reason_codes ?? []) {
          reasonCodeCounts.set(reasonCode, (reasonCodeCounts.get(reasonCode) ?? 0) + 1);
        }

        if (!gameConsistencyMap.has(cardRow.game_id)) {
          gameConsistencyMap.set(cardRow.game_id, play.consistency ?? { total_bias: 'UNKNOWN' });
        }

        const existing = playsMap.get(cardRow.game_id);
        if (existing) {
          existing.push(play);
        } else {
          playsMap.set(cardRow.game_id, [play]);
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
        consistency: gameConsistencyMap.get(row.game_id) ?? { total_bias: 'UNKNOWN' },
        plays: playsMap.get(row.game_id) ?? [],
      };
    });

    const repairRatio = totalPlayCount > 0 ? repairedPlayCount / totalPlayCount : 0;
    const repairCap = 0.2;

    return NextResponse.json(
      {
        success: true,
        data,
        warning: repairRatio > repairCap,
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
              .slice(0, 5)
          ),
        },
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[API] Error fetching games:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  } finally {
    closeDatabase();
  }
}
