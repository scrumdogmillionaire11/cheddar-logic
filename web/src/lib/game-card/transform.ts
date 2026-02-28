/**
 * Transform and deduplicate GameData into normalized GameCard with canonical Play
 * Based on FILTER-FEATURE.md design
 */

import type {
  GameCard,
  DriverRow,
  Sport,
  Market,
  DriverTier,
  Direction,
  GameMarkets,
  Play,
  ExpressionStatus,
  TruthStatus,
  ValueStatus,
  PriceFlag,
} from '../types/game-card';
import { deduplicateDrivers } from './decision';

const TIER_SCORE: Record<DriverTier, number> = {
  BEST: 1,
  SUPER: 0.72,
  WATCH: 0.52,
};

const OPPOSITE_DIRECTION: Partial<Record<Direction, Direction>> = {
  HOME: 'AWAY',
  AWAY: 'HOME',
  OVER: 'UNDER',
  UNDER: 'OVER',
};

// API types from cards page
interface ApiPlay {
  cardType: string;
  cardTitle: string;
  prediction: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';
  confidence: number;
  tier: 'SUPER' | 'BEST' | 'WATCH' | null;
  reasoning: string;
  evPassed: boolean;
  driverKey: string;
}

interface GameData {
  id: string;
  gameId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  gameTimeUtc: string;
  status: string;
  createdAt: string;
  odds: {
    h2hHome: number | null;
    h2hAway: number | null;
    total: number | null;
    spreadHome: number | null;
    spreadAway: number | null;
    capturedAt: string | null;
  } | null;
  plays: ApiPlay[];
}

/**
 * Extract market type from card title
 */
function inferMarket(cardTitle: string): Market {
  const titleLower = cardTitle.toLowerCase();
  
  if (titleLower.includes('total') || titleLower.includes('o/u') || 
      titleLower.includes('over') || titleLower.includes('under')) {
    return 'TOTAL';
  }
  
  if (titleLower.includes('spread') || titleLower.includes('line')) {
    return 'SPREAD';
  }
  
  if (titleLower.includes('moneyline') || titleLower.includes('ml') ||
      titleLower.includes('h2h')) {
    return 'ML';
  }

  if (titleLower.includes('projection') || titleLower.includes('rest') ||
      titleLower.includes('matchup')) {
    return 'ML';
  }
  
  if (titleLower.includes('risk') || titleLower.includes('fragility') ||
      titleLower.includes('blowout') || titleLower.includes('key number')) {
    return 'RISK';
  }
  
  return 'UNKNOWN';
}

/**
 * Normalize sport string to Sport type
 */
function normalizeSport(sport: string): Sport {
  const sportUpper = sport.toUpperCase();
  if (sportUpper === 'NHL' || sportUpper === 'NBA' || 
      sportUpper === 'NCAAM' || sportUpper === 'SOCCER') {
    return sportUpper as Sport;
  }
  return 'UNKNOWN';
}

/**
 * Convert API Play to normalized DriverRow
 */
function playToDriver(play: ApiPlay): DriverRow {
  const direction: Direction = play.prediction === 'NEUTRAL' ? 'NEUTRAL' : play.prediction;
  const tier: DriverTier = play.tier || 'WATCH';
  const market = inferMarket(play.cardTitle);
  
  return {
    key: play.driverKey || `${play.cardType}_${market.toLowerCase()}`,
    market,
    tier,
    direction,
    confidence: play.confidence,
    note: play.reasoning,
    cardType: play.cardType,
    cardTitle: play.cardTitle,
  };
}

/**
 * Build GameMarkets from odds
 */
function buildMarkets(odds: GameData['odds']): GameMarkets {
  if (!odds) return {};
  
  const markets: GameMarkets = {};
  
  if (odds.h2hHome !== null && odds.h2hAway !== null) {
    markets.ml = { home: odds.h2hHome, away: odds.h2hAway };
  }
  
  if (odds.spreadHome !== null && odds.spreadAway !== null) {
    markets.spread = { home: odds.spreadHome, away: odds.spreadAway };
  }
  
  if (odds.total !== null) {
    markets.total = { line: odds.total };
  }
  
  return markets;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sortDriversByStrength(drivers: DriverRow[]): DriverRow[] {
  return [...drivers].sort((a, b) => {
    const tierDiff = TIER_SCORE[b.tier] - TIER_SCORE[a.tier];
    if (tierDiff !== 0) return tierDiff;
    const aConf = typeof a.confidence === 'number' ? a.confidence : 0.6;
    const bConf = typeof b.confidence === 'number' ? b.confidence : 0.6;
    return bConf - aConf;
  });
}

function isRiskOnlyDriver(driver: DriverRow): boolean {
  const text = `${driver.key} ${driver.cardTitle} ${driver.note}`.toLowerCase();
  return text.includes('blowout risk') || (driver.market === 'RISK' && text.includes('blowout'));
}

function directionScore(drivers: DriverRow[], direction: Direction): number {
  return drivers
    .filter((driver) => driver.direction === direction)
    .reduce((sum, driver) => {
      const confidence = typeof driver.confidence === 'number' ? clamp(driver.confidence, 0, 1) : 0.6;
      return sum + TIER_SCORE[driver.tier] * confidence;
    }, 0);
}

function truthStatusFromStrength(truthStrength: number): TruthStatus {
  if (truthStrength >= 0.67) return 'STRONG';
  if (truthStrength >= 0.58) return 'MEDIUM';
  return 'WEAK';
}

function americanToImpliedProbability(price?: number): number | undefined {
  if (price === undefined || Number.isNaN(price)) return undefined;
  if (price > 0) return 100 / (price + 100);
  return Math.abs(price) / (Math.abs(price) + 100);
}

function pickTruthDriver(drivers: DriverRow[]): DriverRow | null {
  const candidates = drivers.filter(
    (driver) => driver.direction !== 'NEUTRAL' && !isRiskOnlyDriver(driver)
  );
  if (candidates.length === 0) return null;
  return sortDriversByStrength(candidates)[0];
}

function selectExpressionMarket(
  direction: Direction,
  truthStatus: TruthStatus,
  driver: DriverRow,
  odds: GameData['odds']
): Market | 'NONE' {
  if (direction === 'OVER' || direction === 'UNDER') {
    return odds?.total !== null && odds?.total !== undefined ? 'TOTAL' : 'NONE';
  }

  const mlPrice = direction === 'HOME' ? odds?.h2hHome ?? undefined : odds?.h2hAway ?? undefined;
  const hasMLOdds = mlPrice !== undefined && mlPrice !== null;
  const hasSpreadOdds =
    (odds?.spreadHome !== null && odds?.spreadHome !== undefined) ||
    (odds?.spreadAway !== null && odds?.spreadAway !== undefined);

  const spreadHint =
    driver.note.toLowerCase().includes('spread') ||
    driver.cardTitle.toLowerCase().includes('spread') ||
    driver.key.toLowerCase().includes('spread');

  if (hasSpreadOdds && spreadHint && truthStatus !== 'WEAK') {
    return 'SPREAD';
  }

  if (hasMLOdds && typeof mlPrice === 'number' && mlPrice <= -240 && hasSpreadOdds && truthStatus === 'STRONG') {
    return 'SPREAD';
  }

  if (hasMLOdds) {
    return 'ML';
  }

  if (hasSpreadOdds) {
    return 'SPREAD';
  }

  return 'NONE';
}

function getPriceFlags(direction: Direction | null, price?: number): PriceFlag[] {
  if (direction !== 'HOME' && direction !== 'AWAY') return [];
  if (price === undefined) return ['VIG_HEAVY'];

  const flags = new Set<PriceFlag>();
  if (Math.abs(price) <= 120) flags.add('COINFLIP');
  if (price <= -240) flags.add('PRICE_TOO_STEEP');
  return Array.from(flags);
}

function getValueStatus(edge?: number): ValueStatus {
  if (edge === undefined) return 'BAD';
  if (edge >= 0.04) return 'GOOD';
  if (edge >= 0.015) return 'OK';
  return 'BAD';
}

function deriveBetStatus(
  betAction: 'BET' | 'NO_PLAY',
  truthStatus: TruthStatus,
  valueStatus: ValueStatus
): ExpressionStatus {
  if (betAction === 'NO_PLAY') return 'PASS';
  if (truthStatus === 'STRONG' && valueStatus === 'GOOD') return 'FIRE';
  return 'WATCH';
}

/**
 * Determine best market from drivers + available odds
 * Uses same logic as decision.ts but at transform time
 */
function getPlayWhyCode(
  betAction: 'BET' | 'NO_PLAY',
  market: Market | 'NONE',
  drivers: DriverRow[],
  priceFlags: PriceFlag[]
): string {
  if (betAction === 'NO_PLAY') {
    if (priceFlags.includes('PRICE_TOO_STEEP')) return 'PRICE_TOO_STEEP';
    if (priceFlags.includes('VIG_HEAVY')) return 'MISSING_PRICE_EDGE';
    return 'NO_VALUE_AT_PRICE';
  }

  if (market === 'NONE') return 'NO_DECISION';

  const allText = drivers.map((d) => `${d.cardTitle} ${d.note}`.toLowerCase()).join(' ');

  if (market === 'TOTAL') {
    if (allText.includes('fragility') || allText.includes('key number')) {
      return 'KEY_NUMBER_FRAGILITY_TOTAL';
    }
    return 'EDGE_FOUND_TOTAL';
  }

  if (market === 'ML' || market === 'SPREAD') {
    if (allText.includes('rest') || allText.includes('fatigue')) {
      return 'REST_EDGE_SIDE';
    }
    if (allText.includes('home') && allText.includes('fade')) {
      return 'WELCOME_HOME_FADE';
    }
    if (allText.includes('matchup')) {
      return 'MATCHUP_EDGE_SIDE';
    }
    return 'EDGE_FOUND_SIDE';
  }

  return 'EDGE_FOUND';
}

/**
 * Build canonical Play object at transform time
 */
function buildPlay(
  game: GameData,
  drivers: DriverRow[]
): Play {
  const truthDriver = pickTruthDriver(drivers);

  if (!truthDriver) {
    return {
      status: 'PASS',
      market: 'NONE',
      pick: 'NO PLAY',
      lean: 'NO LEAN',
      side: null,
      truthStatus: 'WEAK',
      truthStrength: 0.5,
      conflict: 0,
      valueStatus: 'BAD',
      betAction: 'NO_PLAY',
      priceFlags: ['VIG_HEAVY'],
      updatedAt: game.odds?.capturedAt || game.createdAt,
      whyCode: 'NO_DECISION',
      whyText: 'No clear edge found',
    };
  }

  const truthDirection = truthDriver.direction;
  const oppositeDirection = OPPOSITE_DIRECTION[truthDirection];
  const supportScore = directionScore(drivers, truthDirection);
  const opposeScore = oppositeDirection ? directionScore(drivers, oppositeDirection) : 0;
  const totalScore = supportScore + opposeScore;
  const net = totalScore > 0 ? (supportScore - opposeScore) / totalScore : 0;
  const conflict = totalScore > 0 ? clamp(opposeScore / totalScore, 0, 1) : 0;
  const truthStrength = clamp(0.5 + net * 0.3, 0.5, 0.8);
  const truthStatus = truthStatusFromStrength(truthStrength);
  const modelProb = clamp(0.5 + (truthStrength - 0.5) * 0.9 - conflict * 0.12, 0.5, 0.78);

  const market = selectExpressionMarket(truthDirection, truthStatus, truthDriver, game.odds);

  // Build pick string with proper price/line
  let pick = 'NO PLAY';
  let price: number | undefined;
  let line: number | undefined;

  const direction = truthDirection;
  const teamName = direction === 'HOME' ? game.homeTeam : game.awayTeam;

  if (market === 'ML') {
    price = direction === 'HOME' ? game.odds?.h2hHome ?? undefined : game.odds?.h2hAway ?? undefined;
    if (price !== undefined) {
      const priceStr = price > 0 ? `+${price}` : `${price}`;
      pick = `${teamName} ML ${priceStr}`;
    } else {
      pick = `${teamName} ML (Price N/A)`;
    }
  } else if (market === 'SPREAD') {
    line = direction === 'HOME' ? game.odds?.spreadHome ?? undefined : game.odds?.spreadAway ?? undefined;
    if (line !== undefined) {
      const lineStr = line > 0 ? `+${line}` : `${line}`;
      pick = `${teamName} ${lineStr}`;
    } else {
      pick = `${teamName} Spread (Line N/A)`;
    }
  } else if (market === 'TOTAL') {
    line = game.odds?.total ?? undefined;
    if (line !== undefined) {
      pick = `${direction === 'OVER' ? 'Over' : 'Under'} ${line}`;
    } else {
      pick = `${direction === 'OVER' ? 'Over' : 'Under'} (Line N/A)`;
    }
  }

  const impliedProb = market === 'ML' ? americanToImpliedProbability(price) : undefined;
  const edge = impliedProb !== undefined ? modelProb - impliedProb : undefined;
  const valueStatus = getValueStatus(edge);
  const priceFlags = getPriceFlags(direction, price);

  const needsSteepFavoritePremium = typeof price === 'number' && price <= -240;
  let edgeThreshold = 0.02;
  if (truthStatus === 'WEAK') edgeThreshold += 0.015;
  if (conflict >= 0.35) edgeThreshold += 0.01;
  if (needsSteepFavoritePremium) edgeThreshold += 0.02;

  let betAction: 'BET' | 'NO_PLAY' = 'NO_PLAY';
  if (market !== 'NONE' && edge !== undefined && edge >= edgeThreshold) {
    betAction = 'BET';
  }

  if (priceFlags.includes('PRICE_TOO_STEEP') && (edge === undefined || edge < 0.06)) {
    betAction = 'NO_PLAY';
  }

  if (edge === undefined) {
    betAction = 'NO_PLAY';
  }

  const status = deriveBetStatus(betAction, truthStatus, valueStatus);
  const whyCode = getPlayWhyCode(betAction, market, drivers, priceFlags);
  const whyText = whyCode.replace(/_/g, ' ');

  if (betAction === 'NO_PLAY') {
    pick = 'NO PLAY';
  }

  return {
    status,
    market,
    pick,
    lean: direction === 'HOME' ? game.homeTeam : direction === 'AWAY' ? game.awayTeam : direction,
    side: direction,
    truthStatus,
    truthStrength,
    conflict,
    modelProb,
    impliedProb,
    edge,
    valueStatus,
    betAction,
    priceFlags,
    line,
    price,
    updatedAt: game.odds?.capturedAt || game.createdAt,
    whyCode,
    whyText,
  };
}

/**
 * Transform GameData to normalized GameCard with deduped drivers and canonical Play
 */
export function transformToGameCard(game: GameData): GameCard {
  // Convert plays to drivers and dedupe
  const rawDrivers = game.plays.map(playToDriver);
  const drivers = deduplicateDrivers(rawDrivers);
  
  // Build canonical play object
  const play = buildPlay(game, drivers);
  
  // Determine updatedAt (prefer odds captured_at over created_at)
  const updatedAt = game.odds?.capturedAt || game.createdAt;
  const normalizedSport = normalizeSport(game.sport);
  const initialTags = normalizedSport === 'UNKNOWN' ? ['unknown_sport'] : [];
  
  return {
    id: game.id,
    gameId: game.gameId,
    sport: normalizedSport,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    startTime: game.gameTimeUtc,
    updatedAt,
    status: game.status,
    markets: buildMarkets(game.odds),
    play,
    drivers,
    tags: initialTags,
  };
}

/**
 * Transform array of GameData to GameCard[]
 */
export function transformGames(games: GameData[]): GameCard[] {
  return games.map(transformToGameCard);
}
