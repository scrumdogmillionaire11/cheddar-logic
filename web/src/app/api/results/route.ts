import { NextRequest, NextResponse } from 'next/server';
import { initDb, getDatabase, closeDatabase } from '@cheddar-logic/data';

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

const CALL_PATTERNS = [
  '%-totals-call',
  '%-spread-call',
];

function buildCardCategoryFilter(category: string | null, alias: string): { sql: string; params: string[] } {
  if (!category) return { sql: '', params: [] };

  if (category === 'driver') {
    const conditions = DRIVER_PATTERNS.map(() => `${alias}.card_type LIKE ?`).join(' OR ');
    return { sql: `AND (${conditions})`, params: DRIVER_PATTERNS };
  } else {
    // call
    const conditions = CALL_PATTERNS.map(() => `${alias}.card_type LIKE ?`).join(' OR ');
    return { sql: `AND (${conditions})`, params: CALL_PATTERNS };
  }
}

export async function GET(request: NextRequest) {
  let db: ReturnType<typeof getDatabase> | null = null;
  try {
    await initDb();
    db = getDatabase();

    const { searchParams } = request.nextUrl;
    const limit = clampNumber(searchParams.get('limit'), 50, 1, 200);

    // Parse and sanitize filter params
    const rawSport = searchParams.get('sport');
    const sport: string | null = rawSport && (ALLOWED_SPORTS as readonly string[]).includes(rawSport.toUpperCase())
      ? rawSport.toUpperCase()
      : null;

    const rawCategory = searchParams.get('card_category');
    const cardCategory: string | null = rawCategory && (ALLOWED_CATEGORIES as readonly string[]).includes(rawCategory.toLowerCase())
      ? rawCategory.toLowerCase()
      : null;

    const rawConfidence = searchParams.get('min_confidence');
    const minConfidence: number | null = rawConfidence !== null
      ? Math.min(Math.max(Number.parseFloat(rawConfidence), 0), 100)
      : null;

    const rawMarket = searchParams.get('market');
    const market: string | null = rawMarket && (ALLOWED_MARKETS as readonly string[]).includes(rawMarket.toLowerCase())
      ? rawMarket.toLowerCase()
      : null;

    // Build filter SQL fragments for the dedup subquery (inner)
    const sportFilter = sport ? `AND UPPER(cr3.sport) = ?` : '';
    const sportParams = sport ? [sport] : [];

    const categoryFilter3 = buildCardCategoryFilter(cardCategory, 'cr3');
    const confidenceFilter3 = minConfidence !== null
      ? `AND CAST(json_extract(cp3.payload_data, '$.confidence_pct') AS REAL) >= ?`
      : '';
    const confidenceParams3 = minConfidence !== null ? [minConfidence] : [];

    const marketFilter3 = market ? `AND LOWER(cr3.recommended_bet_type) = ?` : '';
    const marketParams3 = market ? [market] : [];

    // Same for outer dedup query
    const sportFilter2 = sport ? `AND UPPER(cr2.sport) = ?` : '';
    const categoryFilter2 = buildCardCategoryFilter(cardCategory, 'cr2');
    const confidenceFilter2 = minConfidence !== null
      ? `AND CAST(json_extract(cp2.payload_data, '$.confidence_pct') AS REAL) >= ?`
      : '';
    const confidenceParams2 = minConfidence !== null ? [minConfidence] : [];

    const marketFilter2 = market ? `AND LOWER(cr2.recommended_bet_type) = ?` : '';
    const marketParams2 = market ? [market] : [];

    // Deduplication: one card per game per market (moneyline/total),
    // highest confidence, excluding PASS recommendations.
    // Apply filters in inner subquery so dedupedIdSet is pre-filtered.
    const dedupSql = `
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
          ${sportFilter}
          ${categoryFilter3.sql}
          ${confidenceFilter3}
          ${marketFilter3}
        GROUP BY cr3.game_id, cr3.recommended_bet_type
      ) best ON cr2.game_id = best.game_id
            AND cr2.recommended_bet_type = best.recommended_bet_type
            AND CAST(json_extract(cp2.payload_data, '$.confidence_pct') AS REAL) = best.max_conf
      WHERE cr2.status = 'settled'
        AND json_extract(cp2.payload_data, '$.recommendation.type') != 'PASS'
        ${sportFilter2}
        ${categoryFilter2.sql}
        ${confidenceFilter2}
        ${marketFilter2}
      GROUP BY cr2.game_id, cr2.recommended_bet_type
    `;

    const dedupParams = [
      ...sportParams,
      ...categoryFilter3.params,
      ...confidenceParams3,
      ...marketParams3,
      ...sportParams,
      ...categoryFilter2.params,
      ...confidenceParams2,
      ...marketParams2,
    ];

    const dedupedIdRows = db.prepare(dedupSql).all(...dedupParams) as { id: string }[];
    const placeholders = dedupedIdRows.map(() => '?').join(',');

    if (dedupedIdRows.length === 0) {
      return NextResponse.json(
        {
          success: true,
          data: {
            summary: { totalCards: 0, settledCards: 0, wins: 0, losses: 0, pushes: 0, totalPnlUnits: 0, winRate: 0, avgPnl: 0 },
            segments: [],
            ledger: [],
            filters: { sport, cardCategory, minConfidence, market },
          },
        },
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

    // card_category CASE expression for segments
    const cardCaseSql = `
      CASE
        WHEN cr.card_type LIKE '%-totals-call' OR cr.card_type LIKE '%-spread-call'
          THEN 'call'
        ELSE 'driver'
      END AS card_category
    `;

    const segments = db.prepare(`
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
      INNER JOIN card_payloads cp ON cr.card_id = cp.id
      WHERE cr.id IN (${placeholders})
      GROUP BY cr.sport, card_category, cr.recommended_bet_type
      ORDER BY cr.sport ASC, card_category ASC, cr.recommended_bet_type ASC
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

      // Derive display prediction from recommendation.type (authoritative BET decision).
      // Falls back to raw prediction field for legacy cards without recommendation.type.
      const recType = payload
        && typeof (payload.recommendation as Record<string, unknown> | null | undefined)?.['type'] === 'string'
        ? ((payload.recommendation as Record<string, unknown>)['type'] as string)
        : null;

      let prediction: string | null = null;
      if (recType && recType !== 'PASS') {
        if (recType === 'ML_HOME' || recType === 'SPREAD_HOME') prediction = 'HOME';
        else if (recType === 'ML_AWAY' || recType === 'SPREAD_AWAY') prediction = 'AWAY';
        else if (recType === 'TOTAL_OVER') prediction = 'OVER';
        else if (recType === 'TOTAL_UNDER') prediction = 'UNDER';
      } else if (!recType && payload && typeof payload.prediction === 'string') {
        prediction = payload.prediction;
      }

      // price — extracted from odds_context based on recommendation.type (preferred) or prediction (legacy)
      let price: number | null = null;
      if (payload && payload.odds_context && typeof payload.odds_context === 'object') {
        const oddsCtx = payload.odds_context as Record<string, unknown>;
        if (recType === 'ML_HOME') {
          price = typeof oddsCtx.h2h_home === 'number' ? oddsCtx.h2h_home : null;
        } else if (recType === 'ML_AWAY') {
          price = typeof oddsCtx.h2h_away === 'number' ? oddsCtx.h2h_away : null;
        } else if (recType === 'TOTAL_OVER' || recType === 'TOTAL_UNDER') {
          price = typeof oddsCtx.total === 'number' ? oddsCtx.total : null;
        } else if (recType === 'SPREAD_HOME') {
          price = typeof oddsCtx.spread_home === 'number' ? oddsCtx.spread_home : null;
        } else if (recType === 'SPREAD_AWAY') {
          price = typeof oddsCtx.spread_away === 'number' ? oddsCtx.spread_away : null;
        } else if (prediction === 'HOME') {
          price = typeof oddsCtx.h2h_home === 'number' ? oddsCtx.h2h_home : null;
        } else if (prediction === 'AWAY') {
          price = typeof oddsCtx.h2h_away === 'number' ? oddsCtx.h2h_away : null;
        } else if (prediction === 'OVER' || prediction === 'UNDER') {
          price = typeof oddsCtx.total === 'number' ? oddsCtx.total : null;
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
            cardCategory: row.card_category,
            recommendedBetType: row.recommended_bet_type || 'unknown',
            settledCards: Number(row.settled_cards || 0),
            wins: Number(row.wins || 0),
            losses: Number(row.losses || 0),
            pushes: Number(row.pushes || 0),
            totalPnlUnits: Number(row.total_pnl_units || 0),
          })),
          ledger: ledgerRows,
          filters: { sport, cardCategory, minConfidence, market },
        },
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[API] Error fetching results:', error);
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    }
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  } finally {
    if (db) {
      closeDatabase();
    }
  }
}
