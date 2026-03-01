/**
 * GET /api/cards
 *
 * Returns betting dashboard cards (NBA, NHL, SOCCER, NCAAM).
 * FPL projections are served from cheddar-fpl-sage backend.
 *
 * Query params:
 * - sport: optional sport filter (case-insensitive)
 * - card_type: optional card type filter
 * - game_id: optional game ID filter
 * - include_expired: optional (true/false), default false
 * - dedupe: optional (default latest_per_game_type, use none for raw history)
 * - limit: optional (default 20, max 100)
 * - offset: optional (default 0, max 1000)
 *
 * Response:
 * {
 *   success: boolean,
 *   data: [
 *     {
 *       id: string,
 *       gameId: string,
 *       sport: string,
 *       cardType: string,
 *       cardTitle: string,
 *       createdAt: string,
 *       expiresAt: string | null,
 *       payloadData: object | null,
 *       payloadParseError: boolean,
 *       modelOutputIds: string | null
 *     }
 *   ],
 *   error?: string
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { RESOURCE, initDb, getDatabase, closeDatabase } from '@cheddar-logic/data';
import { requireEntitlementForRequest } from '@/lib/auth/server';

interface CardRow {
  id: string;
  game_id: string;
  sport: string;
  card_type: string;
  card_title: string;
  created_at: string;
  expires_at: string | null;
  payload_data: string;
  model_output_ids: string | null;
}

function clampNumber(value: string | null, fallback: number, min: number, max: number) {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseBoolean(value: string | null) {
  if (!value) return false;
  return ['true', '1', 'yes'].includes(value.toLowerCase());
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
  try {
    await initDb();

    // AUTH DISABLED: Commenting out auth walls to allow public access
    // const access = requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD);
    // if (!access.ok) {
    //   return NextResponse.json(
    //     { success: false, error: access.error },
    //     { status: access.status }
    //   );
    // }

    const { searchParams } = request.nextUrl;
    const sportParam = searchParams.get('sport');
    const sport = sportParam ? sportParam.toUpperCase() : null;
    const cardType = searchParams.get('card_type');
    const gameId = searchParams.get('game_id');
    const includeExpired = parseBoolean(searchParams.get('include_expired'));
    const dedupe = searchParams.get('dedupe');
    const limit = clampNumber(searchParams.get('limit'), 20, 1, 100);
    const offset = clampNumber(searchParams.get('offset'), 0, 0, 1000);

    const db = getDatabase();

    const where: string[] = [];
    const params: Array<string | number> = [];

    if (sport) {
      where.push('sport = ?');
      params.push(sport);
    }

    if (cardType) {
      where.push('card_type = ?');
      params.push(cardType);
    }

    if (gameId) {
      where.push('game_id = ?');
      params.push(gameId);
    }

    if (!includeExpired) {
      where.push('(expires_at IS NULL OR expires_at > datetime(\'now\'))');
    }

    // Exclude FPL cards - they are served from cheddar-fpl-sage backend
    where.push('sport != \'FPL\'');

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const dedupeMode = dedupe === 'none' ? 'none' : 'latest_per_game_type';
    const sql = dedupeMode === 'none'
      ? `
        SELECT * FROM card_payloads
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `
      : `
        WITH ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY game_id, card_type
              ORDER BY created_at DESC
            ) AS rn
          FROM card_payloads
          ${whereSql}
        )
        SELECT * FROM ranked
        WHERE rn = 1
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `;

    const stmt = db.prepare(sql);

    const rows = stmt.all(...params, limit, offset) as CardRow[];

    const response = rows.map((card) => {
      const parsed = safeJsonParse(card.payload_data);
      return {
        id: card.id,
        gameId: card.game_id,
        sport: card.sport,
        cardType: card.card_type,
        cardTitle: card.card_title,
        createdAt: card.created_at,
        expiresAt: card.expires_at,
        payloadData: parsed.data,
        payloadParseError: parsed.error,
        modelOutputIds: card.model_output_ids
      };
    });

    return NextResponse.json(
      { success: true, data: response },
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[API] Error fetching cards:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  } finally {
    closeDatabase();
  }
}
