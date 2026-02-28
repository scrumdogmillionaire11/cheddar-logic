/**
 * Filter state and logic for GameCard filtering
 * Based on FILTER-FEATURE.md design
 */

import type { GameCard, Sport, Market, DriverTier, ExpressionStatus } from '../types/game-card';
import { GAME_TAGS } from '../types/game-card';

/**
 * Sort modes for game cards
 */
export type SortMode = 'start_time' | 'odds_updated' | 'signal_strength' | 'pick_score';

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
 * Filter by market availability
 */
function filterByMarketAvailability(card: GameCard, filters: GameFilters): boolean {
  if (filters.markets.length === 0) return true;

  const playMarket = card.play?.market;
  if (playMarket && playMarket !== 'NONE') {
    return filters.markets.includes(playMarket);
  }

  return card.drivers.some(d => filters.markets.includes(d.market));
}

/**
 * Filter by actionability status
 */
function filterByActionability(card: GameCard, filters: GameFilters): boolean {
  if (filters.statuses.length === 0) return true;

  let status: ExpressionStatus = card.play?.status || card.expressionChoice?.status || 'PASS';
  if (!card.play?.status && !card.expressionChoice?.status) {
    if (card.tags.includes(GAME_TAGS.HAS_FIRE)) status = 'FIRE';
    else if (card.tags.includes(GAME_TAGS.HAS_WATCH)) status = 'WATCH';
    else status = 'PASS';
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
 * Filter by clear play (has canonical play with valid market)
 */
function filterByClearPlay(card: GameCard, filters: GameFilters): boolean {
  if (!filters.hasClearPlay) return true;

  return card.play !== undefined && card.play.market !== 'NONE' && card.play.pick !== 'NO PLAY';
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
