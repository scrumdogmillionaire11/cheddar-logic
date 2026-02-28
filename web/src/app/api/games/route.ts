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
 *       capturedAt: string | null,
 *     } | null,
 *     plays: Play[],
 *   }>,
 *   error?: string,
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { RESOURCE, initDb, getDatabase, closeDatabase } from '@cheddar-logic/data';
import { requireEntitlementForRequest } from '@/lib/auth/server';

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
}

export async function GET(request: NextRequest) {
  try {
    await initDb();

    const access = requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD);
    if (!access.ok) {
      return NextResponse.json(
        { success: false, error: access.error },
        { status: access.status }
      );
    }

    const db = getDatabase();

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
        };

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
              capturedAt: row.odds_captured_at,
            }
          : null,
        plays: playsMap.get(row.game_id) ?? [],
      };
    });

    return NextResponse.json(
      { success: true, data },
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
