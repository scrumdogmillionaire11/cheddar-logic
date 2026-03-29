/**
 * Title, diagnostic token, and explanatory-text helpers extracted from
 * game-card/transform.ts.
 */

import type {
  CanonicalMarketType,
  DecisionV2,
  DriverRow,
  Market,
  PassReasonCode,
  PriceFlag,
} from '../../types/game-card';

export interface GameTeamsLike {
  homeTeam: string;
  awayTeam: string;
}

export interface Wave1PlayLike {
  market_type?: CanonicalMarketType;
  price?: number;
  line?: number;
}

export function toDiagnosticToken(prefix: string, value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) return null;
  return `${prefix}:${normalized}`;
}

export function directionToLean(
  direction: DecisionV2['direction'],
  game: GameTeamsLike,
): string {
  if (direction === 'HOME') return game.homeTeam;
  if (direction === 'AWAY') return game.awayTeam;
  if (direction === 'OVER' || direction === 'UNDER') return direction;
  return 'NO LEAN';
}

export function buildWave1PickText(
  play: Wave1PlayLike,
  game: GameTeamsLike,
  direction: DecisionV2['direction'],
): string {
  if (direction === 'NONE') return 'NO PLAY';
  if (play.market_type === 'MONEYLINE') {
    const team = direction === 'HOME' ? game.homeTeam : game.awayTeam;
    if (typeof play.price === 'number') {
      return `${team} ML ${play.price > 0 ? `+${play.price}` : `${play.price}`}`;
    }
    return `${team} ML`;
  }
  if (play.market_type === 'SPREAD' || play.market_type === 'PUCKLINE') {
    const team = direction === 'HOME' ? game.homeTeam : game.awayTeam;
    if (typeof play.line === 'number') {
      const lineText = play.line > 0 ? `+${play.line}` : `${play.line}`;
      return `${team} ${lineText}`;
    }
    return `${team} Spread`;
  }
  if (
    play.market_type === 'TOTAL' ||
    play.market_type === 'TEAM_TOTAL' ||
    play.market_type === 'FIRST_PERIOD'
  ) {
    if (typeof play.line === 'number') {
      return `${direction === 'OVER' ? 'Over' : 'Under'} ${play.line}`;
    }
    return direction === 'OVER' ? 'Over' : 'Under';
  }
  return direction;
}

export function getPlayWhyCode(
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

export function getRiskTagsFromText(...texts: string[]): string[] {
  const source = texts.join(' ').toLowerCase();
  const tags: string[] = [];
  if (source.includes('fragility')) tags.push('RISK_FRAGILITY');
  if (source.includes('blowout')) tags.push('RISK_BLOWOUT');
  if (source.includes('key number')) tags.push('RISK_KEY_NUMBER');
  return tags;
}

export function hasPlaceholderText(value?: string): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized.includes('generic analysis for') ||
    normalized === 'no contributors available'
  );
}
