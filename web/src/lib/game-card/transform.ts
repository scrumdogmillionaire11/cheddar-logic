/**
 * Transform and deduplicate GameData into normalized GameCard with canonical Play
 * Based on FILTER-FEATURE.md design
 */

import type {
  GameCard,
  DriverRow,
  EvidenceItem,
  Sport,
  Market,
  CanonicalMarketType,
  DriverTier,
  Direction,
  GameMarkets,
  Play,
  TruthStatus,
  ValueStatus,
  PriceFlag,
  PassReasonCode,
  SelectionSide,
  PropGameCard,
  PropPlayRow,
} from '../types/game-card';
import type { CanonicalPlay, MarketType, SelectionKey, Sport as CanonicalSport } from '../types/canonical-play';
import { deduplicateDrivers, resolvePlayDisplayDecision } from './decision';
import {
  derivePlayDecision,
} from '../play-decision/canonical-decision';

const ENABLE_WELCOME_HOME = process.env.NEXT_PUBLIC_ENABLE_WELCOME_HOME === 'true';

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
  projectedTotal?: number | null;
  edge?: number | null;
  status?: 'FIRE' | 'WATCH' | 'PASS';
  classification?: 'BASE' | 'LEAN' | 'PASS';
  action?: 'FIRE' | 'HOLD' | 'PASS';
  pass_reason_code?: string | null;
  run_id?: string;
  created_at?: string;
  player_id?: string;
  player_name?: string;
  team_abbr?: string;
  game_id?: string;
  mu?: number | null;
  suggested_line?: number | null;
  threshold?: number | null;
  is_trending?: boolean;
  role_gate_pass?: boolean;
  data_quality?: string | null;
  l5_sog?: number[] | null;
  l5_mean?: number | null;
  market_type?: CanonicalMarketType;
  selection?: { side?: string; team?: string };
  line?: number;
  price?: number;
  reason_codes?: string[];
  tags?: string[];
  recommendation?: { type?: string };
  recommended_bet_type?: string;
  kind?: 'PLAY' | 'EVIDENCE';
  evidence_for_play_id?: string;
  aggregation_key?: string;
  consistency?: {
    total_bias?: 'OK' | 'INSUFFICIENT_DATA' | 'CONFLICTING_SIGNALS' | 'VOLATILE_ENV' | 'UNKNOWN';
  };
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
    spreadPriceHome: number | null;
    spreadPriceAway: number | null;
    totalPriceOver: number | null;
    totalPriceUnder: number | null;
    capturedAt: string | null;
  } | null;
  consistency?: {
    total_bias?: 'OK' | 'INSUFFICIENT_DATA' | 'CONFLICTING_SIGNALS' | 'VOLATILE_ENV' | 'UNKNOWN';
  };
  plays: ApiPlay[];
}

function isPlayItem(play: ApiPlay): boolean {
  return (play.kind ?? 'PLAY') === 'PLAY';
}

function isEvidenceItem(play: ApiPlay): boolean {
  return (play.kind ?? 'PLAY') === 'EVIDENCE';
}

function isWelcomeHomePlay(play: ApiPlay): boolean {
  return play.cardType === 'welcome-home-v2';
}

function mapCanonicalToLegacyMarket(canonical?: CanonicalMarketType): Market | 'NONE' {
  if (!canonical) return 'NONE';
  if (canonical === 'TOTAL' || canonical === 'TEAM_TOTAL') return 'TOTAL';
  if (canonical === 'SPREAD' || canonical === 'PUCKLINE') return 'SPREAD';
  if (canonical === 'MONEYLINE') return 'ML';
  return 'UNKNOWN';
}

function inferMarketFromCardTitle(cardTitle: string): Market {
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
  
  return 'UNKNOWN';
}

function getSourcePlayAction(play?: ApiPlay): 'FIRE' | 'HOLD' | 'PASS' | undefined {
  if (!play) return undefined;
  if (play.action === 'FIRE' || play.action === 'HOLD' || play.action === 'PASS') {
    return play.action;
  }

  const legacyStatus = String(play.status ?? '').toUpperCase();
  if (legacyStatus === 'FIRE') return 'FIRE';
  if (legacyStatus === 'WATCH' || legacyStatus === 'HOLD') return 'HOLD';
  if (legacyStatus === 'PASS') return 'PASS';
  return undefined;
}

function inferCanonicalFromSecondary(play: ApiPlay): CanonicalMarketType | undefined {
  const recommendationType = play.recommendation?.type?.toLowerCase();
  if (recommendationType) {
    if (recommendationType.includes('total')) return 'TOTAL';
    if (recommendationType.includes('spread')) return 'SPREAD';
    if (recommendationType.includes('moneyline') || recommendationType.includes('ml')) return 'MONEYLINE';
  }

  const recommendedBetType = play.recommended_bet_type?.toLowerCase();
  if (recommendedBetType) {
    if (recommendedBetType === 'total') return 'TOTAL';
    if (recommendedBetType === 'spread') return 'SPREAD';
    if (recommendedBetType === 'moneyline' || recommendedBetType === 'ml') return 'MONEYLINE';
  }

  return undefined;
}

function inferMarketFromPlay(play: ApiPlay): { market: Market; canonical?: CanonicalMarketType; reasonCodes: string[]; tags: string[] } {
  const reasonCodes = [...(play.reason_codes ?? [])];
  const tags = [...(play.tags ?? [])];

  if (!isPlayItem(play)) {
    return {
      market: 'UNKNOWN',
      canonical: 'INFO',
      reasonCodes,
      tags,
    };
  }

  if (play.market_type) {
    return {
      market: mapCanonicalToLegacyMarket(play.market_type) as Market,
      canonical: play.market_type,
      reasonCodes,
      tags,
    };
  }

  const secondary = inferCanonicalFromSecondary(play);
  if (secondary) {
    return {
      market: mapCanonicalToLegacyMarket(secondary) as Market,
      canonical: secondary,
      reasonCodes,
      tags,
    };
  }

  const side = play.selection?.side || play.prediction;
  if ((side === 'OVER' || side === 'UNDER') && typeof play.line === 'number') {
    return { market: 'TOTAL', canonical: 'TOTAL', reasonCodes, tags };
  }
  if ((side === 'HOME' || side === 'AWAY') && typeof play.line === 'number') {
    return { market: 'SPREAD', canonical: 'SPREAD', reasonCodes, tags };
  }
  if ((side === 'HOME' || side === 'AWAY') && typeof play.price === 'number') {
    return { market: 'ML', canonical: 'MONEYLINE', reasonCodes, tags };
  }

  const fallbackMarket = inferMarketFromCardTitle(play.cardTitle);
  reasonCodes.push('LEGACY_TITLE_INFERENCE_USED');
  return {
    market: fallbackMarket,
    canonical:
      fallbackMarket === 'TOTAL'
        ? 'TOTAL'
        : fallbackMarket === 'SPREAD'
          ? 'SPREAD'
          : fallbackMarket === 'ML'
            ? 'MONEYLINE'
            : undefined,
    reasonCodes,
    tags,
  };
}

/**
 * Normalize sport string to Sport type
 */
function normalizeSport(sport: string): Sport {
  const sportUpper = sport.toUpperCase();
  if (
    sportUpper === 'NHL' ||
    sportUpper === 'NBA' ||
    sportUpper === 'NCAAM' ||
    sportUpper === 'SOCCER' ||
    sportUpper === 'MLB' ||
    sportUpper === 'NFL'
  ) {
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
  const inference = inferMarketFromPlay(play);
  const market = inference.market;
  
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

/**
 * Determine best market from drivers + available odds
 * Uses same logic as decision.ts but at transform time
 */
function getPlayWhyCode(
  betAction: 'BET' | 'NO_PLAY',
  market: Market | 'NONE',
  drivers: DriverRow[],
  priceFlags: PriceFlag[]
): PassReasonCode {
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

function getRiskTagsFromText(...texts: string[]): string[] {
  const source = texts.join(' ').toLowerCase();
  const tags: string[] = [];
  if (source.includes('fragility')) tags.push('RISK_FRAGILITY');
  if (source.includes('blowout')) tags.push('RISK_BLOWOUT');
  if (source.includes('key number')) tags.push('RISK_KEY_NUMBER');
  return tags;
}

/**
 * Build canonical Play object at transform time
 */
function buildPlay(
  game: GameData,
  drivers: DriverRow[]
): Play {
  const playCandidates = game.plays.filter(isPlayItem);
  const evidenceCandidates = game.plays.filter(isEvidenceItem);
  const scopedPlayCandidates = ENABLE_WELCOME_HOME
    ? playCandidates
    : playCandidates.filter((play) => !isWelcomeHomePlay(play));
  const scopedEvidenceCandidates = ENABLE_WELCOME_HOME
    ? evidenceCandidates
    : evidenceCandidates.filter((play) => !isWelcomeHomePlay(play));
  const inferredPlays = scopedPlayCandidates.map((sourcePlay) => ({ sourcePlay, inference: inferMarketFromPlay(sourcePlay) }));
  const canonicalPlayableCount = inferredPlays.filter(({ inference }) => inference.canonical && inference.canonical !== 'INFO').length;
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
      market_type: 'INFO',
      kind: 'PLAY',
      consistency: {
        total_bias: game.consistency?.total_bias ?? 'UNKNOWN',
      },
      reason_codes: ['PASS_NO_QUALIFIED_PLAYS'],
      tags: [],
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

  // Check if there's a PROP play first (preferred for player props view)
  const propPlay = scopedPlayCandidates.find(
    (p) => p.market_type === 'PROP' && p.confidence >= 0.0
  );

  // Check if there's an explicit high-confidence SPREAD or TOTAL play available
  // Prefer those over defaulting to MONEYLINE
  const spreadPlay = scopedPlayCandidates.find(
    (p) => p.market_type === 'SPREAD' && p.confidence >= 0.6 && p.tier !== null
  );
  const totalPlay = scopedPlayCandidates.find(
    (p) => p.market_type === 'TOTAL' && p.confidence >= 0.6 && p.tier !== null
  );

  // If we have a PROP play, use it for the canonical play object
  // Otherwise, default to SPREAD/TOTAL/MONEYLINE logic
  let market: Market | 'NONE';
  let direction: Direction;
  let isPropMarket = false;
  
  if (propPlay) {
    // For PROP plays, preserve them as-is for the player props view
    market = 'UNKNOWN'; // Use UNKNOWN as placeholder since PROP isn't in Market enum
    direction = propPlay.prediction as Direction || 'NEUTRAL';
    isPropMarket = true;
  } else if (spreadPlay) {
    market = 'SPREAD';
    direction = (spreadPlay.prediction === 'HOME' || spreadPlay.prediction === 'AWAY') 
      ? spreadPlay.prediction 
      : truthDirection;
  } else if (totalPlay) {
    market = 'TOTAL';
    direction = (totalPlay.prediction === 'OVER' || totalPlay.prediction === 'UNDER') 
      ? totalPlay.prediction 
      : truthDirection;
  } else {
    // Fall back to standard market selection logic
    market = selectExpressionMarket(truthDirection, truthStatus, truthDriver, game.odds);
    direction = truthDirection;
  }

  // Build pick string with proper price/line
  let pick = 'NO PLAY';
  let price: number | undefined;
  let line: number | undefined;

  if (isPropMarket && propPlay) {
    // For PROP plays, use the selection and line/price from the prop play
    const playerName = propPlay.selection?.team || 'Player';
    const propSelection = propPlay.selection?.side || propPlay.prediction || 'UNKNOWN';
    line = propPlay.line;
    price = propPlay.price;
    if (line !== undefined) {
      pick = `${playerName} ${propSelection} ${line}`;
    } else if (price !== undefined) {
      pick = `${playerName} ${propSelection} (${price > 0 ? '+' : ''}${price})`;
    } else {
      pick = `${playerName} ${propSelection}`;
    }
  } else {
    const teamName = direction === 'HOME' ? game.homeTeam : direction === 'AWAY' ? game.awayTeam : '';

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
      price = direction === 'HOME' ? game.odds?.spreadPriceHome ?? undefined : game.odds?.spreadPriceAway ?? undefined;
      if (line !== undefined) {
        const lineStr = line > 0 ? `+${line}` : `${line}`;
        pick = `${teamName} ${lineStr}`;
      } else {
        pick = `${teamName} Spread (Line N/A)`;
      }
    } else if (market === 'TOTAL') {
      line = game.odds?.total ?? undefined;
      // Get the over/under price based on direction
      if (market === 'TOTAL') {
        price = direction === 'OVER' ? game.odds?.totalPriceOver ?? undefined : game.odds?.totalPriceUnder ?? undefined;
      }
      if (line !== undefined) {
        pick = `${direction === 'OVER' ? 'Over' : 'Under'} ${line}`;
      } else {
        pick = `${direction === 'OVER' ? 'Over' : 'Under'} (Line N/A)`;
      }
    }
  }

  const impliedProb = market === 'ML' || market === 'SPREAD' || market === 'TOTAL' ? americanToImpliedProbability(price) : undefined;
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

  let whyCode = getPlayWhyCode(betAction, market, drivers, priceFlags);
  let whyText = whyCode.replace(/_/g, ' ');
  const sourcePlayByTruthDriver = scopedPlayCandidates.find((play) => play.driverKey === truthDriver.key);
  const actionableSourcePlay = scopedPlayCandidates.find((play) => {
    const sourceAction = getSourcePlayAction(play);
    return sourceAction === 'FIRE' || sourceAction === 'HOLD';
  });
  // Prefer PROP play if available, otherwise use standard selection logic
  const sourcePlay = isPropMarket && propPlay 
    ? propPlay 
    : actionableSourcePlay ?? sourcePlayByTruthDriver ?? scopedPlayCandidates[0];
  const sourceInference = sourcePlay ? inferMarketFromPlay(sourcePlay) : { market, canonical: undefined, reasonCodes: [], tags: [] };
  const totalBias = game.consistency?.total_bias ?? sourcePlay?.consistency?.total_bias ?? 'UNKNOWN';

  const riskTags = getRiskTagsFromText(
    sourcePlay?.cardTitle ?? '',
    sourcePlay?.reasoning ?? '',
    truthDriver.cardTitle,
    truthDriver.note,
  );
  const tags = [...new Set([...(sourceInference.tags ?? []), ...riskTags])];

  const sourceAggregationKey = sourcePlay?.aggregation_key;
  const linkedEvidence = scopedEvidenceCandidates.filter((evidence) => {
    if (sourcePlay?.driverKey && evidence.evidence_for_play_id === sourcePlay.driverKey) return true;
    if (sourceAggregationKey && evidence.aggregation_key === sourceAggregationKey) return true;
    return false;
  });

  // Resolve market type: prefer explicit market_type from play, otherwise infer from direction/market
  const resolvedMarketType = isPropMarket && propPlay?.market_type === 'PROP'
    ? 'PROP'
    : sourceInference.canonical ?? (market === 'TOTAL'
      ? 'TOTAL'
      : market === 'SPREAD'
        ? 'SPREAD'
        : market === 'ML'
          ? 'MONEYLINE'
          : 'INFO');

  const reasonCodes: string[] = [...sourceInference.reasonCodes];
  if (!sourcePlay?.kind) reasonCodes.push('PASS_MISSING_KIND');
  
  // For PROP plays, the validation is different
  if (resolvedMarketType === 'PROP') {
    if (!sourcePlay?.selection?.side && !sourcePlay?.selection?.team) reasonCodes.push('PASS_MISSING_SELECTION');
  } else {
    if (!sourceInference.canonical) reasonCodes.push('PASS_MISSING_MARKET_TYPE');
    if (sourceInference.canonical === 'TOTAL' && line === undefined) reasonCodes.push('PASS_MISSING_LINE');
    if ((sourceInference.canonical === 'SPREAD' || sourceInference.canonical === 'MONEYLINE') && direction === 'NEUTRAL') {
      reasonCodes.push('PASS_MISSING_SELECTION');
    }
    if (
      (sourceInference.canonical === 'TOTAL' || sourceInference.canonical === 'SPREAD' || sourceInference.canonical === 'MONEYLINE') &&
      price === undefined
    ) {
      reasonCodes.push('PASS_NO_MARKET_PRICE');
    }
  }
  
  if (edge === undefined) reasonCodes.push('PASS_MISSING_EDGE');
  if (canonicalPlayableCount === 0) reasonCodes.push('PASS_NO_QUALIFIED_PLAYS');
  if (betAction === 'NO_PLAY' && !reasonCodes.includes(whyCode)) reasonCodes.push(whyCode);

  const sourcePlayAction = getSourcePlayAction(sourcePlay);
  const sourcePlayIsActionable = sourcePlayAction === 'FIRE' || sourcePlayAction === 'HOLD';
  const hasExplicitTotalsConsistencyBlock =
    resolvedMarketType === 'TOTAL' &&
    totalBias !== 'OK' &&
    totalBias !== 'UNKNOWN' &&
    !sourcePlayIsActionable;

  if (hasExplicitTotalsConsistencyBlock) {
    reasonCodes.push('PASS_TOTAL_INSUFFICIENT_DATA');
    tags.push('CONSISTENCY_BLOCK_TOTALS');
    whyCode = 'PASS_TOTAL_INSUFFICIENT_DATA';
    whyText = 'PASS TOTAL INSUFFICIENT DATA';
  }

  const hasTeamContext =
    direction === 'HOME' ||
    direction === 'AWAY' ||
    Boolean(sourcePlay?.selection?.team);

  // Invariant violations only apply to standard markets, not PROP
  const hasTotalInvariantViolation =
    resolvedMarketType === 'TOTAL' &&
    (!((direction === 'OVER' || direction === 'UNDER') && typeof line === 'number'));
  const hasSpreadInvariantViolation =
    resolvedMarketType === 'SPREAD' &&
    (!((direction === 'HOME' || direction === 'AWAY') && typeof line === 'number'));
  const hasMoneylineInvariantViolation =
    resolvedMarketType === 'MONEYLINE' &&
    !((direction === 'HOME' || direction === 'AWAY') && hasTeamContext);

  if (betAction === 'NO_PLAY' || hasExplicitTotalsConsistencyBlock) {
    pick = 'NO PLAY';
  }

  // For PROP plays, don't enforce standard market invariants
  const forcedPass = resolvedMarketType !== 'PROP' && (hasTotalInvariantViolation || hasSpreadInvariantViolation || hasMoneylineInvariantViolation);
  if (forcedPass) {
    if (hasTotalInvariantViolation) reasonCodes.push('PASS_MISSING_LINE');
    if (hasSpreadInvariantViolation) {
      reasonCodes.push('PASS_MISSING_SELECTION');
      reasonCodes.push('PASS_MISSING_LINE');
    }
    if (hasMoneylineInvariantViolation) reasonCodes.push('PASS_MISSING_SELECTION');
    pick = 'NO PLAY';
  }

  const hardPass = forcedPass || hasExplicitTotalsConsistencyBlock;
  const passReasonCode = Array.from(new Set(reasonCodes)).find((code) => code.startsWith('PASS_')) ?? null;

  // Build initial play object for canonical decision
  const playForDecision: CanonicalPlay = {
    play_id: sourcePlay?.driverKey ?? `${game.id}:${resolvedMarketType}:${direction}`,
    sport: game.sport as CanonicalSport,
    game_id: game.gameId,
    market_type: resolvedMarketType as MarketType,
    side: direction === 'HOME' || direction === 'AWAY' || direction === 'OVER' || direction === 'UNDER' ? direction : undefined,
    selection_key: direction as SelectionKey,
    line,
    price_american: price,
    model: {
      edge,
      confidence: truthStrength,
    },
    warning_tags: tags,
    classification: 'PASS',
    action: 'PASS',
    created_at: game.createdAt,
  };

  // Market context: refine later with real availability checks
  const marketContext = {
    market_available: Boolean(game?.odds), // refine later if you have per-market availability
    time_window_ok: true, // refine later based on game time
    wrapper_blocks: false, // set true in wrappers (NHL goalie, Soccer scope, etc.)
  };

  // Derive canonical decision (classification + action)
  const decision = derivePlayDecision(playForDecision, marketContext, {});
  const resolvedDisplayDecision = resolvePlayDisplayDecision({
    action: hardPass
      ? 'PASS'
      : sourcePlayAction ?? (decision.action as 'FIRE' | 'HOLD' | 'PASS' | undefined),
    status: sourcePlay?.status,
    classification: hardPass
      ? 'PASS'
      : (decision.classification as 'BASE' | 'LEAN' | 'PASS' | undefined),
  });

  return {
    market_type: resolvedMarketType,
    kind: 'PLAY',
    evidence_count: linkedEvidence.length,
    consistency: {
      total_bias: totalBias,
    },
    selection:
      resolvedMarketType === 'PROP' && propPlay?.selection?.side
        ? {
            side: propPlay.selection.side as SelectionSide,
            team: propPlay.selection.team,
          }
        : direction === 'HOME' || direction === 'AWAY' || direction === 'OVER' || direction === 'UNDER'
          ? {
              side: direction as SelectionSide,
              team: direction === 'HOME' ? game.homeTeam : direction === 'AWAY' ? game.awayTeam : undefined,
            }
          : undefined,
    reason_codes: Array.from(new Set(reasonCodes)),
    tags,
    // Canonical fields (preferred)
    classification: resolvedDisplayDecision.classification,
    action: resolvedDisplayDecision.action,
    pass_reason_code: hardPass
      ? passReasonCode
      : sourcePlay?.pass_reason_code ?? decision.play?.pass_reason_code ?? null,
    // Legacy compatibility (keep until UI migration complete)
    status: resolvedDisplayDecision.status,
    market,
    pick,
    lean: resolvedMarketType === 'PROP' && propPlay?.selection?.team ? propPlay.selection.team : direction === 'HOME' ? game.homeTeam : direction === 'AWAY' ? game.awayTeam : direction,
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
  const rawDrivers = game.plays.filter(isPlayItem).map(playToDriver);
  const scopedRawDrivers = ENABLE_WELCOME_HOME
    ? rawDrivers
    : rawDrivers.filter((driver) => driver.cardType !== 'welcome-home-v2');
  const drivers = deduplicateDrivers(scopedRawDrivers);
  const evidenceSource = ENABLE_WELCOME_HOME
    ? game.plays.filter(isEvidenceItem)
    : game.plays.filter((play) => !isWelcomeHomePlay(play) && isEvidenceItem(play));
  const evidence: EvidenceItem[] = evidenceSource
    .map((play, index) => ({
      id: `${game.gameId}:evidence:${play.driverKey || play.cardType || index}`,
      cardType: play.cardType,
      cardTitle: play.cardTitle,
      reasoning: play.reasoning,
      driverKey: play.driverKey,
      selection: play.selection?.side
        ? {
            side: play.selection.side as 'OVER' | 'UNDER' | 'HOME' | 'AWAY' | 'FAV' | 'DOG' | 'NONE',
            team: play.selection.team,
          }
        : undefined,
      aggregation_key: play.aggregation_key,
      evidence_for_play_id: play.evidence_for_play_id,
    }));
  
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
    evidence,
    tags: initialTags,
  };
}

/**
 * Transform array of GameData to GameCard[]
 */
export function transformGames(games: GameData[]): GameCard[] {
  return games.map(transformToGameCard);
}

/**
 * Transform games to PropGameCard format - for player props view
 * Groups all PROP plays under each game as rows
 */
export function transformPropGames(games: GameData[]): PropGameCard[] {
  const propGames: PropGameCard[] = [];
  
  for (const game of games) {
    // Extract all PROP plays from this game
    const propPlays = game.plays.filter(p => p.market_type === 'PROP');
    
    // Skip games with no props
    if (propPlays.length === 0) continue;
    
    // Convert each play to a PropPlayRow
    const propPlayRows: PropPlayRow[] = propPlays.map(play => {
      const selectionTeam = play.selection?.team;
      const playerName = play.player_name || selectionTeam || 'Unknown Player';
      const playerId = play.player_id || selectionTeam || 'unknown';
      
      // Infer prop type from card title or type
      let propType = 'Unknown';
      const titleLower = (play.cardTitle || '').toLowerCase();
      if (titleLower.includes('shots') || titleLower.includes('sog')) {
        propType = 'Shots on Goal';
      } else if (titleLower.includes('points')) {
        propType = 'Points';
      } else if (titleLower.includes('assists')) {
        propType = 'Assists';
      } else if (titleLower.includes('rebounds')) {
        propType = 'Rebounds';
      }
      
      // Determine status from action or legacy status field
      let status: PropPlayRow['status'] = 'NO_PLAY';
      if (play.action === 'FIRE') {
        status = 'FIRE';
      } else if (play.action === 'HOLD') {
        status = 'HOLD';
      } else if (play.action === 'PASS') {
        status = 'NO_PLAY';
      } else if (play.status === 'FIRE') {
        status = 'FIRE';
      } else if (play.status === 'WATCH') {
        status = 'WATCH';
      } else if (play.status === 'PASS') {
        status = 'NO_PLAY';
      }
      
      const mu = play.mu ?? play.projectedTotal ?? null;
      const suggestedLine = play.suggested_line ?? play.line ?? null;
      const edge = play.edge ?? (mu !== null && suggestedLine !== null ? mu - suggestedLine : null);

      return {
        runId: play.run_id,
        createdAt: play.created_at,
        playerId,
        playerName,
        teamAbbr: play.team_abbr ?? undefined,
        gameId: play.game_id ?? game.gameId,
        propType,
        line: play.line ?? play.suggested_line ?? null,
        projection: play.projectedTotal ?? play.mu ?? null,
        mu,
        suggestedLine,
        threshold: play.threshold ?? null,
        confidence: play.confidence ?? null,
        price: play.price ?? null,
        status,
        action: play.action,
        edge,
        isTrending: play.is_trending,
        roleGatePass: play.role_gate_pass,
        dataQuality: play.data_quality ?? null,
        reasonCodes: play.reason_codes,
        l5Sog: play.l5_sog ?? undefined,
        l5Mean: play.l5_mean ?? null,
        sourceCardType: play.cardType,
        sourceCardTitle: play.cardTitle,
        updatedAtUtc: game.odds?.capturedAt || game.createdAt,
        reasoning: play.reasoning,
      };
    });
    
    // Sort rows by confidence desc, then edge desc
    propPlayRows.sort((a, b) => {
      if ((a.confidence ?? 0) !== (b.confidence ?? 0)) {
        return (b.confidence ?? 0) - (a.confidence ?? 0);
      }
      return (b.edge ?? 0) - (a.edge ?? 0);
    });
    
    const maxConfidence = Math.max(...propPlayRows.map(p => p.confidence ?? 0));
    
    // Build prop game card
    const propGameCard: PropGameCard = {
      gameId: game.gameId,
      sport: normalizeSport(game.sport),
      gameTimeUtc: game.gameTimeUtc,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      status: game.status,
      oddsUpdatedUtc: game.odds?.capturedAt,
      moneyline: game.odds?.h2hHome && game.odds?.h2hAway
        ? { home: game.odds.h2hHome, away: game.odds.h2hAway }
        : undefined,
      total: game.odds?.total ? { line: game.odds.total } : undefined,
      propPlays: propPlayRows,
      maxConfidence,
      tags: [], // add filtering tags as needed
    };
    
    propGames.push(propGameCard);
  }
  
  // Sort games by max confidence desc
  propGames.sort((a, b) => b.maxConfidence - a.maxConfidence);
  
  return propGames;
}
