/**
 * GET /api/admin/odds-ingest
 *
 * Development-only diagnostics endpoint for odds ingest failures.
 *
 * Query parameters:
 * - sinceHours: lookback window in hours (default 24, max 720)
 * - limit: recent failure rows to return (default 50, max 500)
 * - reasonLimit: grouped reason rows to return (default 20, max 100)
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getOddsIngestFailureSummary,
} from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';

function parseBoundedInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export async function GET(request: NextRequest) {
  // Admin secret gate (behind ENABLE_AUTH_WALLS — not yet active)
  if (process.env.ENABLE_AUTH_WALLS === 'true') {
    const adminSecret = process.env.ADMIN_API_SECRET;
    const providedSecret = request.headers.get('x-admin-secret');
    if (!adminSecret || providedSecret !== adminSecret) {
      return NextResponse.json(
        { success: false, error: 'Forbidden' },
        { status: 403 },
      );
    }
  }

  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      {
        success: false,
        error: 'Odds ingest diagnostics endpoint only available in development',
      },
      { status: 403 },
    );
  }

  try {
    await ensureDbReady();

    const { searchParams } = new URL(request.url);
    const sinceHours = parseBoundedInt(
      searchParams.get('sinceHours'),
      24,
      1,
      24 * 30,
    );
    const limit = parseBoundedInt(searchParams.get('limit'), 50, 1, 500);
    const reasonLimit = parseBoundedInt(
      searchParams.get('reasonLimit'),
      20,
      1,
      100,
    );

    const summary = getOddsIngestFailureSummary({
      sinceHours,
      limit,
      reasonLimit,
      readOnly: true,
    });

    return NextResponse.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      {
        success: false,
        error: `Failed to read odds ingest diagnostics: ${message}`,
      },
      { status: 500 },
    );
  }
}
