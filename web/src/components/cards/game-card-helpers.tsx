'use client';

import type { ReactNode } from 'react';
import type {
  Direction,
  DriverRow,
  DriverTier,
  Market,
} from '@/lib/types/game-card';
import type { GameData } from './types';

export const INFORMATIONAL_CODES = new Set([
  'EDGE_CLEAR',
  'EDGE_FOUND_SIDE',
  'EDGE_FOUND',
  'BASE',
  'LEAN',
]);

export function formatDate(dateStr: string) {
  try {
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return dateStr;
  }
}

export function formatOddsLine(value: number | null): string {
  if (value === null) return '--';
  return value > 0 ? `+${value}` : `${value}`;
}

export function resolvePlayLivePrice(
  marketType: string | undefined,
  selectionSide: string | undefined,
  gameOdds: GameData['odds'],
): number | undefined {
  if (!gameOdds) return undefined;
  const side = selectionSide?.toUpperCase();
  if (marketType === 'MONEYLINE') {
    if (side === 'HOME' && gameOdds.h2hHome != null) return gameOdds.h2hHome;
    if (side === 'AWAY' && gameOdds.h2hAway != null) return gameOdds.h2hAway;
  }
  if (marketType === 'SPREAD' || marketType === 'PUCKLINE') {
    if (side === 'HOME' && gameOdds.spreadPriceHome != null) {
      return gameOdds.spreadPriceHome;
    }
    if (side === 'AWAY' && gameOdds.spreadPriceAway != null) {
      return gameOdds.spreadPriceAway;
    }
  }
  if (marketType === 'TOTAL') {
    if (side === 'OVER' && gameOdds.totalPriceOver != null) {
      return gameOdds.totalPriceOver;
    }
    if (side === 'UNDER' && gameOdds.totalPriceUnder != null) {
      return gameOdds.totalPriceUnder;
    }
  }
  return undefined;
}

export function resolvePlayLiveLine(
  marketType: string | undefined,
  selectionSide: string | undefined,
  gameOdds: GameData['odds'],
): number | undefined {
  if (!gameOdds) return undefined;
  const side = selectionSide?.toUpperCase();
  if (marketType === 'SPREAD' || marketType === 'PUCKLINE') {
    if (side === 'HOME' && gameOdds.spreadHome != null) return gameOdds.spreadHome;
    if (side === 'AWAY' && gameOdds.spreadAway != null) return gameOdds.spreadAway;
  }
  if (marketType === 'TOTAL') {
    if (side === 'OVER' && gameOdds.totalLineOver != null) return gameOdds.totalLineOver;
    if (side === 'UNDER' && gameOdds.totalLineUnder != null) return gameOdds.totalLineUnder;
    if (gameOdds.total != null) return gameOdds.total;
  }
  return undefined;
}

export function resolvePlayLiveBook(
  marketType: string | undefined,
  selectionSide: string | undefined,
  gameOdds: GameData['odds'],
): string | null {
  if (!gameOdds) return null;
  const side = selectionSide?.toUpperCase();
  if (marketType === 'MONEYLINE') {
    if (side === 'HOME') return gameOdds.h2hHomeBook ?? gameOdds.h2hBook ?? null;
    if (side === 'AWAY') return gameOdds.h2hAwayBook ?? gameOdds.h2hBook ?? null;
    return gameOdds.h2hBook ?? null;
  }
  if (marketType === 'SPREAD' || marketType === 'PUCKLINE') {
    if (side === 'HOME') {
      return gameOdds.spreadPriceHomeBook ?? gameOdds.spreadHomeBook ?? null;
    }
    if (side === 'AWAY') {
      return gameOdds.spreadPriceAwayBook ?? gameOdds.spreadAwayBook ?? null;
    }
  }
  if (marketType === 'TOTAL') {
    if (side === 'OVER') return gameOdds.totalPriceOverBook ?? gameOdds.totalBook ?? null;
    if (side === 'UNDER') return gameOdds.totalPriceUnderBook ?? gameOdds.totalBook ?? null;
    return gameOdds.totalBook ?? null;
  }
  return null;
}

export function resolvePlayLiveLineBook(
  marketType: string | undefined,
  selectionSide: string | undefined,
  gameOdds: GameData['odds'],
): string | null {
  if (!gameOdds) return null;
  const side = selectionSide?.toUpperCase();
  if (marketType === 'SPREAD' || marketType === 'PUCKLINE') {
    if (side === 'HOME') return gameOdds.spreadHomeBook ?? null;
    if (side === 'AWAY') return gameOdds.spreadAwayBook ?? null;
  }
  if (marketType === 'TOTAL') {
    if (side === 'OVER') return gameOdds.totalLineOverBook ?? gameOdds.totalBook ?? null;
    if (side === 'UNDER') return gameOdds.totalLineUnderBook ?? gameOdds.totalBook ?? null;
  }
  return null;
}

export function impliedProbFromOdds(americanOdds: number): number | undefined {
  if (!Number.isFinite(americanOdds) || americanOdds === 0) return undefined;
  const p =
    americanOdds < 0
      ? -americanOdds / (-americanOdds + 100)
      : 100 / (americanOdds + 100);
  return p >= 0 && p <= 1 ? p : undefined;
}

export function fairProbToAmericanOdds(probability: number): number | undefined {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    return undefined;
  }
  const odds =
    probability >= 0.5
      ? -((probability * 100) / (1 - probability))
      : ((1 - probability) * 100) / probability;
  if (!Number.isFinite(odds)) return undefined;
  return Math.round(odds);
}

export function getTierBadge(tier: DriverTier | null): ReactNode {
  switch (tier) {
    case 'SUPER':
      return (
        <span className="px-2 py-0.5 text-xs font-bold bg-green-700/50 text-green-300 rounded border border-green-600/60">
          Strong
        </span>
      );
    case 'BEST':
      return (
        <span className="px-2 py-0.5 text-xs font-bold bg-blue-700/50 text-blue-300 rounded border border-blue-600/60">
          Good
        </span>
      );
    case 'WATCH':
      return (
        <span className="px-2 py-0.5 text-xs font-bold bg-yellow-700/50 text-yellow-300 rounded border border-yellow-600/60">
          Weak
        </span>
      );
    default:
      return null;
  }
}

export function getDirectionBadge(direction: Direction): ReactNode {
  const colorMap = {
    HOME: 'bg-indigo-700/40 text-indigo-200 border-indigo-600/50',
    AWAY: 'bg-orange-700/40 text-orange-200 border-orange-600/50',
    OVER: 'bg-emerald-700/40 text-emerald-200 border-emerald-600/50',
    UNDER: 'bg-sky-700/40 text-sky-200 border-sky-600/50',
    NEUTRAL: 'bg-white/10 text-cloud/70 border-white/20',
  };
  return (
    <span
      className={`px-2 py-0.5 text-xs font-semibold rounded border ${colorMap[direction]}`}
    >
      {direction}
    </span>
  );
}

export function getPolarityBadge(
  polarity: 'pro' | 'contra' | 'neutral',
): ReactNode {
  const labels = {
    pro: 'PRO',
    contra: 'CONTRA',
    neutral: 'NEUTRAL',
  };
  const colorMap = {
    pro: 'bg-green-700/40 text-green-200 border-green-600/50',
    contra: 'bg-amber-700/40 text-amber-200 border-amber-600/50',
    neutral: 'bg-white/10 text-cloud/70 border-white/20',
  };

  return (
    <span
      className={`px-2 py-0.5 text-xs font-semibold rounded border ${colorMap[polarity]}`}
    >
      {labels[polarity]}
    </span>
  );
}

export function formatConfidence(value?: number | null) {
  if (value === null || value === undefined) return '--';
  return `${Math.round(value * 100)}%`;
}

export function formatMarketLabel(market: Market | 'NONE') {
  if (market === 'ML') return 'ML';
  if (market === 'SPREAD') return 'SPREAD';
  if (market === 'TOTAL') return 'TOTAL';
  if (market === 'RISK') return 'RISK';
  if (market === 'NONE') return 'NONE';
  return market;
}

export function formatReasonCode(code?: string | null) {
  if (!code) return 'UNKNOWN';
  const LABELS: Record<string, string> = {
    EDGE_VERIFICATION_REQUIRED: 'Line unstable — waiting for confirmation',
    EDGE_CLEAR: 'Edge clear',
    EDGE_FOUND_SIDE: 'Edge found',
    NO_EDGE_AT_PRICE: 'Price too sharp',
    PASS_NO_EDGE: 'No edge',
    PASS_LOW_CONFIDENCE: 'Low confidence',
    PASS_SHARP_MONEY_OPPOSITE: 'Sharp money against',
    GATE_GOALIE_UNCONFIRMED: 'Goalie not confirmed',
    GATE_LINE_MOVEMENT: 'Line moved — re-evaluating',
    BLOCK_INJURY_RISK: 'Injury risk flag',
    BLOCK_STALE_DATA: 'Data stale',
    MODEL_PROB_MISSING: 'Model incomplete',
    EXACT_WAGER_MISMATCH: 'Line mismatch',
    HEAVY_FAVORITE_PRICE_CAP: 'High price cap',
  };
  return LABELS[code] ?? code.replace(/_/g, ' ').toLowerCase();
}

export function formatSharpPriceStatus(status?: string | null) {
  if (status === 'CHEDDAR') return 'Priced edge';
  if (status === 'COTTAGE') return 'No edge at current price';
  if (status === 'PENDING_VERIFICATION') {
    return 'Priced, pending verification';
  }
  if (status === 'UNPRICED') return 'Unpriced';
  return status ?? 'Unpriced';
}

export function formatSignedDecimal(value: number, digits = 1) {
  const fixed = value.toFixed(digits);
  return value >= 0 ? `+${fixed}` : fixed;
}

export function formatBookName(book: string | null | undefined): string {
  if (!book) return '';
  const names: Record<string, string> = {
    betmgm: 'BetMGM',
    draftkings: 'DraftKings',
    fanduel: 'FanDuel',
    williamhill_us: 'Caesars',
    espnbet: 'ESPN Bet',
    fliff: 'Fliff',
    pinnacle: 'Pinnacle',
    fanatics: 'Fanatics',
    hardrockbet: 'Hard Rock',
  };
  return names[book] ?? book;
}

export function formatConsensusConfidence(
  confidence: string | null | undefined,
): string | null {
  if (confidence === 'high') return 'high';
  if (confidence === 'medium') return 'med';
  if (confidence === 'low') return 'low';
  return null;
}

export function formatProjectedMarginDirectional(
  projectedMargin: number | undefined,
) {
  if (typeof projectedMargin !== 'number') return 'N/A';
  return projectedMargin >= 0
    ? `+${projectedMargin.toFixed(1)}`
    : projectedMargin.toFixed(1);
}

export function normalizeSelectionSide(
  side: string | null | undefined,
): 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | undefined {
  if (!side) return undefined;
  const normalized = side.toUpperCase();
  if (
    normalized === 'HOME' ||
    normalized === 'AWAY' ||
    normalized === 'OVER' ||
    normalized === 'UNDER'
  ) {
    return normalized;
  }
  return undefined;
}

export function resolveProjectedValueForMarketContext({
  marketType,
  selectionSide,
  projectedMargin,
  projectedTotal,
  projectedTeamTotal,
}: {
  marketType: string | undefined;
  selectionSide: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | undefined;
  projectedMargin: number | undefined;
  projectedTotal: number | undefined;
  projectedTeamTotal: number | undefined;
}) {
  if (marketType === 'SPREAD' || marketType === 'PUCKLINE') {
    if (typeof projectedMargin !== 'number') return undefined;
    return selectionSide === 'AWAY' ? projectedMargin : -1 * projectedMargin;
  }
  if (
    marketType === 'TOTAL' ||
    marketType === 'TEAM_TOTAL' ||
    marketType === 'FIRST_PERIOD'
  ) {
    if (typeof projectedTeamTotal === 'number') return projectedTeamTotal;
    if (typeof projectedTotal === 'number') return projectedTotal;
    return undefined;
  }
  return undefined;
}

export function formatProjectedSentence(
  projection: number | undefined,
  line: number | undefined,
  reasonCode: string | undefined,
  edgePctValue: number | undefined,
  marketType: string | undefined,
  projectedMargin: number | undefined,
): string | null {
  if (typeof projection !== 'number') {
    return null;
  }

  const isSpreadLikeMarket =
    marketType === 'SPREAD' || marketType === 'PUCKLINE';
  const spreadProjectedLabel =
    isSpreadLikeMarket && typeof projectedMargin === 'number'
      ? `Model: ${formatProjectedMarginDirectional(projectedMargin)}`
      : `Model: ${projection.toFixed(1)}`;

  if (typeof line === 'number' && Math.abs(line) > 0.001) {
    const shouldShowDelta =
      reasonCode !== 'NO_EDGE_AT_PRICE' &&
      typeof edgePctValue === 'number' &&
      edgePctValue !== 0;

    if (shouldShowDelta) {
      const delta = projection - line;
      const deltaStr = delta >= 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
      return `${spreadProjectedLabel}  (${deltaStr} vs line)`;
    }

    return spreadProjectedLabel;
  }

  return spreadProjectedLabel;
}

export function getMarketTypeBadge(
  betMarketType?: string | null,
  market?: Market | 'NONE',
) {
  const t = betMarketType?.toLowerCase() ?? market?.toLowerCase() ?? '';
  if (t === 'moneyline' || t === 'ml') {
    return (
      <span className="px-2 py-0.5 text-xs font-bold rounded border bg-blue-700/40 text-blue-200 border-blue-600/60">
        ML
      </span>
    );
  }
  if (t === 'spread') {
    return (
      <span className="px-2 py-0.5 text-xs font-bold rounded border bg-purple-700/40 text-purple-200 border-purple-600/60">
        SPREAD
      </span>
    );
  }
  if (t === 'total') {
    return (
      <span className="px-2 py-0.5 text-xs font-bold rounded border bg-teal-700/40 text-teal-200 border-teal-600/60">
        TOTAL
      </span>
    );
  }
  if (t === 'team_total') {
    return (
      <span className="px-2 py-0.5 text-xs font-bold rounded border bg-cyan-700/40 text-cyan-200 border-cyan-600/60">
        TT
      </span>
    );
  }
  if (t === 'player_prop') {
    return (
      <span className="px-2 py-0.5 text-xs font-bold rounded border bg-amber-700/40 text-amber-200 border-amber-600/60">
        PROP
      </span>
    );
  }
  return null;
}

export function formatCanonicalBetText(
  bet:
    | {
        market_type: string;
        side: string;
        line?: number;
        odds_american: number;
      }
    | null
    | undefined,
  homeTeam: string,
  awayTeam: string,
  oddsAmericanOverride?: number,
) {
  if (!bet) return 'NO PLAY';
  const oddsAmerican =
    typeof oddsAmericanOverride === 'number'
      ? oddsAmericanOverride
      : bet.odds_american;
  const oddsText = oddsAmerican > 0 ? `+${oddsAmerican}` : `${oddsAmerican}`;
  if (bet.market_type === 'moneyline') {
    const teamLabel =
      bet.side === 'home'
        ? homeTeam
        : bet.side === 'away'
          ? awayTeam
          : bet.side.toUpperCase();
    return `${teamLabel} ML ${oddsText}`;
  }
  if (bet.market_type === 'spread') {
    const teamLabel = bet.side === 'home' ? homeTeam : awayTeam;
    const lineText =
      typeof bet.line === 'number'
        ? bet.line > 0
          ? `+${bet.line}`
          : `${bet.line}`
        : 'Line N/A';
    return `${teamLabel} ${lineText} (${oddsText})`;
  }
  if (bet.market_type === 'total') {
    const sideLabel = bet.side === 'over' ? 'Over' : 'Under';
    const lineText = typeof bet.line === 'number' ? `${bet.line}` : 'Line N/A';
    return `${sideLabel} ${lineText} (${oddsText})`;
  }
  const sideLabel = bet.side.toUpperCase();
  const lineText = typeof bet.line === 'number' ? ` ${bet.line}` : '';
  return `${sideLabel}${lineText} (${oddsText})`;
}

export function formatContributorMarketLabel(
  driverMarket: Market,
  cardMarket: Market | 'NONE',
) {
  if (driverMarket === cardMarket) return `${formatMarketLabel(driverMarket)} (native)`;
  if (driverMarket === 'UNKNOWN') return 'BASE (shared)';
  if (driverMarket === 'RISK') return 'RISK';
  return formatMarketLabel(driverMarket);
}

export function driverRowKey(driver: DriverRow) {
  return `${driver.key}-${driver.market}-${driver.direction}-${driver.cardTitle}`;
}

/**
 * Renders the MLB F5 projection block for PROJECTION_ONLY mlb-f5 cards.
 * No direction badge, no line, no odds — MAE tracking surface only.
 */
export function formatF5ProjectionBlock(
  projectedTotal: number | undefined,
  projectedHome: number | undefined,
  projectedAway: number | undefined,
  homeTeam: string,
  awayTeam: string,
): {
  headline: string;
  subLabel: string;
  homeLabel: string | null;
  awayLabel: string | null;
} {
  const headline =
    typeof projectedTotal === 'number'
      ? `Projected: ${projectedTotal.toFixed(1)} runs`
      : 'Projected: N/A';
  const subLabel = 'No market line \u00b7 MAE tracking';
  const homeLabel =
    typeof projectedHome === 'number'
      ? `${homeTeam}: ${projectedHome.toFixed(1)}`
      : null;
  const awayLabel =
    typeof projectedAway === 'number'
      ? `${awayTeam}: ${projectedAway.toFixed(1)}`
      : null;
  return { headline, subLabel, homeLabel, awayLabel };
}
