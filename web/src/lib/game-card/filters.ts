/**
 * Filter state and logic for GameCard filtering
 * Based on FILTER-FEATURE.md design
 */

import type { GameCard, Sport, Market, DriverTier, ExpressionStatus } from '../types/game-card';
import { GAME_TAGS } from '../types/game-card';
import { getPlayDisplayAction } from './decision';

/**
 * Sort modes for game cards
 */
export type SortMode = 'start_time' | 'odds_updated' | 'signal_strength' | 'pick_score';

export type FilterDebugFlags = {
  sport: boolean;
  timeWindow: boolean;
  oddsFreshness: boolean;
  market: boolean;
  actionability: boolean;
  driverStrength: boolean;
  riskFlags: boolean;
  search: boolean;
  welcomeHome: boolean;
  hasPicks: boolean;
  clearPlay: boolean;
};

/**
 * Filter configuration
 */
export interface GameFilters {
  // Sport / League
  sports: Sport[];
  leagues?: string[];
  
  // Time window
  timeWindow?: 'next_2h' | 'today' | 'custom';
  customTimeRange?: {
    start: string; // ISO
    end: string; // ISO
  };
  
  // Actionability
  statuses: ExpressionStatus[];
  
  // Market type
  markets: Market[];
  onlyGamesWithPicks: boolean;
   hasClearPlay: boolean; // play.market != 'NONE'
  onlyWelcomeHome?: boolean;
  
  // Driver strength
  minTier?: DriverTier; // BEST only / SUPER+ / WATCH+
  minConfidence?: number; // 0-1 range
  
  // Risk flags
  hideFragility: boolean;
  hideBlowout: boolean;
  hideLowCoverage: boolean;
  hideStaleOdds: boolean;
  
  // Search
  searchQuery: string;
  
  // Sort
  sortMode: SortMode;
}

/**
 * Default filter state
 */
export const DEFAULT_FILTERS: GameFilters = {
  sports: ['NHL', 'NBA', 'NCAAM', 'SOCCER'],
  statuses: ['FIRE', 'WATCH'],
  markets: ['ML', 'SPREAD', 'TOTAL'],
  onlyGamesWithPicks: false,
   hasClearPlay: false,
  onlyWelcomeHome: false,
  hideFragility: false,
  hideBlowout: false,
  hideLowCoverage: false,
  hideStaleOdds: false,
  searchQuery: '',
  sortMode: 'start_time',
};

function filterBySport(card: GameCard, filters: GameFilters): boolean {
  return filters.sports.includes(card.sport);
}

/**
 * Filter by time window
 */
function filterByTimeWindow(card: GameCard, filters: GameFilters): boolean {
  if (!filters.timeWindow) return true;
  
  const startTime = new Date(card.startTime).getTime();
  const now = new Date().getTime();
  
  if (filters.timeWindow === 'next_2h') {
    const twoHours = 2 * 60 * 60 * 1000;
    return startTime <= now + twoHours && startTime > now;
  }
  
  if (filters.timeWindow === 'today') {
    return card.tags.includes(GAME_TAGS.STARTS_TODAY);
  }
  
  if (filters.timeWindow === 'custom' && filters.customTimeRange) {
    const rangeStart = new Date(filters.customTimeRange.start).getTime();
    const rangeEnd = new Date(filters.customTimeRange.end).getTime();
    return startTime >= rangeStart && startTime <= rangeEnd;
  }
  
  return true;
}

/**
 * Filter by odds freshness (stale filter)
 */
function filterByOddsFreshness(card: GameCard, filters: GameFilters): boolean {
  if (!filters.hideStaleOdds) return true;
  
  // Hide if stale by 5+ minutes
  return !card.tags.includes(GAME_TAGS.STALE_5M);
}

/**
 * Normalize market string to canonical format
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function normalizeMarket(m?: string): string {
  if (!m) return 'INFO';
  const upper = m.toUpperCase();
  if (upper === 'ML' || upper === 'H2H') return 'MONEYLINE';
  if (upper === 'PUCKLINE') return 'SPREAD';
  if (upper === 'TEAM_TOTAL') return 'TOTAL';
  return upper;
}

/**
 * Map canonical market type to legacy Market enum for comparison
 */
function canonicalToLegacyMarket(canonical?: string): Market | null {
  if (!canonical) return null;
  const upper = canonical.toUpperCase();
  if (upper === 'MONEYLINE' || upper === 'ML') return 'ML';
  if (upper === 'SPREAD' || upper === 'PUCKLINE') return 'SPREAD';
  if (upper === 'TOTAL' || upper === 'TEAM_TOTAL') return 'TOTAL';
  if (upper === 'INFO') return null; // INFO items don't count as bettable markets
  return 'UNKNOWN';
}

/**
 * Filter by market availability
 * Checks both canonical market_type and legacy market fields
 * 
 * Special rule for Full Slate (when PASS is included):
 * - Allow PASS plays through even if their market doesn't match the filter
 */
function filterByMarketAvailability(card: GameCard, filters: GameFilters): boolean {
  if (filters.markets.length === 0) return true;

  const includePass = filters.statuses.includes('PASS');
  const displayAction = getPlayDisplayAction(card.play);
  
  // Full Slate lenient mode: let PASS plays through regardless of market
  if (includePass && displayAction === 'PASS') {
    return true;
  }

  // Check play's canonical market_type first
  const canonicalMarket = canonicalToLegacyMarket(card.play?.market_type);
  if (canonicalMarket && filters.markets.includes(canonicalMarket)) {
    return true;
  }

  // Fallback to legacy play.market
  const playMarket = card.play?.market;
  if (playMarket && playMarket !== 'NONE' && filters.markets.includes(playMarket)) {
    return true;
  }

  // Check drivers as final fallback
  return card.drivers.some(d => filters.markets.includes(d.market));
}

/**
 * Filter by actionability status
 * 
 * Special rule for Full Slate (when PASS is included):
 * - If statuses includes PASS, show any game with a play object OR blocked totals
 * - Otherwise, require exact status match
 */
function filterByActionability(card: GameCard, filters: GameFilters): boolean {
  if (filters.statuses.length === 0) return true;

  const includePass = filters.statuses.includes('PASS');
  const displayAction = getPlayDisplayAction(card.play);
  
  // Full Slate mode: include any game with a play or blocked totals
  if (includePass) {
    const hasPlay = card.play !== undefined;
    const hasBlockedTotals = Boolean(
      card.play?.market_type === 'TOTAL' &&
      displayAction === 'PASS' &&
      (card.play?.reason_codes?.includes('PASS_TOTAL_INSUFFICIENT_DATA') ||
        card.play?.tags?.includes('CONSISTENCY_BLOCK_TOTALS'))
    );
    const hasDrivers = card.drivers.length > 0;
    
    if (hasPlay || hasBlockedTotals || hasDrivers) {
      return true;
    }
  }
  
  // Standard mode: Check displayAction against filter
  // Map display action to filter status names
  let status: ExpressionStatus = 'PASS';
  if (displayAction === 'FIRE') {
    status = 'FIRE';
  } else if (displayAction === 'HOLD') {
    status = 'WATCH';
  }
  
  // Also check legacy expression choice if no play
  if (!displayAction || displayAction === 'PASS') {
    if (card.expressionChoice?.status) {
      status = card.expressionChoice.status;
    } else if (card.tags.includes(GAME_TAGS.HAS_FIRE)) {
      status = 'FIRE';
    } else if (card.tags.includes(GAME_TAGS.HAS_WATCH)) {
      status = 'WATCH';
    }
  }
  
  return filters.statuses.includes(status);
}

/**
 * Filter by driver tier and confidence
 */
function filterByDriverStrength(card: GameCard, filters: GameFilters): boolean {
  if (!filters.minTier && !filters.minConfidence) return true;
  
  const tierRank: Record<DriverTier, number> = { BEST: 3, SUPER: 2, WATCH: 1 };
  
  for (const driver of card.drivers) {
    // Check tier
    if (filters.minTier) {
      const minRank = tierRank[filters.minTier];
      const driverRank = tierRank[driver.tier];
      if (driverRank < minRank) continue;
    }
    
    // Check confidence
    if (filters.minConfidence && driver.confidence !== undefined) {
      if (driver.confidence < filters.minConfidence) continue;
    }
    
    // If we got here, this driver passes
    return true;
  }
  
  // No drivers passed filters
  return filters.minTier === undefined && filters.minConfidence === undefined;
}

/**
 * Filter by risk flags
 */
function filterByRiskFlags(card: GameCard, filters: GameFilters): boolean {
  if (filters.hideFragility && card.tags.includes(GAME_TAGS.HAS_RISK_FRAGILITY)) {
    return false;
  }
  if (filters.hideBlowout && card.tags.includes(GAME_TAGS.HAS_RISK_BLOWOUT)) {
    return false;
  }
  if (filters.hideLowCoverage && card.tags.includes(GAME_TAGS.HAS_LOW_COVERAGE)) {
    return false;
  }
  
  return true;
}

/**
 * Filter by search query (team names)
 */
function filterBySearch(card: GameCard, filters: GameFilters): boolean {
  if (!filters.searchQuery) return true;
  
  const query = filters.searchQuery.toLowerCase();
  const homeTeam = card.homeTeam.toLowerCase();
  const awayTeam = card.awayTeam.toLowerCase();
  
  return homeTeam.includes(query) || awayTeam.includes(query);
}

/**
 * Filter games with picks only
 */
function filterByHasPicks(card: GameCard, filters: GameFilters): boolean {
  if (!filters.onlyGamesWithPicks) return true;

  if (card.play && card.play.market !== 'NONE' && card.play.pick !== 'NO PLAY') {
    return true;
  }

  return card.drivers.some(d => d.direction !== 'NEUTRAL');
}

/**
 * Filter for Welcome Home Fade cards only
 */
function filterByWelcomeHome(card: GameCard, filters: GameFilters): boolean {
  if (!filters.onlyWelcomeHome) return true;
  
  // Check if any driver is Welcome Home Fade
  return card.drivers.some(d => d.cardType === 'welcome-home-v2' || d.key === 'welcomeHomeV2');
}

/**
 * Filter by clear play (has canonical play with valid market)
 */
function filterByClearPlay(card: GameCard, filters: GameFilters): boolean {
  if (!filters.hasClearPlay) return true;

  return card.play !== undefined && card.play.market !== 'NONE' && card.play.pick !== 'NO PLAY';
}

export function getFilterDebugFlags(card: GameCard, filters: GameFilters): FilterDebugFlags {
  return {
    sport: filterBySport(card, filters),
    timeWindow: filterByTimeWindow(card, filters),
    oddsFreshness: filterByOddsFreshness(card, filters),
    market: filterByMarketAvailability(card, filters),
    actionability: filterByActionability(card, filters),
    driverStrength: filterByDriverStrength(card, filters),
    riskFlags: filterByRiskFlags(card, filters),
    search: filterBySearch(card, filters),
    welcomeHome: filterByWelcomeHome(card, filters),
    hasPicks: filterByHasPicks(card, filters),
    clearPlay: filterByClearPlay(card, filters),
  };
}

/**
 * Get sort value for a card
 */
function getSortValue(card: GameCard, sortMode: SortMode): number {
  switch (sortMode) {
    case 'start_time':
      return new Date(card.startTime).getTime();
    
    case 'odds_updated':
      return new Date(card.updatedAt).getTime();
    
    case 'signal_strength': {
      const tierRank: Record<DriverTier, number> = { BEST: 3, SUPER: 2, WATCH: 1 };
      const maxTier = Math.max(
        0,
        ...card.drivers.map(d => tierRank[d.tier])
      );
      const maxConfidence = Math.max(
        0,
        ...card.drivers.map(d => d.confidence || 0)
      );
      // Combine tier (weighted 10x) and confidence
      return maxTier * 10 + maxConfidence;
    }
    
    case 'pick_score':
      return card.expressionChoice?.score || 0;
    
    default:
      return 0;
  }
}

/**
 * Sort game cards
 */
function sortCards(cards: GameCard[], sortMode: SortMode): GameCard[] {
  const sorted = [...cards].sort((a, b) => {
    // Special handling for start_time sort: FIRE first
    if (sortMode === 'start_time') {
      const aIsFire = a.tags.includes(GAME_TAGS.HAS_FIRE);
      const bIsFire = b.tags.includes(GAME_TAGS.HAS_FIRE);
      if (aIsFire && !bIsFire) return -1;
      if (!aIsFire && bIsFire) return 1;
    }
    
    const aVal = getSortValue(a, sortMode);
    const bVal = getSortValue(b, sortMode);
    
    // For start_time and odds_updated: ascending (soonest first)
    // For signal_strength and pick_score: descending (strongest first)
    if (sortMode === 'start_time' || sortMode === 'odds_updated') {
      return aVal - bVal;
    } else {
      return bVal - aVal;
    }
  });
  
  return sorted;
}

/**
 * Apply all filters to game cards
 */
export function applyFilters(cards: GameCard[], filters: GameFilters): GameCard[] {
  const filtered = cards
    .filter(card => filterBySport(card, filters))
    .filter(card => filterByTimeWindow(card, filters))
    .filter(card => filterByOddsFreshness(card, filters))
    .filter(card => filterByMarketAvailability(card, filters))
    .filter(card => filterByActionability(card, filters))
    .filter(card => filterByDriverStrength(card, filters))
    .filter(card => filterByRiskFlags(card, filters))
    .filter(card => filterBySearch(card, filters))
    .filter(card => filterByWelcomeHome(card, filters))
     .filter(card => filterByHasPicks(card, filters))
     .filter(card => filterByClearPlay(card, filters));
  
  return sortCards(filtered, filters.sortMode);
}

/**
 * Get count of active filters (excluding defaults)
 */
export function getActiveFilterCount(filters: GameFilters): number {
  let count = 0;
  
  // Compare against defaults
  if (filters.sports.length !== DEFAULT_FILTERS.sports.length) count++;
  if (filters.statuses.length !== DEFAULT_FILTERS.statuses.length) count++;
  if (filters.markets.length !== DEFAULT_FILTERS.markets.length) count++;
  if (filters.onlyGamesWithPicks) count++;
   if (filters.hasClearPlay) count++;
  if (filters.onlyWelcomeHome) count++;
  if (filters.minTier) count++;
  if (filters.minConfidence) count++;
  if (filters.hideFragility) count++;
  if (filters.hideBlowout) count++;
  if (filters.hideLowCoverage) count++;
  if (filters.hideStaleOdds) count++;
  if (filters.searchQuery) count++;
  if (filters.timeWindow) count++;
  
  return count;
}

/**
 * Reset filters to defaults
 */
export function resetFilters(): GameFilters {
  return { ...DEFAULT_FILTERS };
}
