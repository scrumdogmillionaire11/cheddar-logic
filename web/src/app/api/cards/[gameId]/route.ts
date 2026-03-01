/**
 * GET /api/cards/[gameId]
 * 
 * Fetch all non-expired card payloads for a specific game (betting dashboard only).
 * FPL projections are served from cheddar-fpl-sage backend.
 * 
 * Query params:
 * - cardType: optional filter by card type
 * - dedupe: optional (default latest_per_game_type, use none for raw history)
 * - limit: max cards (default 10)
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
 *       createdAt: string (ISO 8601),
 *       expiresAt: string | null,
 *       payloadData: object | null (parsed JSON),
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ gameId: string }> }
) {
  try {
    await initDb();

    const access = requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD);
    if (!access.ok) {
      return NextResponse.json(
        { success: false, error: access.error },
        { status: access.status }
      );
    }

    const { gameId } = await params;
    const { searchParams } = request.nextUrl;
    const cardType = searchParams.get('cardType') || searchParams.get('card_type');
    const includeExpired = parseBoolean(searchParams.get('include_expired'));
    const dedupe = searchParams.get('dedupe');
    const limit = clampNumber(searchParams.get('limit'), 10, 1, 100);
    const offset = clampNumber(searchParams.get('offset'), 0, 0, 1000);
    
    if (!gameId) {
      return NextResponse.json(
        { success: false, error: 'gameId is required' },
        { status: 400 }
      );
    }
    
    // Open database connection
    const db = getDatabase();
    
    const where: string[] = ['game_id = ?'];
    const paramsList: Array<string | number> = [gameId];
    
    if (cardType) {
      where.push('card_type = ?');
      paramsList.push(cardType);
    }
    
    if (!includeExpired) {
      where.push('(expires_at IS NULL OR expires_at > datetime(\'now\'))');
    }
    
    // Exclude FPL cards - they are served from cheddar-fpl-sage backend
    where.push('sport != \'FPL\'');
    
    const dedupeMode = dedupe === 'none' ? 'none' : 'latest_per_game_type';
    const sql = dedupeMode === 'none'
      ? `
        SELECT * FROM card_payloads
        WHERE ${where.join(' AND ')}
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
          WHERE ${where.join(' AND ')}
        )
        SELECT * FROM ranked
        WHERE rn = 1
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `;

    const stmt = db.prepare(sql);
    
    const cards = stmt.all(...paramsList, limit, offset) as CardRow[];
    
    // Parse JSON fields for response
    const response = cards.map(card => {
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
