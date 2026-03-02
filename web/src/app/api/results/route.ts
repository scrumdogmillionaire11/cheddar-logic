import { NextRequest, NextResponse } from 'next/server';
import { initDb, getDatabase, closeDatabase } from '@cheddar-logic/data';

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
  result: string | null;
  pnl_units: number | null;
  settled_at: string | null;
  created_at: string | null;
  payload_data: string | null;
};

function clampNumber(value: string | null, fallback: number, min: number, max: number) {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function safeJsonParse(payload: string | null) {
  if (!payload) return { data: null, error: true };
  try {
    return { data: JSON.parse(payload), error: false };
  } catch {
    return { data: null, error: true };
  }
}

export async function GET(request: NextRequest) {
  let db: ReturnType<typeof getDatabase> | null = null;
  try {
    await initDb();
    db = getDatabase();

    const { searchParams } = request.nextUrl;
    const limit = clampNumber(searchParams.get('limit'), 50, 1, 200);

    // Deduplication: one card per game per market (moneyline/total),
    // highest confidence, excluding PASS recommendations.
    const dedupedIdRows = db.prepare(`
      SELECT cr2.id
      FROM card_results cr2
      INNER JOIN card_payloads cp2 ON cr2.card_id = cp2.id
      INNER JOIN (
        SELECT cr3.game_id, cr3.recommended_bet_type,
               MAX(CAST(json_extract(cp3.payload_data, '$.confidence_pct') AS REAL)) AS max_conf
        FROM card_results cr3
        INNER JOIN card_payloads cp3 ON cr3.card_id = cp3.id
        WHERE cr3.status = 'settled'
          AND json_extract(cp3.payload_data, '$.recommendation.type') != 'PASS'
        GROUP BY cr3.game_id, cr3.recommended_bet_type
      ) best ON cr2.game_id = best.game_id
            AND cr2.recommended_bet_type = best.recommended_bet_type
            AND CAST(json_extract(cp2.payload_data, '$.confidence_pct') AS REAL) = best.max_conf
      WHERE cr2.status = 'settled'
        AND json_extract(cp2.payload_data, '$.recommendation.type') != 'PASS'
      GROUP BY cr2.game_id, cr2.recommended_bet_type
    `).all() as { id: string }[];
    const dedupedIdSet = new Set(dedupedIdRows.map((r) => r.id));
    const placeholders = dedupedIdRows.map(() => '?').join(',');

    if (dedupedIdRows.length === 0) {
      return NextResponse.json(
        { success: true, data: { summary: { totalCards: 0, settledCards: 0, wins: 0, losses: 0, pushes: 0, totalPnlUnits: 0, winRate: 0, avgPnl: 0 }, segments: [], ledger: [] } },
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    const ids = dedupedIdRows.map((r) => r.id);

    const summary = db.prepare(`
      SELECT
        COUNT(*) AS total_cards,
        SUM(CASE WHEN cr.status = 'settled' THEN 1 ELSE 0 END) AS settled_cards,
        SUM(CASE WHEN cr.result = 'win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN cr.result = 'loss' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN cr.result = 'push' THEN 1 ELSE 0 END) AS pushes,
        SUM(COALESCE(cr.pnl_units, 0)) AS total_pnl_units
      FROM card_results cr
      INNER JOIN card_payloads cp ON cr.card_id = cp.id
      WHERE cr.id IN (${placeholders})
    `).get(...ids) as SummaryRow;

    const segments = db.prepare(`
      SELECT
        cr.sport,
        COUNT(*) AS settled_cards,
        SUM(CASE WHEN cr.result = 'win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN cr.result = 'loss' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN cr.result = 'push' THEN 1 ELSE 0 END) AS pushes,
        SUM(COALESCE(cr.pnl_units, 0)) AS total_pnl_units
      FROM card_results cr
      INNER JOIN card_payloads cp ON cr.card_id = cp.id
      WHERE cr.id IN (${placeholders})
      GROUP BY cr.sport
      ORDER BY cr.sport ASC
    `).all(...ids) as SegmentRow[];

    const ledger = db.prepare(`
      SELECT
        cr.id,
        cr.game_id,
        cr.sport,
        cr.card_type,
        cr.result,
        cr.pnl_units,
        cr.settled_at,
        cp.created_at,
        cp.payload_data
      FROM card_results cr
      INNER JOIN card_payloads cp ON cr.card_id = cp.id
      WHERE cr.id IN (${placeholders})
      ORDER BY cr.settled_at DESC
      LIMIT ${limit}
    `).all(...ids) as LedgerRow[];

    const ledgerRows = ledger.map((row) => {
      const parsed = safeJsonParse(row.payload_data);
      const payload = parsed.data as Record<string, unknown> | null;
      const prediction = payload && typeof payload.prediction === 'string'
        ? payload.prediction
        : null;
      const tier = payload && typeof payload.tier === 'string' ? payload.tier : null;
      const market = payload && typeof payload.recommended_bet_type === 'string'
        ? payload.recommended_bet_type
        : null;

      // homeTeam / awayTeam
      const homeTeam = payload && typeof payload.home_team === 'string'
        ? payload.home_team
        : null;
      const awayTeam = payload && typeof payload.away_team === 'string'
        ? payload.away_team
        : null;

      // price — extracted from odds_context based on prediction
      let price: number | null = null;
      if (payload && payload.odds_context && typeof payload.odds_context === 'object') {
        const oddsCtx = payload.odds_context as Record<string, unknown>;
        if (prediction === 'HOME') {
          const val = oddsCtx.h2h_home;
          price = typeof val === 'number' ? val : null;
        } else if (prediction === 'AWAY') {
          const val = oddsCtx.h2h_away;
          price = typeof val === 'number' ? val : null;
        } else if (prediction === 'OVER' || prediction === 'UNDER') {
          const val = oddsCtx.total;
          price = typeof val === 'number' ? val : null;
        } else if (typeof prediction === 'string' && prediction.startsWith('SPREAD_HOME')) {
          const val = oddsCtx.spread_home;
          price = typeof val === 'number' ? val : null;
        } else if (typeof prediction === 'string' && prediction.startsWith('SPREAD_AWAY')) {
          const val = oddsCtx.spread_away;
          price = typeof val === 'number' ? val : null;
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
        homeTeam,
        awayTeam,
        price,
        confidencePct,
        payloadParseError: parsed.error,
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

    return NextResponse.json(
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
            settledCards: Number(row.settled_cards || 0),
            wins: Number(row.wins || 0),
            losses: Number(row.losses || 0),
            pushes: Number(row.pushes || 0),
            totalPnlUnits: Number(row.total_pnl_units || 0),
          })),
          ledger: ledgerRows,
        },
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[API] Error fetching results:', error);
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
