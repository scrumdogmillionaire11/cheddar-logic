// Shared TypeScript type definitions for the Market Pulse feature.
// The API route (web/src/app/api/market-pulse/route.ts) declares its own
// local interfaces — do not modify that file. Import from here in all
// client/server components.

export interface LineGap {
  gameId: string;
  sport: string;
  home: string;
  away: string;
  market: string;
  outlierBook: string;
  delta: number;
  tier: 'TRIGGER' | 'WATCH';
  [key: string]: unknown;
}

export interface OddsGap {
  gameId: string;
  sport: string;
  home: string;
  away: string;
  market: string;
  outlierBook: string;
  impliedEdgePct: number;
  tier: 'TRIGGER' | 'WATCH';
  [key: string]: unknown;
}

export interface MarketPulseMeta {
  gamesScanned: number;
  booksScanned: number;
  lineGapCount: number;
  oddsGapCount: number;
}

export interface MarketPulseResponse {
  scannedAt: string;
  lineGaps: LineGap[];
  oddsGaps: OddsGap[];
  meta: MarketPulseMeta;
}

export type SportFilter = 'ALL' | 'NBA' | 'MLB' | 'NHL';
