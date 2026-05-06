// Shared TypeScript type definitions for the Market Pulse feature.

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

export interface OddsSnapshot {
  game_id: string;
  sport: string;
  captured_at: string;
  raw_data: string;
}

export type MarketType = 'SPREAD' | 'TOTAL' | 'MONEYLINE';
export type OpportunitySide = 'HOME' | 'AWAY' | 'OVER' | 'UNDER';
export type SignalKind = 'LINE' | 'PRICE';
export type FreshnessStatus =
  | 'FRESH'
  | 'STALE_VERIFY_REQUIRED'
  | 'EXPIRED';
export type ProjectionStatus =
  | 'CONFIRMED'
  | 'MISMATCHED'
  | 'UNAVAILABLE'
  | 'UNSUPPORTED_SPORT';
export type OpportunityKind =
  | 'PROJECTION_CONFIRMED'
  | 'MARKET_ONLY'
  | 'CONFLICTING'
  | 'UNSUPPORTED';
export type DisplayTier = 'SCOUT' | 'WATCH' | 'MARKET_ONLY' | 'EXPIRED';
export type SuppressionReason = 'MERGED_COMPOSITE_SIGNAL' | null;

export interface MarketPulseOpportunity {
  opportunityId: string;
  gameId: string;
  sport: string;
  homeTeam: string | null;
  awayTeam: string | null;
  marketType: MarketType;
  displayMarket: string;
  line: number | null;
  side: OpportunitySide;
  signalKinds: SignalKind[];
  bestBook: string;
  bestPrice: number | null;
  referenceBook: string;
  referencePrice: number | null;
  marketGapPct: number | null;
  lineDelta: number | null;
  capturedAt: string;
  minutesAgo: number;
  freshnessStatus: FreshnessStatus;
  projectionStatus: ProjectionStatus;
  projectionValue?: number;
  fairPrice?: number;
  opportunityKind: OpportunityKind;
  displayTier: DisplayTier;
  verifyBeforeBetLabel: string | null;
  suppressionReason: SuppressionReason;
}

export interface MarketPulseMeta {
  gamesScanned: number;
  booksScanned: number;
  rawLineGaps: number;
  rawOddsGaps: number;
  surfaced: number;
  droppedDuplicate: number;
  droppedStale: number;
  droppedUnsupported: number;
  droppedConflict: number;
  freshCount: number;
  staleVerifyRequiredCount: number;
  expiredCount: number;
  projectionAlignedWatchCount: number;
  marketOnlyCount: number;
  durationMs: number;
}

export interface MarketPulseResponse {
  scannedAt: string;
  opportunities: MarketPulseOpportunity[];
  meta: MarketPulseMeta;
}

export type SportFilter = 'ALL' | 'NBA' | 'MLB' | 'NHL';
