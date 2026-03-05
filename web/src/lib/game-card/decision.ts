/**
 * Decision helpers for card display (dedupe, primary play, contributors, risks).
 *
 * Implements market-first decision logic:
 * 1. Determine best market from drivers + available odds
 * 2. Build canonical Play object with proper price/line
 * 3. Market-scope why codes (totals codes never for ML/spread)
 * 4. Filter contributors by market relevance
 */

import type {
  GameCard,
  DriverRow,
  Market,
  Direction,
  DriverTier,
  ExpressionStatus,
  Play,
} from '../types/game-card';

type DecisionPolarity = 'pro' | 'contra' | 'neutral';

export type DecisionContributor = {
  driver: DriverRow;
  polarity: DecisionPolarity;
};

export type DecisionModel = {
  status: ExpressionStatus;
  primaryPlay: {
    pick: string;
    market: Market | 'NONE';
    status: ExpressionStatus;
    direction: Direction | null;
    tier: DriverTier | null;
    confidence: number | null;
    source: 'expressionChoice' | 'play' | 'drivers' | 'none';
  };
  whyReason: string;
  riskCodes: string[];
  topContributors: DecisionContributor[];
  allDrivers: DriverRow[];
};

export type PlayDisplayAction = 'FIRE' | 'HOLD' | 'PASS';

export type ResolvedPlayDisplayDecision = {
  action: PlayDisplayAction;
  status: ExpressionStatus;
  classification: 'BASE' | 'LEAN' | 'PASS';
};

interface Odds {
  h2hHome: number | null;
  h2hAway: number | null;
  total: number | null;
  spreadHome: number | null;
  spreadAway: number | null;
  capturedAt: string | null;
}

const TIER_RANK: Record<DriverTier, number> = { BEST: 3, SUPER: 2, WATCH: 1 };
const DIRECTION_OPPOSITE: Partial<Record<Direction, Direction>> = {
  HOME: 'AWAY',
  AWAY: 'HOME',
  OVER: 'UNDER',
  UNDER: 'OVER',
};

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function hasPlaceholderDriverText(value: string): boolean {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return true;
  return (
    normalized.includes('generic analysis for') ||
    normalized.includes('ncaam ncaam generic')
  );
}

function isValidAction(value: unknown): value is PlayDisplayAction {
  return value === 'FIRE' || value === 'HOLD' || value === 'PASS';
}

function actionFromLegacyStatus(value: unknown): PlayDisplayAction | undefined {
  const status = String(value ?? '').toUpperCase();
  if (status.includes('FIRE')) return 'FIRE';
  if (status.includes('WATCH') || status.includes('HOLD')) return 'HOLD';
  if (status.includes('PASS')) return 'PASS';
  return undefined;
}

function actionFromClassification(
  value: unknown,
): PlayDisplayAction | undefined {
  if (value === 'BASE' || value === 'PLAY') return 'FIRE';
  if (value === 'LEAN') return 'HOLD';
  if (value === 'PASS') return 'PASS';
  return undefined;
}

function classificationFromAction(
  action: PlayDisplayAction,
): 'BASE' | 'LEAN' | 'PASS' {
  if (action === 'FIRE') return 'BASE';
  if (action === 'HOLD') return 'LEAN';
  return 'PASS';
}

function expressionStatusFromAction(
  action: PlayDisplayAction,
): ExpressionStatus {
  if (action === 'HOLD') return 'WATCH';
  return action;
}

export function resolvePlayDisplayDecision(
  play?: Partial<Pick<Play, 'action' | 'status' | 'classification'>> | null,
): ResolvedPlayDisplayDecision {
  const explicitAction = isValidAction(play?.action) ? play.action : undefined;
  const legacyAction = actionFromLegacyStatus(play?.status);
  const classificationAction = actionFromClassification(play?.classification);
  const action =
    explicitAction ?? legacyAction ?? classificationAction ?? 'PASS';

  return {
    action,
    status: expressionStatusFromAction(action),
    classification: classificationFromAction(action),
  };
}

function buildDriverHash(driver: DriverRow): string {
  const note = normalizeText(driver.note);
  return `${driver.key}|${driver.market}|${driver.direction}|${note}`;
}

function isStrongerDriver(next: DriverRow, current: DriverRow): boolean {
  const nextRank = TIER_RANK[next.tier] || 0;
  const currentRank = TIER_RANK[current.tier] || 0;
  if (nextRank !== currentRank) return nextRank > currentRank;

  const nextConfidence =
    typeof next.confidence === 'number' ? next.confidence : -1;
  const currentConfidence =
    typeof current.confidence === 'number' ? current.confidence : -1;
  if (nextConfidence !== currentConfidence)
    return nextConfidence > currentConfidence;

  return false;
}

export function deduplicateDrivers(drivers: DriverRow[]): DriverRow[] {
  const driverMap = new Map<string, DriverRow>();

  for (const driver of drivers) {
    const hash = buildDriverHash(driver);
    const existing = driverMap.get(hash);

    if (!existing) {
      driverMap.set(hash, driver);
      continue;
    }

    if (isStrongerDriver(driver, existing)) {
      driverMap.set(hash, driver);
    }
  }

  return Array.from(driverMap.values());
}

function sortDrivers(drivers: DriverRow[]): DriverRow[] {
  return [...drivers].sort((a, b) => {
    const rankDiff = (TIER_RANK[b.tier] || 0) - (TIER_RANK[a.tier] || 0);
    if (rankDiff !== 0) return rankDiff;

    const aConfidence = typeof a.confidence === 'number' ? a.confidence : -1;
    const bConfidence = typeof b.confidence === 'number' ? b.confidence : -1;
    return bConfidence - aConfidence;
  });
}

function isSideIntentDriver(driver: DriverRow): boolean {
  const text = `${driver.key} ${driver.cardTitle} ${driver.note}`.toLowerCase();
  return (
    text.includes('projection') ||
    text.includes('rest') ||
    text.includes('matchup') ||
    text.includes('nba projection') ||
    text.includes('nba rest') ||
    text.includes('nba matchup') ||
    text.includes('ncaam projection') ||
    text.includes('ncaam rest') ||
    text.includes('ncaam matchup')
  );
}

function isRiskOnlyDriver(driver: DriverRow): boolean {
  const text = `${driver.key} ${driver.cardTitle} ${driver.note}`.toLowerCase();
  return (
    text.includes('blowout risk') ||
    (driver.market === 'RISK' && text.includes('blowout'))
  );
}

/**
 * Determine best market from drivers + available odds
 * Returns market type and strongest driver for that market
 */
function determineBestMarket(
  drivers: DriverRow[],
  odds: Odds | null,
): { market: Market | 'NONE'; driver: DriverRow | null } {
  const nonNeutral = drivers.filter(
    (d) => d.direction !== 'NEUTRAL' && !isRiskOnlyDriver(d),
  );
  if (nonNeutral.length === 0) {
    return { market: 'NONE', driver: null };
  }

  // Check for TOTAL drivers with SUPER+ tier
  const totalDrivers = nonNeutral.filter(
    (d) =>
      (d.direction === 'OVER' || d.direction === 'UNDER') &&
      (d.tier === 'SUPER' || d.tier === 'BEST'),
  );

  if (
    totalDrivers.length > 0 &&
    odds?.total !== null &&
    odds?.total !== undefined
  ) {
    const sorted = sortDrivers(totalDrivers);
    return { market: 'TOTAL', driver: sorted[0] };
  }

  // Check for SIDE drivers with SUPER+ tier
  const sideDrivers = nonNeutral.filter(
    (d) =>
      (d.direction === 'HOME' || d.direction === 'AWAY') &&
      (d.tier === 'SUPER' || d.tier === 'BEST') &&
      (d.market === 'ML' ||
        d.market === 'SPREAD' ||
        d.market === 'UNKNOWN' ||
        isSideIntentDriver(d)),
  );

  if (sideDrivers.length > 0) {
    const sorted = sortDrivers(sideDrivers);
    const best = sorted[0];

    // Check if we should use SPREAD instead of ML
    const hasSpreadOdds =
      (odds?.spreadHome !== null && odds?.spreadHome !== undefined) ||
      (odds?.spreadAway !== null && odds?.spreadAway !== undefined);

    // Look for projection vs line indicators in the driver
    const hasSpreadEdge =
      best.note.toLowerCase().includes('spread') ||
      best.cardTitle.toLowerCase().includes('spread') ||
      best.key.toLowerCase().includes('spread');

    if (hasSpreadEdge && hasSpreadOdds) {
      return { market: 'SPREAD', driver: best };
    }

    // Default to ML for side plays if we have ML odds
    const hasMLOdds =
      (odds?.h2hHome !== null && odds?.h2hHome !== undefined) ||
      (odds?.h2hAway !== null && odds?.h2hAway !== undefined);

    if (hasMLOdds) {
      return { market: 'ML', driver: best };
    }
  }

  // No clear market with sufficient odds
  return { market: 'NONE', driver: null };
}

/**
 * Build pick string with proper price/line from odds
 */
function buildPickString(
  market: Market | 'NONE',
  direction: Direction | null,
  homeTeam: string,
  awayTeam: string,
  odds: Odds | null,
): { pick: string; price?: number; line?: number } {
  if (!direction || direction === 'NEUTRAL' || market === 'NONE') {
    return { pick: 'NO PLAY' };
  }

  const teamName = direction === 'HOME' ? homeTeam : awayTeam;

  if (market === 'ML') {
    const price = direction === 'HOME' ? odds?.h2hHome : odds?.h2hAway;
    if (price === null || price === undefined) {
      return { pick: `${teamName} ML (Price N/A)` };
    }
    const priceStr = price > 0 ? `+${price}` : `${price}`;
    return { pick: `${teamName} ML ${priceStr}`, price };
  }

  if (market === 'SPREAD') {
    const line = direction === 'HOME' ? odds?.spreadHome : odds?.spreadAway;
    if (line === null || line === undefined) {
      return { pick: `${teamName} Spread (Line N/A)` };
    }
    const lineStr = line > 0 ? `+${line}` : `${line}`;
    return { pick: `${teamName} ${lineStr}`, line };
  }

  if (market === 'TOTAL') {
    const line = odds?.total;
    if (line === null || line === undefined) {
      return { pick: `${direction === 'OVER' ? 'Over' : 'Under'} (Line N/A)` };
    }
    return { pick: `${direction === 'OVER' ? 'Over' : 'Under'} ${line}`, line };
  }

  return { pick: `${direction} ${market}` };
}

/**
 * Derive risk codes scoped to market
 */
function deriveRiskCodes(
  card: GameCard,
  drivers: DriverRow[],
  market: Market | 'NONE',
): string[] {
  const codes = new Set<string>();
  const tags = Array.isArray(card.tags) ? card.tags : [];
  const allText = drivers
    .map((d) => `${d.cardTitle} ${d.note}`.toLowerCase())
    .join(' ');

  const isTotalMarket = market === 'TOTAL';
  const isSideMarket = market === 'ML' || market === 'SPREAD';

  // Fragility / key number is TOTALS only
  if (
    isTotalMarket &&
    (tags.includes('has_risk_fragility') ||
      tags.includes('has_risk_key_number') ||
      allText.includes('fragility') ||
      allText.includes('key number'))
  ) {
    codes.add('KEY_NUMBER_FRAGILITY_TOTAL');
  }

  // Blowout is SIDE only
  if (
    isSideMarket &&
    (tags.includes('has_risk_blowout') || allText.includes('blowout'))
  ) {
    codes.add('BLOWOUT_RISK_SIDE');
  }

  // Low coverage applies to all
  if (
    tags.includes('has_low_coverage') ||
    allText.includes('low coverage') ||
    allText.includes('limited data')
  ) {
    codes.add(
      isTotalMarket
        ? 'LOW_COVERAGE_TOTAL'
        : isSideMarket
          ? 'LOW_COVERAGE_SIDE'
          : 'LOW_COVERAGE',
    );
  }

  // Stale odds applies to all
  if (
    tags.includes('stale_5m') ||
    tags.includes('stale_30m') ||
    allText.includes('stale')
  ) {
    codes.add(
      isTotalMarket
        ? 'STALE_ODDS_TOTAL'
        : isSideMarket
          ? 'STALE_ODDS_SIDE'
          : 'STALE_ODDS',
    );
  }

  // Conflict applies to all
  if (
    tags.includes('has_driver_contradiction') ||
    allText.includes('conflict')
  ) {
    codes.add(
      isTotalMarket
        ? 'CONFLICT_HIGH_TOTAL'
        : isSideMarket
          ? 'CONFLICT_HIGH_SIDE'
          : 'CONFLICT_HIGH',
    );
  }

  return Array.from(codes);
}

/**
 * Get why reason scoped to market
 */
function getWhyReason(
  status: ExpressionStatus,
  riskCodes: string[],
  market: Market | 'NONE',
  drivers: DriverRow[],
): string {
  if (status === 'PASS' || market === 'NONE') return 'NO_DECISION';

  if (riskCodes.length > 0) {
    return riskCodes[0];
  }

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

/**
 * Derive status from drivers and market selection
 */
function deriveStatus(
  card: GameCard,
  drivers: DriverRow[],
  market: Market | 'NONE',
): ExpressionStatus {
  if (card.expressionChoice?.status) {
    return card.expressionChoice.status;
  }

  if (market === 'NONE') {
    return 'PASS';
  }

  const hasBestNonNeutral = drivers.some(
    (driver) => driver.tier === 'BEST' && driver.direction !== 'NEUTRAL',
  );
  if (hasBestNonNeutral) return 'FIRE';

  const hasSuperNonNeutral = drivers.some(
    (driver) => driver.tier === 'SUPER' && driver.direction !== 'NEUTRAL',
  );
  if (hasSuperNonNeutral) return 'WATCH';

  return 'PASS';
}

/**
 * Select primary play using market-first logic
 */
function selectPrimaryPlay(
  card: GameCard,
  odds: Odds | null,
  drivers: DriverRow[],
): DecisionModel['primaryPlay'] {
  // Use expression choice if available
  if (card.expressionChoice?.pick) {
    return {
      source: 'expressionChoice',
      market: card.expressionChoice.chosenMarket,
      status: card.expressionChoice.status,
      pick: card.expressionChoice.pick,
      direction: null,
      tier: null,
      confidence: null,
    };
  }

  // Use pre-built play if available
  if (card.play) {
    const resolved = resolvePlayDisplayDecision(card.play);
    return {
      source: 'play',
      market:
        card.play.market === 'NONE' ? 'NONE' : (card.play.market as Market),
      status: resolved.status,
      pick: card.play.pick,
      direction: card.play.side,
      tier: null,
      confidence: null,
    };
  }

  // Determine best market from drivers
  const { market, driver } = determineBestMarket(drivers, odds);

  if (market === 'NONE' || !driver) {
    return {
      source: 'none',
      market: 'NONE',
      status: 'PASS',
      pick: 'NO PLAY',
      direction: null,
      tier: null,
      confidence: null,
    };
  }

  const status = deriveStatus(card, drivers, market);
  const { pick } = buildPickString(
    market,
    driver.direction,
    card.homeTeam,
    card.awayTeam,
    odds,
  );

  return {
    source: 'drivers',
    market,
    status,
    pick,
    direction: driver.direction,
    tier: driver.tier,
    confidence: driver.confidence ?? null,
  };
}

/**
 * Filter drivers by market relevance
 */
function filterDriversByMarket(
  drivers: DriverRow[],
  market: Market | 'NONE',
): DriverRow[] {
  if (market === 'NONE') return [];

  if (market === 'TOTAL') {
    const filtered = drivers.filter(
      (d) =>
        (d.market === 'TOTAL' ||
          d.market === 'UNKNOWN' ||
          d.market === 'RISK') &&
        (d.direction === 'OVER' ||
          d.direction === 'UNDER' ||
          d.direction === 'NEUTRAL'),
    );
    if (filtered.length > 0) return filtered;
    return drivers.filter(
      (d) =>
        d.direction === 'OVER' ||
        d.direction === 'UNDER' ||
        d.direction === 'NEUTRAL',
    );
  }

  if (market === 'ML') {
    const filtered = drivers.filter(
      (d) =>
        (d.market === 'ML' || d.market === 'UNKNOWN' || d.market === 'RISK') &&
        (d.direction === 'HOME' ||
          d.direction === 'AWAY' ||
          d.direction === 'NEUTRAL'),
    );
    if (filtered.length > 0) return filtered;
    return drivers.filter(
      (d) =>
        d.direction === 'HOME' ||
        d.direction === 'AWAY' ||
        d.direction === 'NEUTRAL',
    );
  }

  if (market === 'SPREAD') {
    const filtered = drivers.filter(
      (d) =>
        (d.market === 'SPREAD' ||
          d.market === 'UNKNOWN' ||
          d.market === 'RISK') &&
        (d.direction === 'HOME' ||
          d.direction === 'AWAY' ||
          d.direction === 'NEUTRAL'),
    );
    if (filtered.length > 0) return filtered;
    return drivers.filter(
      (d) =>
        (d.market === 'UNKNOWN' || d.market === 'RISK') &&
        (d.direction === 'HOME' ||
          d.direction === 'AWAY' ||
          d.direction === 'NEUTRAL'),
    );
  }

  return drivers;
}

function marketPreferenceScore(
  driverMarket: Market,
  chosenMarket: Market | 'NONE',
): number {
  if (chosenMarket === 'NONE') return 0;
  if (driverMarket === chosenMarket) return 3;
  if (driverMarket === 'UNKNOWN') return 2;
  if (driverMarket === 'RISK') return 1;
  return 0;
}

function dedupeContributorsByIntent(
  drivers: DriverRow[],
  market: Market | 'NONE',
): DriverRow[] {
  const byIntent = new Map<string, DriverRow>();

  for (const driver of drivers) {
    const intentKey = `${driver.key}|${driver.direction}|${normalizeText(driver.note)}`;
    const existing = byIntent.get(intentKey);
    if (!existing) {
      byIntent.set(intentKey, driver);
      continue;
    }

    const nextPref = marketPreferenceScore(driver.market, market);
    const currentPref = marketPreferenceScore(existing.market, market);
    if (nextPref > currentPref) {
      byIntent.set(intentKey, driver);
      continue;
    }
    if (nextPref === currentPref && isStrongerDriver(driver, existing)) {
      byIntent.set(intentKey, driver);
    }
  }

  return Array.from(byIntent.values());
}

/**
 * Pick top contributors matching the chosen market and play direction
 */
function pickTopContributors(
  drivers: DriverRow[],
  primary: DecisionModel['primaryPlay'],
): DecisionContributor[] {
  if (
    !drivers.length ||
    !primary.direction ||
    primary.direction === 'NEUTRAL'
  ) {
    return [];
  }

  // Filter to market-relevant drivers
  const relevantDrivers = dedupeContributorsByIntent(
    filterDriversByMarket(drivers, primary.market),
    primary.market,
  ).filter(
    (driver) =>
      !hasPlaceholderDriverText(driver.note) &&
      !hasPlaceholderDriverText(driver.cardTitle),
  );
  const sorted = sortDrivers(relevantDrivers);
  const nonNeutral = sorted.filter((d) => d.direction !== 'NEUTRAL');

  const opposite = DIRECTION_OPPOSITE[primary.direction];
  const pro = nonNeutral.filter((d) => d.direction === primary.direction);
  const contra = nonNeutral.filter((d) => d.direction === opposite);

  const selected: DecisionContributor[] = [];
  const used = new Set<DriverRow>();

  // Add top 2 PRO drivers
  for (const driver of pro.slice(0, 2)) {
    selected.push({ driver, polarity: 'pro' });
    used.add(driver);
  }

  // Add 1 CONTRA driver if available (only if truly opposing)
  if (contra.length > 0) {
    const driver = contra.find((item) => !used.has(item));
    if (driver) {
      selected.push({ driver, polarity: 'contra' });
      used.add(driver);
    }
  }

  // Fill remaining slots with pro if needed
  if (selected.length < 3) {
    for (const driver of nonNeutral) {
      if (selected.length >= 3) break;
      if (used.has(driver)) continue;
      selected.push({ driver, polarity: 'pro' });
      used.add(driver);
    }
  }

  return selected;
}

/**
 * Build canonical decision model for card display
 */
export function getCardDecisionModel(
  card: GameCard,
  odds: Odds | null,
): DecisionModel {
  const baseDrivers = Array.isArray(card.drivers) ? card.drivers : [];
  const drivers = deduplicateDrivers(baseDrivers);

  const primaryPlay = selectPrimaryPlay(card, odds, drivers);
  const status = primaryPlay.status;
  const riskCodes = deriveRiskCodes(card, drivers, primaryPlay.market);
  const whyReason = getWhyReason(
    status,
    riskCodes,
    primaryPlay.market,
    drivers,
  );
  const topContributors = pickTopContributors(drivers, primaryPlay);

  return {
    status,
    primaryPlay,
    whyReason,
    riskCodes,
    topContributors,
    allDrivers: drivers,
  };
}

/**
 * Get display action from play object, respecting canonical fields with fallback to legacy
 *
 * This is the single source of truth for UI filtering and display.
 * Uses the new canonical 'action' field if available, falls back to legacy 'status' field.
 *
 * @param play - Play object from GameCard
 * @returns 'FIRE' | 'HOLD' | 'PASS'
 */
export function getPlayDisplayAction(
  play?: Play | null,
): 'FIRE' | 'HOLD' | 'PASS' {
  return resolvePlayDisplayDecision(play).action;
}
