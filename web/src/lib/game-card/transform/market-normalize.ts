/**
 * Market normalization and inference helpers extracted from game-card/transform.ts.
 */

import type {
  BetMarketType,
  CanonicalMarketType,
  GameMarkets,
  Market,
} from '../../types/game-card';
import { isPlayItem } from './legacy-repair';

type Prediction = 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';
type Kind = 'PLAY' | 'EVIDENCE';

export interface ApiPlayLike {
  cardType: string;
  cardTitle: string;
  prediction: Prediction;
  market_type?: CanonicalMarketType;
  selection?: { side?: string; team?: string };
  line?: number;
  price?: number;
  reason_codes?: string[];
  tags?: string[];
  recommendation?: { type?: string };
  recommended_bet_type?: string;
  kind?: Kind;
}

export type CanonicalSide = 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NONE';

export interface InferredMarket {
  market: Market;
  canonical?: CanonicalMarketType;
  reasonCodes: string[];
  tags: string[];
}

export function normalizeCardType(cardType: string): string {
  return cardType.trim().toLowerCase();
}

export function mapCanonicalToLegacyMarket(
  canonical?: CanonicalMarketType,
): Market | 'NONE' {
  if (!canonical) return 'NONE';
  if (
    canonical === 'TOTAL' ||
    canonical === 'TEAM_TOTAL' ||
    canonical === 'FIRST_PERIOD'
  ) {
    return 'TOTAL';
  }
  if (canonical === 'SPREAD' || canonical === 'PUCKLINE') return 'SPREAD';
  if (canonical === 'MONEYLINE') return 'ML';
  return 'UNKNOWN';
}

export function inferMarketFromCardTitle(cardTitle: string): Market {
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

export function inferCanonicalFromSecondary(
  play: ApiPlayLike,
): CanonicalMarketType | undefined {
  const recommendationType = play.recommendation?.type?.toLowerCase();
  if (recommendationType) {
    if (recommendationType.includes('first_period')) return 'FIRST_PERIOD';
    if (recommendationType.includes('total')) return 'TOTAL';
    if (recommendationType.includes('spread')) return 'SPREAD';
    if (
      recommendationType.includes('moneyline') ||
      recommendationType.includes('ml')
    ) {
      return 'MONEYLINE';
    }
  }

  const recommendedBetType = play.recommended_bet_type?.toLowerCase();
  if (recommendedBetType) {
    if (recommendedBetType === 'first_period') return 'FIRST_PERIOD';
    if (recommendedBetType === 'total') return 'TOTAL';
    if (recommendedBetType === 'spread') return 'SPREAD';
    if (recommendedBetType === 'moneyline' || recommendedBetType === 'ml') {
      return 'MONEYLINE';
    }
  }

  return undefined;
}

export function inferMarketFromPlay(play: ApiPlayLike): InferredMarket {
  const reasonCodes = [...(play.reason_codes ?? [])];
  const tags = [...(play.tags ?? [])];

  if (!isPlayItem(play as Parameters<typeof isPlayItem>[0])) {
    return {
      market: 'UNKNOWN',
      canonical: 'INFO',
      reasonCodes,
      tags: Array.from(new Set(tags)),
    };
  }

  if (play.market_type) {
    return {
      market: mapCanonicalToLegacyMarket(play.market_type) as Market,
      canonical: play.market_type,
      reasonCodes,
      tags: Array.from(new Set(tags)),
    };
  }

  const secondary = inferCanonicalFromSecondary(play);
  if (secondary) {
    return {
      market: mapCanonicalToLegacyMarket(secondary) as Market,
      canonical: secondary,
      reasonCodes,
      tags: Array.from(new Set(tags)),
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

export function normalizeSideToken(value: unknown): CanonicalSide {
  const token = String(value ?? '').toUpperCase();
  if (
    token === 'HOME' ||
    token === 'AWAY' ||
    token === 'OVER' ||
    token === 'UNDER'
  ) {
    if (token === 'HOME') return 'HOME';
    if (token === 'AWAY') return 'AWAY';
    return token === 'OVER' ? 'OVER' : 'UNDER';
  }
  return 'NONE';
}

export function normalizeSideForCanonicalMarket(
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
    canonical === 'FIRST_PERIOD' ||
    canonical === 'PROP'
  ) {
    return side === 'OVER' || side === 'UNDER' ? side : 'NONE';
  }
  return 'NONE';
}

export function marketPrefix(
  canonical?: CanonicalMarketType,
): 'ML' | 'SPREAD' | 'TOTAL' | 'PROP' | 'INFO' {
  if (canonical === 'MONEYLINE') return 'ML';
  if (canonical === 'SPREAD' || canonical === 'PUCKLINE') return 'SPREAD';
  if (
    canonical === 'TOTAL' ||
    canonical === 'TEAM_TOTAL' ||
    canonical === 'FIRST_PERIOD'
  ) {
    return 'TOTAL';
  }
  if (canonical === 'PROP') return 'PROP';
  return 'INFO';
}

export function buildMarketKey(
  canonical: CanonicalMarketType | undefined,
  side: CanonicalSide,
): string {
  return `${marketPrefix(canonical)}|${side}`;
}

export function mapCanonicalToBetMarketType(
  marketType: CanonicalMarketType,
): BetMarketType | null {
  if (marketType === 'MONEYLINE') return 'moneyline';
  if (marketType === 'SPREAD' || marketType === 'PUCKLINE') return 'spread';
  if (marketType === 'TOTAL' || marketType === 'FIRST_PERIOD') return 'total';
  if (marketType === 'TEAM_TOTAL') return 'team_total';
  if (marketType === 'PROP') return 'player_prop';
  return null;
}

export function buildMarkets(
  odds:
    | {
        h2hHome: number | null;
        h2hAway: number | null;
        total: number | null;
        spreadHome: number | null;
        spreadAway: number | null;
      }
    | null
    | undefined,
): GameMarkets {
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
