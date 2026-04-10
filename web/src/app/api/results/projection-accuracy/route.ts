import { NextResponse } from 'next/server';
import type { ProjectionAccuracyResponse } from '@/lib/types/projection-accuracy';
import { getDatabaseReadOnly, closeReadOnlyInstance, getProjectionAccuracySummary } from '@cheddar-logic/data';
// Use static top-level imports (not await import). All 3 are re-exported from packages/data/index.js (WI-0864).

const VALID_FAMILIES = ['MLB_F5_TOTAL', 'NHL_1P_TOTAL'] as const;

const DEFAULT_LOOKBACK_DAYS = 90;
const MAX_LOOKBACK_DAYS = 365;

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const familyParam = searchParams.get('family');
  const daysParam = searchParams.get('days');

  // Validate family
  if (familyParam && !(VALID_FAMILIES as readonly string[]).includes(familyParam)) {
    return NextResponse.json({ error: 'Invalid family' }, { status: 400 });
  }

  // Validate days
  const lookbackDays = daysParam ? parseInt(daysParam, 10) : DEFAULT_LOOKBACK_DAYS;
  if (!Number.isFinite(lookbackDays) || lookbackDays < 1 || lookbackDays > MAX_LOOKBACK_DAYS) {
    return NextResponse.json({ error: 'Invalid days parameter (1–365)' }, { status: 400 });
  }

  const gameDateGte = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  const familiesToQuery: string[] = familyParam
    ? [familyParam]
    : [...VALID_FAMILIES];

  // Static imports at top of file (matching all other web API routes).
  // getDatabaseReadOnly() opens a read-only connection using CHEDDAR_DB_PATH (no args).
  // Always closeReadOnlyInstance(db) in finally to avoid handle leaks — matches projection-settled/route.ts.
  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;
  try {
    db = getDatabaseReadOnly();

    const families = familiesToQuery.map((cardFamily: string) =>
      getProjectionAccuracySummary(db!, { cardFamily, gameDateGte })
    );

    const payload: ProjectionAccuracyResponse = {
      generatedAt: new Date().toISOString(),
      lookbackDays,
      families,
    };

    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[API] projection-accuracy error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (db) {
      closeReadOnlyInstance(db);
    }
  }
}
