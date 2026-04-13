/**
 * GET /api/props/player-shots
 *
 * Returns recent player_shot_logs rows across all tracked players.
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

interface PlayerShotRow {
  id: string;
  sport: string;
  player_id: number;
  player_name: string | null;
  game_id: string;
  game_date: string | null;
  opponent: string | null;
  is_home: number;
  shots: number | null;
  toi_minutes: number | null;
  fetched_at: string;
  created_at: string;
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
    const securityCheck = performSecurityChecks(request, '/api/props/player-shots');
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

    let rows: PlayerShotRow[];
    if (dateParam) {
      rows = db
        .prepare(
          `SELECT id, sport, player_id, player_name, game_id, game_date,
                  opponent, is_home, shots, toi_minutes, fetched_at, created_at
           FROM player_shot_logs
           WHERE game_date = ?
           ORDER BY player_name ASC, fetched_at DESC
           LIMIT ?`,
        )
        .all(dateParam, limit) as PlayerShotRow[];
    } else {
      rows = db
        .prepare(
          `SELECT id, sport, player_id, player_name, game_id, game_date,
                  opponent, is_home, shots, toi_minutes, fetched_at, created_at
           FROM player_shot_logs
           ORDER BY game_date DESC, fetched_at DESC
           LIMIT ?`,
        )
        .all(limit) as PlayerShotRow[];
    }

    const response = NextResponse.json({ success: true, data: rows, count: rows.length });
    return addRateLimitHeaders(response, request);
  } catch (err) {
    console.error('[/api/props/player-shots] error', err);
    const errorResponse = NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
    return addRateLimitHeaders(errorResponse, request);
  } finally {
    if (db) closeReadOnlyInstance(db);
  }
}
