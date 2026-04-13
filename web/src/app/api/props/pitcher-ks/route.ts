/**
 * GET /api/props/pitcher-ks
 *
 * Returns recent mlb_pitcher_game_logs rows joined with mlb_pitcher_stats
 * for pitcher name and team.
 *
 * Query params:
 *   ?limit=N   — number of rows to return (default 100, max 500)
 *   ?date=YYYY-MM-DD — filter to a specific game_date (optional)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabaseReadOnly, closeReadOnlyInstance } from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  performSecurityChecks,
  addRateLimitHeaders,
} from '../../../../lib/api-security';

export const runtime = 'nodejs';

interface PitcherKRow {
  id: string;
  mlb_pitcher_id: number;
  game_pk: number;
  game_date: string;
  season: number;
  innings_pitched: number | null;
  strikeouts: number | null;
  walks: number | null;
  hits: number | null;
  earned_runs: number | null;
  opponent: string | null;
  home_away: string | null;
  updated_at: string;
  full_name: string | null;
  team: string | null;
}

function clampLimit(raw: string | null): number {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isNaN(parsed) || parsed < 1) return 100;
  return Math.min(parsed, 500);
}

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function GET(request: NextRequest) {
  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;
  try {
    const securityCheck = performSecurityChecks(request, '/api/props/pitcher-ks');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    await ensureDbReady();

    const { searchParams } = request.nextUrl;
    const limit = clampLimit(searchParams.get('limit'));
    const dateParam = searchParams.get('date');

    if (dateParam && !isValidDate(dateParam)) {
      return NextResponse.json(
        { success: false, error: 'date must be in YYYY-MM-DD format' },
        { status: 400 },
      );
    }

    db = getDatabaseReadOnly();

    let rows: PitcherKRow[];
    if (dateParam) {
      rows = db
        .prepare(
          `SELECT gl.id, gl.mlb_pitcher_id, gl.game_pk, gl.game_date, gl.season,
                  gl.innings_pitched, gl.strikeouts, gl.walks, gl.hits,
                  gl.earned_runs, gl.opponent, gl.home_away, gl.updated_at,
                  ps.full_name, ps.team
           FROM mlb_pitcher_game_logs gl
           LEFT JOIN mlb_pitcher_stats ps ON ps.mlb_id = gl.mlb_pitcher_id
           WHERE gl.game_date = ?
           ORDER BY gl.strikeouts DESC, ps.full_name ASC
           LIMIT ?`,
        )
        .all(dateParam, limit) as PitcherKRow[];
    } else {
      rows = db
        .prepare(
          `SELECT gl.id, gl.mlb_pitcher_id, gl.game_pk, gl.game_date, gl.season,
                  gl.innings_pitched, gl.strikeouts, gl.walks, gl.hits,
                  gl.earned_runs, gl.opponent, gl.home_away, gl.updated_at,
                  ps.full_name, ps.team
           FROM mlb_pitcher_game_logs gl
           LEFT JOIN mlb_pitcher_stats ps ON ps.mlb_id = gl.mlb_pitcher_id
           ORDER BY gl.game_date DESC, gl.strikeouts DESC
           LIMIT ?`,
        )
        .all(limit) as PitcherKRow[];
    }

    const response = NextResponse.json({ success: true, data: rows, count: rows.length });
    return addRateLimitHeaders(response, request);
  } catch (err) {
    console.error('[/api/props/pitcher-ks] error', err);
    const errorResponse = NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
    return addRateLimitHeaders(errorResponse, request);
  } finally {
    if (db) closeReadOnlyInstance(db);
  }
}
