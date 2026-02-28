/**
 * GET /api/games
 *
 * Returns all upcoming games from the odds API, joined with the latest
 * odds snapshot per game, plus any active driver play calls from card_payloads.
 * Games with no card_payloads still appear.
 *
 * Query window: game_time_utc >= midnight today UTC (today + future games only)
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
  prediction: 'HOME' | 'AWAY' | 'NEUTRAL';
  confidence: number;
  tier: 'SUPER' | 'BEST' | 'WATCH' | null;
  reasoning: string;
  evPassed: boolean;
  driverKey: string;
}

export async function GET() {
  let db: ReturnType<typeof getDatabase> | null = null;
  try {
    await initDb();
    db = getDatabase();

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
      WHERE g.game_time_utc >= datetime('now', 'start of day')
      ORDER BY g.game_time_utc ASC
      LIMIT 200
    `;

    const stmt = db.prepare(sql);
    const rows = stmt.all() as GameRow[];

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

        const play: Play = {
          cardType: cardRow.card_type,
          cardTitle: cardRow.card_title,
          prediction: (payload.prediction as 'HOME' | 'AWAY' | 'NEUTRAL') ?? 'NEUTRAL',
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
    if (db) {
      closeDatabase();
    }
  }
}
