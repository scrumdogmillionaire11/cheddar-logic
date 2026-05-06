/**
 * GET /api/market-pulse
 *
 * Returns Market Pulse opportunities for the dashboard.
 * Scans the latest snapshot per game on each request to keep displayed prices current.
 *
 * Query params:
 *   sport        - optional; one of NBA, MLB, NHL (default: ALL)
 *   includeWatch - optional; set to "true" to include WATCH-tier items
 *                  (default: SCOUT + MARKET_ONLY + EXPIRED)
 */

import type {
  LineGap,
  MarketPulseResponse,
  OddsGap,
  OddsSnapshot,
} from '@/lib/types/market-pulse';
import {
  buildMarketPulsePayload,
  filterOpportunitiesByWatch,
  logMarketPulseSummary,
} from '@/lib/market-pulse/observability';
import type { ProjectionReaders } from '@/lib/market-pulse/opportunity-engine';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cheddarData = require('@cheddar-logic/data') as {
  getOddsSnapshots: (sport: string, sinceUtc: string) => OddsSnapshot[];
  getLatestMlbModelOutput: ProjectionReaders['getLatestMlbModelOutput'];
  getLatestNbaModelOutput: ProjectionReaders['getLatestNbaModelOutput'];
  getLatestNhlModelOutput: ProjectionReaders['getLatestNhlModelOutput'];
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scanLineDiscrepancies, scanOddsDiscrepancies } = require(
  '@cheddar-logic/models/src/mispricing-scanner.js',
) as {
  scanLineDiscrepancies: (
    snapshots: OddsSnapshot[],
    config?: Record<string, unknown>,
  ) => LineGap[];
  scanOddsDiscrepancies: (
    snapshots: OddsSnapshot[],
    config?: Record<string, unknown>,
  ) => OddsGap[];
};

interface CacheEntry {
  payload: MarketPulseResponse;
  expiresAt: number;
}

const CACHE_TTL_MS = 0;
const LOOKBACK_MS = 30 * 60 * 1000;

const VALID_SPORTS = ['ALL', 'NBA', 'MLB', 'NHL'] as const;
type ValidSport = (typeof VALID_SPORTS)[number];

const cache = new Map<string, CacheEntry>();

function loadSnapshots(sport: ValidSport, sinceUtc: string): OddsSnapshot[] {
  if (sport === 'ALL') {
    return [
      ...cheddarData.getOddsSnapshots('NBA', sinceUtc),
      ...cheddarData.getOddsSnapshots('MLB', sinceUtc),
      ...cheddarData.getOddsSnapshots('NHL', sinceUtc),
    ];
  }
  return cheddarData.getOddsSnapshots(sport, sinceUtc);
}

function keepLatestSnapshotPerGame(snapshots: OddsSnapshot[]): OddsSnapshot[] {
  const latestByGame = new Map<string, OddsSnapshot>();

  for (const snapshot of snapshots) {
    const key = `${snapshot.sport}:${snapshot.game_id}`;
    const current = latestByGame.get(key);
    if (!current) {
      latestByGame.set(key, snapshot);
      continue;
    }

    const currentMs = new Date(current.captured_at).getTime();
    const incomingMs = new Date(snapshot.captured_at).getTime();
    if (!Number.isFinite(incomingMs)) continue;
    if (!Number.isFinite(currentMs) || incomingMs > currentMs) {
      latestByGame.set(key, snapshot);
    }
  }

  return Array.from(latestByGame.values());
}

export async function GET(request: Request): Promise<Response> {
  const requestStartedAt = Date.now();

  try {
    const { searchParams } = new URL(request.url);
    const rawSport = searchParams.get('sport')?.toUpperCase() ?? 'ALL';
    const includeWatch = searchParams.get('includeWatch') === 'true';

    if (!VALID_SPORTS.includes(rawSport as ValidSport)) {
      return Response.json({ error: 'Invalid sport' }, { status: 400 });
    }

    const sport = rawSport as ValidSport;
    const cached = cache.get(sport);
    if (CACHE_TTL_MS > 0 && cached && cached.expiresAt > Date.now()) {
      return Response.json(filterOpportunitiesByWatch(cached.payload, includeWatch));
    }

    const sinceUtc = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const snapshots = keepLatestSnapshotPerGame(loadSnapshots(sport, sinceUtc));
    const lineGaps = scanLineDiscrepancies(snapshots);
    lineGaps.sort((left, right) => (right.delta ?? 0) - (left.delta ?? 0));
    const oddsGaps = scanOddsDiscrepancies(snapshots);
    oddsGaps.sort(
      (left, right) => (right.impliedEdgePct ?? 0) - (left.impliedEdgePct ?? 0),
    );

    const payload = buildMarketPulsePayload({
      snapshots,
      lineGaps,
      oddsGaps,
      includeWatch,
      nowMs: Date.now(),
      readers: {
        getLatestMlbModelOutput: cheddarData.getLatestMlbModelOutput,
        getLatestNbaModelOutput: cheddarData.getLatestNbaModelOutput,
        getLatestNhlModelOutput: cheddarData.getLatestNhlModelOutput,
      },
    });

    payload.meta.durationMs = Date.now() - requestStartedAt;
    logMarketPulseSummary(payload);

    if (CACHE_TTL_MS > 0) {
      cache.set(sport, {
        payload,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }

    return Response.json(payload);
  } catch (error) {
    console.error('[API] market-pulse error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
