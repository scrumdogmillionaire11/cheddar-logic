/**
 * Card stage counting logic extracted from route.ts (WI-0621)
 */

import { normalizeMarketType, normalizeSport } from './normalizers';
import type { SportCardTypeContract } from './market-inference';

type MarketType =
  | 'MONEYLINE'
  | 'SPREAD'
  | 'TOTAL'
  | 'PUCKLINE'
  | 'TEAM_TOTAL'
  | 'FIRST_PERIOD'
  | 'FIRST_5_INNINGS'
  | 'PROP'
  | 'INFO';

export type StageCounterStage =
  | 'base_games'
  | 'card_rows'
  | 'parsed_rows'
  | 'wave1_skipped_no_d2'
  | 'plays_emitted'
  | 'games_with_plays';
export type StageCounterBucket = Record<string, number>;
export type StageCounterBySport = Record<string, StageCounterBucket>;
export type StageCounters = Record<StageCounterStage, StageCounterBySport>;

export const COUNTER_ALL_MARKET = 'ALL';
export const UNKNOWN_SPORT = 'UNKNOWN';

export function createStageCounters(): StageCounters {
  return {
    base_games: {},
    card_rows: {},
    parsed_rows: {},
    wave1_skipped_no_d2: {},
    plays_emitted: {},
    games_with_plays: {},
  };
}

export function normalizeCounterSport(value: unknown): string {
  const sport = normalizeSport(value);
  return sport ?? UNKNOWN_SPORT;
}

export function normalizeCounterMarket(value: unknown): string {
  const market = normalizeMarketType(value);
  return market ?? COUNTER_ALL_MARKET;
}

export function incrementStageCounter(
  counters: StageCounters,
  stage: StageCounterStage,
  sport: unknown,
  market: unknown = COUNTER_ALL_MARKET,
  amount = 1,
): void {
  const normalizedSport = normalizeCounterSport(sport);
  const normalizedMarket =
    typeof market === 'string' &&
    market.trim().toUpperCase() === COUNTER_ALL_MARKET
      ? COUNTER_ALL_MARKET
      : normalizeCounterMarket(market);
  if (!counters[stage][normalizedSport]) {
    counters[stage][normalizedSport] = {};
  }
  counters[stage][normalizedSport][normalizedMarket] =
    (counters[stage][normalizedSport][normalizedMarket] ?? 0) + amount;
}

export function bumpCount(store: Map<string, number>, key: string, amount = 1): void {
  store.set(key, (store.get(key) ?? 0) + amount);
}

export function registerGameWithPlayableMarket(
  store: Map<string, Map<string, Set<string>>>,
  sport: unknown,
  market: unknown,
  gameId: string,
): void {
  const normalizedSport = normalizeCounterSport(sport);
  const normalizedMarket = normalizeCounterMarket(market);
  if (!store.has(normalizedSport)) {
    store.set(normalizedSport, new Map());
  }
  const marketMap = store.get(normalizedSport)!;
  if (!marketMap.has(normalizedMarket)) {
    marketMap.set(normalizedMarket, new Set());
  }
  marketMap.get(normalizedMarket)!.add(gameId);
}

export function buildPlayableMarketFamilyDiagnostics(
  counters: StageCounters,
  activeContract: Record<string, SportCardTypeContract>,
): {
  expected_playable_markets: Record<string, MarketType[]>;
  emitted_playable_markets: Record<string, string[]>;
  missing_playable_markets: Record<string, string[]>;
} {
  const expected: Record<string, MarketType[]> = {};
  const emitted: Record<string, string[]> = {};
  const missing: Record<string, string[]> = {};

  for (const [sport, contract] of Object.entries(activeContract)) {
    expected[sport] = Array.from(contract.expectedPlayableMarkets).sort();
    const emittedMarkets = Object.entries(counters.plays_emitted[sport] ?? {})
      .filter(
        ([market, count]) =>
          market !== COUNTER_ALL_MARKET &&
          typeof count === 'number' &&
          count > 0,
      )
      .map(([market]) => market)
      .sort();
    emitted[sport] = emittedMarkets;
    const emittedSet = new Set(emittedMarkets);
    missing[sport] = Array.from(contract.expectedPlayableMarkets)
      .filter((market) => !emittedSet.has(market))
      .sort();
  }

  return {
    expected_playable_markets: expected,
    emitted_playable_markets: emitted,
    missing_playable_markets: missing,
  };
}
