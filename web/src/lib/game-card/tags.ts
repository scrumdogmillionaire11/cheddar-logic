/**
 * Derive tags from GameCard for fast filtering
 * Based on FILTER-FEATURE.md design
 */

import type { GameCard, GameTag, ExpressionStatus, Direction } from '../types/game-card';
import { GAME_TAGS } from '../types/game-card';
import { getPlayDisplayAction } from './decision';
import { computeSupportScores } from './driver-scoring';
import { hasEdgeVerificationSignals } from '../play-decision/decision-logic';

/**
 * Derive expression status from drivers if not explicitly provided
 */
function deriveStatus(card: GameCard): ExpressionStatus {
  if (card.play?.decision_v2) {
    if (card.play.decision_v2.official_status === 'PLAY') return 'FIRE';
    if (card.play.decision_v2.official_status === 'LEAN') return 'WATCH';
    return 'PASS';
  }

  if (card.play) {
    const action = getPlayDisplayAction(card.play);
    if (action === 'FIRE') return 'FIRE';
    if (action === 'HOLD') return 'WATCH';
    return 'PASS';
  }

  if (card.expressionChoice?.status) {
    return card.expressionChoice.status;
  }

  // FIRE if any driver is BEST and direction != NEUTRAL
  const hasBestNonNeutral = card.drivers.some(
    (d) => d.tier === 'BEST' && d.direction !== 'NEUTRAL',
  );
  if (hasBestNonNeutral) return 'FIRE';

  // WATCH if any SUPER/WATCH non-neutral
  const hasWatchOrSuper = card.drivers.some(
    (d) =>
      (d.tier === 'WATCH' || d.tier === 'SUPER') && d.direction !== 'NEUTRAL',
  );
  if (hasWatchOrSuper) return 'WATCH';

  // Otherwise PASS
  return 'PASS';
}

/**
 * Check if ML odds are in coinflip range (-120 to +120)
 */
function isCoinflipML(card: GameCard): boolean {
  const ml = card.markets.ml;
  if (!ml) return false;

  return (
    (ml.home >= -120 && ml.home <= 120) || (ml.away >= -120 && ml.away <= 120)
  );
}

/**
 * Get time difference in milliseconds
 */
function getTimeDiff(timestamp: string): number {
  return new Date().getTime() - new Date(timestamp).getTime();
}

/**
 * Get time until game starts in milliseconds
 */
function getTimeUntilStart(startTime: string): number {
  return new Date(startTime).getTime() - new Date().getTime();
}

/**
 * Check if card is updated today (same calendar day in ET)
 */
function isUpdatedToday(timestamp: string): boolean {
  const now = new Date();
  const updated = new Date(timestamp);

  const nowET = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
  }).format(now);

  const updatedET = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
  }).format(updated);

  return nowET === updatedET;
}

/**
 * Derive all tags from a GameCard
 */
export function deriveTags(card: GameCard): GameTag[] {
  const tags = new Set<GameTag>();

  for (const existingTag of card.tags) {
    if (Object.values(GAME_TAGS).includes(existingTag as GameTag)) {
      tags.add(existingTag as GameTag);
    }
  }

  // Actionability status
  const status = deriveStatus(card);
  if (status === 'FIRE') tags.add(GAME_TAGS.HAS_FIRE);
  if (status === 'WATCH') tags.add(GAME_TAGS.HAS_WATCH);
  if (status === 'PASS') tags.add(GAME_TAGS.HAS_PASS);

  if (card.sport === 'UNKNOWN') {
    tags.add(GAME_TAGS.UNKNOWN_SPORT);
  }

  // Market picks
  const playMarket = card.play?.market;
  const hasPlayML = playMarket === 'ML';
  const hasPlaySpread = playMarket === 'SPREAD';
  const hasPlayTotal = playMarket === 'TOTAL';
  const hasMLPick =
    hasPlayML ||
    card.drivers.some((d) => d.market === 'ML' && d.direction !== 'NEUTRAL');
  const hasSpreadPick =
    hasPlaySpread ||
    card.drivers.some(
      (d) => d.market === 'SPREAD' && d.direction !== 'NEUTRAL',
    );
  const hasTotalPick =
    hasPlayTotal ||
    card.drivers.some((d) => d.market === 'TOTAL' && d.direction !== 'NEUTRAL');

  if (hasMLPick) tags.add(GAME_TAGS.HAS_ML_PICK);
  if (hasSpreadPick || hasMLPick) tags.add(GAME_TAGS.HAS_SIDE_PICK);
  if (hasTotalPick) tags.add(GAME_TAGS.HAS_TOTAL_PICK);

  // Driver strength
  if (card.drivers.some((d) => d.tier === 'BEST')) {
    tags.add(GAME_TAGS.HAS_BEST_DRIVER);
  }
  if (card.drivers.some((d) => d.tier === 'SUPER')) {
    tags.add(GAME_TAGS.HAS_SUPER_DRIVER);
  }
  if (card.drivers.some((d) => d.tier === 'WATCH')) {
    tags.add(GAME_TAGS.HAS_WATCH_DRIVER);
  }

  // Risk flags (check card titles and notes for risk keywords)
  const allText = card.drivers
    .map((d) => `${d.cardTitle} ${d.note}`.toLowerCase())
    .join(' ');

  if (allText.includes('fragility') || allText.includes('fragile')) {
    tags.add(GAME_TAGS.HAS_RISK_FRAGILITY);
  }
  if (allText.includes('blowout') || allText.includes('blow out')) {
    tags.add(GAME_TAGS.HAS_RISK_BLOWOUT);
  }
  if (allText.includes('key number') || allText.includes('key-number')) {
    tags.add(GAME_TAGS.HAS_RISK_KEY_NUMBER);
  }
  if (allText.includes('low coverage') || allText.includes('limited data')) {
    tags.add(GAME_TAGS.HAS_LOW_COVERAGE);
  }

  // Odds freshness
  const updatedDiff = getTimeDiff(card.updatedAt);
  const oneMinute = 60 * 1000;
  const fiveMinutes = 5 * oneMinute;
  const thirtyMinutes = 30 * oneMinute;

  if (updatedDiff <= oneMinute) {
    tags.add(GAME_TAGS.UPDATED_WITHIN_60S);
  }
  if (updatedDiff <= fiveMinutes) {
    tags.add(GAME_TAGS.UPDATED_WITHIN_5M);
  }
  if (updatedDiff > fiveMinutes) {
    tags.add(GAME_TAGS.STALE_5M);
  }
  if (updatedDiff > thirtyMinutes) {
    tags.add(GAME_TAGS.STALE_30M);
  }

  // ML patterns
  if (isCoinflipML(card)) {
    tags.add(GAME_TAGS.COINFLIP_ML);
  }

  // Time windows
  const timeUntilStart = getTimeUntilStart(card.startTime);
  const twoHours = 2 * 60 * 60 * 1000;

  if (timeUntilStart <= twoHours && timeUntilStart > 0) {
    tags.add(GAME_TAGS.STARTS_WITHIN_2H);
  }
  if (isUpdatedToday(card.startTime)) {
    tags.add(GAME_TAGS.STARTS_TODAY);
  }

  // Data quality
  if (Object.keys(card.markets).length === 0) {
    tags.add(GAME_TAGS.NO_ODDS);
  }

  // Support grade — consensus strength of driver alignment
  // Primary direction: prefer card.play.side, fallback to strongest non-neutral driver
  const rawSide = card.play?.side ?? null;
  const primaryDirection: Direction | null =
    rawSide && rawSide !== 'NEUTRAL'
      ? rawSide
      : (card.drivers.find((d) => d.direction !== 'NEUTRAL')?.direction ?? null);

  if (primaryDirection && primaryDirection !== 'NEUTRAL') {
    const scores = computeSupportScores(card.drivers, primaryDirection);
    if (scores.support_grade === 'STRONG') tags.add(GAME_TAGS.SUPPORT_STRONG);
    else if (scores.support_grade === 'MIXED') tags.add(GAME_TAGS.SUPPORT_MIXED);
    else tags.add(GAME_TAGS.SUPPORT_WEAK);
  }

  // Situational signals
  if (
    card.drivers.some((d) => d.cardType === 'welcome-home-v2') ||
    (card.evidence?.some((e) => e.cardType === 'welcome-home-v2') ?? false)
  ) {
    tags.add(GAME_TAGS.WELCOME_HOME_FADE);
  }

  // Check for contradictions (HOME and AWAY picks on same market)
  const marketDirections = new Map<string, Set<string>>();
  for (const driver of card.drivers) {
    if (driver.direction === 'NEUTRAL') continue;

    const key = driver.market;
    if (!marketDirections.has(key)) {
      marketDirections.set(key, new Set());
    }
    marketDirections.get(key)!.add(driver.direction);
  }

  for (const directions of marketDirections.values()) {
    if (directions.has('HOME') && directions.has('AWAY')) {
      tags.add(GAME_TAGS.HAS_DRIVER_CONTRADICTION);
      break;
    }
    if (directions.has('OVER') && directions.has('UNDER')) {
      tags.add(GAME_TAGS.HAS_DRIVER_CONTRADICTION);
      break;
    }
  }

  return Array.from(tags);
}

export function hasEdgeVerification(card: GameCard): boolean {
  return hasEdgeVerificationSignals(card.play);
}

export function hasProxyCap(card: GameCard): boolean {
  const play = card.play;
  if (!play) return false;
  return Boolean(
    play.decision_v2?.proxy_capped === true ||
      play.decision_v2?.price_reason_codes?.includes('PROXY_EDGE_CAPPED') ||
      play.decision_v2?.price_reason_codes?.includes('PROXY_EDGE_BLOCKED') ||
      play.tags?.includes('PROXY_CARD') ||
      play.reason_codes?.includes('PASS_PROXY_CAPPED') ||
      play.reason_codes?.includes('DOWNGRADED_PROXY_CAPPED') ||
      play.reason_codes?.includes('PASS_PROXY_EDGE_SANITY_COMBO') ||
      play.reason_codes?.includes('DOWNGRADED_PROXY_EDGE_SANITY_COMBO') ||
      play.gates?.some((gate) => gate.code === 'PROXY_CAP'),
  );
}

/**
 * Transform and enrich a game card with derived tags
 */
export function enrichCardWithTags(card: GameCard): GameCard {
  return {
    ...card,
    tags: deriveTags(card),
  };
}

/**
 * Transform and enrich multiple game cards with tags
 */
export function enrichCards(cards: GameCard[]): GameCard[] {
  return cards.map(enrichCardWithTags);
}
