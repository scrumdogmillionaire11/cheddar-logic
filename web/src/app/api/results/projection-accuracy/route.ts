import { NextResponse } from 'next/server.js';
import type { ProjectionAccuracyResponse } from '@/lib/types/projection-accuracy';
import data from '@cheddar-logic/data';

const {
  closeReadOnlyInstance,
  getDatabaseReadOnly,
  getProjectionAccuracyEvalSummary,
  getProjectionAccuracyEvals,
  getProjectionAccuracyMarketHealth,
  PROJECTION_ANALYTICS_CONTRACT_BY_MARKET_FAMILY,
} = data;

const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_LOOKBACK_DAYS = 365;
const VALID_MARKETS = new Set(Object.keys(PROJECTION_ANALYTICS_CONTRACT_BY_MARKET_FAMILY));

function parseLookbackDays(value: string | null): number {
  if (!value) return DEFAULT_LOOKBACK_DAYS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_LOOKBACK_DAYS) {
    return Number.NaN;
  }
  return parsed;
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const marketFamily = searchParams.get('market_family');
  const days = parseLookbackDays(searchParams.get('days'));

  if (Number.isNaN(days)) {
    return NextResponse.json({ error: 'Invalid days parameter (1-365)' }, { status: 400 });
  }
  if (marketFamily && !VALID_MARKETS.has(marketFamily)) {
    return NextResponse.json({ error: 'Invalid market_family' }, { status: 400 });
  }

  const capturedAtGte = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString();

  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;
  try {
    db = getDatabaseReadOnly();
    const filters = {
      capturedAtGte,
      ...(marketFamily ? { marketFamily } : {}),
    };
    const summary = getProjectionAccuracyEvalSummary(db, {
      ...filters,
      lineRole: 'SYNTHETIC',
    });
    const rows = getProjectionAccuracyEvals(db, {
      ...filters,
      limit: 200,
    });
    const marketHealth = getProjectionAccuracyMarketHealth(db, {
      ...(marketFamily ? { marketFamily } : {}),
    });

    const payload: ProjectionAccuracyResponse = {
      generatedAt: new Date().toISOString(),
      lookbackDays: days,
      summary,
      marketHealth,
      rows,
    };

    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[API] projection-accuracy error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (db) closeReadOnlyInstance(db);
  }
}
