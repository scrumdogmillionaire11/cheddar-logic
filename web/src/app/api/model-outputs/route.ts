/**
 * GET /api/model-outputs
 *
 * Read surface for the model_outputs table. Written by run_mlb_model.js,
 * run_nfl_model.js, and run_fpl_model.js via insertModelOutput(). Not written by NHL or NBA model
 * runners (they write card_payloads directly).
 *
 * Query params:
 *   ?sport=mlb|nfl  (optional) — filters to rows for that sport in the last 24h
 *
 * Response: { success: boolean, data: ModelOutputRow[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getDatabaseReadOnly,
  closeReadOnlyInstance,
  getModelOutputsBySport,
} from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  performSecurityChecks,
  addRateLimitHeaders,
} from '../../../lib/api-security';

interface ModelOutputRow {
  id: string;
  game_id: string;
  sport: string;
  model_name: string;
  model_version: string;
  prediction_type: string;
  predicted_at: string;
  confidence: number | null;
  output_data: unknown;
  odds_snapshot_id: string | null;
  job_run_id: string | null;
}

export async function GET(request: NextRequest) {
  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;
  try {
    const securityCheck = performSecurityChecks(request, '/api/model-outputs');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    await ensureDbReady();

    const { searchParams } = request.nextUrl;
    const sportParam = searchParams.get('sport');
    const sport = sportParam ? sportParam.trim().toLowerCase() : null;

    db = getDatabaseReadOnly();

    let rows: ModelOutputRow[];

    if (sport) {
      const sinceUtc = new Date(Date.now() - 86_400_000).toISOString();
      rows = (getModelOutputsBySport as (sport: string, sinceUtc: string) => ModelOutputRow[])(sport, sinceUtc);
    } else {
      rows = db
        .prepare('SELECT * FROM model_outputs ORDER BY predicted_at DESC LIMIT 200')
        .all() as ModelOutputRow[];
    }

    // Parse output_data JSON string for each row
    const parsed = rows.map((row) => {
      let outputData: unknown = {};
      try {
        outputData = JSON.parse((row.output_data as string) || '{}');
      } catch {
        outputData = {};
      }
      return { ...row, output_data: outputData };
    });

    const response = NextResponse.json({ success: true, data: parsed });
    return addRateLimitHeaders(response, request);
  } catch (err) {
    console.error('[API] Error fetching model-outputs:', err);
    const errorResponse = NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
    return addRateLimitHeaders(errorResponse, request);
  } finally {
    if (db) closeReadOnlyInstance(db);
  }
}
