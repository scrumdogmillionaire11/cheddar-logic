import type {
  LineGap,
  MarketPulseMeta,
  MarketPulseResponse,
  OddsGap,
  OddsSnapshot,
} from '@/lib/types/market-pulse';
import {
  buildMarketPulseView,
  type ProjectionReaders,
} from '@/lib/market-pulse/opportunity-engine';

function extractUniqueBooks(snapshots: OddsSnapshot[]): Set<string> {
  const books = new Set<string>();
  for (const snapshot of snapshots) {
    try {
      const raw = JSON.parse(snapshot.raw_data ?? '{}') as Record<string, unknown>;
      const markets =
        raw.markets && typeof raw.markets === 'object'
          ? (raw.markets as Record<string, unknown>)
          : raw;
      const entries = [
        ...((markets.spreads ?? []) as Array<{ book?: string }>),
        ...((markets.totals ?? []) as Array<{ book?: string }>),
        ...((markets.h2h ?? []) as Array<{ book?: string }>),
      ];
      for (const entry of entries) {
        if (entry.book && typeof entry.book === 'string') {
          books.add(entry.book);
        }
      }
    } catch {
      // Ignore malformed snapshot payloads.
    }
  }
  return books;
}

export function filterOpportunitiesByWatch(
  payload: MarketPulseResponse,
  includeWatch: boolean,
): MarketPulseResponse {
  if (includeWatch) return payload;
  return {
    ...payload,
    opportunities: payload.opportunities.filter(
      (opportunity) => opportunity.displayTier !== 'WATCH',
    ),
  };
}

export function buildMarketPulsePayload(input: {
  snapshots: OddsSnapshot[];
  lineGaps: LineGap[];
  oddsGaps: OddsGap[];
  includeWatch: boolean;
  nowMs?: number;
  readers?: ProjectionReaders;
}): MarketPulseResponse {
  const nowMs = input.nowMs ?? Date.now();
  const view = buildMarketPulseView({
    snapshots: input.snapshots,
    lineGaps: input.lineGaps,
    oddsGaps: input.oddsGaps,
    nowMs,
    readers: input.readers,
  });

  const uniqueGameIds = new Set(input.snapshots.map((snapshot) => snapshot.game_id));
  const uniqueBooks = extractUniqueBooks(input.snapshots);
  const meta: MarketPulseMeta = {
    gamesScanned: uniqueGameIds.size,
    booksScanned: uniqueBooks.size,
    rawLineGaps: input.lineGaps.length,
    rawOddsGaps: input.oddsGaps.length,
    surfaced: view.opportunities.length,
    droppedDuplicate: view.counters.droppedDuplicate,
    droppedStale: view.counters.droppedStale,
    droppedUnsupported: view.counters.droppedUnsupported,
    droppedConflict: view.counters.droppedConflict,
    freshCount: view.counters.freshCount,
    staleVerifyRequiredCount: view.counters.staleVerifyRequiredCount,
    expiredCount: view.counters.expiredCount,
    projectionAlignedWatchCount: view.counters.projectionAlignedWatchCount,
    marketOnlyCount: view.counters.marketOnlyCount,
    durationMs: 0,
  };

  return filterOpportunitiesByWatch(
    {
      scannedAt: new Date(nowMs).toISOString(),
      opportunities: view.opportunities,
      meta,
    },
    input.includeWatch,
  );
}

export function logMarketPulseSummary(payload: MarketPulseResponse): void {
  console.info(
    '[API] market-pulse summary',
    JSON.stringify({
      scannedAt: payload.scannedAt,
      gamesScanned: payload.meta.gamesScanned,
      booksScanned: payload.meta.booksScanned,
      rawLineGaps: payload.meta.rawLineGaps,
      rawOddsGaps: payload.meta.rawOddsGaps,
      surfaced: payload.meta.surfaced,
      droppedDuplicate: payload.meta.droppedDuplicate,
      droppedStale: payload.meta.droppedStale,
      droppedUnsupported: payload.meta.droppedUnsupported,
      droppedConflict: payload.meta.droppedConflict,
      freshCount: payload.meta.freshCount,
      staleVerifyRequiredCount: payload.meta.staleVerifyRequiredCount,
      expiredCount: payload.meta.expiredCount,
      projectionAlignedWatchCount: payload.meta.projectionAlignedWatchCount,
      marketOnlyCount: payload.meta.marketOnlyCount,
      durationMs: payload.meta.durationMs,
    }),
  );
}
