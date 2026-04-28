/**
 * Filter state and logic for GameCard filtering
 * Based on FILTER-FEATURE.md design
 */

import type {
  GameCard,
  Sport,
  Market,
  DriverTier,
  ExpressionStatus,
} from '../types';
import { GAME_TAGS } from '../types';
import { getPlayDisplayAction } from './decision';
import { isNflSeason } from './season-gates';
import { isWelcomeHomeCardType } from './welcome-home';
import { PROJECTION_SURFACE_CARD_TYPES } from '../games/projection-surface';
import { readRuntimeCanonicalDecision } from '@/lib/runtime-decision-authority';

// Season-gated sports list: NFL excluded during off-season (Mar–Aug)
const NFL_SPORTS: Sport[] = isNflSeason()
  ? ['NHL', 'NBA', 'MLB', 'NFL']
  : ['NHL', 'NBA', 'MLB'];

const ENABLE_WELCOME_HOME =
  process.env.NEXT_PUBLIC_ENABLE_WELCOME_HOME === 'true';


/**
 * Sort modes for game cards
 */
export type SortMode =
  | 'start_time'
  | 'odds_updated'
  | 'signal_strength'
  | 'pick_score'
  | 'edge_pct';

export type ViewMode = 'game' | 'props' | 'projections';

export type FilterDebugFlags = {
  sport: boolean;
  timeWindow: boolean;
  oddsFreshness: boolean;
  market: boolean;
  cardType: boolean;
  actionability: boolean;
  driverStrength: boolean;
  riskFlags: boolean;
  search: boolean;
  welcomeHome: boolean;
  hasPicks: boolean;
  clearPlay: boolean;
  totalProjection: boolean;
  minEdge: boolean;
};

export type CardFilterPredicateResult = {
  passes: boolean;
  flags: FilterDebugFlags;
};

/**
 * Filter configuration
 */
export type PropStatGroup =
  | 'PTS'
  | 'REB'
  | 'AST'
  | 'PRA'
  | '3PM'
  | 'SOG'
  | 'SAVES'
  | 'GOALS'
  | 'HITS'
  | 'BLOCKS'
  | 'K'
  | 'OTHER';

export type PropType = 'OVER' | 'UNDER' | 'ALT' | 'COMBO';

export type PropVarianceBand = 'LOW' | 'MED' | 'HIGH';

export type PropSearchTarget = 'player' | 'team' | 'opponent';

export interface CommonFilters {
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

  // Search
  searchQuery: string;

  // Sort
  sortMode: SortMode;
}

export interface GameModeFilters extends CommonFilters {
  // Market type
  markets: Market[];
  onlyGamesWithPicks: boolean;
  hasClearPlay: boolean; // requires canonical actionable play call
  requireTotalProjection: boolean;
  onlyWelcomeHome?: boolean;

  // Card types
  cardTypes?: string[]; // e.g., ['nhl-pace-1p']

  // Edge filter — whole-number percentage threshold (1 = 1%, 2 = 2%, etc.)
  // null means no filter
  minEdgePct?: number | null;

  // Driver strength
  minTier?: DriverTier; // BEST only / SUPER+ / WATCH+
  minConfidence?: number; // 0-1 range

  // Risk flags
  hideFragility: boolean;
  hideBlowout: boolean;
  hideLowCoverage: boolean;
  hideStaleOdds: boolean;
}

export interface PropsModeFilters extends CommonFilters {
  propStatGroups: PropStatGroup[];
  propTypes: PropType[];
  lineBands: string[];
  priceBands: string[];
  varianceBands: PropVarianceBand[];
  searchTarget: PropSearchTarget;
}

export type GameFilters = GameModeFilters | PropsModeFilters;

function readCanonicalDecision(play: GameCard['play']) {
  if (!play) return null;
  const decision = readRuntimeCanonicalDecision(
    {
      decision_v2: (play.decision_v2 as unknown as Record<string, unknown> | null) ?? null,
    },
    { stage: 'read_api' },
  );
  return decision.officialStatus === 'INVALID' ? null : decision;
}

function resolveCanonicalOfficialStatus(
  play: GameCard['play'],
): 'PLAY' | 'LEAN' | 'PASS' | null {
  const decision = readCanonicalDecision(play);
  if (!decision) return null;
  return decision.officialStatus;
}

function resolveCanonicalIsActionable(play: GameCard['play']): boolean | null {
  const decision = readCanonicalDecision(play);
  if (!decision) return null;
  return decision.isActionable;
}

/**
 * Default filter state
 */
export const DEFAULT_GAME_FILTERS: GameModeFilters = {
  sports: NFL_SPORTS,
  statuses: ['FIRE', 'WATCH'],
  markets: ['ML', 'SPREAD', 'TOTAL'],
  onlyGamesWithPicks: false,
  hasClearPlay: false,
  requireTotalProjection: false,
  onlyWelcomeHome: false,
  cardTypes: [],
  minEdgePct: null,
  hideFragility: false,
  hideBlowout: false,
  hideLowCoverage: false,
  hideStaleOdds: false,
  searchQuery: '',
  sortMode: 'start_time',
};

export const DEFAULT_PROPS_FILTERS: PropsModeFilters = {
  sports: NFL_SPORTS,
  statuses: ['FIRE', 'WATCH', 'PASS'],
  searchQuery: '',
  sortMode: 'start_time',
  propStatGroups: [],
  propTypes: [],
  lineBands: [],
  priceBands: [],
  varianceBands: [],
  searchTarget: 'player',
};

export const DEFAULT_PROJECTIONS_FILTERS: GameModeFilters = {
  sports: NFL_SPORTS,
  statuses: ['FIRE', 'WATCH', 'PASS'],
  markets: ['ML', 'SPREAD', 'TOTAL'],
  onlyGamesWithPicks: false,
  hasClearPlay: false,
  requireTotalProjection: false,
  onlyWelcomeHome: false,
  cardTypes: [...PROJECTION_SURFACE_CARD_TYPES],
  minEdgePct: null,
  hideFragility: false,
  hideBlowout: false,
  hideLowCoverage: false,
  hideStaleOdds: false,
  searchQuery: '',
  sortMode: 'start_time',
};

export const DEFAULT_FILTERS_BY_MODE: Record<ViewMode, GameFilters> = {
  game: DEFAULT_GAME_FILTERS,
  props: DEFAULT_PROPS_FILTERS,
  projections: DEFAULT_PROJECTIONS_FILTERS,
};

export function getDefaultFilters(mode: ViewMode): GameFilters {
  return DEFAULT_FILTERS_BY_MODE[mode];
}

function isPropsModeFilters(filters: GameFilters): filters is PropsModeFilters {
  return 'propStatGroups' in filters;
}

function filterBySport(card: GameCard, filters: CommonFilters): boolean {
  return filters.sports.includes(card.sport);
}

/**
 * Filter by time window
 */
function filterByTimeWindow(card: GameCard, filters: CommonFilters): boolean {
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
function filterByOddsFreshness(
  card: GameCard,
  filters: GameModeFilters,
): boolean {
  if (!filters.hideStaleOdds) return true;

  // Hide if stale by configured warning threshold (default: 60+ minutes)
  return !card.tags.includes(GAME_TAGS.STALE_5M);
}

/**
 * Map canonical market type to legacy Market enum for comparison
 */
function canonicalToLegacyMarket(canonical?: string): Market | null {
  if (!canonical) return null;
  const upper = canonical.toUpperCase();
  if (upper === 'MONEYLINE' || upper === 'ML') return 'ML';
  if (upper === 'SPREAD' || upper === 'PUCKLINE') return 'SPREAD';
  if (
    upper === 'TOTAL' ||
    upper === 'TEAM_TOTAL' ||
    upper === 'FIRST_PERIOD' ||
    upper === 'FIRST_5_INNINGS'
  ) {
    return 'TOTAL';
  }
  if (upper === 'INFO') return null; // INFO items don't count as bettable markets
  return 'UNKNOWN';
}

/**
 * Filter by market availability.
 * Canonical market_type is the only authoritative source.
 *
 * Special rule for Full Slate (when PASS is included):
 * - Allow PASS plays through even if their market doesn't match the filter
 */
function filterByMarketAvailability(
  card: GameCard,
  filters: GameModeFilters,
): boolean {
  if (filters.markets.length === 0) return true;

  const includePass = filters.statuses.includes('PASS');
  const displayAction = getPlayDisplayAction(card.play);
  const officialStatus = resolveCanonicalOfficialStatus(card.play);

  // Full Slate lenient mode: let PASS plays through regardless of market
  if (
    includePass &&
    (displayAction === 'PASS' || officialStatus === 'PASS')
  ) {
    return true;
  }

  // Check play's canonical market_type first
  const canonicalMarket = canonicalToLegacyMarket(card.play?.market_type);
  if (canonicalMarket && filters.markets.includes(canonicalMarket)) {
    return true;
  }

  return false;
}

function filterByPropAvailability(card: GameCard): boolean {
  const play = card.play;
  if (!play) return false;
  if (play.market_type !== 'PROP') return false;

  const selectionSide = play.selection?.side;
  const hasSelection = Boolean(selectionSide) && selectionSide !== 'NONE';
  const hasLineOrPrice =
    typeof play.line === 'number' || typeof play.price === 'number';

  return hasSelection && hasLineOrPrice;
}

/**
 * Filter by actionability status
 *
 * Special rule for Full Slate (when PASS is included):
 * - If statuses includes PASS, show any game with a play object OR blocked totals
 * - Otherwise, require exact status match
 */
function filterByActionability(
  card: GameCard,
  filters: CommonFilters,
): boolean {
  if (filters.statuses.length === 0) return true;

  const includePass = filters.statuses.includes('PASS');
  const displayAction = getPlayDisplayAction(card.play);
  const canonicalOfficialStatus = resolveCanonicalOfficialStatus(card.play);
  const moneylineExecutionStatus =
    card.play?.market_type === 'MONEYLINE'
      ? card.play.execution_status
      : undefined;

  if (!canonicalOfficialStatus) {
    return false;
  }

  if (!includePass && moneylineExecutionStatus === 'EXECUTABLE') {
    return true;
  }
  if (
    !includePass &&
    (moneylineExecutionStatus === 'BLOCKED' ||
      moneylineExecutionStatus === 'PROJECTION_ONLY')
  ) {
    return false;
  }

  // Full Slate mode: include canonical PASS/actionable plays and blocked totals.
  // Legacy-only rows (no decision_v2, no market_type/selection) are excluded even
  // in full-slate mode — they cannot be actioned and have no canonical PASS signal.
  if (includePass) {
    const canonicalPassSignal =
      canonicalOfficialStatus === 'PASS';

    const hasBlockedTotals = Boolean(
      card.play?.market_type === 'TOTAL' &&
      displayAction === 'PASS' &&
      (card.play?.reason_codes?.includes('PASS_TOTAL_INSUFFICIENT_DATA') ||
        card.play?.tags?.includes('CONSISTENCY_BLOCK_TOTALS')),
    );

    if (canonicalPassSignal || hasBlockedTotals || hasActionablePlayCall(card)) {
      return true;
    }
    return false;
  }

  // Standard mode: Check displayAction against filter
  // Map display action to filter status names
  let status: ExpressionStatus = 'PASS';
  if (displayAction === 'FIRE') {
    status = 'FIRE';
  } else if (displayAction === 'HOLD') {
    status = 'WATCH';
  }
  if (moneylineExecutionStatus === 'EXECUTABLE' && status === 'PASS') {
    status = 'WATCH';
  }
  if (
    moneylineExecutionStatus === 'BLOCKED' ||
    moneylineExecutionStatus === 'PROJECTION_ONLY'
  ) {
    status = 'PASS';
  }

  const explicitPassPlay =
    displayAction === 'PASS' ||
    canonicalOfficialStatus === 'PASS';

  // Allow expressionChoice to override a PASS display action, but never driver
  // tags: HAS_FIRE / HAS_WATCH are derived from the same pipeline that produced
  // the PASS signal — re-promoting via tags creates a self-contradiction that lets
  // PASS cards surface in the main FIRE/WATCH view.
  if ((!displayAction || displayAction === 'PASS') && !explicitPassPlay) {
    if (card.expressionChoice?.status) {
      status = card.expressionChoice.status;
    }
  }

  // In standard mode (FIRE/WATCH-only), status labels are not sufficient:
  // suppress cards that do not have an actionable canonical play call.
  if (
    !includePass &&
    (status === 'FIRE' || status === 'WATCH') &&
    !hasActionablePlayCall(card)
  ) {
    return false;
  }

  return filters.statuses.includes(status);
}

/**
 * Filter by driver tier and confidence
 */
function filterByDriverStrength(
  card: GameCard,
  filters: GameModeFilters,
): boolean {
  if (!filters.minTier && !filters.minConfidence) return true;

  const tierRank: Record<DriverTier, number> = {
    BEST: 3,
    SUPER: 2,
    GOOD: 2,
    WATCH: 1,
    OK: 1,
    BAD: 0,
  };

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
function filterByRiskFlags(card: GameCard, filters: GameModeFilters): boolean {
  if (
    filters.hideFragility &&
    card.tags.includes(GAME_TAGS.HAS_RISK_FRAGILITY)
  ) {
    return false;
  }
  if (filters.hideBlowout && card.tags.includes(GAME_TAGS.HAS_RISK_BLOWOUT)) {
    return false;
  }
  if (
    filters.hideLowCoverage &&
    card.tags.includes(GAME_TAGS.HAS_LOW_COVERAGE)
  ) {
    return false;
  }

  return true;
}

/**
 * Filter by search query (team names)
 */
function filterBySearch(card: GameCard, filters: CommonFilters): boolean {
  if (!filters.searchQuery) return true;

  const query = filters.searchQuery.toLowerCase();
  const homeTeam = card.homeTeam.toLowerCase();
  const awayTeam = card.awayTeam.toLowerCase();

  if ('searchTarget' in filters) {
    if (filters.searchTarget === 'player') {
      const playerName = (card.play?.selection?.team || '').toLowerCase();
      const pickText = (card.play?.pick || '').toLowerCase();
      return playerName.includes(query) || pickText.includes(query);
    }
    if (filters.searchTarget === 'opponent') {
      return awayTeam.includes(query) || homeTeam.includes(query);
    }
    if (filters.searchTarget === 'team') {
      return homeTeam.includes(query) || awayTeam.includes(query);
    }
  }

  return homeTeam.includes(query) || awayTeam.includes(query);
}

function hasActionablePlayCall(card: GameCard): boolean {
  const play = card.play;
  if (!play) return false;

  if (play.market_type === 'MONEYLINE') {
    if (play.execution_status === 'EXECUTABLE') return true;
    if (
      play.execution_status === 'BLOCKED' ||
      play.execution_status === 'PROJECTION_ONLY'
    ) {
      return false;
    }
  }

  const canonicalActionable = resolveCanonicalIsActionable(play);
  if (canonicalActionable === false) return false;

  // Canonical PASS signals are never actionable.
  if (resolveCanonicalOfficialStatus(play) === 'PASS') return false;

  const canonicalMarket = canonicalToLegacyMarket(play.market_type);
  if (!canonicalMarket) return false;

  const selectionSide = play.selection?.side;
  if (
    !selectionSide ||
    selectionSide === 'NONE'
  ) {
    return false;
  }

  // v2 action takes precedence — if the resolved display action is PASS,
  // the card is not actionable regardless of what official_status says.
  const displayAction = getPlayDisplayAction(play);
  if (displayAction === 'PASS') return false;

  const officialStatus = resolveCanonicalOfficialStatus(play);
  if (officialStatus) {
    return officialStatus === 'PLAY' || officialStatus === 'LEAN';
  }

  return displayAction === 'FIRE' || displayAction === 'HOLD';
}

/**
 * Filter games with picks only
 */
function filterByHasPicks(card: GameCard, filters: GameModeFilters): boolean {
  if (!filters.onlyGamesWithPicks) return true;
  return hasActionablePlayCall(card);
}

/**
 * Filter for Welcome Home Fade cards only
 */
function filterByWelcomeHome(
  card: GameCard,
  filters: GameModeFilters,
): boolean {
  if (!filters.onlyWelcomeHome) return true;
  if (!ENABLE_WELCOME_HOME) return false;

  // Check if any driver or evidence item is Welcome Home Fade
  const hasWHF =
    card.drivers.some((d) => isWelcomeHomeCardType(d.cardType)) ||
    (card.evidence?.some((e) => isWelcomeHomeCardType(e.cardType)) ?? false);
  return hasWHF;
}

/**
 * Filter by clear play (has canonical play with valid market)
 */
function filterByClearPlay(card: GameCard, filters: GameModeFilters): boolean {
  if (!filters.hasClearPlay) return true;
  return hasActionablePlayCall(card);
}

function filterByTotalProjection(
  card: GameCard,
  filters: GameModeFilters,
): boolean {
  if (!filters.requireTotalProjection) return true;
  if (!card.play) return false;

  const canonicalMarket = canonicalToLegacyMarket(card.play.market_type);
  const isTotalMarket = canonicalMarket === 'TOTAL';
  if (!isTotalMarket) return false;

  const projectedTotal =
    typeof card.play.projectedTotal === 'number'
      ? card.play.projectedTotal
      : typeof card.play.projectedTeamTotal === 'number'
        ? card.play.projectedTeamTotal
        : null;
  return typeof projectedTotal === 'number' && Number.isFinite(projectedTotal);
}

function filterByCardType(card: GameCard, filters: GameModeFilters): boolean {
  if (!filters.cardTypes || filters.cardTypes.length === 0) return true;

  const allowedTypes = filters.cardTypes;
  const playCardType = card.play?.cardType;
  if (playCardType && allowedTypes.includes(playCardType)) return true;

  // Check if any driver matches the required card types
  return card.drivers.some((d) => allowedTypes.includes(d.cardType ?? ''));
}

function buildFilterDebugFlags(
  card: GameCard,
  filters: GameFilters,
  mode: ViewMode = 'game',
): FilterDebugFlags {
  if (mode === 'props' && isPropsModeFilters(filters)) {
    return {
      sport: filterBySport(card, filters),
      timeWindow: filterByTimeWindow(card, filters),
      oddsFreshness: true,
      market: filterByPropAvailability(card),
      cardType: true,
      actionability: filterByActionability(card, filters),
      driverStrength: true,
      riskFlags: true,
      search: filterBySearch(card, filters),
      welcomeHome: true,
      hasPicks: true,
      clearPlay: true,
      totalProjection: true,
      minEdge: true,
    };
  }

  const gameFilters = filters as GameModeFilters;
  return {
    sport: filterBySport(card, gameFilters),
    timeWindow: filterByTimeWindow(card, gameFilters),
    oddsFreshness: filterByOddsFreshness(card, gameFilters),
    market: filterByMarketAvailability(card, gameFilters),
    cardType: filterByCardType(card, gameFilters),
    actionability: filterByActionability(card, gameFilters),
    driverStrength: filterByDriverStrength(card, gameFilters),
    riskFlags: filterByRiskFlags(card, gameFilters),
    search: filterBySearch(card, gameFilters),
    welcomeHome: filterByWelcomeHome(card, gameFilters),
    hasPicks: filterByHasPicks(card, gameFilters),
    clearPlay: filterByClearPlay(card, gameFilters),
    totalProjection: filterByTotalProjection(card, gameFilters),
    minEdge: filterByMinEdgePct(card, gameFilters),
  };
}

export function evaluateCardFilter(
  card: GameCard,
  filters: GameFilters,
  mode: ViewMode = 'game',
): CardFilterPredicateResult {
  const flags = buildFilterDebugFlags(card, filters, mode);
  return {
    flags,
    passes: Object.values(flags).every(Boolean),
  };
}

export function getFilterDebugFlags(
  card: GameCard,
  filters: GameFilters,
  mode: ViewMode = 'game',
): FilterDebugFlags {
  return evaluateCardFilter(card, filters, mode).flags;
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
      const tierRank: Record<DriverTier, number> = {
        BEST: 3,
        SUPER: 2,
        GOOD: 2,
        WATCH: 1,
        OK: 1,
        BAD: 0,
      };
      const maxTier = Math.max(0, ...card.drivers.map((d) => tierRank[d.tier]));
      const maxConfidence = Math.max(
        0,
        ...card.drivers.map((d) => d.confidence || 0),
      );
      // Combine tier (weighted 10x) and confidence
      return maxTier * 10 + maxConfidence;
    }

    case 'pick_score':
      return card.expressionChoice?.score || 0;

    case 'edge_pct': {
      // Use decision_v2.edge_pct (canonical probability edge).
      // Null values sort last (return -Infinity so descending puts them at end).
      const ep = card.play?.decision_v2?.edge_pct;
      return typeof ep === 'number' && Number.isFinite(ep) ? ep : -Infinity;
    }

    default:
      return 0;
  }
}

/**
 * Filter by minimum edge percentage threshold.
 * minEdgePct is stored as a whole-number percentage (e.g. 2 = 2%).
 * Cards with null edge_pct fail the filter when a threshold is set.
 */
function filterByMinEdgePct(
  card: GameCard,
  filters: GameModeFilters,
): boolean {
  const threshold = filters.minEdgePct;
  if (threshold == null || threshold <= 0) return true;

  const edgePct = card.play?.decision_v2?.edge_pct;
  if (typeof edgePct !== 'number' || !Number.isFinite(edgePct)) return false;
  return edgePct * 100 >= threshold;
}

/**
 * Sort game cards
 */
function sortCards(cards: GameCard[], sortMode: SortMode): GameCard[] {
  const sorted = [...cards].sort((a, b) => {
    const aVal = getSortValue(a, sortMode);
    const bVal = getSortValue(b, sortMode);

    // For start_time and odds_updated: ascending (soonest first)
    // For signal_strength, pick_score, and edge_pct: descending (strongest first)
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
function applyGameFilters(
  cards: GameCard[],
  filters: GameModeFilters,
  mode: ViewMode = 'game',
): GameCard[] {
  const filtered = cards.filter(
    (card) => evaluateCardFilter(card, filters, mode).passes,
  );

  return sortCards(filtered, filters.sortMode);
}

export function applyFilters(
  cards: GameCard[],
  filters: GameFilters,
  mode: ViewMode = 'game',
): GameCard[] {
  if (mode === 'props' && isPropsModeFilters(filters)) {
    const filtered = cards.filter(
      (card) => evaluateCardFilter(card, filters, mode).passes,
    );

    return sortCards(filtered, filters.sortMode);
  }

  return applyGameFilters(cards, filters as GameModeFilters, mode);
}

/**
 * Get count of active filters (excluding defaults)
 */
export function getActiveFilterCount(
  filters: GameFilters,
  mode: ViewMode = 'game',
): number {
  let count = 0;

  if (mode === 'props' && isPropsModeFilters(filters)) {
    const defaults = DEFAULT_PROPS_FILTERS;
    if (filters.sports.length !== defaults.sports.length) count++;
    if (filters.statuses.length !== defaults.statuses.length) count++;
    if (filters.searchQuery) count++;
    if (filters.timeWindow) count++;
    if (filters.propStatGroups.length) count++;
    if (filters.searchTarget !== defaults.searchTarget) count++;
    if (filters.sortMode !== defaults.sortMode) count++;
    return count;
  }
  // Note: props mode does not support minEdgePct — falls through to game filter count

  const gameFilters = filters as GameModeFilters;
  const defaults = mode === 'projections' ? DEFAULT_PROJECTIONS_FILTERS : DEFAULT_GAME_FILTERS;
  if (gameFilters.sports.length !== defaults.sports.length) count++;
  if (gameFilters.statuses.length !== defaults.statuses.length) count++;
  if (gameFilters.markets.length !== defaults.markets.length) count++;
  if (gameFilters.onlyGamesWithPicks) count++;
  if (gameFilters.hasClearPlay) count++;
  if (gameFilters.requireTotalProjection) count++;
  if (ENABLE_WELCOME_HOME && gameFilters.onlyWelcomeHome) count++;
  if (gameFilters.minTier) count++;
  if (gameFilters.minConfidence) count++;
  if (gameFilters.hideFragility) count++;
  if (gameFilters.hideBlowout) count++;
  if (gameFilters.hideLowCoverage) count++;
  if (gameFilters.hideStaleOdds) count++;
  if (gameFilters.searchQuery) count++;
  if (gameFilters.timeWindow) count++;
  if (gameFilters.sortMode !== defaults.sortMode) count++;
  if (gameFilters.minEdgePct != null && gameFilters.minEdgePct > 0) count++;

  return count;
}

/**
 * Reset filters to defaults
 */
export function resetFilters(mode: ViewMode = 'game'): GameFilters {
  return { ...getDefaultFilters(mode) };
}
