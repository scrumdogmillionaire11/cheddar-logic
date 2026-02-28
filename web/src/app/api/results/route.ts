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
      WHERE cp.payload_data IS NOT NULL AND cp.payload_data != '' AND cr.status = 'settled'
    `).get() as SummaryRow;

    const segments = db.prepare(`
      SELECT
        cr.sport,
        SUM(CASE WHEN cr.status = 'settled' THEN 1 ELSE 0 END) AS settled_cards,
        SUM(CASE WHEN cr.result = 'win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN cr.result = 'loss' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN cr.result = 'push' THEN 1 ELSE 0 END) AS pushes,
        SUM(COALESCE(cr.pnl_units, 0)) AS total_pnl_units
      FROM card_results cr
      INNER JOIN card_payloads cp ON cr.card_id = cp.id
      WHERE cp.payload_data IS NOT NULL AND cp.payload_data != '' AND cr.status = 'settled'
      GROUP BY cr.sport
      ORDER BY cr.sport ASC
    `).all() as SegmentRow[];

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
      WHERE cr.status = 'settled'
      ORDER BY cr.settled_at DESC
      LIMIT ?
    `).all(limit) as LedgerRow[];

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
