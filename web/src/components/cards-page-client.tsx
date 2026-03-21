'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import FilterPanel from './filter-panel';
import { transformGames, transformPropGames } from '@/lib/game-card/transform';
import {
  enrichCards,
  hasEdgeVerification,
  hasProxyCap,
} from '@/lib/game-card/tags';
import {
  applyFilters,
  getActiveFilterCount,
  getDefaultFilters,
  getFilterDebugFlags,
  resetFilters,
} from '@/lib/game-card/filters';
import PropGameCard from './prop-game-card';
import ProjectionCard from './projection-card';
import type { GameFilters, GameModeFilters, ViewMode } from '@/lib/game-card/filters';
import type {
  Direction,
  DriverRow,
  DriverTier,
  ExpressionStatus,
  GameCard,
  Market,
  PropGameCard as PropGameCardType,
  PropPlayRow,
  Sport,
  SupportGrade,
  PassReasonCode,
  SpreadCompare,
} from '@/lib/types/game-card';
import { GAME_TAGS } from '@/lib/types/game-card';
import {
  getPlayDisplayAction,
  getCardDecisionModel,
} from '@/lib/game-card/decision';
import { getDisplayVerdict } from '@/lib/game-card/display-verdict';
import { StickyBackButton } from '@/components/sticky-back-button';
import { createTimeoutSignal } from '@/lib/network/timeout-signal';

const TRACKED_SPORTS = ['NCAAM', 'NBA', 'NHL', 'SOCCER', 'MLB', 'NFL'] as const;

type SportCountMap = Record<string, number>;

type DropReason =
  | 'DROP_SPORT_NOT_ALLOWED'
  | 'DROP_TIME_WINDOW'
  | 'DROP_STALE_ODDS'
  | 'DROP_MARKET_NOT_ALLOWED'
  | 'DROP_NO_BETTABLE_STATUS'
  | 'DROP_DRIVER_STRENGTH'
  | 'DROP_RISK_FILTER'
  | 'DROP_SEARCH'
  | 'DROP_NO_PLAY'
  | 'DROP_PRESET_RULE'
  | 'DROP_UNKNOWN';

type DropReasonCounts = Record<DropReason, number>;

type PlayStatusCounts = {
  FIRE: number;
  WATCH: number;
  PASS: number;
};

type DroppedMeta = {
  games: number;
  playCount: number;
  hasAnyPlay: number;
  hasBettable: number;
  hasBlockedTotals: number;
  hasDataError: number;
  playStatusCounts: PlayStatusCounts;
  playMarkets: Record<string, number>;
};

type GuardrailTriggeredCounts = {
  edge_sanity_triggered: number;
  proxy_cap_triggered: number;
  proxy_blocked: number;
  high_edge_non_total_blocked: number;
  driver_load_failures: number;
  exact_wager_mismatch: number;
  market_price_missing: number;
};

type GuardrailOutcomeCounts = {
  fire_to_watch: number;
  watch_to_pass: number;
  fire_to_pass: number;
  bet_removed: number;
};

type GuardrailBreakdownEntry = {
  triggered: GuardrailTriggeredCounts;
  outcome: GuardrailOutcomeCounts;
};

const DROP_REASONS: DropReason[] = [
  'DROP_SPORT_NOT_ALLOWED',
  'DROP_TIME_WINDOW',
  'DROP_STALE_ODDS',
  'DROP_MARKET_NOT_ALLOWED',
  'DROP_NO_BETTABLE_STATUS',
  'DROP_DRIVER_STRENGTH',
  'DROP_RISK_FILTER',
  'DROP_SEARCH',
  'DROP_NO_PLAY',
  'DROP_PRESET_RULE',
  'DROP_UNKNOWN',
];

function createEmptySportCounts(): SportCountMap {
  return TRACKED_SPORTS.reduce<SportCountMap>((acc, sport) => {
    acc[sport] = 0;
    return acc;
  }, {});
}

function countBySport(items: Array<{ sport: string }>): SportCountMap {
  const counts = createEmptySportCounts();

  for (const item of items) {
    const sport = (item.sport || '').toUpperCase();
    if (Object.prototype.hasOwnProperty.call(counts, sport)) {
      counts[sport] += 1;
      continue;
    }

    counts.OTHER = (counts.OTHER || 0) + 1;
  }

  return counts;
}

function createDropReasonCounts(): DropReasonCounts {
  return DROP_REASONS.reduce<DropReasonCounts>((acc, reason) => {
    acc[reason] = 0;
    return acc;
  }, {} as DropReasonCounts);
}

function createPlayStatusCounts(): PlayStatusCounts {
  return { FIRE: 0, WATCH: 0, PASS: 0 };
}

function createDroppedMeta(): DroppedMeta {
  return {
    games: 0,
    playCount: 0,
    hasAnyPlay: 0,
    hasBettable: 0,
    hasBlockedTotals: 0,
    hasDataError: 0,
    playStatusCounts: createPlayStatusCounts(),
    playMarkets: {},
  };
}

function bumpReason(counts: DropReasonCounts, reason: DropReason) {
  counts[reason] = (counts[reason] || 0) + 1;
}

function getFirstDropReason(
  flags: ReturnType<typeof getFilterDebugFlags>,
): DropReason {
  if (!flags.sport) return 'DROP_SPORT_NOT_ALLOWED';
  if (!flags.timeWindow) return 'DROP_TIME_WINDOW';
  if (!flags.oddsFreshness) return 'DROP_STALE_ODDS';
  if (!flags.market) return 'DROP_MARKET_NOT_ALLOWED';
  if (!flags.actionability) return 'DROP_NO_BETTABLE_STATUS';
  if (!flags.driverStrength) return 'DROP_DRIVER_STRENGTH';
  if (!flags.riskFlags) return 'DROP_RISK_FILTER';
  if (!flags.search) return 'DROP_SEARCH';
  if (!flags.hasPicks) return 'DROP_NO_PLAY';
  if (!flags.clearPlay) return 'DROP_PRESET_RULE';
  return 'DROP_UNKNOWN';
}

function getCardDebugMeta(card: GameCard) {
  const playStatusCounts = createPlayStatusCounts();
  const displayAction = getPlayDisplayAction(card.play);
  if (displayAction) {
    // Map display action back to status names for counting
    const statusName =
      displayAction === 'FIRE'
        ? 'FIRE'
        : displayAction === 'HOLD'
          ? 'WATCH'
          : 'PASS';
    playStatusCounts[statusName] += 1;
  }

  const playMarkets = new Set<string>();
  if (card.play?.market && card.play.market !== 'NONE') {
    playMarkets.add(card.play.market);
  }
  for (const driver of card.drivers) {
    playMarkets.add(driver.market);
  }

  const playCount = card.drivers.length;
  const hasAnyPlay = playCount > 0;
  const hasBettable =
    card.tags.includes(GAME_TAGS.HAS_FIRE) ||
    card.tags.includes(GAME_TAGS.HAS_WATCH);
  const playDisplayAction = getPlayDisplayAction(card.play);
  const hasBlockedTotals = Boolean(
    card.play?.market_type === 'TOTAL' &&
    playDisplayAction === 'PASS' &&
    (card.play?.reason_codes?.includes('PASS_TOTAL_INSUFFICIENT_DATA') ||
      card.play?.tags?.includes('CONSISTENCY_BLOCK_TOTALS')),
  );
  const hasDataError = Boolean(
    card.play?.transform_meta?.quality === 'BROKEN' ||
    card.play?.reason_codes?.includes('PASS_DATA_ERROR') ||
    card.play?.gates?.some((gate) => gate.code === 'PASS_DATA_ERROR'),
  );

  return {
    playCount,
    playStatusCounts,
    playMarkets: Array.from(playMarkets),
    hasAnyPlay,
    hasBettable,
    hasBlockedTotals,
    hasDataError,
  };
}

function getEtDayKey(dateInput: Date | string): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

type DateCardGroup<T> = { dateKey: string; label: string; cards: T[] };

function groupCardsByEtDate<T>(
  cards: T[],
  getStartTime: (card: T) => string,
): DateCardGroup<T>[] {
  const now = new Date();
  const todayET = getEtDayKey(now);
  const tomorrowET = getEtDayKey(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const labelFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  const groups = new Map<string, DateCardGroup<T>>();
  for (const card of cards) {
    const dateKey = getEtDayKey(getStartTime(card));
    let group = groups.get(dateKey);
    if (!group) {
      const date = new Date(`${dateKey}T12:00:00`);
      let label: string;
      if (dateKey === todayET) label = `Today · ${labelFormatter.format(date)}`;
      else if (dateKey === tomorrowET) label = `Tomorrow · ${labelFormatter.format(date)}`;
      else label = labelFormatter.format(date);

      group = { dateKey, label, cards: [] };
      groups.set(dateKey, group);
    }

    group.cards.push(card);
  }

  return Array.from(groups.values());
}

function formatSportCounts(counts: SportCountMap): string {
  const base = TRACKED_SPORTS.map(
    (sport) => `${sport} ${counts[sport] || 0}`,
  ).join(' | ');
  return counts.OTHER ? `${base} | OTHER ${counts.OTHER}` : base;
}

interface GameData {
  id: string;
  gameId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  gameTimeUtc: string;
  status: string;
  lifecycle_mode?: 'pregame' | 'active';
  display_status?: 'SCHEDULED' | 'ACTIVE';
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
  plays: Array<{
    cardType: string;
    cardTitle: string;
    kind?: 'PLAY' | 'EVIDENCE';
    status?: 'FIRE' | 'WATCH' | 'PASS';
    action?: 'FIRE' | 'HOLD' | 'PASS';
    prediction: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';
    confidence: number;
    tier: 'SUPER' | 'BEST' | 'WATCH' | null;
    reasoning: string;
    evPassed: boolean;
    driverKey: string;
    projectedTotal: number | null;
    edge: number | null;
    model_prob?: number | null;
    market_type?:
      | 'MONEYLINE'
      | 'SPREAD'
      | 'TOTAL'
      | 'PUCKLINE'
      | 'TEAM_TOTAL'
      | 'FIRST_PERIOD'
      | 'PROP'
      | 'INFO';
    selection?: { side: string; team?: string };
    line?: number;
    price?: number;
    reason_codes?: string[];
    tags?: string[];
    consistency?: {
      total_bias?:
        | 'OK'
        | 'INSUFFICIENT_DATA'
        | 'CONFLICTING_SIGNALS'
        | 'VOLATILE_ENV'
        | 'UNKNOWN';
    };
    one_p_model_call?:
      | 'BEST_OVER'
      | 'PLAY_OVER'
      | 'LEAN_OVER'
      | 'BEST_UNDER'
      | 'PLAY_UNDER'
      | 'LEAN_UNDER'
      | 'PASS'
      | null;
    one_p_bet_status?: 'FIRE' | 'HOLD' | 'PASS' | null;
    goalie_home_name?: string | null;
    goalie_away_name?: string | null;
    goalie_home_status?: 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | null;
    goalie_away_status?: 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | null;
  }>;
  true_play?: (GameData['plays'][number] & { source_card_id?: string }) | null;
  consistency?: {
    total_bias?:
      | 'OK'
      | 'INSUFFICIENT_DATA'
      | 'CONFLICTING_SIGNALS'
      | 'VOLATILE_ENV'
      | 'UNKNOWN';
  };
}

function hasProjectedTotal(
  play: GameData['plays'][number] | undefined,
): play is GameData['plays'][number] {
  return typeof play?.projectedTotal === 'number';
}

function isFullGameTotalsCallPlay(play: GameData['plays'][number]): boolean {
  const cardType = String(play.cardType || '').toLowerCase();
  return (
    !cardType.includes('1p') &&
    !cardType.includes('first-period') &&
    cardType.includes('totals-call')
  );
}

function resolvePrimaryTotalProjectionPlay(
  plays: GameData['plays'],
  sport: string,
): GameData['plays'][number] | undefined {
  const sportUpper = String(sport || '').toUpperCase();

  const totalsCallPlay = plays.find(
    (play) => isFullGameTotalsCallPlay(play) && hasProjectedTotal(play),
  );
  if (totalsCallPlay) return totalsCallPlay;

  if (sportUpper === 'NHL') {
    return plays.find(
      (play) => play.cardType === 'nhl-pace-totals' && hasProjectedTotal(play),
    );
  }

  if (sportUpper === 'NBA') {
    return plays.find(
      (play) =>
        play.cardType === 'nba-total-projection' && hasProjectedTotal(play),
    );
  }

  // Generic fallback for historical/incomplete rows.
  return plays.find((play) => {
    if (!hasProjectedTotal(play)) return false;
    const cardType = String(play.cardType || '').toLowerCase();
    return (
      !cardType.includes('1p') &&
      !cardType.includes('first-period') &&
      cardType.includes('total-projection')
    );
  });
}

function deriveOnePModelCallFromReasons(
  reasonCodes: string[],
  prediction?: GameData['plays'][number]['prediction'],
): GameData['plays'][number]['one_p_model_call'] {
  if (reasonCodes.includes('NHL_1P_OVER_BEST')) return 'BEST_OVER';
  if (reasonCodes.includes('NHL_1P_OVER_PLAY')) return 'PLAY_OVER';
  if (reasonCodes.includes('NHL_1P_OVER_LEAN')) return 'LEAN_OVER';
  if (reasonCodes.includes('NHL_1P_UNDER_BEST')) return 'BEST_UNDER';
  if (reasonCodes.includes('NHL_1P_UNDER_PLAY')) return 'PLAY_UNDER';
  if (reasonCodes.includes('NHL_1P_UNDER_LEAN')) return 'LEAN_UNDER';
  if (reasonCodes.includes('NHL_1P_PASS_DEAD_ZONE')) return 'PASS';
  if (prediction === 'OVER') return 'LEAN_OVER';
  if (prediction === 'UNDER') return 'LEAN_UNDER';
  return null;
}

interface ApiResponse {
  success: boolean;
  data: GameData[];
  error?: string;
}

type LifecycleMode = 'pregame' | 'active';

function hasActionablePlay(game: GameData): boolean {
  if (!Array.isArray(game.plays) || game.plays.length === 0) return false;
  return game.plays.some((play) => {
    const kind = (play.kind ?? 'PLAY') === 'PLAY';
    const side = play.selection?.side?.toUpperCase() ?? '';
    const hasSelection = side !== '' && side !== 'NONE';
    const hasNonNeutralPrediction = play.prediction !== 'NEUTRAL';
    return kind && hasSelection && hasNonNeutralPrediction;
  });
}

type DecisionPolarity = 'pro' | 'contra' | 'neutral';

type DecisionContributor = {
  driver: DriverRow;
  polarity: DecisionPolarity;
};

type DecisionModel = {
  status: 'FIRE' | 'WATCH' | 'PASS';
  primaryPlay: {
    pick: string;
    market: Market | 'NONE';
    status: 'FIRE' | 'WATCH' | 'PASS';
    direction: Direction | null;
    tier: DriverTier | null;
    confidence: number | null;
    source: 'expressionChoice' | 'drivers' | 'none';
  };
  whyReason: string;
  riskCodes: string[];
  topContributors: DecisionContributor[];
  allDrivers: DriverRow[];
  supportGrade: SupportGrade;
  passReasonCode: PassReasonCode | null;
  spreadCompare: SpreadCompare | null;
};

const CLIENT_POLL_INTERVAL_MS = 60_000;
const CLIENT_MIN_FETCH_INTERVAL_MS = 5_000;
const CLIENT_FETCH_TIMEOUT_MS = 30_000;
const CLIENT_DEFAULT_BACKOFF_MS = 30_000;
const CHUNK_RELOAD_GUARD_KEY = 'cards_chunk_reload_once';
const LIFECYCLE_SESSION_KEY = 'cheddar_cards_lifecycle_mode';
const CHUNK_ERROR_LOG_CODE = 'CARDS_CHUNK_LOAD_FAILED';
const FETCH_ERROR_LOG_CODE = 'CARDS_FETCH_FAILED';

let globalGamesFetchInFlight = false;
let globalGamesLastFetchAt = 0;
let globalGamesBlockedUntil = 0;
let globalGamesRequestLifecycle: LifecycleMode | null = null;

function parseRetryAfterMs(retryAfterHeader: string | null): number | null {
  if (!retryAfterHeader) return null;

  const numeric = Number(retryAfterHeader.trim());
  if (Number.isFinite(numeric)) {
    // Accept both delta-seconds and absolute epoch-seconds.
    if (numeric > 1_000_000_000) {
      return Math.max(0, numeric * 1000 - Date.now());
    }
    return Math.max(0, numeric * 1000);
  }

  const asDate = Date.parse(retryAfterHeader);
  if (!Number.isFinite(asDate)) return null;
  return Math.max(0, asDate - Date.now());
}

function summarizeNonJsonBody(bodyText: string): string {
  const compact = bodyText.replace(/\s+/g, ' ').trim();
  if (!compact) return 'empty response body';
  return compact.length > 120 ? `${compact.slice(0, 120)}...` : compact;
}

function extractChunkPath(message: string): string | null {
  const match = message.match(/\/_next\/static\/[^"'\s)]+/);
  return match ? match[0] : null;
}

function isChunkLoadFailure(message: string): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  const nextStaticPathReferenced = normalized.includes('/_next/static/');
  const nextStaticCssFailure =
    nextStaticPathReferenced &&
    normalized.includes('.css') &&
    (normalized.includes('404') ||
      normalized.includes('net::err') ||
      normalized.includes('failed to load'));

  return (
    normalized.includes('chunkloaderror') ||
    normalized.includes('loading chunk') ||
    normalized.includes('failed to fetch dynamically imported module') ||
    (normalized.includes('/_next/static/chunks/') && normalized.includes('404')) ||
    nextStaticCssFailure
  );
}

function stringifyUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function parseLifecycleMode(value: string | null): LifecycleMode | null {
  if (value === 'active' || value === 'pregame') return value;
  return null;
}

function resolveLifecycleModeFromUrlAndStorage(): LifecycleMode {
  if (typeof window === 'undefined') return 'pregame';
  const params = new URLSearchParams(window.location.search);
  const urlMode = parseLifecycleMode(params.get('lifecycle'));
  if (urlMode) {
    window.sessionStorage.setItem(LIFECYCLE_SESSION_KEY, urlMode);
    return urlMode;
  }
  return 'pregame';
}

function getLifecycleAwareFilters(
  filters: GameFilters,
  viewMode: ViewMode,
  lifecycleMode: LifecycleMode,
): GameFilters {
  if (
    viewMode !== 'game' ||
    lifecycleMode !== 'active' ||
    'propStatGroups' in filters
  ) {
    return filters;
  }

  const statusesWithoutPass = filters.statuses.filter(
    (status) => status !== 'PASS',
  );
  const statuses: ExpressionStatus[] =
    statusesWithoutPass.length > 0 ? statusesWithoutPass : ['FIRE', 'WATCH'];

  return {
    ...filters,
    statuses,
    markets: [],
    onlyGamesWithPicks: false,
    hasClearPlay: true,
  };
}

function mapPropStatusToExpression(
  status: PropPlayRow['status'],
): ExpressionStatus {
  if (status === 'FIRE') return 'FIRE';
  if (status === 'WATCH' || status === 'HOLD') return 'WATCH';
  return 'PASS';
}

function mapPropTypeToGroup(propType: string): 'SOG' | 'PTS' | 'AST' | 'REB' | 'PRA' | 'OTHER' {
  const normalized = String(propType || '').toUpperCase();

  if (
    normalized.includes('SHOT') ||
    normalized === 'SOG' ||
    normalized.includes('GOAL')
  ) {
    return 'SOG';
  }
  if (normalized.includes('POINT')) return 'PTS';
  if (normalized.includes('ASSIST')) return 'AST';
  if (normalized.includes('REBOUND')) return 'REB';
  if (normalized.includes('PRA')) return 'PRA';

  return 'OTHER';
}

function filterPropCards(cards: PropGameCardType[], filters: GameFilters): PropGameCardType[] {
  if (!('propStatGroups' in filters)) return cards;

  const now = Date.now();

  const filteredByGame = cards
    .filter((card) => filters.sports.includes(card.sport))
    .filter((card) => {
      if (!filters.timeWindow) return true;

      const startTime = new Date(card.gameTimeUtc).getTime();

      if (filters.timeWindow === 'next_2h') {
        const twoHours = 2 * 60 * 60 * 1000;
        return startTime <= now + twoHours && startTime > now;
      }

      if (filters.timeWindow === 'today') {
        return getEtDayKey(card.gameTimeUtc) === getEtDayKey(new Date());
      }

      if (filters.timeWindow === 'custom' && filters.customTimeRange) {
        const rangeStart = new Date(filters.customTimeRange.start).getTime();
        const rangeEnd = new Date(filters.customTimeRange.end).getTime();
        return startTime >= rangeStart && startTime <= rangeEnd;
      }

      return true;
    });

  const filteredRows = filteredByGame
    .map((card) => {
      const query = filters.searchQuery.trim().toLowerCase();

      const propPlays = card.propPlays.filter((row) => {
        if (
          filters.statuses.length > 0 &&
          !filters.statuses.includes(mapPropStatusToExpression(row.status))
        ) {
          return false;
        }

        if (
          filters.propStatGroups.length > 0 &&
          !filters.propStatGroups.includes(mapPropTypeToGroup(row.propType))
        ) {
          return false;
        }

        if (!query) return true;

        const playerName = row.playerName.toLowerCase();
        const team = (row.teamAbbr || '').toLowerCase();
        const opponent = `${card.homeTeam} ${card.awayTeam}`.toLowerCase();

        if (filters.searchTarget === 'player') return playerName.includes(query);
        if (filters.searchTarget === 'team') return team.includes(query);
        return opponent.includes(query);
      });

      if (propPlays.length === 0) return null;

      const maxConfidence = Math.max(...propPlays.map((row) => row.confidence ?? 0));

      return {
        ...card,
        propPlays,
        maxConfidence,
      };
    })
    .filter((card): card is PropGameCardType => card !== null);

  return [...filteredRows].sort((a, b) => {
    if (filters.sortMode === 'start_time') {
      return new Date(a.gameTimeUtc).getTime() - new Date(b.gameTimeUtc).getTime();
    }

    if (filters.sortMode === 'odds_updated') {
      return (
        new Date(a.oddsUpdatedUtc || a.gameTimeUtc).getTime() -
        new Date(b.oddsUpdatedUtc || b.gameTimeUtc).getTime()
      );
    }

    return b.maxConfidence - a.maxConfidence;
  });
}

type FtTrendInsight = {
  advantagedTeam: string;
  disadvantagedTeam: string;
  advantagedPct: number | null;
  disadvantagedPct: number | null;
  totalLine: number | null;
};

function extractFtTrendInsight(card: GameCard): FtTrendInsight | null {
  const ftDriver = card.drivers.find(
    (driver) => driver.cardType === 'ncaam-ft-trend',
  );
  if (!ftDriver) return null;

  const context = ftDriver.ftTrendContext;

  const safeHomePct =
    typeof context?.homeFtPct === 'number' ? context.homeFtPct : null;
  const safeAwayPct =
    typeof context?.awayFtPct === 'number' ? context.awayFtPct : null;
  const safeTotalLine =
    typeof context?.totalLine === 'number' ? context.totalLine : null;

  const sideFromPct =
    safeHomePct !== null && safeAwayPct !== null
      ? safeHomePct > safeAwayPct
        ? 'HOME'
        : safeAwayPct > safeHomePct
          ? 'AWAY'
          : null
      : null;
  const resolvedSide =
    sideFromPct ??
    context?.advantagedSide ??
    (ftDriver.direction === 'HOME' || ftDriver.direction === 'AWAY'
      ? ftDriver.direction
      : null);

  if (!resolvedSide) return null;

  const homeSide = resolvedSide === 'HOME';

  return {
    advantagedTeam: homeSide ? card.homeTeam : card.awayTeam,
    disadvantagedTeam: homeSide ? card.awayTeam : card.homeTeam,
    advantagedPct: homeSide ? safeHomePct : safeAwayPct,
    disadvantagedPct: homeSide ? safeAwayPct : safeHomePct,
    totalLine: safeTotalLine,
  };
}

function formatFtTrendInsight(insight: FtTrendInsight): string {
  const ftPart =
    insight.advantagedPct !== null && insight.disadvantagedPct !== null
      ? `${insight.advantagedTeam} ${insight.advantagedPct.toFixed(1)}% vs ${insight.disadvantagedTeam} ${insight.disadvantagedPct.toFixed(1)}%`
      : `${insight.advantagedTeam} over ${insight.disadvantagedTeam}`;
  const totalPart =
    insight.totalLine !== null
      ? ` (total ${insight.totalLine.toFixed(1)})`
      : '';
  return `${ftPart}${totalPart}`;
}

export default function CardsPageClient() {
  const [games, setGames] = useState<GameData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('game');
  const [lifecycleMode, setLifecycleMode] =
    useState<LifecycleMode>('pregame');
  const [filters, setFilters] = useState<GameFilters>(
    getDefaultFilters('game'),
  );
  const isInitialLoad = useRef(true);
  const latestLifecycleModeRef = useRef<LifecycleMode>(lifecycleMode);
  const lifecycleRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [diagnosticFilter, setDiagnosticFilter] = useState<{
    sport: string;
    bucket: 'missingMapping' | 'driverLoadFailed' | 'noOdds' | 'noProjection';
  } | null>(null);
  const diagnosticsEnabled =
    process.env.NODE_ENV !== 'production' &&
    process.env.NEXT_PUBLIC_ENABLE_CARDS_DIAGNOSTICS === 'true';
  // Player props feature flag - explicit opt-in only (hidden by default)
  const propsEnabled = process.env.NEXT_PUBLIC_ENABLE_PLAYER_PROPS === 'true';
  const effectiveFilters = useMemo(
    () => getLifecycleAwareFilters(filters, viewMode, lifecycleMode),
    [filters, viewMode, lifecycleMode],
  );

  // Compute cards based on view mode
  const { enrichedCards, filteredCards, propCards, totalCardsInView } = useMemo(() => {
    if (viewMode === 'props') {
      const propGameCards = transformPropGames(games);
      const filteredPropCards = filterPropCards(propGameCards, effectiveFilters);

      // Props mode debugging
      if (process.env.NODE_ENV !== 'production') {
        console.info('[props-debug]', {
          total_prop_games: propGameCards.length,
          filtered_prop_games: filteredPropCards.length,
          total_prop_plays: propGameCards.reduce(
            (sum, g) => sum + g.propPlays.length,
            0,
          ),
          filtered_prop_plays: filteredPropCards.reduce(
            (sum, g) => sum + g.propPlays.length,
            0,
          ),
          sample_prop_game: propGameCards[0]
            ? {
                gameId: propGameCards[0].gameId,
                sport: propGameCards[0].sport,
                homeTeam: propGameCards[0].homeTeam,
                awayTeam: propGameCards[0].awayTeam,
                propPlays_count: propGameCards[0].propPlays.length,
                sample_play: propGameCards[0].propPlays[0],
              }
            : null,
        });
      }

      return {
        enrichedCards: [],
        filteredCards: [],
        propCards: filteredPropCards,
        totalCardsInView: propGameCards.length,
      };
    }

    // Game mode: existing pipeline
    const transformed = transformGames(games);
    const enriched = enrichCards(transformed);
    const filtered = applyFilters(enriched, effectiveFilters, viewMode);

    return {
      enrichedCards: enriched,
      filteredCards: filtered,
      propCards: [],
      totalCardsInView: enriched.length,
    };
  }, [games, effectiveFilters, viewMode]);

  // Group filtered game cards by ET calendar date for section headers
  const groupedByDate = useMemo(
    () => groupCardsByEtDate(filteredCards, (card) => card.startTime),
    [filteredCards],
  );

  // Group filtered prop cards by ET calendar date for section headers
  const propGroupedByDate = useMemo(
    () => groupCardsByEtDate(propCards, (card) => card.gameTimeUtc),
    [propCards],
  );

  // Projections mode: extract nhl-pace-1p plays directly from raw games,
  // bypassing the game-card pipeline which doesn't handle FIRST_PERIOD market_type.
  const projectionItems = useMemo(() => {
    if (viewMode !== 'projections') return [];
    const f = effectiveFilters as GameModeFilters;
    const todayKey = getEtDayKey(new Date());

    return games.flatMap((game) => {
      const play1p = game.plays.find((p) => p.cardType === 'nhl-pace-1p');
      if (!play1p) return [];

      // Sport filter (game.sport from API is lowercase, filter values are uppercase)
      if (f.sports.length > 0 && !f.sports.includes(game.sport.toUpperCase() as Sport)) return [];

      // Status filter (FIRE/WATCH/PASS)
      const playStatus = play1p.status as ExpressionStatus | undefined;
      if (f.statuses.length > 0 && playStatus && !f.statuses.includes(playStatus)) return [];

      // Time window filter
      if (f.timeWindow === 'today') {
        if (getEtDayKey(game.gameTimeUtc) !== todayKey) return [];
      } else if (f.timeWindow === 'next_2h') {
        const startMs = new Date(game.gameTimeUtc).getTime();
        const now = Date.now();
        if (startMs <= now || startMs > now + 2 * 60 * 60 * 1000) return [];
      } else if (f.timeWindow === 'custom' && f.customTimeRange) {
        const startMs = new Date(game.gameTimeUtc).getTime();
        const rangeStart = new Date(f.customTimeRange.start).getTime();
        const rangeEnd = new Date(f.customTimeRange.end).getTime();
        if (startMs < rangeStart || startMs > rangeEnd) return [];
      }

      return [{ game, play: play1p }];
    });
  }, [games, effectiveFilters, viewMode]);

  const displayedCardsInView =
    viewMode === 'props'
      ? propCards.length
      : viewMode === 'projections'
        ? projectionItems.length
        : filteredCards.length;

  const activeFilterCount = getActiveFilterCount(effectiveFilters, viewMode);
  const todayEtKey = useMemo(() => getEtDayKey(new Date()), []);

  const traceStats = useMemo(() => {
    const fetchedBySport = countBySport(games);
    const transformedBySport = countBySport(enrichedCards);
    const displayedBySport = countBySport(filteredCards);

    const fetchedTodayBySport = countBySport(
      games.filter((game) => getEtDayKey(game.gameTimeUtc) === todayEtKey),
    );
    const transformedTodayBySport = countBySport(
      enrichedCards.filter(
        (card) => getEtDayKey(card.startTime) === todayEtKey,
      ),
    );
    const displayedTodayBySport = countBySport(
      filteredCards.filter(
        (card) => getEtDayKey(card.startTime) === todayEtKey,
      ),
    );

    return {
      fetchedTotal: games.length,
      transformedTotal: enrichedCards.length,
      displayedTotal: filteredCards.length,
      fetchedBySport,
      transformedBySport,
      displayedBySport,
      fetchedTodayBySport,
      transformedTodayBySport,
      displayedTodayBySport,
    };
  }, [games, enrichedCards, filteredCards, todayEtKey]);

  const guardrailStats = useMemo(() => {
    const triggered: GuardrailTriggeredCounts = {
      edge_sanity_triggered: 0,
      proxy_cap_triggered: 0,
      proxy_blocked: 0,
      high_edge_non_total_blocked: 0,
      driver_load_failures: 0,
      exact_wager_mismatch: 0,
      market_price_missing: 0,
    };
    const outcome: GuardrailOutcomeCounts = {
      fire_to_watch: 0,
      watch_to_pass: 0,
      fire_to_pass: 0,
      bet_removed: 0,
    };
    const breakdownBySportMarketBook: Record<string, GuardrailBreakdownEntry> =
      {};

    for (const card of enrichedCards) {
      const play = card.play;
      const tags = play?.tags ?? [];
      const edgeTriggered = hasEdgeVerification(card);
      const proxyTriggered = hasProxyCap(card);
      const market = play?.market_type ?? play?.market ?? 'UNKNOWN';
      const book = play?.bet?.book ?? 'unknown';
      const source = play?.priceSource ?? play?.lineSource ?? 'unknown';
      const key = `${card.sport}|${market}|${book}|${source}`;

      if (!breakdownBySportMarketBook[key]) {
        breakdownBySportMarketBook[key] = {
          triggered: {
            edge_sanity_triggered: 0,
            proxy_cap_triggered: 0,
            proxy_blocked: 0,
            high_edge_non_total_blocked: 0,
            driver_load_failures: 0,
            exact_wager_mismatch: 0,
            market_price_missing: 0,
          },
          outcome: {
            fire_to_watch: 0,
            watch_to_pass: 0,
            fire_to_pass: 0,
            bet_removed: 0,
          },
        };
      }
      const bucket = breakdownBySportMarketBook[key];
      const reasonCodes = new Set([
        ...(Array.isArray(play?.reason_codes) ? play.reason_codes : []),
        ...(Array.isArray(play?.decision_v2?.price_reason_codes)
          ? play.decision_v2.price_reason_codes
          : []),
      ]);

      if (edgeTriggered) {
        triggered.edge_sanity_triggered += 1;
        bucket.triggered.edge_sanity_triggered += 1;
      }
      if (proxyTriggered) {
        triggered.proxy_cap_triggered += 1;
        bucket.triggered.proxy_cap_triggered += 1;
      }
      if (reasonCodes.has('PROXY_EDGE_BLOCKED')) {
        triggered.proxy_blocked += 1;
        bucket.triggered.proxy_blocked += 1;
      }
      if (
        reasonCodes.has('EDGE_VERIFICATION_REQUIRED') ||
        reasonCodes.has('PASS_EDGE_VERIFICATION_REQUIRED')
      ) {
        triggered.high_edge_non_total_blocked += 1;
        bucket.triggered.high_edge_non_total_blocked += 1;
      }
      if (
        reasonCodes.has('PASS_DRIVER_LOAD_FAILED') ||
        reasonCodes.has('PASS_MISSING_DRIVER_INPUTS')
      ) {
        triggered.driver_load_failures += 1;
        bucket.triggered.driver_load_failures += 1;
      }
      if (reasonCodes.has('EXACT_WAGER_MISMATCH')) {
        triggered.exact_wager_mismatch += 1;
        bucket.triggered.exact_wager_mismatch += 1;
      }
      if (
        reasonCodes.has('MARKET_PRICE_MISSING') ||
        reasonCodes.has('PASS_MARKET_PRICE_MISSING') ||
        reasonCodes.has('MISSING_DATA_NO_ODDS')
      ) {
        triggered.market_price_missing += 1;
        bucket.triggered.market_price_missing += 1;
      }

      if (tags.includes('OUTCOME_FIRE_TO_WATCH')) {
        outcome.fire_to_watch += 1;
        bucket.outcome.fire_to_watch += 1;
      }
      if (tags.includes('OUTCOME_WATCH_TO_PASS')) {
        outcome.watch_to_pass += 1;
        bucket.outcome.watch_to_pass += 1;
      }
      if (tags.includes('OUTCOME_FIRE_TO_PASS')) {
        outcome.fire_to_pass += 1;
        bucket.outcome.fire_to_pass += 1;
      }
      if (tags.includes('OUTCOME_BET_REMOVED')) {
        outcome.bet_removed += 1;
        bucket.outcome.bet_removed += 1;
      }
    }

    return { triggered, outcome, breakdownBySportMarketBook };
  }, [enrichedCards]);

  const dropTraceStats = useMemo(() => {
    const droppedByReason = createDropReasonCounts();
    const droppedByReasonBySport: Record<string, DropReasonCounts> = {};
    const droppedMetaBySport: Record<string, DroppedMeta> = {};

    for (const card of enrichedCards) {
      const flags = getFilterDebugFlags(card, effectiveFilters, viewMode);
      const passesAll = Object.values(flags).every(Boolean);
      if (passesAll) continue;

      const reason = getFirstDropReason(flags);
      bumpReason(droppedByReason, reason);

      const sportKey = (card.sport || 'UNKNOWN').toUpperCase();
      if (!droppedByReasonBySport[sportKey]) {
        droppedByReasonBySport[sportKey] = createDropReasonCounts();
      }
      bumpReason(droppedByReasonBySport[sportKey], reason);

      if (!droppedMetaBySport[sportKey]) {
        droppedMetaBySport[sportKey] = createDroppedMeta();
      }

      const meta = droppedMetaBySport[sportKey];
      const cardMeta = getCardDebugMeta(card);

      meta.games += 1;
      meta.playCount += cardMeta.playCount;
      meta.hasAnyPlay += cardMeta.hasAnyPlay ? 1 : 0;
      meta.hasBettable += cardMeta.hasBettable ? 1 : 0;
      meta.hasBlockedTotals += cardMeta.hasBlockedTotals ? 1 : 0;
      meta.hasDataError += cardMeta.hasDataError ? 1 : 0;
      meta.playStatusCounts.FIRE += cardMeta.playStatusCounts.FIRE;
      meta.playStatusCounts.WATCH += cardMeta.playStatusCounts.WATCH;
      meta.playStatusCounts.PASS += cardMeta.playStatusCounts.PASS;

      for (const market of cardMeta.playMarkets) {
        meta.playMarkets[market] = (meta.playMarkets[market] || 0) + 1;
      }
    }

    return {
      droppedByReason,
      droppedByReasonBySport,
      droppedMetaBySport,
    };
  }, [enrichedCards, effectiveFilters, viewMode]);
  type SportBuckets = {
    missingMapping: number;
    driverLoadFailed: number;
    noOdds: number;
    noProjection: number;
  };
  type SportDiagnosticsMap = Record<string, SportBuckets>;

  const sportDiagnostics = useMemo((): SportDiagnosticsMap => {
    const visibleIds = new Set(filteredCards.map((card) => card.id));
    const result: SportDiagnosticsMap = {};
    for (const card of enrichedCards) {
      if (visibleIds.has(card.id)) continue;
      const codes = card.play?.reason_codes ?? [];
      const missingInputs = card.play?.transform_meta?.missing_inputs ?? [];
      const sportKey = (card.sport || 'UNKNOWN').toUpperCase();
      if (!result[sportKey]) {
        result[sportKey] = {
          missingMapping: 0,
          driverLoadFailed: 0,
          noOdds: 0,
          noProjection: 0,
        };
      }
      const buckets = result[sportKey];
      // Priority: noOdds > missingMapping > driverLoadFailed > noProjection
      if (
        codes.includes('MISSING_DATA_NO_ODDS') ||
        missingInputs.includes('odds_timestamp')
      ) {
        buckets.noOdds += 1;
      } else if (
        codes.includes('MISSING_DATA_TEAM_MAPPING') ||
        codes.includes('MISSING_DATA_NO_PLAYS') ||
        codes.includes('PASS_MISSING_MARKET_TYPE')
      ) {
        buckets.missingMapping += 1;
      } else if (
        codes.includes('MISSING_DATA_DRIVERS') ||
        codes.includes('PASS_DATA_ERROR')
      ) {
        buckets.driverLoadFailed += 1;
      } else if (codes.includes('MISSING_DATA_PROJECTION_INPUTS')) {
        buckets.noProjection += 1;
      } else {
        buckets.noProjection += 1;
      }
    }
    return result;
  }, [enrichedCards, filteredCards]);

  const diagnosticCards = useMemo(() => {
    if (!diagnosticFilter) return [];
    const visibleIds = new Set(filteredCards.map((card) => card.id));
    return enrichedCards.filter((card) => {
      if (visibleIds.has(card.id)) return false;
      if ((card.sport || 'UNKNOWN').toUpperCase() !== diagnosticFilter.sport)
        return false;
      const codes = card.play?.reason_codes ?? [];
      const missingInputs = card.play?.transform_meta?.missing_inputs ?? [];
      switch (diagnosticFilter.bucket) {
        case 'noOdds':
          return (
            codes.includes('MISSING_DATA_NO_ODDS') ||
            missingInputs.includes('odds_timestamp')
          );
        case 'missingMapping':
          return (
            codes.includes('MISSING_DATA_TEAM_MAPPING') ||
            codes.includes('MISSING_DATA_NO_PLAYS') ||
            codes.includes('PASS_MISSING_MARKET_TYPE')
          );
        case 'driverLoadFailed':
          return (
            codes.includes('MISSING_DATA_DRIVERS') ||
            codes.includes('PASS_DATA_ERROR')
          );
        case 'noProjection':
          return (
            codes.includes('MISSING_DATA_PROJECTION_INPUTS') ||
            !codes.includes('MISSING_DATA_NO_ODDS') &&
            !missingInputs.includes('odds_timestamp') &&
            !codes.includes('MISSING_DATA_TEAM_MAPPING') &&
            !codes.includes('MISSING_DATA_NO_PLAYS') &&
            !codes.includes('PASS_MISSING_MARKET_TYPE') &&
            !codes.includes('MISSING_DATA_DRIVERS') &&
            !codes.includes('PASS_DATA_ERROR')
          );
        default:
          return false;
      }
    });
  }, [diagnosticFilter, enrichedCards, filteredCards]);

  const hiddenDataErrors = useMemo(
    () =>
      Object.values(dropTraceStats.droppedMetaBySport).reduce(
        (sum, meta) => sum + (meta?.hasDataError ?? 0),
        0,
      ),
    [dropTraceStats],
  );
  const hiddenDataErrorCards = useMemo(() => {
    const visibleIds = new Set(filteredCards.map((card) => card.id));
    return enrichedCards
      .filter((card) => {
        if (visibleIds.has(card.id)) return false;
        return Boolean(
          card.play?.transform_meta?.quality === 'BROKEN' ||
          card.play?.reason_codes?.includes('PASS_DATA_ERROR') ||
          card.play?.gates?.some((gate) => gate.code === 'PASS_DATA_ERROR'),
        );
      })
      .slice(0, 25);
  }, [enrichedCards, filteredCards]);

  const handleResetFilters = () => {
    setFilters(resetFilters(viewMode));
  };

  const handleModeChange = (nextMode: ViewMode) => {
    if (nextMode === viewMode) return;
    if (nextMode === 'props' && !propsEnabled) return;
    setViewMode(nextMode);
    setFilters((current) => {
      const defaults = getDefaultFilters(nextMode);
      return {
        ...defaults,
        sports: current.sports,
        timeWindow: current.timeWindow,
        customTimeRange: current.customTimeRange,
      };
    });
  };

  const handleLifecycleModeChange = (nextMode: LifecycleMode) => {
    if (nextMode === lifecycleMode) return;
    globalGamesLastFetchAt = 0;
    if (lifecycleRetryTimeoutRef.current) {
      clearTimeout(lifecycleRetryTimeoutRef.current);
      lifecycleRetryTimeoutRef.current = null;
    }
    setLifecycleMode(nextMode);
    setLoading(true);
  };

  useEffect(() => {
    latestLifecycleModeRef.current = lifecycleMode;
  }, [lifecycleMode]);

  useEffect(() => {
    const handleChunkFailure = (
      message: string,
      source: 'error' | 'unhandledrejection',
    ) => {
      if (!isChunkLoadFailure(message)) return;
      const chunkPath = extractChunkPath(message);
      console.error(`[${CHUNK_ERROR_LOG_CODE}]`, {
        source,
        message,
        chunk_path: chunkPath,
      });

      if (typeof window === 'undefined') return;
      const alreadyReloaded =
        window.sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY) === '1';

      if (!alreadyReloaded) {
        window.sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, '1');
        window.location.reload();
        return;
      }

      const assetSuffix = chunkPath ? ` (${chunkPath})` : '';
      setError(
        `App assets are out of date${assetSuffix}. Hard refresh required.`,
      );
      setGames([]);
    };

    const onError = (event: Event) => {
      const errorEvent = event as ErrorEvent;
      const parts = [
        errorEvent.message,
        stringifyUnknownError(errorEvent.error),
      ];
      const target = errorEvent.target;
      if (target instanceof HTMLScriptElement && target.src) {
        parts.push(target.src);
      }
      if (target instanceof HTMLLinkElement && target.href) {
        parts.push(target.href);
      }
      handleChunkFailure(parts.filter(Boolean).join(' | '), 'error');
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      handleChunkFailure(
        stringifyUnknownError(event.reason),
        'unhandledrejection',
      );
    };

    window.addEventListener('error', onError, true);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      window.removeEventListener('error', onError, true);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    latestLifecycleModeRef.current = lifecycleMode;
  }, [lifecycleMode]);

  useEffect(() => {
    let cancelled = false;

    const fetchGames = async () => {
      const now = Date.now();
      const requestedLifecycleMode = latestLifecycleModeRef.current;

      if (globalGamesFetchInFlight) {
        console.debug(
          '[cards] Skipping fetch - global request already in flight',
          {
            requestedLifecycleMode,
            inflightLifecycleMode: globalGamesRequestLifecycle,
          },
        );
        const shouldRetryForLifecycleChange =
          globalGamesRequestLifecycle !== requestedLifecycleMode;
        if (
          shouldRetryForLifecycleChange &&
          lifecycleRetryTimeoutRef.current === null
        ) {
          lifecycleRetryTimeoutRef.current = setTimeout(() => {
            lifecycleRetryTimeoutRef.current = null;
            globalGamesLastFetchAt = 0;
            void fetchGames();
          }, 150);
        }
        if (!cancelled) {
          setLoading(shouldRetryForLifecycleChange);
        }
        return;
      }

      if (globalGamesBlockedUntil > now) {
        const retryAfterSec = Math.max(
          1,
          Math.ceil((globalGamesBlockedUntil - now) / 1000),
        );
        if (!cancelled) {
          setError(
            `Server rate limited. Retrying in ${retryAfterSec} seconds...`,
          );
          setLoading(false);
        }
        return;
      }

      if (
        globalGamesLastFetchAt &&
        now - globalGamesLastFetchAt < CLIENT_MIN_FETCH_INTERVAL_MS
      ) {
        console.debug('[cards] Skipping fetch - throttled');
        if (!cancelled) {
          setLoading(false);
        }
        return;
      }

      try {
        globalGamesFetchInFlight = true;
        globalGamesRequestLifecycle = requestedLifecycleMode;
        globalGamesLastFetchAt = now;

        if (isInitialLoad.current) {
          setLoading(true);
        }

        const timeoutHandle = createTimeoutSignal(CLIENT_FETCH_TIMEOUT_MS);
        const lifecycleQuery =
          requestedLifecycleMode === 'active' ? '?lifecycle=active' : '';
        const response = await fetch(`/api/games${lifecycleQuery}`, {
          ...(timeoutHandle.signal ? { signal: timeoutHandle.signal } : {}),
          cache: 'no-store',
        }).finally(() => {
          timeoutHandle.cleanup();
        });

        if (response.status === 429) {
          const retryAfterMs =
            parseRetryAfterMs(response.headers.get('Retry-After')) ??
            CLIENT_DEFAULT_BACKOFF_MS;
          globalGamesBlockedUntil = Date.now() + retryAfterMs;
          const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
          console.warn('[cards] Rate limited, backing off', { retryAfterSec });
          if (!cancelled) {
            setError(
              `Server rate limited. Retrying in ${retryAfterSec} seconds...`,
            );
          }
          return;
        }

        globalGamesBlockedUntil = 0;
        const contentType = (
          response.headers.get('content-type') || ''
        ).toLowerCase();
        const responseText = await response.text();
        let data: ApiResponse | null = null;
        if (contentType.includes('application/json')) {
          try {
            data = JSON.parse(responseText) as ApiResponse;
          } catch {
            data = null;
          }
        }

        if (!response.ok) {
          const nonJsonDetail =
            data?.error ||
            `HTTP ${response.status} ${response.statusText}${
              responseText ? `: ${summarizeNonJsonBody(responseText)}` : ''
            }`;
          if (!cancelled) {
            setError(nonJsonDetail);
            // On background polls, preserve stale game data so the page does
            // not flash "No Play" on a transient server error. Only wipe on
            // the initial load where there is no prior state to fall back to.
            if (isInitialLoad.current) {
              setGames([]);
            }
          }
          return;
        }

        if (!data) {
          if (!cancelled) {
            setError(
              `Invalid API response format (expected JSON, got ${contentType || 'unknown content-type'})`,
            );
            if (isInitialLoad.current) {
              setGames([]);
            }
          }
          return;
        }

        if (!data.success) {
          if (!cancelled) {
            setError(data.error || 'Failed to fetch games');
            if (isInitialLoad.current) {
              setGames([]);
            }
          }
          return;
        }

        const nextGames = Array.isArray(data.data) ? data.data : [];
        const hasAnyActionableInRequestedMode = nextGames.some(hasActionablePlay);
        // Failsafe: if cards boot into active lifecycle with no actionable plays,
        // automatically fall back to pregame so /cards never appears empty-by-default.
        if (
          requestedLifecycleMode === 'active' &&
          isInitialLoad.current &&
          !hasAnyActionableInRequestedMode
        ) {
          if (!cancelled) {
            globalGamesLastFetchAt = 0;
            latestLifecycleModeRef.current = 'pregame';
            setLifecycleMode('pregame');
            setLoading(true);
          }
          return;
        }

        if (!cancelled) {
          setGames(nextGames);
          setError(null);
        }
      } catch (err) {
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.name === 'TimeoutError');
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[${FETCH_ERROR_LOG_CODE}]`, {
          message,
          error_name: err instanceof Error ? err.name : 'UnknownError',
        });
        if (!cancelled && !isAbort) {
          setError(message);
          // Same stale-data guard: preserve games on background poll errors.
          if (isInitialLoad.current) {
            setGames([]);
          }
        }
      } finally {
        globalGamesFetchInFlight = false;
        globalGamesRequestLifecycle = null;
        if (!cancelled) {
          setLoading(false);
          isInitialLoad.current = false;
        }
      }
    };

    void fetchGames();
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void fetchGames();
    }, CLIENT_POLL_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void fetchGames();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      if (lifecycleRetryTimeoutRef.current) {
        clearTimeout(lifecycleRetryTimeoutRef.current);
        lifecycleRetryTimeoutRef.current = null;
      }
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [lifecycleMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const resolvedLifecycleMode = resolveLifecycleModeFromUrlAndStorage();
    setLifecycleMode((currentMode) => {
      if (currentMode === resolvedLifecycleMode) return currentMode;
      globalGamesLastFetchAt = 0;
      latestLifecycleModeRef.current = resolvedLifecycleMode;
      setLoading(true);
      return resolvedLifecycleMode;
    });

    const modeParam = params.get('mode');
    if (modeParam === 'props' && propsEnabled) {
      setViewMode('props');
      setFilters((current) => {
        const defaults = getDefaultFilters('props');
        return {
          ...defaults,
          sports: current.sports,
          timeWindow: current.timeWindow,
          customTimeRange: current.customTimeRange,
        };
      });
    } else if (modeParam === 'projections') {
      setViewMode('projections');
      setFilters((current) => {
        const defaults = getDefaultFilters('projections');
        return {
          ...defaults,
          sports: current.sports,
          timeWindow: current.timeWindow,
          customTimeRange: current.customTimeRange,
        };
      });
    }
  }, [propsEnabled]);

  useEffect(() => {
    if (propsEnabled || viewMode !== 'props') return;
    setViewMode('game');
    setFilters(getDefaultFilters('game'));
  }, [propsEnabled, viewMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (viewMode === 'game') {
      url.searchParams.delete('mode');
    } else {
      url.searchParams.set('mode', viewMode);
    }
    if (lifecycleMode === 'pregame') {
      url.searchParams.delete('lifecycle');
    } else {
      url.searchParams.set('lifecycle', lifecycleMode);
    }
    window.sessionStorage.setItem(LIFECYCLE_SESSION_KEY, lifecycleMode);
    window.history.replaceState({}, '', url.toString());
  }, [viewMode, lifecycleMode]);

  useEffect(() => {
    const isVerboseCardsTrace =
      process.env.NEXT_PUBLIC_CARDS_TRACE_VERBOSE === 'true';
    if (loading || !diagnosticsEnabled || !isVerboseCardsTrace) return;

    const displayedMetaBySport: Record<string, DroppedMeta> = {};
    for (const card of filteredCards) {
      const sportKey = (card.sport || 'UNKNOWN').toUpperCase();
      if (!displayedMetaBySport[sportKey]) {
        displayedMetaBySport[sportKey] = createDroppedMeta();
      }

      const meta = displayedMetaBySport[sportKey];
      const cardMeta = getCardDebugMeta(card);

      meta.games += 1;
      meta.playCount += cardMeta.playCount;
      meta.hasAnyPlay += cardMeta.hasAnyPlay ? 1 : 0;
      meta.hasBettable += cardMeta.hasBettable ? 1 : 0;
      meta.hasBlockedTotals += cardMeta.hasBlockedTotals ? 1 : 0;
      meta.hasDataError += cardMeta.hasDataError ? 1 : 0;
      meta.playStatusCounts.FIRE += cardMeta.playStatusCounts.FIRE;
      meta.playStatusCounts.WATCH += cardMeta.playStatusCounts.WATCH;
      meta.playStatusCounts.PASS += cardMeta.playStatusCounts.PASS;

      for (const market of cardMeta.playMarkets) {
        meta.playMarkets[market] = (meta.playMarkets[market] || 0) + 1;
      }
    }

    console.info('[cards-trace]', {
      todayEt: todayEtKey,
      fetchedTotal: traceStats.fetchedTotal,
      transformedTotal: traceStats.transformedTotal,
      displayedTotal: traceStats.displayedTotal,
      fetchedBySport: traceStats.fetchedBySport,
      transformedBySport: traceStats.transformedBySport,
      displayedBySport: traceStats.displayedBySport,
      fetchedTodayBySport: traceStats.fetchedTodayBySport,
      transformedTodayBySport: traceStats.transformedTodayBySport,
      displayedTodayBySport: traceStats.displayedTodayBySport,
      dropTraceStats,
      displayedMetaBySport,
      guardrail_telemetry: {
        triggered: guardrailStats.triggered,
        outcome: guardrailStats.outcome,
        breakdown_by_sport_market_book:
          guardrailStats.breakdownBySportMarketBook,
      },
      filters,
    });
    console.warn(
      '[🚫 FILTERED OUT - REASONS BY SPORT]',
      dropTraceStats.droppedByReasonBySport,
    );
    console.warn(
      '[🚫 FILTERED OUT - META BY SPORT]',
      dropTraceStats.droppedMetaBySport,
    );
    console.info('[✅ DISPLAYED - META BY SPORT]', displayedMetaBySport);
  }, [
    loading,
    diagnosticsEnabled,
    traceStats,
    todayEtKey,
    filters,
    dropTraceStats,
    guardrailStats,
    enrichedCards,
    filteredCards,
    viewMode,
  ]);

  const formatDate = (dateStr: string) => {
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
  };

  const formatOddsLine = (value: number | null): string => {
    if (value === null) return '--';
    return value > 0 ? `+${value}` : `${value}`;
  };

  /**
   * Resolve the live market price from the game-level odds snapshot.
   * Preferred over the stale price embedded in a card_payload at model-run time.
   * Falls back to undefined so callers can chain to the embedded price.
   */
  const resolvePlayLivePrice = (
    marketType: string | undefined,
    selectionSide: string | undefined,
    gameOdds: GameData['odds'],
  ): number | undefined => {
    if (!gameOdds) return undefined;
    const side = selectionSide?.toUpperCase();
    if (marketType === 'MONEYLINE') {
      if (side === 'HOME' && gameOdds.h2hHome != null) return gameOdds.h2hHome;
      if (side === 'AWAY' && gameOdds.h2hAway != null) return gameOdds.h2hAway;
    }
    if (marketType === 'SPREAD' || marketType === 'PUCKLINE') {
      if (side === 'HOME' && gameOdds.spreadPriceHome != null)
        return gameOdds.spreadPriceHome;
      if (side === 'AWAY' && gameOdds.spreadPriceAway != null)
        return gameOdds.spreadPriceAway;
    }
    if (marketType === 'TOTAL') {
      if (side === 'OVER' && gameOdds.totalPriceOver != null)
        return gameOdds.totalPriceOver;
      if (side === 'UNDER' && gameOdds.totalPriceUnder != null)
        return gameOdds.totalPriceUnder;
    }
    return undefined;
  };

  /** American-odds → implied probability (no vig removed, raw conversion). */
  const impliedProbFromOdds = (americanOdds: number): number | undefined => {
    if (!Number.isFinite(americanOdds) || americanOdds === 0) return undefined;
    const p =
      americanOdds < 0
        ? -americanOdds / (-americanOdds + 100)
        : 100 / (americanOdds + 100);
    return p >= 0 && p <= 1 ? p : undefined;
  };

  const fairProbToAmericanOdds = (probability: number): number | undefined => {
    if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
      return undefined;
    }
    const odds =
      probability >= 0.5
        ? -((probability * 100) / (1 - probability))
        : ((1 - probability) * 100) / probability;
    if (!Number.isFinite(odds)) return undefined;
    return Math.round(odds);
  };

  const getTierBadge = (tier: DriverTier | null) => {
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
  };

  const getDirectionBadge = (direction: Direction) => {
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
  };

  const getPolarityBadge = (polarity: 'pro' | 'contra' | 'neutral') => {
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
  };

  const formatConfidence = (value?: number | null) => {
    if (value === null || value === undefined) return '--';
    return `${Math.round(value * 100)}%`;
  };

  const formatMarketLabel = (market: Market | 'NONE') => {
    if (market === 'ML') return 'ML';
    if (market === 'SPREAD') return 'SPREAD';
    if (market === 'TOTAL') return 'TOTAL';
    if (market === 'RISK') return 'RISK';
    if (market === 'NONE') return 'NONE';
    return market;
  };

  const formatReasonCode = (code?: string | null) => {
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
  };

  const formatSharpPriceStatus = (status?: string | null) => {
    if (status === 'CHEDDAR') return 'Priced edge';
    if (status === 'COTTAGE') return 'No edge at current price';
    if (status === 'PENDING_VERIFICATION') {
      return 'Priced, pending verification';
    }
    if (status === 'UNPRICED') return 'Unpriced';
    return status ?? 'Unpriced';
  };

  const formatSignedDecimal = (value: number, digits = 1) => {
    const fixed = value.toFixed(digits);
    return value >= 0 ? `+${fixed}` : fixed;
  };

  const formatProjectedMarginDirectional = (
    projectedMargin: number | undefined,
  ) => {
    if (typeof projectedMargin !== 'number') return 'N/A';
    return projectedMargin >= 0
      ? `+${projectedMargin.toFixed(1)}`
      : projectedMargin.toFixed(1);
  };

  const normalizeSelectionSide = (
    side: string | null | undefined,
  ): 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | undefined => {
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
  };

  const resolveProjectedValueForMarketContext = ({
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
  }): number | undefined => {
    if (marketType === 'SPREAD' || marketType === 'PUCKLINE') {
      if (typeof projectedMargin !== 'number') return undefined;
      // projectedMargin is home-margin space; convert into selected spread side space.
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
  };

  /**
   * Format the simplified projected sentence for default card edge display.
   * 
   * Rules:
   * - IF projection AND market line exist: show with percent beyond line
   * - ELSE IF projection exists: show projection only
   * - ELSE: return null (use fallback messaging)
   * 
   * Percent calculation: abs(projection - line) / abs(line) * 100
   * Percent is suppressed if NO_EDGE_AT_PRICE applies or if edge_pct is null/invalid.
   */
  const formatProjectedSentence = (
    projection: number | undefined,
    line: number | undefined,
    reasonCode: string | undefined,
    edgePctValue: number | undefined,
    marketType: string | undefined,
    projectedMargin: number | undefined,
  ): string | null => {
    // Must have projection to show anything
    if (typeof projection !== 'number') {
      return null;
    }

    const isSpreadLikeMarket =
      marketType === 'SPREAD' || marketType === 'PUCKLINE';
    const spreadProjectedLabel =
      isSpreadLikeMarket && typeof projectedMargin === 'number'
        ? `Model: ${formatProjectedMarginDirectional(projectedMargin)}`
        : `Model: ${projection.toFixed(1)}`;

    // If we have both projection and line, show signed delta vs line
    if (typeof line === 'number' && Math.abs(line) > 0.001) {
      const shouldShowDelta =
        reasonCode !== 'NO_EDGE_AT_PRICE' &&
        typeof edgePctValue === 'number' &&
        edgePctValue !== 0;

      if (shouldShowDelta) {
        const delta = projection - line;
        const deltaStr = delta >= 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
        return `${spreadProjectedLabel}  (${deltaStr} vs line)`;
      } else {
        return spreadProjectedLabel;
      }
    }

    // Only projection, no line (edge case, but graceful)
    if (typeof projection === 'number') {
      return spreadProjectedLabel;
    }

    return null;
  };

  const getMarketTypeBadge = (
    betMarketType?: string | null,
    market?: Market | 'NONE',
  ) => {
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
  };

  const formatCanonicalBetText = (
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
  ) => {
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
      const lineText =
        typeof bet.line === 'number' ? `${bet.line}` : 'Line N/A';
      return `${sideLabel} ${lineText} (${oddsText})`;
    }
    const sideLabel = bet.side.toUpperCase();
    const lineText = typeof bet.line === 'number' ? ` ${bet.line}` : '';
    return `${sideLabel}${lineText} (${oddsText})`;
  };

  const formatContributorMarketLabel = (
    driverMarket: Market,
    cardMarket: Market | 'NONE',
  ) => {
    if (driverMarket === cardMarket)
      return `${formatMarketLabel(driverMarket)} (native)`;
    if (driverMarket === 'UNKNOWN') return 'BASE (shared)';
    if (driverMarket === 'RISK') return 'RISK';
    return formatMarketLabel(driverMarket);
  };

  const driverRowKey = (driver: DriverRow) =>
    `${driver.key}-${driver.market}-${driver.direction}-${driver.cardTitle}`;

  const BUCKET_LABELS: Record<
    'missingMapping' | 'driverLoadFailed' | 'noOdds' | 'noProjection',
    string
  > = {
    missingMapping: 'Missing mapping',
    driverLoadFailed: 'Driver load failed',
    noOdds: 'No odds',
    noProjection: 'No projection',
  };

  const SportDiagnosticsPanel = ({
    diagnostics,
    onBucketClick,
  }: {
    diagnostics: SportDiagnosticsMap;
    onBucketClick: (
      sport: string,
      bucket: 'missingMapping' | 'driverLoadFailed' | 'noOdds' | 'noProjection',
    ) => void;
  }) => {
    const sportsWithBlocked = Object.entries(diagnostics).filter(
      ([, buckets]) =>
        buckets.missingMapping +
          buckets.driverLoadFailed +
          buckets.noOdds +
          buckets.noProjection >
        0,
    );
    if (sportsWithBlocked.length === 0) return null;
    const totalBlocked = sportsWithBlocked.reduce(
      (sum, [, b]) =>
        sum + b.missingMapping + b.driverLoadFailed + b.noOdds + b.noProjection,
      0,
    );
    return (
      <details className="mb-4 border-t border-white/10 pt-2">
        <summary className="cursor-pointer text-xs text-cloud/50 hover:text-cloud/70 select-none">
          Diagnostics — {totalBlocked} game{totalBlocked !== 1 ? 's' : ''}{' '}
          blocked
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs text-cloud/50">
            <thead>
              <tr>
                <th className="text-left pr-4 pb-1 font-normal">Sport</th>
                <th className="text-center px-2 pb-1 font-normal">No odds</th>
                <th className="text-center px-2 pb-1 font-normal">
                  Missing map
                </th>
                <th className="text-center px-2 pb-1 font-normal">
                  Driver failed
                </th>
                <th className="text-center px-2 pb-1 font-normal">
                  No projection
                </th>
              </tr>
            </thead>
            <tbody>
              {sportsWithBlocked.map(([sport, buckets]) => (
                <tr key={sport}>
                  <td className="pr-4 py-0.5 font-mono">{sport}</td>
                  {(
                    [
                      'noOdds',
                      'missingMapping',
                      'driverLoadFailed',
                      'noProjection',
                    ] as const
                  ).map((bucket) => (
                    <td key={bucket} className="text-center px-2 py-0.5">
                      {buckets[bucket] > 0 ? (
                        <button
                          onClick={() => onBucketClick(sport, bucket)}
                          className="underline decoration-dotted hover:text-cloud/80 tabular-nums"
                          title={`Show ${buckets[bucket]} blocked ${sport} — ${BUCKET_LABELS[bucket]}`}
                        >
                          {buckets[bucket]}
                        </button>
                      ) : (
                        <span className="text-cloud/20">—</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    );
  };

  const GameCardItem = ({
    card,
    originalGame,
  }: {
    card: (typeof filteredCards)[number];
    originalGame: GameData;
  }) => {
    const decision = useMemo(
      () =>
        card.play?.decision_v2
          ? null
          : (getCardDecisionModel(
              card,
              originalGame?.odds || null,
            ) as DecisionModel),
      [card, originalGame],
    );
    const fallbackDecision: DecisionModel =
      decision ??
      ({
        status: 'PASS',
        primaryPlay: {
          pick: 'NO PLAY',
          market: 'NONE',
          status: 'PASS',
          direction: null,
          tier: null,
          confidence: null,
          source: 'none',
        },
        whyReason: 'NO_DECISION',
        riskCodes: [],
        topContributors: [],
        allDrivers: card.drivers,
        supportGrade: 'WEAK',
        passReasonCode: 'PASS_NO_EDGE',
        spreadCompare: null,
      } as DecisionModel);

    // Prefer canonical play object from transform, fallback to decision model
    const displayPlay = card.play || {
      status: fallbackDecision.status,
      market: fallbackDecision.primaryPlay.market,
      pick: fallbackDecision.primaryPlay.pick,
      lean:
        fallbackDecision.primaryPlay.direction === 'HOME'
          ? card.homeTeam
          : fallbackDecision.primaryPlay.direction === 'AWAY'
            ? card.awayTeam
            : fallbackDecision.primaryPlay.direction || 'NO LEAN',
      side: fallbackDecision.primaryPlay.direction,
      truthStatus:
        fallbackDecision.primaryPlay.tier === 'BEST'
          ? 'STRONG'
          : fallbackDecision.primaryPlay.tier === 'SUPER'
            ? 'MEDIUM'
            : 'WEAK',
      truthStrength: fallbackDecision.primaryPlay.confidence ?? 0.5,
      conflict: 0,
      modelProb: undefined,
      impliedProb: undefined,
      edge: undefined,
      valueStatus: 'BAD',
      betAction:
        fallbackDecision.primaryPlay.pick === 'NO PLAY' ? 'NO_PLAY' : 'BET',
      priceFlags: [],
      updatedAt: card.updatedAt,
      whyCode: fallbackDecision.whyReason,
      whyText: fallbackDecision.whyReason.replace(/_/g, ' '),
      // Canonical fields (fallback from decision)
      market_key: undefined,
      decision:
        fallbackDecision.status === 'FIRE'
          ? 'FIRE'
          : fallbackDecision.status === 'WATCH'
            ? 'WATCH'
            : 'PASS',
      classificationLabel:
        fallbackDecision.status === 'FIRE'
          ? 'PLAY'
          : fallbackDecision.status === 'WATCH'
            ? 'LEAN'
            : 'NONE',
      bet: fallbackDecision.primaryPlay.pick === 'NO PLAY' ? null : undefined,
      gates: [],
      decision_data: {
        status:
          fallbackDecision.status === 'FIRE'
            ? 'FIRE'
            : fallbackDecision.status === 'WATCH'
              ? 'WATCH'
              : 'PASS',
        truth:
          fallbackDecision.primaryPlay.tier === 'BEST'
            ? 'STRONG'
            : fallbackDecision.primaryPlay.tier === 'SUPER'
              ? 'MEDIUM'
              : 'WEAK',
        value_tier: 'BAD',
        edge_pct: null,
        edge_tier: 'BAD',
        coinflip: false,
        reason_code: fallbackDecision.whyReason,
      },
      transform_meta: {
        quality: 'BROKEN',
        missing_inputs: ['play'],
        placeholders_found: [],
      },
      classification:
        fallbackDecision.status === 'FIRE'
          ? 'BASE'
          : fallbackDecision.status === 'WATCH'
            ? 'LEAN'
            : 'PASS',
      action:
        fallbackDecision.status === 'FIRE'
          ? 'FIRE'
          : fallbackDecision.status === 'WATCH'
            ? 'HOLD'
            : 'PASS',
    };
    const quality = displayPlay.transform_meta?.quality ?? 'OK';
    const isBroken = quality === 'BROKEN';
    const isDegraded = quality === 'DEGRADED';
    const decisionV2 = displayPlay.decision_v2;
    const canonicalTruePlay = originalGame?.true_play;
    const totalProjectionFallback = resolvePrimaryTotalProjectionPlay(
      originalGame?.plays || [],
      card.sport,
    );
    const totalFallbackPlay =
      !canonicalTruePlay &&
      (displayPlay.market_type === 'TOTAL' ||
        displayPlay.market_type === 'TEAM_TOTAL')
        ? totalProjectionFallback &&
          (totalProjectionFallback.market_type === 'TOTAL' ||
            totalProjectionFallback.market_type === 'TEAM_TOTAL') &&
          (typeof totalProjectionFallback.model_prob === 'number' ||
            typeof (
              totalProjectionFallback as {
                decision_v2?: { fair_prob?: number };
              }
            ).decision_v2?.fair_prob === 'number')
          ? totalProjectionFallback
          : undefined
        : undefined;
    const totalFallbackDecision = (
      totalFallbackPlay as { decision_v2?: typeof decisionV2 }
    )?.decision_v2;
    // Only substitute totalFallbackDecision when the primary play has no
    // decision_v2 at all. For wave-1 plays that have decision_v2 but a null
    // fair_prob (e.g. MODEL_PROB_MISSING), keep that decision intact so Market
    // Math either renders correctly or is suppressed — not silently replaced
    // with a different play's canonical edge data.
    const resolvedDecisionV2 =
      !decisionV2 && totalFallbackDecision
        ? totalFallbackDecision
        : decisionV2;
    const inferredDecision =
      resolvedDecisionV2?.official_status ??
      (displayPlay.decision === 'FIRE'
        ? 'PLAY'
        : displayPlay.decision === 'WATCH'
          ? 'LEAN'
          : displayPlay.action === 'FIRE'
            ? 'PLAY'
            : displayPlay.action === 'HOLD'
              ? 'LEAN'
              : 'PASS');
    const isEdgeVerification = hasEdgeVerification(card);
    const isProxyCapped = hasProxyCap(card);
    const hasCanonicalBet = Boolean(displayPlay.bet);
    const shouldPreserveNoBetLean = isEdgeVerification || isProxyCapped;
    const displayDecision =
      isBroken ||
      (!hasCanonicalBet &&
        inferredDecision !== 'PASS' &&
        !shouldPreserveNoBetLean)
        ? 'PASS'
        : inferredDecision;
    const canonicalGates = (displayPlay.gates ?? []).map((gate) => gate.code);
    const INFORMATIONAL_CODES = new Set([
      'EDGE_CLEAR', 'EDGE_FOUND_SIDE', 'EDGE_FOUND', 'BASE', 'LEAN',
    ]);
    const activeRiskCodes = Array.from(
      new Set(
        resolvedDecisionV2
          ? [
              ...canonicalGates,
              ...resolvedDecisionV2.watchdog_reason_codes,
              ...resolvedDecisionV2.price_reason_codes,
            ]
          : [...canonicalGates, ...fallbackDecision.riskCodes],
      ),
    ).filter((code) => !INFORMATIONAL_CODES.has(code));
    // Live price from the current game snapshot — keeps play odds in sync with header.
    const livePrice = resolvePlayLivePrice(
      displayPlay.market_type ?? displayPlay.bet?.market_type?.toUpperCase(),
      displayPlay.selection?.side ?? displayPlay.bet?.side?.toUpperCase(),
      originalGame.odds,
    );
    // For total-market bets, prefer the live odds line over the baked card line
    // so "BET: Over X" reflects what's actually available to bet.
    const liveTotalLine =
      displayPlay.bet?.market_type === 'total' &&
      typeof originalGame.odds?.total === 'number'
        ? originalGame.odds.total
        : undefined;
    const displayBetText = displayPlay.bet
      ? formatCanonicalBetText(
          liveTotalLine !== undefined
            ? { ...displayPlay.bet, line: liveTotalLine }
            : displayPlay.bet,
          card.homeTeam,
          card.awayTeam,
          livePrice,
        )
      : displayPlay.pick === 'NO PLAY'
        ? 'NO PLAY'
        : livePrice != null
        ? `${displayPlay.pick} (${livePrice > 0 ? '+' : ''}${livePrice})`
        : displayPlay.pick;
    const updatedTime = formatDate(displayPlay.updatedAt);
    // Prefer the game-level capturedAt (latest odds snapshot) over the stale
    // as_of_iso embedded in the card_payload at model-run time.
    const displayOddsTimestamp = originalGame.odds?.capturedAt
      ? formatDate(originalGame.odds.capturedAt)
      : displayPlay.bet?.as_of_iso
        ? formatDate(displayPlay.bet.as_of_iso)
        : updatedTime;
    const canRenderModelSummary = !isBroken && card.drivers.length > 0;
    const ftTrendInsight =
      card.sport === 'NCAAM' && displayPlay.market_type === 'SPREAD'
        ? extractFtTrendInsight(card)
        : null;
    const isFtTrendSpread = Boolean(ftTrendInsight);
    const effectiveEdgePct =
      typeof resolvedDecisionV2?.edge_pct === 'number'
        ? resolvedDecisionV2.edge_pct
        : typeof displayPlay.decision_data?.edge_pct === 'number'
          ? displayPlay.decision_data.edge_pct
          : typeof displayPlay.edge === 'number'
            ? displayPlay.edge
            : undefined;
    const hasMarketSpecificEdge = typeof effectiveEdgePct === 'number';
    const primaryReasonCode =
      resolvedDecisionV2?.primary_reason_code ??
      displayPlay.pass_reason_code ??
      displayPlay.decision_data?.reason_code ??
      displayPlay.whyCode;
    const isNoEdgeAtPrice =
      primaryReasonCode === 'NO_EDGE_AT_PRICE' ||
      (hasMarketSpecificEdge && Math.abs(effectiveEdgePct) < 0.0005);
    const hasActionableEdge = hasMarketSpecificEdge && !isNoEdgeAtPrice;
    const marketType = displayPlay.market_type;
    const isSpreadLikeMarket =
      marketType === 'SPREAD' || marketType === 'PUCKLINE';
    const isTotalLikeMarket =
      marketType === 'TOTAL' || marketType === 'TEAM_TOTAL';
    const projectedMargin =
      typeof displayPlay.projectedMargin === 'number'
        ? displayPlay.projectedMargin
        : undefined;
    const projectedSpreadHome =
      typeof projectedMargin === 'number' ? -1 * projectedMargin : undefined;
    const nhlDecisionProjectionPlay =
      card.sport === 'NHL'
        ? originalGame.plays.find(
            (play) => isFullGameTotalsCallPlay(play) && hasProjectedTotal(play),
          )
        : undefined;
    const projectedTotal =
      card.sport === 'NHL' &&
      typeof nhlDecisionProjectionPlay?.projectedTotal === 'number'
        ? nhlDecisionProjectionPlay.projectedTotal
        : typeof displayPlay.projectedTotal === 'number'
          ? displayPlay.projectedTotal
          : typeof totalFallbackPlay?.projectedTotal === 'number'
            ? totalFallbackPlay.projectedTotal
            : undefined;
    const onePeriodTotalsPlay = originalGame.plays.find(
      (p) => p.cardType === 'nhl-pace-1p',
    );
    const projectedTotal1p =
      typeof onePeriodTotalsPlay?.projectedTotal === 'number'
        ? onePeriodTotalsPlay.projectedTotal
        : undefined;
    const reasonCodes1p = Array.isArray(onePeriodTotalsPlay?.reason_codes)
      ? onePeriodTotalsPlay.reason_codes
      : [];
    const onePModelCall =
      onePeriodTotalsPlay?.one_p_model_call ??
      deriveOnePModelCallFromReasons(
        reasonCodes1p,
        onePeriodTotalsPlay?.prediction,
      );
    const goalieUncertain1p = reasonCodes1p.includes('NHL_1P_GOALIE_UNCERTAIN');
    const goalieContextNames = [
      onePeriodTotalsPlay?.goalie_away_name,
      onePeriodTotalsPlay?.goalie_home_name,
    ].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    const goalieContextStatuses = [
      onePeriodTotalsPlay?.goalie_away_status,
      onePeriodTotalsPlay?.goalie_home_status,
    ].filter(
      (
        value,
      ): value is NonNullable<GameData['plays'][number]['goalie_home_status']> =>
        typeof value === 'string' && value.length > 0,
    );
    const onePeriodMarketLine =
      typeof onePeriodTotalsPlay?.line === 'number'
        ? onePeriodTotalsPlay.line
        : 1.5;
    const edgePoints1p =
      typeof onePeriodTotalsPlay?.edge === 'number'
        ? onePeriodTotalsPlay.edge
        : typeof projectedTotal1p === 'number' &&
            typeof onePeriodMarketLine === 'number'
          ? Number((projectedTotal1p - onePeriodMarketLine).toFixed(2))
          : undefined;
    const resolvedModelProb =
      typeof displayPlay.modelProb === 'number'
        ? displayPlay.modelProb
        : typeof resolvedDecisionV2?.fair_prob === 'number'
          ? resolvedDecisionV2.fair_prob
          : typeof totalFallbackPlay?.model_prob === 'number'
            ? totalFallbackPlay.model_prob
            : undefined;
    const resolvedImpliedProb =
      typeof displayPlay.impliedProb === 'number'
        ? displayPlay.impliedProb
        : typeof resolvedDecisionV2?.implied_prob === 'number'
          ? resolvedDecisionV2.implied_prob
          : // Only infer from live price for non-wave-1 plays (no decision_v2).
            // For wave-1 plays, decision_v2.implied_prob is the canonical source;
            // absence means the market math section should not be shown.
            !decisionV2 && livePrice != null
            ? impliedProbFromOdds(livePrice)
            : undefined;
    const mlBreakEvenPrice =
      typeof resolvedModelProb === 'number'
        ? fairProbToAmericanOdds(resolvedModelProb)
        : undefined;
    const projectedTeamTotal =
      typeof displayPlay.projectedTeamTotal === 'number'
        ? displayPlay.projectedTeamTotal
        : undefined;
    const projectedScoreHome =
      typeof displayPlay.projectedScoreHome === 'number'
        ? displayPlay.projectedScoreHome
        : undefined;
    const projectedScoreAway =
      typeof displayPlay.projectedScoreAway === 'number'
        ? displayPlay.projectedScoreAway
        : undefined;
    const bakedLine =
      typeof displayPlay.line === 'number' ? displayPlay.line : undefined;
    // For total-market cards, prefer the live odds line so edge % and delta
    // reflect the current market, not the stale value baked at model-run time.
    const marketLine =
      isTotalLikeMarket && typeof originalGame.odds?.total === 'number'
        ? originalGame.odds.total
        : bakedLine;
    const lineMoved =
      isTotalLikeMarket &&
      typeof bakedLine === 'number' &&
      typeof originalGame.odds?.total === 'number' &&
      Math.abs(originalGame.odds.total - bakedLine) >= 0.5;
    const projectedLineValue =
      typeof projectedTeamTotal === 'number'
        ? projectedTeamTotal
        : typeof projectedTotal === 'number'
          ? projectedTotal
          : undefined;
    const edgePoints =
      card.sport === 'NHL' && isTotalLikeMarket
        ? typeof projectedLineValue === 'number' && typeof marketLine === 'number'
          ? Number((projectedLineValue - marketLine).toFixed(2))
          : undefined
        : typeof displayPlay.edgePoints === 'number'
          ? displayPlay.edgePoints
          : typeof projectedLineValue === 'number' && typeof marketLine === 'number'
            ? Number((projectedLineValue - marketLine).toFixed(2))
            : undefined;
    const displaySelectionSide = normalizeSelectionSide(
      displayPlay.selection?.side ?? displayPlay.bet?.side ?? displayPlay.side,
    );
    const isMoneylineMarket = marketType === 'MONEYLINE';
    const hasEdgeMathContext =
      typeof resolvedModelProb === 'number' &&
      typeof resolvedImpliedProb === 'number' &&
      hasMarketSpecificEdge &&
      primaryReasonCode !== 'EXACT_WAGER_MISMATCH';
    const hasSpreadContext =
      isSpreadLikeMarket &&
      (typeof projectedMargin === 'number' ||
        typeof edgePoints === 'number' ||
        typeof marketLine === 'number');
    const shouldRenderSpreadContext = hasSpreadContext && !isFtTrendSpread;
    const hasTotalContext =
      isTotalLikeMarket &&
      (typeof projectedTotal === 'number' ||
        typeof projectedTeamTotal === 'number' ||
        typeof edgePoints === 'number' ||
        typeof marketLine === 'number');
    const hasOnePeriodTotalContext =
      typeof projectedTotal1p === 'number' ||
      typeof edgePoints1p === 'number' ||
      typeof onePModelCall === 'string';
    const hasMlContext =
      isMoneylineMarket &&
      (hasEdgeMathContext ||
        typeof livePrice === 'number' ||
        typeof mlBreakEvenPrice === 'number');
    const sharpVerdict = decisionV2?.sharp_price_status;
    const modelLean = decisionV2?.direction;
    const isCoinflip = Boolean(
      canRenderModelSummary && displayPlay.decision_data?.coinflip,
    );
    const isCoinflipHighEdge =
      isCoinflip && hasActionableEdge && effectiveEdgePct > 0.05;
    const isCoinflipLowEdge =
      isCoinflip && (!hasActionableEdge || effectiveEdgePct <= 0.05);
    const [showAllDrivers, setShowAllDrivers] = useState(false);
    const storageKey = `cheddar-card-show-drivers:${card.id}`;

    useEffect(() => {
      if (typeof window === 'undefined') return;
      const stored = window.sessionStorage.getItem(storageKey);
      if (stored !== null) {
        setShowAllDrivers(stored === 'true');
      }
    }, [storageKey]);

    const toggleDrivers = () => {
      setShowAllDrivers((prev) => {
        const next = !prev;
        if (typeof window !== 'undefined') {
          window.sessionStorage.setItem(storageKey, String(next));
        }
        return next;
      });
    };

    const gameTime = formatDate(card.startTime);
    const displayStatus =
      originalGame.display_status ??
      (originalGame.lifecycle_mode === 'active' ? 'ACTIVE' : 'SCHEDULED');
    const showActiveBadge = displayStatus === 'ACTIVE';
    const hasVisibleBetOdds = Boolean(
      displayPlay.bet &&
        Number.isFinite(
          typeof livePrice === 'number' ? livePrice : displayPlay.bet.odds_american,
        ),
    );
    const isProjectionOnlyCard =
      displayPlay.market_type === 'FIRST_PERIOD' ||
      displayPlay.market_type === 'INFO' ||
      displayPlay.market_type === 'PROP';
    const isActionableDecision =
      displayDecision === 'PLAY' || displayDecision === 'LEAN';
    const shouldDemoteForMissingOdds =
      isActionableDecision && !hasVisibleBetOdds && !isProjectionOnlyCard;
    const visibleDecision = shouldDemoteForMissingOdds ? 'PASS' : displayDecision;
    const visibleVerdict = getDisplayVerdict(visibleDecision);
    const visibleStatusLabel = visibleVerdict ? visibleVerdict.label : visibleDecision;
    const visibleBetText = shouldDemoteForMissingOdds ? 'NO PLAY' : displayBetText;
    const projectedValue = resolveProjectedValueForMarketContext({
      marketType,
      selectionSide: displaySelectionSide,
      projectedMargin,
      projectedTotal,
      projectedTeamTotal,
    });
    const projectedSentence =
      isSpreadLikeMarket || isTotalLikeMarket
        ? formatProjectedSentence(
            projectedValue,
            marketLine,
            primaryReasonCode,
            effectiveEdgePct,
            marketType,
            projectedMargin,
          )
        : null;
    const contextLine1 =
      projectedSentence ||
      (hasActionableEdge && primaryReasonCode !== 'EXACT_WAGER_MISMATCH'
        ? `Edge: ${(effectiveEdgePct * 100).toFixed(1)}% | Tier: ${
            decisionV2?.play_tier ??
            displayPlay.decision_data?.edge_tier ??
            displayPlay.valueStatus
          }`
        : isNoEdgeAtPrice
          ? `No edge at current price | Tier: ${
              decisionV2?.play_tier ??
              displayPlay.decision_data?.edge_tier ??
              displayPlay.valueStatus
            }`
          : 'No market-specific edge available');
    const baseDriverLine =
      primaryReasonCode && !INFORMATIONAL_CODES.has(primaryReasonCode)
        ? formatReasonCode(primaryReasonCode)
        : canRenderModelSummary
          ? (() => {
              const whyCode = displayPlay.whyCode;
              if (whyCode && INFORMATIONAL_CODES.has(whyCode)) {
                return displayPlay.whyText || null;
              }
              return displayPlay.whyText || (whyCode ? formatReasonCode(whyCode) : null);
            })()
          : 'Analysis unavailable (drivers missing).';
    const contextLine2 = baseDriverLine
      ? `Driver: ${baseDriverLine}`
      : activeRiskCodes.length > 0
        ? `Risk: ${formatReasonCode(activeRiskCodes[0])}`
        : null;
    const showMathDetails =
      canRenderModelSummary &&
      (shouldRenderSpreadContext ||
        hasTotalContext ||
        hasOnePeriodTotalContext ||
        hasMlContext ||
        hasEdgeMathContext);
    const hasDriverDetails = decisionV2
      ? decisionV2.driver_reasons.length > 0
      : fallbackDecision.topContributors.length > 0;
    const hasMissingInputDetails =
      (!decisionV2 &&
        (isBroken || isDegraded) &&
        (displayPlay.transform_meta?.missing_inputs?.length ?? 0) > 0) ||
      Boolean(decisionV2 && decisionV2.missing_data.missing_fields.length > 0);
    const showPassDetail = visibleDecision === 'PASS' && Boolean(decisionV2);
    const showAdvancedRisk =
      activeRiskCodes.length > 0 ||
      isCoinflipHighEdge ||
      isCoinflipLowEdge ||
      fallbackDecision.spreadCompare !== undefined;
    const hasDetails =
      showMathDetails ||
      hasDriverDetails ||
      hasMissingInputDetails ||
      showPassDetail ||
      showAdvancedRisk ||
      Boolean(displayOddsTimestamp) ||
      Boolean(updatedTime) ||
      Boolean(ftTrendInsight);

    return (
      <div
        key={card.id}
        className="border border-white/10 rounded-lg p-4 bg-surface/30 hover:bg-surface/50 transition"
      >
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <h3 className="font-semibold text-lg">
                {card.awayTeam} @ {card.homeTeam}
              </h3>
              <span className="px-2 py-1 text-xs font-semibold bg-white/10 text-cloud/80 rounded border border-white/20">
                {card.sport}
              </span>
              {showActiveBadge && (
                <span className="px-2 py-1 text-xs font-semibold bg-blue-600/40 text-blue-200 rounded border border-blue-600/60">
                  {displayStatus}
                </span>
              )}
            </div>
            <div className="text-sm text-cloud/70">
              <span>{gameTime}</span>
            </div>
            {originalGame.odds && (
              <p className="mt-1 text-xs text-cloud/55 font-mono">
                ML: {formatOddsLine(originalGame.odds.h2hHome)} /{' '}
                {formatOddsLine(originalGame.odds.h2hAway)}{' '}
                {typeof originalGame.odds.total === 'number'
                  ? `| O/U ${originalGame.odds.total}`
                  : ''}
              </p>
            )}
          </div>
        </div>

        <div className="border-t border-white/5 mt-3 pt-3 space-y-3">
          <div className="rounded-md border border-white/10 bg-white/5 p-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                {getMarketTypeBadge(
                  displayPlay.bet?.market_type,
                  displayPlay.market,
                )}
                <span
                  className={`px-2 py-1 text-xs font-bold rounded border ${
                    visibleDecision === 'PLAY'
                      ? 'bg-green-700/50 text-green-200 border-green-600/60'
                      : visibleDecision === 'LEAN'
                        ? 'bg-yellow-700/50 text-yellow-200 border-yellow-600/60'
                        : 'bg-slate-700/50 text-slate-200 border-slate-600/60'
                  }`}
                >
                  {visibleStatusLabel}
                </span>
                {isDegraded && (
                  <span className="px-2 py-0.5 text-xs font-semibold rounded border bg-amber-700/30 text-amber-200 border-amber-600/50">
                    Degraded
                  </span>
                )}
                {isBroken && (
                  <span className="px-2 py-0.5 text-xs font-semibold rounded border bg-red-700/30 text-red-200 border-red-600/50">
                    Data issue
                  </span>
                )}
              </div>
            </div>
            <p className="mt-2 text-xl font-bold text-cloud">{visibleBetText}</p>
            <p className="mt-1 text-xs text-cloud/65">{contextLine1}</p>
          </div>

          {contextLine2 && (
            <div className="rounded-md border border-white/10 bg-white/5 p-3">
              <p className="text-sm text-cloud/80">{contextLine2}</p>
            </div>
          )}

          {hasDetails && (
            <details className="rounded-md border border-white/10 bg-white/5 p-3">
              <summary className="cursor-pointer text-xs uppercase tracking-widest text-cloud/45 font-semibold select-none">
                Details
              </summary>
              <div className="mt-2 space-y-3">
                {showMathDetails && (
                  <div className="space-y-1 text-xs font-mono text-cloud/65">
                    {shouldRenderSpreadContext && (
                      <p>
                        Model spread (home):{' '}
                        <span className="text-cloud/90 font-bold">
                          {typeof projectedSpreadHome === 'number'
                            ? formatSignedDecimal(projectedSpreadHome)
                            : 'N/A'}
                        </span>{' '}
                        | Market line:{' '}
                        <span className="text-cloud/90 font-bold">
                          {typeof marketLine === 'number'
                            ? formatSignedDecimal(marketLine)
                            : 'N/A'}
                        </span>{' '}
                        | Delta:{' '}
                        <span className="text-cloud/90 font-bold">
                          {typeof edgePoints === 'number'
                            ? `${formatSignedDecimal(edgePoints)} pts`
                            : 'N/A'}
                        </span>
                      </p>
                    )}
                    {hasTotalContext && (
                      <p>
                        Model total:{' '}
                        <span className="text-cloud/90 font-bold">
                          {typeof projectedTeamTotal === 'number'
                            ? projectedTeamTotal.toFixed(1)
                            : typeof projectedTotal === 'number'
                              ? projectedTotal.toFixed(1)
                              : 'N/A'}
                        </span>{' '}
                        | Market line:{' '}
                        <span className="text-cloud/90 font-bold">
                          {typeof marketLine === 'number'
                            ? marketLine.toFixed(1)
                            : 'N/A'}
                        </span>{' '}
                        | Delta:{' '}
                        <span className="text-cloud/90 font-bold">
                          {typeof edgePoints === 'number'
                            ? `${formatSignedDecimal(edgePoints)} pts`
                            : 'N/A'}
                        </span>
                      </p>
                    )}
                    {hasMlContext && (
                      <p>
                        Fair:{' '}
                        <span className="text-cloud/90 font-bold">
                          {typeof mlBreakEvenPrice === 'number'
                            ? `${mlBreakEvenPrice > 0 ? '+' : ''}${mlBreakEvenPrice}`
                            : 'N/A'}
                        </span>{' '}
                        vs{' '}
                        <span className="text-cloud/90 font-bold">
                          {typeof livePrice === 'number'
                            ? `${livePrice > 0 ? '+' : ''}${Math.trunc(livePrice)}`
                            : 'N/A'}
                        </span>
                      </p>
                    )}
                    {hasOnePeriodTotalContext && (
                      <div className="space-y-1">
                        <p>
                          1P projection:{' '}
                          <span className="text-cloud/90 font-bold">
                            {typeof projectedTotal1p === 'number'
                              ? projectedTotal1p.toFixed(2)
                              : 'N/A'}
                          </span>{' '}
                          | 1P call:{' '}
                          <span className="text-cloud/90 font-bold">
                            {onePModelCall ?? 'PASS'}
                          </span>
                        </p>
                        <p>
                          Goalie context:{' '}
                          <span className="text-cloud/90 font-bold">
                            {goalieContextNames.length > 0
                              ? goalieContextNames.join(' / ')
                              : goalieUncertain1p
                                ? 'Uncertain (PASS-capped)'
                                : 'Stable'}
                          </span>
                          {goalieContextStatuses.length > 0 && (
                            <>
                              {' '}
                              | Status:{' '}
                              <span className="text-cloud/90 font-bold">
                                {goalieContextStatuses.join(' / ')}
                              </span>
                            </>
                          )}
                        </p>
                      </div>
                    )}
                    {typeof projectedScoreHome === 'number' &&
                      typeof projectedScoreAway === 'number' && (
                        <p>
                          Projected score: {card.awayTeam}{' '}
                          {projectedScoreAway.toFixed(1)} - {card.homeTeam}{' '}
                          {projectedScoreHome.toFixed(1)}
                        </p>
                      )}
                    {lineMoved && typeof bakedLine === 'number' && (
                      <p className="text-amber-300">
                        Line moved since model run (was {bakedLine.toFixed(1)})
                      </p>
                    )}
                    {isEdgeVerification && hasEdgeMathContext && (
                      <p className="text-amber-300">
                        Edge verification required on non-total market.
                      </p>
                    )}
                  </div>
                )}

                {showPassDetail && (
                  <div className="text-xs text-cloud/70 space-y-1">
                    <p>
                      Model direction:{' '}
                      <span className="text-cloud/90 font-semibold">
                        {isFtTrendSpread
                          ? `Take ${ftTrendInsight?.advantagedTeam ?? 'better FT% team'} spread`
                          : (modelLean ?? 'NONE')}
                      </span>
                    </p>
                    <p>
                      Pricing Status:{' '}
                      <span className="text-cloud/90 font-semibold">
                        {formatSharpPriceStatus(sharpVerdict)}
                      </span>
                    </p>
                    <p>
                      Reason:{' '}
                      <span className="text-cloud/90 font-semibold">
                        {formatReasonCode(primaryReasonCode)}
                      </span>
                    </p>
                  </div>
                )}

                {hasDriverDetails && (
                  <div className="space-y-2">
                    {decisionV2 ? (
                      decisionV2.driver_reasons.map((reason, index) => (
                        <div
                          key={`${card.id}-indicator-${index}`}
                          className="bg-white/5 rounded-md px-3 py-2"
                        >
                          <p className="text-xs text-cloud/55 leading-snug">{reason}</p>
                        </div>
                      ))
                    ) : (
                      fallbackDecision.topContributors.map(({ driver, polarity }) => (
                        <div
                          key={driverRowKey(driver)}
                          className="bg-white/5 rounded-md px-3 py-2"
                        >
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            {getPolarityBadge(polarity)}
                            {getTierBadge(driver.tier)}
                            {getDirectionBadge(driver.direction)}
                            <span className="text-xs font-mono text-cloud/60">
                              {formatConfidence(driver.confidence)}
                            </span>
                            <span className="text-xs font-mono text-cloud/60">
                              {formatContributorMarketLabel(
                                driver.market,
                                displayPlay.market,
                              )}
                            </span>
                            <span className="text-xs text-cloud/70 font-medium">
                              {driver.cardTitle}
                            </span>
                          </div>
                          <p className="text-xs text-cloud/50 leading-snug">{driver.note}</p>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {showAdvancedRisk && (
                  <div className="space-y-2">
                    {activeRiskCodes.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {activeRiskCodes.map((code) => (
                          <span
                            key={code}
                            className="px-2 py-0.5 text-xs font-semibold rounded border bg-amber-700/30 text-amber-200 border-amber-600/50"
                          >
                            {formatReasonCode(code)}
                          </span>
                        ))}
                      </div>
                    )}
                    {isCoinflipHighEdge && (
                      <p className="text-xs text-blue-200/80">
                        Coinflip inefficiency: model fair probability diverges from current
                        market pricing.
                      </p>
                    )}
                    {isCoinflipLowEdge && (
                      <p className="text-xs text-cloud/55">
                        Near-even matchup with minimal edge; variance can flip outcomes.
                      </p>
                    )}
                    {fallbackDecision.spreadCompare && (
                      <p className="text-xs font-mono text-cloud/65">
                        Spread compare: proj{' '}
                        {fallbackDecision.spreadCompare.projectedSpread !== null
                          ? formatSignedDecimal(fallbackDecision.spreadCompare.projectedSpread)
                          : 'N/A'}{' '}
                        vs market{' '}
                        {fallbackDecision.spreadCompare.marketLine !== null
                          ? formatSignedDecimal(fallbackDecision.spreadCompare.marketLine)
                          : 'N/A'}
                      </p>
                    )}
                    {activeRiskCodes.length > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={toggleDrivers}
                          className="text-xs text-cloud/60 hover:text-cloud underline underline-offset-4"
                        >
                          {showAllDrivers ? 'Hide all drivers' : 'Show all drivers'}
                        </button>
                        {showAllDrivers && (
                          <div className="space-y-2">
                            {fallbackDecision.allDrivers.map((driver) => (
                              <div
                                key={`all-${driverRowKey(driver)}`}
                                className="bg-white/5 rounded-md px-3 py-2"
                              >
                                <div className="flex items-center gap-2 flex-wrap mb-1">
                                  {getTierBadge(driver.tier)}
                                  {getDirectionBadge(driver.direction)}
                                  <span className="text-xs font-mono text-cloud/60">
                                    {formatMarketLabel(driver.market)}
                                  </span>
                                  <span className="text-xs font-mono text-cloud/60">
                                    {formatConfidence(driver.confidence)}
                                  </span>
                                  <span className="text-xs text-cloud/70 font-medium">
                                    {driver.cardTitle}
                                  </span>
                                </div>
                                <p className="text-xs text-cloud/50 leading-snug">
                                  {driver.note}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {hasMissingInputDetails && (
                  <p className="text-xs text-amber-200/90">
                    Missing inputs:{' '}
                    {decisionV2
                      ? decisionV2.missing_data.missing_fields.join(', ')
                      : displayPlay.transform_meta?.missing_inputs.join(', ')}
                  </p>
                )}

                {ftTrendInsight && (
                  <p className="text-xs text-cloud/60">
                    FT context: {formatFtTrendInsight(ftTrendInsight)}
                  </p>
                )}

                <p className="text-xs text-cloud/45">
                  Odds updated {displayOddsTimestamp} | Card updated {updatedTime}
                </p>
              </div>
            </details>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-night text-cloud px-6 py-12">
      <StickyBackButton
        fallbackHref="/"
        fallbackLabel="Home"
        showAfterPx={120}
      />

      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <Link
            href="/"
            className="hidden text-sm text-cloud/60 hover:text-cloud/80 md:inline-flex"
          >
            ← Back to Home
          </Link>
        </div>

        <div className="mb-8 space-y-2">
          <h1 className="text-4xl font-bold">🧀 The Cheddar Board 🧀</h1>
          <p className="text-cloud/70">
            {totalCardsInView} game{totalCardsInView !== 1 ? 's' : ''}{' '}
            total, showing {displayedCardsInView} (updates in background every
            60s)
          </p>
          {!loading && !error && diagnosticsEnabled && viewMode === 'game' && (
            <p className="text-xs text-cloud/60">
              Guardrails: edge verification{' '}
              {guardrailStats.triggered.edge_sanity_triggered} • proxy capped{' '}
              {guardrailStats.triggered.proxy_cap_triggered} • proxy blocked{' '}
              {guardrailStats.triggered.proxy_blocked} • exact wager mismatch{' '}
              {guardrailStats.triggered.exact_wager_mismatch} • market price
              missing {guardrailStats.triggered.market_price_missing}
            </p>
          )}
          {!loading && !error && diagnosticsEnabled && (
            <div className="rounded-lg border border-white/10 bg-surface/30 px-3 py-2 text-xs text-cloud/70 space-y-1">
              <p>
                Trace (all): fetched {traceStats.fetchedTotal} (
                {formatSportCounts(traceStats.fetchedBySport)}) → transformed{' '}
                {traceStats.transformedTotal} (
                {formatSportCounts(traceStats.transformedBySport)}) → displayed{' '}
                {traceStats.displayedTotal} (
                {formatSportCounts(traceStats.displayedBySport)})
              </p>
              <p>
                Trace (today ET {todayEtKey}): fetched (
                {formatSportCounts(traceStats.fetchedTodayBySport)}) →
                transformed (
                {formatSportCounts(traceStats.transformedTodayBySport)}) →
                displayed ({formatSportCounts(traceStats.displayedTodayBySport)}
                )
              </p>
              <p>
                Filter drops: status{' '}
                {dropTraceStats.droppedByReason.DROP_NO_BETTABLE_STATUS} •
                market {dropTraceStats.droppedByReason.DROP_MARKET_NOT_ALLOWED}{' '}
                • time {dropTraceStats.droppedByReason.DROP_TIME_WINDOW} • data
                errors {hiddenDataErrors}
              </p>
              <p>
                Guardrails (triggered): edge{' '}
                {guardrailStats.triggered.edge_sanity_triggered} • proxy{' '}
                {guardrailStats.triggered.proxy_cap_triggered} • proxy blocked{' '}
                {guardrailStats.triggered.proxy_blocked} • high-edge blocked{' '}
                {guardrailStats.triggered.high_edge_non_total_blocked} • driver
                load fail {guardrailStats.triggered.driver_load_failures} •
                exact wager mismatch{' '}
                {guardrailStats.triggered.exact_wager_mismatch} • market price
                missing {guardrailStats.triggered.market_price_missing}
              </p>
              <p>
                Guardrails (outcome): PLAY→LEAN{' '}
                {guardrailStats.outcome.fire_to_watch} • LEAN→PASS{' '}
                {guardrailStats.outcome.watch_to_pass} • PLAY→PASS{' '}
                {guardrailStats.outcome.fire_to_pass} • bet removed{' '}
                {guardrailStats.outcome.bet_removed}
              </p>
            </div>
          )}
          {!loading && !error && diagnosticsEnabled && hiddenDataErrors > 0 && (
            <details className="rounded-md border border-amber-600/50 bg-amber-700/20 px-3 py-2 text-xs text-amber-100">
              <summary className="cursor-pointer font-semibold">
                {hiddenDataErrors} game{hiddenDataErrors !== 1 ? 's' : ''}{' '}
                excluded due to incomplete data
              </summary>
              {hiddenDataErrorCards.length > 0 && (
                <div className="mt-2 space-y-1">
                  {hiddenDataErrorCards.map((card) => (
                    <div
                      key={`hidden-error-${card.id}`}
                      className="rounded bg-amber-900/20 px-2 py-1"
                    >
                      <span className="font-semibold">
                        {card.awayTeam} @ {card.homeTeam}
                      </span>
                      <span className="text-amber-200/90">
                        {' '}
                        · {formatDate(card.startTime)}
                      </span>
                      {card.play?.transform_meta?.missing_inputs?.length ? (
                        <span className="text-amber-200/90">
                          {' '}
                          · missing:{' '}
                          {card.play.transform_meta.missing_inputs.join(', ')}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </details>
          )}
        </div>

        <div className="mb-6 flex flex-wrap items-center gap-2">
          <button
            onClick={() => handleLifecycleModeChange('pregame')}
            className={`px-4 py-2 rounded-md border text-sm font-semibold transition ${
              lifecycleMode === 'pregame'
                ? 'bg-blue-700/40 text-blue-100 border-blue-600/60'
                : 'bg-white/5 text-cloud/70 border-white/10 hover:border-white/20'
            }`}
          >
            Pre-Game
          </button>
          <button
            onClick={() => handleLifecycleModeChange('active')}
            className={`px-4 py-2 rounded-md border text-sm font-semibold transition ${
              lifecycleMode === 'active'
                ? 'bg-blue-700/40 text-blue-100 border-blue-600/60'
                : 'bg-white/5 text-cloud/70 border-white/10 hover:border-white/20'
            }`}
          >
            Active
          </button>
          <span className="mx-1 h-6 w-px bg-white/15" aria-hidden="true" />
          <button
            onClick={() => handleModeChange('game')}
            className={`px-4 py-2 rounded-md border text-sm font-semibold transition ${
              viewMode === 'game'
                ? 'bg-emerald-700/50 text-emerald-100 border-emerald-600/60'
                : 'bg-white/5 text-cloud/70 border-white/10 hover:border-white/20'
            }`}
          >
            Game Lines
          </button>
          {propsEnabled && (
            <button
              onClick={() => handleModeChange('props')}
              className={`px-4 py-2 rounded-md border text-sm font-semibold transition ${
                viewMode === 'props'
                  ? 'bg-emerald-700/50 text-emerald-100 border-emerald-600/60'
                  : 'bg-white/5 text-cloud/70 border-white/10 hover:border-white/20'
              }`}
            >
              Player Props
            </button>
          )}
          <button
            onClick={() => handleModeChange('projections')}
            className={`px-4 py-2 rounded-md border text-sm font-semibold transition ${
              viewMode === 'projections'
                ? 'bg-emerald-700/50 text-emerald-100 border-emerald-600/60'
                : 'bg-white/5 text-cloud/70 border-white/10 hover:border-white/20'
            }`}
          >
            1P Projections
          </button>
        </div>

        {/* Filter Panel */}
        <FilterPanel
          filters={filters}
          viewMode={viewMode}
          onFiltersChange={setFilters}
          onReset={handleResetFilters}
          activeCount={activeFilterCount}
        />

        {loading && (
          <div className="text-center py-8 text-cloud/60">Loading games...</div>
        )}

        {error && (
          <div className="mb-6 p-4 bg-red-900/20 border border-red-700 rounded-lg text-red-200">
            Error: {error}
          </div>
        )}

        {!loading &&
          diagnosticsEnabled &&
          viewMode === 'game' &&
          !error &&
          enrichedCards.length > 0 && (
            <SportDiagnosticsPanel
              diagnostics={sportDiagnostics}
              onBucketClick={(sport, bucket) =>
                setDiagnosticFilter((prev) =>
                  prev?.sport === sport && prev?.bucket === bucket
                    ? null
                    : { sport, bucket },
                )
              }
            />
          )}

        {!loading &&
          diagnosticsEnabled &&
          viewMode === 'game' &&
          diagnosticFilter && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-white/10 bg-surface/40 px-3 py-1.5 text-xs text-cloud/70">
              <span>
                Showing {diagnosticCards.length} blocked{' '}
                {diagnosticFilter.sport} games
                {' — '}
                {BUCKET_LABELS[diagnosticFilter.bucket]}
              </span>
              <button
                onClick={() => setDiagnosticFilter(null)}
                className="ml-auto text-cloud/40 hover:text-cloud/70"
                aria-label="Dismiss diagnostic filter"
              >
                ✕
              </button>
            </div>
          )}

        {!loading &&
          ((viewMode === 'props' && propCards.length === 0) ||
            (viewMode === 'projections' && projectionItems.length === 0) ||
            (viewMode === 'game' && filteredCards.length === 0)) &&
          !error && (
            <div className="text-center py-8 space-y-4">
              <div className="text-cloud/60">
                {viewMode === 'props'
                  ? 'No qualified props match your filters'
                  : viewMode === 'projections'
                    ? 'No 1P projections match your filters'
                    : 'No games match your filters'}
              </div>
              {diagnosticsEnabled &&
                viewMode === 'game' &&
                enrichedCards.length > 0 && (
                  <div className="mt-2 text-left mx-auto max-w-sm text-xs text-cloud/40 space-y-1">
                    <div className="font-semibold text-cloud/50 mb-1">
                      {enrichedCards.length} game
                      {enrichedCards.length !== 1 ? 's' : ''} excluded —
                      breakdown by sport:
                    </div>
                    {Object.entries(sportDiagnostics)
                      .filter(
                        ([, b]) =>
                          b.missingMapping +
                            b.driverLoadFailed +
                            b.noOdds +
                            b.noProjection >
                          0,
                      )
                      .map(([sport, b]) => (
                        <div key={sport} className="flex gap-2 font-mono">
                          <span className="w-16">{sport}</span>
                          {b.noOdds > 0 && <span>no-odds:{b.noOdds}</span>}
                          {b.missingMapping > 0 && (
                            <span>no-map:{b.missingMapping}</span>
                          )}
                          {b.driverLoadFailed > 0 && (
                            <span>driver-fail:{b.driverLoadFailed}</span>
                          )}
                          {b.noProjection > 0 && (
                            <span>no-proj:{b.noProjection}</span>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              {activeFilterCount > 0 && (
                <button
                  onClick={handleResetFilters}
                  className="px-4 py-2 rounded-lg border border-white/20 hover:border-white/40 hover:bg-surface/50 transition"
                >
                  Clear All Filters
                </button>
              )}
            </div>
          )}

        {!loading && viewMode === 'props' && propGroupedByDate.length > 0 && (
          <div className="space-y-4">
            {propGroupedByDate.map(({ dateKey, label, cards: groupCards }) => (
              <div key={dateKey}>
                <div className="text-xs font-semibold text-cloud/50 uppercase tracking-wider px-1 pb-2 pt-1 border-b border-white/10 mb-3">
                  {label}
                </div>
                <div className="space-y-4">
                  {groupCards.map((card) => (
                    <PropGameCard key={card.gameId} card={card} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && viewMode === 'projections' && projectionItems.length > 0 && (
          <div className="space-y-4">
            {projectionItems.map(({ game, play }) => (
              <ProjectionCard
                key={`${game.gameId}-1p`}
                homeTeam={game.homeTeam}
                awayTeam={game.awayTeam}
                startTime={game.gameTimeUtc}
                play={play}
              />
            ))}
          </div>
        )}

        {!loading && viewMode === 'game' && groupedByDate.length > 0 && (
          <div className="space-y-4">
            {groupedByDate.map(({ dateKey, label, cards: groupCards }) => (
              <div key={dateKey}>
                <div className="text-xs font-semibold text-cloud/50 uppercase tracking-wider px-1 pb-2 pt-1 border-b border-white/10 mb-3">
                  {label}
                </div>
                <div className="space-y-4">
                  {groupCards.map((card) => {
                    const originalGame = games.find((game) => game.gameId === card.gameId);
                    if (!originalGame) return null;
                    return <GameCardItem key={card.id} card={card} originalGame={originalGame} />;
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading &&
          diagnosticsEnabled &&
          viewMode === 'game' &&
          diagnosticFilter &&
          diagnosticCards.length > 0 && (
            <div className="mt-6 space-y-2">
              <div className="text-xs text-cloud/40 border-t border-white/10 pt-3 mb-2">
                Blocked games — {BUCKET_LABELS[diagnosticFilter.bucket]}
              </div>
              {diagnosticCards.map((card) => {
                const codes = card.play?.reason_codes ?? [];
                const badge = codes
                  .filter(
                    (c) =>
                      c.startsWith('MISSING_DATA') ||
                      c.startsWith('PASS_DATA') ||
                      c.startsWith('PASS_DRIVER') ||
                      c.startsWith('PASS_MISSING_DRIVER') ||
                      c.startsWith('PASS_NO_PRIMARY') ||
                      c.startsWith('PASS_MARKET_PRICE') ||
                      c.startsWith('PASS_MISSING') ||
                      c === 'PASS_NO_QUALIFIED_PLAYS',
                  )
                  .join(', ');
                return (
                  <div
                    key={`diag-${card.id}`}
                    className="flex items-center gap-3 rounded-md border border-white/5 bg-surface/20 px-3 py-2 opacity-60 text-xs"
                  >
                    <span className="text-cloud/50 font-medium">
                      {card.awayTeam} @ {card.homeTeam}
                    </span>
                    {badge && (
                      <span className="ml-auto font-mono text-amber-400/70 text-[10px]">
                        {badge}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
      </div>
    </div>
  );
}
