// Shared TypeScript type definitions for the Market Pulse feature.
// The API route (web/src/app/api/market-pulse/route.ts) declares its own
// local interfaces -- do not modify that file. Import from here in all
// client/server components.

export interface LineGap {
  gameId: string;
  sport: string;
  homeTeam: string | null;
  awayTeam: string | null;
  market: string;
  outlierBook: string;
  outlierLine: number | null;
  consensusLine: number | null;
  delta: number;
  direction: 'home' | 'away' | 'over' | 'under';
  tier: 'TRIGGER' | 'WATCH';
  capturedAt: string;
}

export interface OddsGap {
  gameId: string;
  sport: string;
  homeTeam: string | null;
  awayTeam: string | null;
  market: string;
  line: number | null;
  side: 'home' | 'away' | 'over' | 'under';
  bestBook: string;
  bestPrice: number;
  worstBook: string;
  worstPrice: number;
  impliedEdgePct: number;
  tier: 'TRIGGER' | 'WATCH';
  capturedAt: string;
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
