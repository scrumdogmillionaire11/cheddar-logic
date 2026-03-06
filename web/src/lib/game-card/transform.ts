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
  DecisionLabel,
  DecisionClassification,
  CanonicalGate,
  CanonicalBet,
  BetMarketType,
  BetSide,
  DecisionData,
  CardQuality,
} from '../types/game-card';
import type {
  CanonicalPlay,
  MarketType,
  SelectionKey,
  Sport as CanonicalSport,
} from '../types/canonical-play';
import { deduplicateDrivers, resolvePlayDisplayDecision } from './decision';
import { derivePlayDecision } from '../play-decision/canonical-decision';

const ENABLE_WELCOME_HOME =
  process.env.NEXT_PUBLIC_ENABLE_WELCOME_HOME === 'true';

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
  model_prob?: number | null;
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
    total_bias?:
      | 'OK'
      | 'INSUFFICIENT_DATA'
      | 'CONFLICTING_SIGNALS'
      | 'VOLATILE_ENV'
      | 'UNKNOWN';
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
    total_bias?:
      | 'OK'
      | 'INSUFFICIENT_DATA'
      | 'CONFLICTING_SIGNALS'
      | 'VOLATILE_ENV'
      | 'UNKNOWN';
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

function mapCanonicalToLegacyMarket(
  canonical?: CanonicalMarketType,
): Market | 'NONE' {
  if (!canonical) return 'NONE';
  if (canonical === 'TOTAL' || canonical === 'TEAM_TOTAL') return 'TOTAL';
  if (canonical === 'SPREAD' || canonical === 'PUCKLINE') return 'SPREAD';
  if (canonical === 'MONEYLINE') return 'ML';
  return 'UNKNOWN';
}

function inferMarketFromCardTitle(cardTitle: string): Market {
  const titleLower = cardTitle.toLowerCase();

  if (
    titleLower.includes('total') ||
    titleLower.includes('o/u') ||
    titleLower.includes('over') ||
    titleLower.includes('under')
  ) {
    return 'TOTAL';
  }

  if (titleLower.includes('spread') || titleLower.includes('line')) {
    return 'SPREAD';
  }

  if (
    titleLower.includes('moneyline') ||
    titleLower.includes('ml') ||
    titleLower.includes('h2h')
  ) {
    return 'ML';
  }

  if (
    titleLower.includes('projection') ||
    titleLower.includes('rest') ||
    titleLower.includes('matchup')
  ) {
    return 'ML';
  }

  return 'UNKNOWN';
}

function getSourcePlayAction(
  play?: ApiPlay,
): 'FIRE' | 'HOLD' | 'PASS' | undefined {
  if (!play) return undefined;
  if (
    play.action === 'FIRE' ||
    play.action === 'HOLD' ||
    play.action === 'PASS'
  ) {
    return play.action;
  }

  if (play.classification === 'BASE') return 'FIRE';
  if (play.classification === 'LEAN') return 'HOLD';
  if (play.classification === 'PASS') return 'PASS';

  const legacyStatus = String(play.status ?? '').toUpperCase();
  if (legacyStatus === 'FIRE') return 'FIRE';
  if (legacyStatus === 'WATCH' || legacyStatus === 'HOLD') return 'HOLD';
  if (legacyStatus === 'PASS') return 'PASS';
  return undefined;
}

function inferCanonicalFromSecondary(
  play: ApiPlay,
): CanonicalMarketType | undefined {
  const recommendationType = play.recommendation?.type?.toLowerCase();
  if (recommendationType) {
    if (recommendationType.includes('total')) return 'TOTAL';
    if (recommendationType.includes('spread')) return 'SPREAD';
    if (
      recommendationType.includes('moneyline') ||
      recommendationType.includes('ml')
    )
      return 'MONEYLINE';
  }

  const recommendedBetType = play.recommended_bet_type?.toLowerCase();
  if (recommendedBetType) {
    if (recommendedBetType === 'total') return 'TOTAL';
    if (recommendedBetType === 'spread') return 'SPREAD';
    if (recommendedBetType === 'moneyline' || recommendedBetType === 'ml')
      return 'MONEYLINE';
  }

  return undefined;
}

function inferMarketFromPlay(play: ApiPlay): {
  market: Market;
  canonical?: CanonicalMarketType;
  reasonCodes: string[];
  tags: string[];
} {
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

type CanonicalSide = 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NONE';
type DedupeCandidate = {
  play: ApiPlay;
  inference: ReturnType<typeof inferMarketFromPlay>;
};

function normalizeSideToken(value: unknown): CanonicalSide {
  const token = String(value ?? '').toUpperCase();
  if (
    token === 'HOME' ||
    token === 'AWAY' ||
    token === 'OVER' ||
    token === 'UNDER'
  )
    return token;
  return 'NONE';
}

function normalizeSideForCanonicalMarket(
  canonical: CanonicalMarketType | undefined,
  side: CanonicalSide,
): CanonicalSide {
  if (
    canonical === 'MONEYLINE' ||
    canonical === 'SPREAD' ||
    canonical === 'PUCKLINE'
  ) {
    return side === 'HOME' || side === 'AWAY' ? side : 'NONE';
  }
  if (
    canonical === 'TOTAL' ||
    canonical === 'TEAM_TOTAL' ||
    canonical === 'PROP'
  ) {
    return side === 'OVER' || side === 'UNDER' ? side : 'NONE';
  }
  return 'NONE';
}

function marketPrefix(
  canonical?: CanonicalMarketType,
): 'ML' | 'SPREAD' | 'TOTAL' | 'PROP' | 'INFO' {
  if (canonical === 'MONEYLINE') return 'ML';
  if (canonical === 'SPREAD' || canonical === 'PUCKLINE') return 'SPREAD';
  if (canonical === 'TOTAL' || canonical === 'TEAM_TOTAL') return 'TOTAL';
  if (canonical === 'PROP') return 'PROP';
  return 'INFO';
}

function buildMarketKey(
  canonical: CanonicalMarketType | undefined,
  side: CanonicalSide,
): string {
  return `${marketPrefix(canonical)}|${side}`;
}

function hasPlayableBet(
  play: ApiPlay,
  canonical: CanonicalMarketType | undefined,
  side: CanonicalSide,
): boolean {
  if (canonical === 'MONEYLINE') {
    return (
      (side === 'HOME' || side === 'AWAY') && typeof play.price === 'number'
    );
  }
  if (canonical === 'SPREAD' || canonical === 'PUCKLINE') {
    return (
      (side === 'HOME' || side === 'AWAY') &&
      typeof play.line === 'number' &&
      typeof play.price === 'number'
    );
  }
  if (canonical === 'TOTAL' || canonical === 'TEAM_TOTAL') {
    return (
      (side === 'OVER' || side === 'UNDER') &&
      typeof play.line === 'number' &&
      typeof play.price === 'number'
    );
  }
  if (canonical === 'PROP') {
    return typeof play.line === 'number' || typeof play.price === 'number';
  }
  return false;
}

function playDecisionRank(play: ApiPlay): number {
  const action = getSourcePlayAction(play);
  if (action === 'FIRE') return 3;
  if (action === 'HOLD') return 2;
  if (action === 'PASS') return 1;
  return 0;
}

function playValueRank(play: ApiPlay): number {
  const edge = typeof play.edge === 'number' ? play.edge : null;
  if (edge !== null && edge >= 0.04) return 3;
  if (edge !== null && edge >= 0.015) return 2;
  if (edge !== null && edge > 0) return 1;
  return 0;
}

function timestampMs(value?: string): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function comparePlayCandidates(a: DedupeCandidate, b: DedupeCandidate): number {
  const aHasBet = hasPlayableBet(
    a.play,
    a.inference.canonical,
    normalizeSideToken(a.play.selection?.side ?? a.play.prediction),
  );
  const bHasBet = hasPlayableBet(
    b.play,
    b.inference.canonical,
    normalizeSideToken(b.play.selection?.side ?? b.play.prediction),
  );
  if (aHasBet !== bHasBet) return aHasBet ? 1 : -1;

  const actionDelta = playDecisionRank(a.play) - playDecisionRank(b.play);
  if (actionDelta !== 0) return actionDelta;

  const valueDelta = playValueRank(a.play) - playValueRank(b.play);
  if (valueDelta !== 0) return valueDelta;

  const createdDelta =
    timestampMs(a.play.created_at) - timestampMs(b.play.created_at);
  if (createdDelta !== 0) return createdDelta;

  const edgeDelta =
    (typeof a.play.edge === 'number' ? a.play.edge : -Infinity) -
    (typeof b.play.edge === 'number' ? b.play.edge : -Infinity);
  if (edgeDelta !== 0) return edgeDelta;

  return 0;
}

function dedupePlayCandidates(game: GameData, plays: ApiPlay[]): ApiPlay[] {
  const byKey = new Map<string, DedupeCandidate>();

  for (const play of plays) {
    const inference = inferMarketFromPlay(play);
    const side = normalizeSideToken(play.selection?.side ?? play.prediction);
    const marketKey = buildMarketKey(inference.canonical, side);
    const dedupeKey = `${game.sport}|${game.gameId}|${marketKey}`;
    const current: DedupeCandidate = { play, inference };
    const existing = byKey.get(dedupeKey);
    if (!existing || comparePlayCandidates(current, existing) > 0) {
      byKey.set(dedupeKey, current);
    }
  }

  return Array.from(byKey.values()).map((entry) => entry.play);
}

function decisionFromAction(action: 'FIRE' | 'HOLD' | 'PASS'): DecisionLabel {
  if (action === 'FIRE') return 'FIRE';
  if (action === 'HOLD') return 'WATCH';
  return 'PASS';
}

function decisionClassificationFromAction(
  action: 'FIRE' | 'HOLD' | 'PASS',
): DecisionClassification {
  if (action === 'FIRE') return 'PLAY';
  if (action === 'HOLD') return 'LEAN';
  return 'NONE';
}

function actionFromDecision(decision: DecisionLabel): 'FIRE' | 'HOLD' | 'PASS' {
  if (decision === 'FIRE') return 'FIRE';
  if (decision === 'WATCH') return 'HOLD';
  return 'PASS';
}

function mapCanonicalToBetMarketType(
  marketType: CanonicalMarketType,
): BetMarketType | null {
  if (marketType === 'MONEYLINE') return 'moneyline';
  if (marketType === 'SPREAD' || marketType === 'PUCKLINE') return 'spread';
  if (marketType === 'TOTAL') return 'total';
  if (marketType === 'TEAM_TOTAL') return 'team_total';
  if (marketType === 'PROP') return 'player_prop';
  return null;
}

function mapDirectionToBetSide(direction: Direction): BetSide | null {
  if (direction === 'HOME') return 'home';
  if (direction === 'AWAY') return 'away';
  if (direction === 'OVER') return 'over';
  if (direction === 'UNDER') return 'under';
  return null;
}

function validateCanonicalBet(bet: CanonicalBet): boolean {
  if (bet.market_type === 'moneyline') {
    return (
      (bet.side === 'home' || bet.side === 'away') && bet.line === undefined
    );
  }
  if (bet.market_type === 'spread') {
    return (
      (bet.side === 'home' || bet.side === 'away') &&
      typeof bet.line === 'number'
    );
  }
  if (bet.market_type === 'total') {
    return (
      (bet.side === 'over' || bet.side === 'under') &&
      typeof bet.line === 'number'
    );
  }
  if (bet.market_type === 'team_total') {
    return (
      (bet.side === 'over' || bet.side === 'under') &&
      typeof bet.line === 'number' &&
      (bet.team === 'home' || bet.team === 'away')
    );
  }
  if (bet.market_type === 'player_prop') {
    return (
      (bet.side === 'over' || bet.side === 'under') &&
      (typeof bet.line === 'number' || Number.isFinite(bet.odds_american))
    );
  }
  return false;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function edgeTierFromPct(edgePct: number): 'BEST' | 'GOOD' | 'OK' | 'BAD' {
  if (edgePct >= 0.08) return 'BEST';
  if (edgePct >= 0.04) return 'GOOD';
  if (edgePct >= 0.015) return 'OK';
  return 'BAD';
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
  const direction: Direction =
    play.prediction === 'NEUTRAL' ? 'NEUTRAL' : play.prediction;
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
  return (
    text.includes('blowout risk') ||
    (driver.market === 'RISK' && text.includes('blowout'))
  );
}

function directionScore(drivers: DriverRow[], direction: Direction): number {
  return drivers
    .filter((driver) => driver.direction === direction)
    .reduce((sum, driver) => {
      const confidence =
        typeof driver.confidence === 'number'
          ? clamp(driver.confidence, 0, 1)
          : 0.6;
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
    (driver) => driver.direction !== 'NEUTRAL' && !isRiskOnlyDriver(driver),
  );
  if (candidates.length === 0) return null;
  return sortDriversByStrength(candidates)[0];
}

function selectExpressionMarket(
  direction: Direction,
  truthStatus: TruthStatus,
  driver: DriverRow,
  odds: GameData['odds'],
): Market | 'NONE' {
  if (direction === 'OVER' || direction === 'UNDER') {
    return odds?.total !== null && odds?.total !== undefined ? 'TOTAL' : 'NONE';
  }

  const mlPrice =
    direction === 'HOME'
      ? (odds?.h2hHome ?? undefined)
      : (odds?.h2hAway ?? undefined);
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

  if (
    hasMLOdds &&
    typeof mlPrice === 'number' &&
    mlPrice <= -240 &&
    hasSpreadOdds &&
    truthStatus === 'STRONG'
  ) {
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

function getPriceFlags(
  market: Market | 'NONE',
  direction: Direction | null,
  price?: number,
): PriceFlag[] {
  if (market !== 'ML') return [];
  if (direction !== 'HOME' && direction !== 'AWAY') return [];
  if (price === undefined) return ['VIG_HEAVY'];

  const flags = new Set<PriceFlag>();
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
  priceFlags: PriceFlag[],
): PassReasonCode {
  if (betAction === 'NO_PLAY') {
    if (priceFlags.includes('PRICE_TOO_STEEP')) return 'PRICE_TOO_STEEP';
    if (priceFlags.includes('VIG_HEAVY')) return 'MISSING_PRICE_EDGE';
    return 'NO_VALUE_AT_PRICE';
  }

  if (market === 'NONE') return 'NO_DECISION';

  const allText = drivers
    .map((d) => `${d.cardTitle} ${d.note}`.toLowerCase())
    .join(' ');

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

function hasPlaceholderText(value?: string): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized.includes('generic analysis for') ||
    normalized.includes('ncaam ncaam generic') ||
    normalized === 'no contributors available'
  );
}

function resolveSourceModelProb(play?: ApiPlay): number | undefined {
  const raw = play?.model_prob;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  if (raw < 0 || raw > 1) return undefined;
  return clamp01(raw);
}

/**
 * Build canonical Play object at transform time
 */
function buildPlay(game: GameData, drivers: DriverRow[]): Play {
  const playCandidates = game.plays.filter(isPlayItem);
  const dedupedPlayCandidates = dedupePlayCandidates(game, playCandidates);
  const evidenceCandidates = game.plays.filter(isEvidenceItem);
  const scopedPlayCandidates = ENABLE_WELCOME_HOME
    ? dedupedPlayCandidates
    : dedupedPlayCandidates.filter((play) => !isWelcomeHomePlay(play));
  const scopedEvidenceCandidates = ENABLE_WELCOME_HOME
    ? evidenceCandidates
    : evidenceCandidates.filter((play) => !isWelcomeHomePlay(play));
  const inferredPlays = scopedPlayCandidates.map((sourcePlay) => ({
    sourcePlay,
    inference: inferMarketFromPlay(sourcePlay),
  }));
  const canonicalPlayableCount = inferredPlays.filter(
    ({ inference }) => inference.canonical && inference.canonical !== 'INFO',
  ).length;
  const truthDriver = pickTruthDriver(drivers);

  if (!truthDriver) {
    return {
      market_key: 'INFO|NONE',
      decision: 'PASS',
      classificationLabel: 'NONE',
      bet: null,
      gates: [
        {
          code: 'PASS_NO_QUALIFIED_PLAYS',
          severity: 'BLOCK',
          blocks_bet: true,
        },
      ],
      decision_data: {
        status: 'PASS',
        truth: 'WEAK',
        value_tier: 'BAD',
        edge_pct: null,
        edge_tier: 'BAD',
        coinflip: false,
        reason_code: 'PASS_NO_QUALIFIED_PLAYS',
      },
      transform_meta: {
        quality: 'DEGRADED',
        missing_inputs: ['drivers'],
        placeholders_found: [],
      },
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
  const opposeScore = oppositeDirection
    ? directionScore(drivers, oppositeDirection)
    : 0;
  const totalScore = supportScore + opposeScore;
  const net = totalScore > 0 ? (supportScore - opposeScore) / totalScore : 0;
  const conflict = totalScore > 0 ? clamp(opposeScore / totalScore, 0, 1) : 0;
  const truthStrength = clamp(0.5 + net * 0.3, 0.5, 0.8);
  const truthStatus = truthStatusFromStrength(truthStrength);

  // Check if there's a PROP play first (preferred for player props view)
  const propPlay = scopedPlayCandidates.find(
    (p) => p.market_type === 'PROP' && p.confidence >= 0.0,
  );

  // Check if there's an explicit high-confidence SPREAD or TOTAL play available
  // Prefer those over defaulting to MONEYLINE
  const spreadPlay = scopedPlayCandidates.find(
    (p) => p.market_type === 'SPREAD' && p.confidence >= 0.6 && p.tier !== null,
  );
  const totalPlay = scopedPlayCandidates.find(
    (p) => p.market_type === 'TOTAL' && p.confidence >= 0.6 && p.tier !== null,
  );

  // If we have a PROP play, use it for the canonical play object
  // Otherwise, default to SPREAD/TOTAL/MONEYLINE logic
  let market: Market | 'NONE';
  let direction: Direction;
  let isPropMarket = false;

  if (propPlay) {
    // For PROP plays, preserve them as-is for the player props view
    market = 'UNKNOWN'; // Use UNKNOWN as placeholder since PROP isn't in Market enum
    direction = (propPlay.prediction as Direction) || 'NEUTRAL';
    isPropMarket = true;
  } else if (spreadPlay) {
    market = 'SPREAD';
    const spreadSide = normalizeSideToken(
      spreadPlay.selection?.side ?? spreadPlay.prediction,
    );
    if (spreadSide === 'HOME' || spreadSide === 'AWAY') {
      direction = spreadSide;
    } else if (truthDirection === 'HOME' || truthDirection === 'AWAY') {
      direction = truthDirection;
    } else {
      direction = 'NEUTRAL';
    }
  } else if (totalPlay) {
    market = 'TOTAL';
    const totalSide = normalizeSideToken(
      totalPlay.selection?.side ?? totalPlay.prediction,
    );
    if (totalSide === 'OVER' || totalSide === 'UNDER') {
      direction = totalSide;
    } else if (truthDirection === 'OVER' || truthDirection === 'UNDER') {
      direction = truthDirection;
    } else {
      direction = 'NEUTRAL';
    }
  } else {
    // Fall back to standard market selection logic
    market = selectExpressionMarket(
      truthDirection,
      truthStatus,
      truthDriver,
      game.odds,
    );
    direction = truthDirection;
  }

  // Build pick string with proper price/line
  let pick = 'NO PLAY';
  let price: number | undefined;
  let line: number | undefined;

  if (isPropMarket && propPlay) {
    // For PROP plays, use the selection and line/price from the prop play
    const playerName = propPlay.selection?.team || 'Player';
    const propSelection =
      propPlay.selection?.side || propPlay.prediction || 'UNKNOWN';
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
    const teamName =
      direction === 'HOME'
        ? game.homeTeam
        : direction === 'AWAY'
          ? game.awayTeam
          : '';

    if (market === 'ML') {
      price =
        direction === 'HOME'
          ? (game.odds?.h2hHome ?? undefined)
          : (game.odds?.h2hAway ?? undefined);
      if (price !== undefined) {
        const priceStr = price > 0 ? `+${price}` : `${price}`;
        pick = `${teamName} ML ${priceStr}`;
      } else {
        pick = `${teamName} ML (Price N/A)`;
      }
    } else if (market === 'SPREAD') {
      line =
        direction === 'HOME'
          ? (game.odds?.spreadHome ?? undefined)
          : (game.odds?.spreadAway ?? undefined);
      price =
        direction === 'HOME'
          ? (game.odds?.spreadPriceHome ?? undefined)
          : (game.odds?.spreadPriceAway ?? undefined);
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
        price =
          direction === 'OVER'
            ? (game.odds?.totalPriceOver ?? undefined)
            : (game.odds?.totalPriceUnder ?? undefined);
      }
      if (line !== undefined) {
        pick = `${direction === 'OVER' ? 'Over' : 'Under'} ${line}`;
      } else {
        pick = `${direction === 'OVER' ? 'Over' : 'Under'} (Line N/A)`;
      }
    }
  }

  const sourcePlayByTruthDriver = scopedPlayCandidates.find(
    (play) => play.driverKey === truthDriver.key,
  );
  const rankedSourceCandidates = scopedPlayCandidates
    .map((play) => {
      const inference = inferMarketFromPlay(play);
      const side = normalizeSideToken(play.selection?.side ?? play.prediction);
      return {
        play,
        inference,
        hasPlayableBet: hasPlayableBet(play, inference.canonical, side),
        hasModelProb: resolveSourceModelProb(play) !== undefined,
        actionRank: playDecisionRank(play),
        valueRank: playValueRank(play),
        truthDriverMatch: play.driverKey === truthDriver.key ? 1 : 0,
        createdMs: timestampMs(play.created_at),
      };
    })
    .sort((a, b) => {
      if (a.hasPlayableBet !== b.hasPlayableBet)
        return a.hasPlayableBet ? -1 : 1;
      if (a.hasModelProb !== b.hasModelProb) return a.hasModelProb ? -1 : 1;
      if (a.actionRank !== b.actionRank) return b.actionRank - a.actionRank;
      if (a.truthDriverMatch !== b.truthDriverMatch)
        return b.truthDriverMatch - a.truthDriverMatch;
      if (a.valueRank !== b.valueRank) return b.valueRank - a.valueRank;
      if (a.createdMs !== b.createdMs) return b.createdMs - a.createdMs;
      return 0;
    });

  // Prefer PROP play if available, otherwise use best ranked source candidate
  const preferredCanonical =
    market === 'TOTAL'
      ? 'TOTAL'
      : market === 'SPREAD'
        ? 'SPREAD'
        : market === 'ML'
          ? 'MONEYLINE'
          : undefined;
  const marketAlignedCandidates = preferredCanonical
    ? rankedSourceCandidates.filter(
        (candidate) => candidate.inference.canonical === preferredCanonical,
      )
    : rankedSourceCandidates;
  const marketAlignedPlayableCandidates = marketAlignedCandidates.filter(
    (candidate) => candidate.hasPlayableBet,
  );
  const sourceCandidatePool =
    marketAlignedPlayableCandidates.length > 0
      ? marketAlignedCandidates
      : rankedSourceCandidates;

  const selectedSource =
    isPropMarket && propPlay
      ? {
          play: propPlay,
          inference: inferMarketFromPlay(propPlay),
        }
      : (sourceCandidatePool[0] ??
        rankedSourceCandidates[0] ??
        (sourcePlayByTruthDriver
          ? {
              play: sourcePlayByTruthDriver,
              inference: inferMarketFromPlay(sourcePlayByTruthDriver),
            }
          : null));
  const sourcePlay = selectedSource?.play ?? scopedPlayCandidates[0];
  const sourceInference =
    selectedSource?.inference ??
    (sourcePlay
      ? inferMarketFromPlay(sourcePlay)
      : { market, canonical: undefined, reasonCodes: [], tags: [] });
  const sourceSide = normalizeSideToken(
    sourcePlay?.selection?.side ?? sourcePlay?.prediction,
  );
  const sourceHasPlayableBet =
    Boolean(sourcePlay) &&
    hasPlayableBet(sourcePlay, sourceInference.canonical, sourceSide);

  if (!isPropMarket && sourceHasPlayableBet && sourceInference.canonical) {
    if (
      sourceInference.canonical === 'MONEYLINE' &&
      (sourceSide === 'HOME' || sourceSide === 'AWAY')
    ) {
      market = 'ML';
      direction = sourceSide;
      line = undefined;
      price = typeof sourcePlay?.price === 'number' ? sourcePlay.price : price;
    } else if (
      (sourceInference.canonical === 'SPREAD' ||
        sourceInference.canonical === 'PUCKLINE') &&
      (sourceSide === 'HOME' || sourceSide === 'AWAY')
    ) {
      market = 'SPREAD';
      direction = sourceSide;
      line = typeof sourcePlay?.line === 'number' ? sourcePlay.line : line;
      price = typeof sourcePlay?.price === 'number' ? sourcePlay.price : price;
    } else if (
      (sourceInference.canonical === 'TOTAL' ||
        sourceInference.canonical === 'TEAM_TOTAL') &&
      (sourceSide === 'OVER' || sourceSide === 'UNDER')
    ) {
      market = 'TOTAL';
      direction = sourceSide;
      line = typeof sourcePlay?.line === 'number' ? sourcePlay.line : line;
      price = typeof sourcePlay?.price === 'number' ? sourcePlay.price : price;
    }
  }

  if (!isPropMarket) {
    const teamName =
      direction === 'HOME'
        ? game.homeTeam
        : direction === 'AWAY'
          ? game.awayTeam
          : '';
    if (market === 'ML') {
      if (price === undefined) {
        price =
          direction === 'HOME'
            ? (game.odds?.h2hHome ?? undefined)
            : (game.odds?.h2hAway ?? undefined);
      }
      if (direction === 'HOME' || direction === 'AWAY') {
        pick = `${teamName} ML ${price !== undefined ? (price > 0 ? `+${price}` : `${price}`) : '(Price N/A)'}`;
      }
    } else if (market === 'SPREAD') {
      if (line === undefined) {
        line =
          direction === 'HOME'
            ? (game.odds?.spreadHome ?? undefined)
            : (game.odds?.spreadAway ?? undefined);
      }
      if (price === undefined) {
        price =
          direction === 'HOME'
            ? (game.odds?.spreadPriceHome ?? undefined)
            : (game.odds?.spreadPriceAway ?? undefined);
      }
      if (direction === 'HOME' || direction === 'AWAY') {
        pick = `${teamName} ${line !== undefined ? (line > 0 ? `+${line}` : `${line}`) : 'Spread (Line N/A)'}`;
      }
    } else if (market === 'TOTAL') {
      if (line === undefined) {
        line = game.odds?.total ?? undefined;
      }
      if (price === undefined) {
        price =
          direction === 'OVER'
            ? (game.odds?.totalPriceOver ?? undefined)
            : (game.odds?.totalPriceUnder ?? undefined);
      }
      if (direction === 'OVER' || direction === 'UNDER') {
        pick = `${direction === 'OVER' ? 'Over' : 'Under'} ${line !== undefined ? line : '(Line N/A)'}`;
      }
    }
  }
  // Resolve market type: prefer selected market, then source canonical fallback.
  const inferredMarketTypeFromSelection =
    market === 'TOTAL'
      ? 'TOTAL'
      : market === 'SPREAD'
        ? 'SPREAD'
        : market === 'ML'
          ? 'MONEYLINE'
          : undefined;
  const resolvedMarketType =
    isPropMarket && propPlay?.market_type === 'PROP'
      ? 'PROP'
      : (inferredMarketTypeFromSelection ??
        sourceInference.canonical ??
        'INFO');
  const normalizedSide = normalizeSideForCanonicalMarket(
    resolvedMarketType,
    normalizeSideToken(direction),
  );
  if (normalizedSide === 'NONE') {
    direction = 'NEUTRAL';
    if (resolvedMarketType !== 'PROP') {
      price = undefined;
      if (resolvedMarketType === 'SPREAD' || resolvedMarketType === 'TOTAL') {
        line = undefined;
      }
    }
  } else {
    direction = normalizedSide;
  }

  const sourceModelProb = resolveSourceModelProb(sourcePlay);
  const modelProb = sourceModelProb;

  const impliedProb =
    resolvedMarketType === 'MONEYLINE' ||
    resolvedMarketType === 'SPREAD' ||
    resolvedMarketType === 'TOTAL'
      ? americanToImpliedProbability(price)
      : undefined;
  const edge =
    impliedProb !== undefined && modelProb !== undefined
      ? modelProb - impliedProb
      : undefined;
  const valueStatus = getValueStatus(edge);
  const displayMarketForPriceFlags =
    resolvedMarketType === 'MONEYLINE'
      ? 'ML'
      : resolvedMarketType === 'SPREAD'
        ? 'SPREAD'
        : resolvedMarketType === 'TOTAL'
          ? 'TOTAL'
          : 'NONE';
  const priceFlags = getPriceFlags(
    displayMarketForPriceFlags,
    direction,
    price,
  );

  const needsSteepFavoritePremium = typeof price === 'number' && price <= -240;
  let edgeThreshold = 0.02;
  if (truthStatus === 'WEAK') edgeThreshold += 0.015;
  if (conflict >= 0.35) edgeThreshold += 0.01;
  if (needsSteepFavoritePremium) edgeThreshold += 0.02;

  let betAction: 'BET' | 'NO_PLAY' = 'NO_PLAY';
  const isEdgeBackedMarket =
    resolvedMarketType === 'MONEYLINE' ||
    resolvedMarketType === 'SPREAD' ||
    resolvedMarketType === 'TOTAL';
  if (isEdgeBackedMarket && edge !== undefined && edge >= edgeThreshold) {
    betAction = 'BET';
  }

  if (
    priceFlags.includes('PRICE_TOO_STEEP') &&
    (edge === undefined || edge < 0.06)
  ) {
    betAction = 'NO_PLAY';
  }

  if (edge === undefined) {
    betAction = 'NO_PLAY';
  }

  const whyMarket: Market | 'NONE' =
    resolvedMarketType === 'MONEYLINE'
      ? 'ML'
      : resolvedMarketType === 'SPREAD'
        ? 'SPREAD'
        : resolvedMarketType === 'TOTAL'
          ? 'TOTAL'
          : 'NONE';
  let whyCode = getPlayWhyCode(betAction, whyMarket, drivers, priceFlags);
  let whyText = whyCode.replace(/_/g, ' ');
  const totalBias =
    game.consistency?.total_bias ??
    sourcePlay?.consistency?.total_bias ??
    'UNKNOWN';

  const riskTags = getRiskTagsFromText(
    sourcePlay?.cardTitle ?? '',
    sourcePlay?.reasoning ?? '',
    truthDriver.cardTitle,
    truthDriver.note,
  );
  const tags = [...new Set([...(sourceInference.tags ?? []), ...riskTags])];
  const hasPlaceholderDrivers = drivers.some(
    (driver) =>
      hasPlaceholderText(driver.note) || hasPlaceholderText(driver.cardTitle),
  );
  const placeholderMatches = new Set<string>();
  if (hasPlaceholderDrivers) {
    placeholderMatches.add('drivers');
  }
  if (
    hasPlaceholderText(sourcePlay?.reasoning) ||
    hasPlaceholderText(sourcePlay?.cardTitle)
  ) {
    placeholderMatches.add('play_text');
  }

  const sourceAggregationKey = sourcePlay?.aggregation_key;
  const linkedEvidence = scopedEvidenceCandidates.filter((evidence) => {
    if (
      sourcePlay?.driverKey &&
      evidence.evidence_for_play_id === sourcePlay.driverKey
    )
      return true;
    if (
      sourceAggregationKey &&
      evidence.aggregation_key === sourceAggregationKey
    )
      return true;
    return false;
  });

  const hasPlaceholderEvidence = linkedEvidence.some((evidence) => {
    const hit =
      hasPlaceholderText(evidence.reasoning) ||
      hasPlaceholderText(evidence.cardTitle);
    if (hit) placeholderMatches.add('evidence');
    return hit;
  });

  const reasonCodes: string[] = [...sourceInference.reasonCodes];
  if (!sourcePlay?.kind) reasonCodes.push('PASS_MISSING_KIND');
  if (hasPlaceholderDrivers || hasPlaceholderEvidence) {
    reasonCodes.push('PASS_DATA_ERROR');
    tags.push('DATA_ERROR_PLACEHOLDER');
  }

  // For PROP plays, the validation is different
  if (resolvedMarketType === 'PROP') {
    if (!sourcePlay?.selection?.side && !sourcePlay?.selection?.team)
      reasonCodes.push('PASS_MISSING_SELECTION');
  } else {
    if (!sourceInference.canonical)
      reasonCodes.push('PASS_MISSING_MARKET_TYPE');
    if (sourceInference.canonical === 'TOTAL' && line === undefined)
      reasonCodes.push('PASS_MISSING_LINE');
    if (
      (sourceInference.canonical === 'SPREAD' ||
        sourceInference.canonical === 'MONEYLINE') &&
      direction === 'NEUTRAL'
    ) {
      reasonCodes.push('PASS_MISSING_SELECTION');
    }
    if (
      (sourceInference.canonical === 'TOTAL' ||
        sourceInference.canonical === 'SPREAD' ||
        sourceInference.canonical === 'MONEYLINE') &&
      price === undefined
    ) {
      reasonCodes.push('PASS_NO_MARKET_PRICE');
    }
  }

  if (edge === undefined) reasonCodes.push('PASS_MISSING_EDGE');
  const requiresModelProbForEdge =
    (resolvedMarketType === 'MONEYLINE' ||
      resolvedMarketType === 'SPREAD' ||
      resolvedMarketType === 'TOTAL') &&
    typeof price === 'number';
  if (requiresModelProbForEdge && modelProb === undefined) {
    reasonCodes.push('PASS_DATA_ERROR');
  }
  if (canonicalPlayableCount === 0) reasonCodes.push('PASS_NO_QUALIFIED_PLAYS');
  if (betAction === 'NO_PLAY' && !reasonCodes.includes(whyCode))
    reasonCodes.push(whyCode);

  const hasExplicitTotalsConsistencyBlock =
    resolvedMarketType === 'TOTAL' &&
    totalBias !== 'OK' &&
    totalBias !== 'UNKNOWN';

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
    !(
      (direction === 'OVER' || direction === 'UNDER') &&
      typeof line === 'number'
    );
  const hasSpreadInvariantViolation =
    resolvedMarketType === 'SPREAD' &&
    !(
      (direction === 'HOME' || direction === 'AWAY') &&
      typeof line === 'number'
    );
  const hasMoneylineInvariantViolation =
    resolvedMarketType === 'MONEYLINE' &&
    !((direction === 'HOME' || direction === 'AWAY') && hasTeamContext);

  if (betAction === 'NO_PLAY' || hasExplicitTotalsConsistencyBlock) {
    pick = 'NO PLAY';
  }

  // For PROP plays, don't enforce standard market invariants
  const forcedPass =
    resolvedMarketType !== 'PROP' &&
    (hasTotalInvariantViolation ||
      hasSpreadInvariantViolation ||
      hasMoneylineInvariantViolation);
  if (forcedPass) {
    if (hasTotalInvariantViolation) reasonCodes.push('PASS_MISSING_LINE');
    if (hasSpreadInvariantViolation) {
      reasonCodes.push('PASS_MISSING_SELECTION');
      reasonCodes.push('PASS_MISSING_LINE');
    }
    if (hasMoneylineInvariantViolation)
      reasonCodes.push('PASS_MISSING_SELECTION');
    pick = 'NO PLAY';
  }

  const hardPass = forcedPass;

  // Build initial play object for canonical decision
  const playForDecision: CanonicalPlay = {
    play_id:
      sourcePlay?.driverKey ?? `${game.id}:${resolvedMarketType}:${direction}`,
    sport: game.sport as CanonicalSport,
    game_id: game.gameId,
    market_type: resolvedMarketType as MarketType,
    side:
      direction === 'HOME' ||
      direction === 'AWAY' ||
      direction === 'OVER' ||
      direction === 'UNDER'
        ? direction
        : undefined,
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
  const market_key = buildMarketKey(
    resolvedMarketType,
    normalizeSideForCanonicalMarket(
      resolvedMarketType,
      normalizeSideToken(direction),
    ),
  );
  let candidateBet: CanonicalBet | null = null;
  const betMarketType = mapCanonicalToBetMarketType(resolvedMarketType);
  const betSide = mapDirectionToBetSide(direction);
  if (
    betMarketType &&
    betSide &&
    typeof price === 'number' &&
    pick !== 'NO PLAY'
  ) {
    candidateBet = {
      market_type: betMarketType,
      side: betSide,
      line,
      odds_american: price,
      as_of_iso: game.odds?.capturedAt || game.createdAt,
    };
  }

  if (candidateBet && !validateCanonicalBet(candidateBet)) {
    reasonCodes.push('PASS_DATA_ERROR');
    candidateBet = null;
  }

  const oppositeSelectedDirection = OPPOSITE_DIRECTION[direction];
  const directionalDrivers = drivers.filter(
    (driver) => driver.direction !== 'NEUTRAL',
  );
  const scoreDriver = (driver: DriverRow): number => {
    const conf =
      typeof driver.confidence === 'number' ? clamp01(driver.confidence) : 0.6;
    return TIER_SCORE[driver.tier] * conf;
  };
  const proDriverScores = directionalDrivers
    .filter((driver) => driver.direction === direction)
    .map(scoreDriver)
    .sort((a, b) => b - a);
  const contraDriverScores = oppositeSelectedDirection
    ? directionalDrivers
        .filter((driver) => driver.direction === oppositeSelectedDirection)
        .map(scoreDriver)
        .sort((a, b) => b - a)
    : [];
  const topProScore = proDriverScores[0] ?? 0;
  const strongProCount = proDriverScores.filter((score) => score >= 0.6).length;
  const strongContraCount = contraDriverScores.filter(
    (score) => score >= 0.6,
  ).length;

  if (strongProCount < 2) reasonCodes.push('PASS_DRIVER_SUPPORT_WEAK');
  if (strongContraCount > 0) reasonCodes.push('PASS_DRIVER_CONFLICT');

  const edgePct = typeof edge === 'number' ? edge : null;
  const edgeTier = edgePct === null ? 'BAD' : edgeTierFromPct(edgePct);
  const valueScore =
    edgeTier === 'BEST'
      ? 1
      : edgeTier === 'GOOD'
        ? 0.8
        : edgeTier === 'OK'
          ? 0.6
          : 0.2;
  const missingCoreDataPenalty =
    (candidateBet ? 0 : 0.2) +
    (typeof price === 'number' ? 0 : 0.1) +
    (resolvedMarketType === 'MONEYLINE' ||
    resolvedMarketType === 'PROP' ||
    typeof line === 'number'
      ? 0
      : 0.1);
  const coverageScore = clamp01(
    0.45 +
      (strongProCount >= 2 ? 0.2 : 0) +
      (linkedEvidence.length > 0 ? 0.1 : 0) +
      (hasExplicitTotalsConsistencyBlock ? -0.15 : 0) -
      missingCoreDataPenalty,
  );
  const modelScore =
    0.45 * clamp01(truthStrength) + 0.35 * valueScore + 0.2 * coverageScore;

  let scoreDecision: DecisionLabel = 'PASS';
  if (modelScore >= 0.7) scoreDecision = 'FIRE';
  else if (modelScore >= 0.55) scoreDecision = 'WATCH';

  if (truthStatus === 'WEAK' || valueStatus === 'BAD') {
    if (scoreDecision === 'FIRE') scoreDecision = 'WATCH';
  }
  if (strongProCount < 2 || topProScore < 0.6 || strongContraCount > 0) {
    if (scoreDecision === 'FIRE') scoreDecision = 'WATCH';
  }

  const longshotOdds = typeof price === 'number' && price >= 400;
  const longshotGuardPassed =
    truthStatus === 'STRONG' && (edgePct ?? -1) >= 0.06 && strongProCount >= 2;
  if (longshotOdds && !longshotGuardPassed) {
    reasonCodes.push('PASS_LONGSHOT_GUARD');
    if (scoreDecision === 'FIRE') scoreDecision = 'WATCH';
  }

  let reasonCodesUnique = Array.from(new Set(reasonCodes));
  const gates: CanonicalGate[] = [];
  const gateCodes = new Set<string>();
  const nonBlockingReasonCodes = new Set<string>([
    'PASS_DRIVER_SUPPORT_WEAK',
    'PASS_DRIVER_CONFLICT',
  ]);
  for (const code of reasonCodesUnique) {
    if (nonBlockingReasonCodes.has(code)) {
      gates.push({ code, severity: 'WARN', blocks_bet: false });
      continue;
    }
    if (
      code.startsWith('PASS_') ||
      code === 'NO_VALUE_AT_PRICE' ||
      code === 'PRICE_TOO_STEEP' ||
      code === 'MISSING_PRICE_EDGE'
    ) {
      gateCodes.add(code);
    }
  }
  if (hasExplicitTotalsConsistencyBlock) gateCodes.add('TOTALS_BLOCKED');
  if (longshotOdds && !longshotGuardPassed)
    gateCodes.add('PASS_LONGSHOT_GUARD');

  for (const code of gateCodes) {
    gates.push({ code, severity: 'BLOCK', blocks_bet: true });
  }

  const coinflip =
    resolvedMarketType === 'MONEYLINE' &&
    typeof game.odds?.h2hHome === 'number' &&
    typeof game.odds?.h2hAway === 'number' &&
    Math.abs(game.odds.h2hHome) <= 120 &&
    Math.abs(game.odds.h2hAway) <= 120;
  if (coinflip) {
    gates.push({ code: 'COINFLIP', severity: 'WARN', blocks_bet: false });
  }

  const decisionAction =
    decision.action === 'FIRE' ||
    decision.action === 'HOLD' ||
    decision.action === 'PASS'
      ? decision.action
      : 'PASS';
  let finalDecision: DecisionLabel = decisionFromAction(decisionAction);
  if (scoreDecision === 'PASS') finalDecision = 'PASS';
  if (scoreDecision === 'WATCH' && finalDecision === 'FIRE')
    finalDecision = 'WATCH';
  if (scoreDecision === 'FIRE') finalDecision = 'FIRE';
  if (hardPass) finalDecision = 'PASS';

  const hasBlockingGate = gates.some((gate) => gate.blocks_bet);
  let finalBet = candidateBet;
  if (betAction === 'NO_PLAY') finalBet = null;
  if (hasBlockingGate) {
    finalBet = null;
    if (finalDecision !== 'PASS') finalDecision = 'WATCH';
  }
  if (!finalBet && finalDecision === 'FIRE') {
    finalDecision = 'WATCH';
  }
  if (!finalBet && hardPass) {
    finalDecision = 'PASS';
  }

  if (hasPlaceholderText(whyText)) {
    placeholderMatches.add('why_text');
  }
  const missingInputs = new Set<string>();
  if (!sourcePlay) missingInputs.add('play');
  if (!game.odds?.capturedAt) missingInputs.add('odds_timestamp');
  if (directionalDrivers.length === 0) missingInputs.add('drivers');
  if (finalDecision === 'FIRE' && !finalBet) missingInputs.add('bet');
  if (finalBet && requiresModelProbForEdge && modelProb === undefined)
    missingInputs.add('model_prob');

  let quality: CardQuality = 'OK';
  const placeholdersFound = Array.from(placeholderMatches);
  const hasFatalInputGap =
    missingInputs.has('drivers') ||
    missingInputs.has('model_prob') ||
    missingInputs.has('play');
  if (placeholdersFound.length > 0 || hasFatalInputGap) {
    quality = 'BROKEN';
  } else if (missingInputs.size > 0) {
    quality = 'DEGRADED';
  }

  if (quality === 'DEGRADED' && finalDecision === 'FIRE') {
    finalDecision = 'WATCH';
  }

  if (quality === 'BROKEN') {
    reasonCodesUnique = Array.from(
      new Set([...reasonCodesUnique, 'PASS_DATA_ERROR']),
    );
    gateCodes.add('PASS_DATA_ERROR');
    finalBet = null;
    finalDecision = 'PASS';
    pick = 'NO PLAY';
  }

  for (const code of gateCodes) {
    if (!gates.some((gate) => gate.code === code)) {
      gates.push({ code, severity: 'BLOCK', blocks_bet: true });
    }
  }

  const finalAction = actionFromDecision(finalDecision);
  const finalClassificationLabel =
    decisionClassificationFromAction(finalAction);
  const resolvedDisplayDecision = resolvePlayDisplayDecision({
    action: finalAction,
    status: sourcePlay?.status,
    classification:
      finalAction === 'FIRE'
        ? 'BASE'
        : finalAction === 'HOLD'
          ? 'LEAN'
          : 'PASS',
  });

  if (!finalBet) {
    pick = 'NO PLAY';
  }
  const finalBetAction: 'BET' | 'NO_PLAY' = finalBet ? 'BET' : 'NO_PLAY';
  const passReasonCode =
    reasonCodesUnique.find((code) => code.startsWith('PASS_')) ?? null;
  const resolvedPassReasonCode = finalBet
    ? null
    : (passReasonCode ??
      decision.play?.pass_reason_code ??
      gates.find((gate) => gate.blocks_bet)?.code ??
      null);
  const decisionData: DecisionData = {
    status: finalDecision,
    truth: truthStatus,
    value_tier: valueStatus,
    edge_pct: edgePct,
    edge_tier: edgeTier,
    coinflip,
    reason_code: resolvedPassReasonCode ?? whyCode,
  };

  return {
    market_key,
    decision: finalDecision,
    classificationLabel: finalClassificationLabel,
    bet: finalBet,
    gates,
    decision_data: decisionData,
    transform_meta: {
      quality,
      missing_inputs: Array.from(missingInputs),
      placeholders_found: placeholdersFound,
    },
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
        : direction === 'HOME' ||
            direction === 'AWAY' ||
            direction === 'OVER' ||
            direction === 'UNDER'
          ? {
              side: direction as SelectionSide,
              team:
                direction === 'HOME'
                  ? game.homeTeam
                  : direction === 'AWAY'
                    ? game.awayTeam
                    : undefined,
            }
          : undefined,
    reason_codes: reasonCodesUnique,
    tags,
    // Canonical fields (preferred)
    classification: resolvedDisplayDecision.classification,
    action: resolvedDisplayDecision.action,
    pass_reason_code: resolvedPassReasonCode,
    // Legacy compatibility (keep until UI migration complete)
    status: hardPass ? 'PASS' : resolvedDisplayDecision.status,
    market,
    pick,
    lean:
      resolvedMarketType === 'PROP' && propPlay?.selection?.team
        ? propPlay.selection.team
        : direction === 'HOME'
          ? game.homeTeam
          : direction === 'AWAY'
            ? game.awayTeam
            : direction,
    side: direction,
    truthStatus,
    truthStrength,
    conflict,
    modelProb,
    impliedProb,
    edge,
    valueStatus,
    betAction: finalBetAction,
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
    : game.plays.filter(
        (play) => !isWelcomeHomePlay(play) && isEvidenceItem(play),
      );
  const evidence: EvidenceItem[] = evidenceSource.map((play, index) => ({
    id: `${game.gameId}:evidence:${play.driverKey || play.cardType || index}`,
    cardType: play.cardType,
    cardTitle: play.cardTitle,
    reasoning: play.reasoning,
    driverKey: play.driverKey,
    selection: play.selection?.side
      ? {
          side: play.selection.side as
            | 'OVER'
            | 'UNDER'
            | 'HOME'
            | 'AWAY'
            | 'FAV'
            | 'DOG'
            | 'NONE',
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

function cardDecisionRank(card: GameCard): number {
  const decision = card.play?.decision;
  if (decision === 'FIRE') return 3;
  if (decision === 'WATCH') return 2;
  if (decision === 'PASS') return 1;
  const action = card.play?.action;
  if (action === 'FIRE') return 3;
  if (action === 'HOLD') return 2;
  return 1;
}

function cardValueRank(card: GameCard): number {
  const value = card.play?.valueStatus;
  if (value === 'GOOD') return 3;
  if (value === 'OK') return 2;
  if (value === 'BAD') return 1;
  return 0;
}

function toEpochMs(value?: string): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function compareCardsForDedupe(next: GameCard, current: GameCard): number {
  const nextHasBet = Boolean(next.play?.bet);
  const currentHasBet = Boolean(current.play?.bet);
  if (nextHasBet !== currentHasBet) return nextHasBet ? 1 : -1;

  const decisionDelta = cardDecisionRank(next) - cardDecisionRank(current);
  if (decisionDelta !== 0) return decisionDelta;

  const valueDelta = cardValueRank(next) - cardValueRank(current);
  if (valueDelta !== 0) return valueDelta;

  const updatedDelta =
    toEpochMs(next.play?.updatedAt ?? next.updatedAt) -
    toEpochMs(current.play?.updatedAt ?? current.updatedAt);
  if (updatedDelta !== 0) return updatedDelta;

  const edgeDelta =
    (typeof next.play?.edge === 'number' ? next.play.edge : -Infinity) -
    (typeof current.play?.edge === 'number' ? current.play.edge : -Infinity);
  if (edgeDelta !== 0) return edgeDelta;

  return 0;
}

function getCardMarketKey(card: GameCard): string {
  if (card.play?.market_key) return card.play.market_key;
  const side = normalizeSideToken(
    card.play?.selection?.side ?? card.play?.side ?? 'NONE',
  );
  if (card.play?.market_type)
    return buildMarketKey(card.play.market_type, side);
  const canonical =
    card.play?.market === 'ML'
      ? 'MONEYLINE'
      : card.play?.market === 'SPREAD'
        ? 'SPREAD'
        : card.play?.market === 'TOTAL'
          ? 'TOTAL'
          : 'INFO';
  return buildMarketKey(canonical as CanonicalMarketType, side);
}

function dedupeCardsByGameMarket(cards: GameCard[]): GameCard[] {
  const byKey = new Map<string, GameCard>();
  for (const card of cards) {
    const dedupeKey = `${card.sport}|${card.gameId}|${getCardMarketKey(card)}`;
    const existing = byKey.get(dedupeKey);
    if (!existing || compareCardsForDedupe(card, existing) > 0) {
      byKey.set(dedupeKey, card);
    }
  }
  return Array.from(byKey.values());
}

type ContractReport = {
  fire_with_no_bet: string[];
  play_with_no_bet: string[];
  blocked_with_bet: string[];
  coinflip_non_ml: string[];
  edge_repeated_value_counts: Array<{ edge: string; count: number }>;
};

function buildContractReport(cards: GameCard[]): ContractReport {
  const fire_with_no_bet: string[] = [];
  const play_with_no_bet: string[] = [];
  const blocked_with_bet: string[] = [];
  const coinflip_non_ml: string[] = [];
  const edgeCounts = new Map<string, number>();

  for (const card of cards) {
    const play = card.play;
    if (!play) continue;
    const key = `${card.gameId}:${play.market_key ?? getCardMarketKey(card)}`;
    const hasBet = Boolean(play.bet);
    const hasBlockingGate = (play.gates ?? []).some((gate) => gate.blocks_bet);
    const decision =
      play.decision ??
      (play.action === 'FIRE'
        ? 'FIRE'
        : play.action === 'HOLD'
          ? 'WATCH'
          : 'PASS');
    const classification =
      play.classificationLabel ??
      (play.classification === 'BASE'
        ? 'PLAY'
        : play.classification === 'LEAN'
          ? 'LEAN'
          : 'NONE');

    if (decision === 'FIRE' && !hasBet) fire_with_no_bet.push(key);
    if (classification === 'PLAY' && !hasBet) play_with_no_bet.push(key);
    if (hasBlockingGate && hasBet) blocked_with_bet.push(key);
    if (play.priceFlags.includes('COINFLIP') && play.market !== 'ML')
      coinflip_non_ml.push(key);

    if (typeof play.edge === 'number' && Number.isFinite(play.edge)) {
      const edgeKey = (play.edge * 100).toFixed(1);
      edgeCounts.set(edgeKey, (edgeCounts.get(edgeKey) ?? 0) + 1);
    }
  }

  const edge_repeated_value_counts = Array.from(edgeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([edge, count]) => ({ edge, count }));

  return {
    fire_with_no_bet,
    play_with_no_bet,
    blocked_with_bet,
    coinflip_non_ml,
    edge_repeated_value_counts,
  };
}

function assertContractInDev(cards: GameCard[]): void {
  if (process.env.NODE_ENV === 'production') return;
  const report = buildContractReport(cards);
  const hasHardFailure =
    report.fire_with_no_bet.length > 0 ||
    report.play_with_no_bet.length > 0 ||
    report.blocked_with_bet.length > 0 ||
    report.coinflip_non_ml.length > 0;

  if (hasHardFailure) {
    console.error('[cards-contract-report]', report);
    throw new Error(
      'Game card transform contract violation. See [cards-contract-report] for offending game_ids.',
    );
  }

  console.info('[cards-contract-report]', report);
}

/**
 * Transform array of GameData to GameCard[]
 */
export function transformGames(games: GameData[]): GameCard[] {
  const transformed = games.map(transformToGameCard);
  const deduped = dedupeCardsByGameMarket(transformed);
  assertContractInDev(deduped);
  return deduped;
}

function isPlaceholderPlayerName(value?: string | null): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return (
    lower === 'unknown player' ||
    lower === 'player' ||
    /^player\s*#?\d+$/i.test(trimmed)
  );
}

function extractPlayerId(play: ApiPlay): string {
  if (play.player_id) return String(play.player_id);

  const selectionTeam = play.selection?.team;
  if (selectionTeam) {
    const idMatch = selectionTeam.match(/#(\d+)/);
    if (idMatch?.[1]) return idMatch[1];
  }

  return selectionTeam || 'unknown';
}

function inferPlayerNameFromText(play: ApiPlay): string | undefined {
  const fromPayload = play.player_name;
  if (fromPayload && !isPlaceholderPlayerName(fromPayload)) {
    return fromPayload;
  }

  const selectionTeam = play.selection?.team;
  if (selectionTeam && !isPlaceholderPlayerName(selectionTeam)) {
    return selectionTeam;
  }

  const title = play.cardTitle || '';
  const titlePatterns = [
    /shots\s+on\s+goal\s*[-:]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:shots\s+on\s+goal|sog|over|under)/i,
    /player\s+prop\s*[-:]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i,
  ];

  for (const pattern of titlePatterns) {
    const match = title.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate && !isPlaceholderPlayerName(candidate)) {
      return candidate;
    }
  }

  const reasoning = play.reasoning || '';
  const reasoningMatch = reasoning.match(
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/,
  );
  const reasoningCandidate = reasoningMatch?.[1]?.trim();
  if (reasoningCandidate && !isPlaceholderPlayerName(reasoningCandidate)) {
    return reasoningCandidate;
  }

  return undefined;
}

/**
 * Transform games to PropGameCard format - for player props view
 * Groups all PROP plays under each game as rows
 */
export function transformPropGames(games: GameData[]): PropGameCard[] {
  const propGames: PropGameCard[] = [];
  const playerNameById = new Map<string, string>();

  for (const game of games) {
    for (const play of game.plays) {
      if (play.market_type !== 'PROP') continue;
      const playerId = extractPlayerId(play);
      const inferredName = inferPlayerNameFromText(play);
      if (playerId && inferredName) {
        playerNameById.set(playerId, inferredName);
      }
    }
  }

  for (const game of games) {
    // Extract all PROP plays from this game
    const propPlays = game.plays.filter((p) => p.market_type === 'PROP');

    // Skip games with no props
    if (propPlays.length === 0) continue;

    // Convert each play to a PropPlayRow
    const propPlayRows: PropPlayRow[] = propPlays.map((play) => {
      const playerId = extractPlayerId(play);
      const inferredName = inferPlayerNameFromText(play);
      const mappedName = playerNameById.get(playerId);
      const playerName = inferredName || mappedName || 'Unknown Player';

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
      const edge =
        play.edge ??
        (mu !== null && suggestedLine !== null ? mu - suggestedLine : null);

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

    const maxConfidence = Math.max(
      ...propPlayRows.map((p) => p.confidence ?? 0),
    );

    // Build prop game card
    const propGameCard: PropGameCard = {
      gameId: game.gameId,
      sport: normalizeSport(game.sport),
      gameTimeUtc: game.gameTimeUtc,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      status: game.status,
      oddsUpdatedUtc: game.odds?.capturedAt ?? undefined,
      moneyline:
        game.odds?.h2hHome && game.odds?.h2hAway
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
