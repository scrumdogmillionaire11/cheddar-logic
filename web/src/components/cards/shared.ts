'use client';

import { getFilterDebugFlags } from '@/lib/game-card/filters';
import { getPlayDisplayAction } from '@/lib/game-card/decision';
import type { GameFilters, ViewMode } from '@/lib/game-card/filters';
import { GAME_TAGS } from '@/lib/types/game-card';
import { isNflSeason } from '@/lib/game-card/season-gates';
import type { GameCard, PropPlayRow } from '@/lib/types/game-card';
import type {
  ApiResponse,
  DateCardGroup,
  DropReason,
  DropReasonCounts,
  DroppedMeta,
  GameData,
  GuardrailBreakdownEntry,
  GuardrailOutcomeCounts,
  GuardrailTriggeredCounts,
  LifecycleMode,
  PlayStatusCounts,
  SportCountMap,
} from './types';

export const TRACKED_SPORTS = isNflSeason()
  ? ['NBA', 'NHL', 'MLB', 'NFL']
  : ['NBA', 'NHL', 'MLB'];

export const DROP_REASONS: DropReason[] = [
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

export const CLIENT_POLL_INTERVAL_MS = 60_000;
export const CLIENT_MIN_FETCH_INTERVAL_MS = 5_000;
export const CLIENT_FETCH_TIMEOUT_MS = 30_000;
export const CLIENT_DEFAULT_BACKOFF_MS = 30_000;
export const LIFECYCLE_SESSION_KEY = 'cheddar_cards_lifecycle_mode';
export const CHUNK_ERROR_LOG_CODE = 'CARDS_CHUNK_LOAD_FAILED';
export const FETCH_ERROR_LOG_CODE = 'CARDS_FETCH_FAILED';

export const BUCKET_LABELS: Record<
  'missingMapping' | 'driverLoadFailed' | 'noOdds' | 'noProjection',
  string
> = {
  missingMapping: 'Missing mapping',
  driverLoadFailed: 'Driver load failed',
  noOdds: 'No odds',
  noProjection: 'No projection',
};

export function createEmptySportCounts(): SportCountMap {
  return TRACKED_SPORTS.reduce<SportCountMap>((acc, sport) => {
    acc[sport] = 0;
    return acc;
  }, {});
}

export function countBySport(items: Array<{ sport: string }>): SportCountMap {
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

export function createDropReasonCounts(): DropReasonCounts {
  return DROP_REASONS.reduce<DropReasonCounts>((acc, reason) => {
    acc[reason] = 0;
    return acc;
  }, {} as DropReasonCounts);
}

export function createPlayStatusCounts(): PlayStatusCounts {
  return { FIRE: 0, WATCH: 0, PASS: 0 };
}

export function createDroppedMeta(): DroppedMeta {
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

export function bumpReason(counts: DropReasonCounts, reason: DropReason) {
  counts[reason] = (counts[reason] || 0) + 1;
}

export function getFirstDropReason(
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
  if (!flags.minEdge) return 'DROP_MIN_EDGE';
  return 'DROP_UNKNOWN';
}

export function getCardDebugMeta(card: GameCard) {
  const playStatusCounts = createPlayStatusCounts();
  const displayAction = getPlayDisplayAction(card.play);
  if (displayAction) {
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

export function getEtDayKey(dateInput: Date | string): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function groupCardsByEtDate<T>(
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

export function formatSportCounts(counts: SportCountMap): string {
  const base = TRACKED_SPORTS.map(
    (sport) => `${sport} ${counts[sport] || 0}`,
  ).join(' | ');
  return counts.OTHER ? `${base} | OTHER ${counts.OTHER}` : base;
}

export function hasProjectedTotal(
  play: GameData['plays'][number] | undefined,
): play is GameData['plays'][number] {
  return typeof play?.projectedTotal === 'number';
}

export function isFullGameTotalsCallPlay(
  play: GameData['plays'][number],
): boolean {
  const cardType = String(play.cardType || '').toLowerCase();
  return (
    !cardType.includes('1p') &&
    !cardType.includes('first-period') &&
    cardType.includes('totals-call')
  );
}

export function resolvePrimaryTotalProjectionPlay(
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

export function deriveOnePModelCallFromReasons(
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

export function hasActionablePlay(game: GameData): boolean {
  if (!Array.isArray(game.plays) || game.plays.length === 0) return false;
  return game.plays.some((play) => {
    const kind = (play.kind ?? 'PLAY') === 'PLAY';
    const side = play.selection?.side?.toUpperCase() ?? '';
    const hasSelection = side !== '' && side !== 'NONE';
    const hasNonNeutralPrediction = play.prediction !== 'NEUTRAL';
    return kind && hasSelection && hasNonNeutralPrediction;
  });
}

export function parseRetryAfterMs(retryAfterHeader: string | null): number | null {
  if (!retryAfterHeader) return null;

  const numeric = Number(retryAfterHeader.trim());
  if (Number.isFinite(numeric)) {
    if (numeric > 1_000_000_000) {
      return Math.max(0, numeric * 1000 - Date.now());
    }
    return Math.max(0, numeric * 1000);
  }

  const asDate = Date.parse(retryAfterHeader);
  if (!Number.isFinite(asDate)) return null;
  return Math.max(0, asDate - Date.now());
}

export function summarizeNonJsonBody(bodyText: string): string {
  const compact = bodyText.replace(/\s+/g, ' ').trim();
  if (!compact) return 'empty response body';
  return compact.length > 120 ? `${compact.slice(0, 120)}...` : compact;
}

export function parseLifecycleMode(value: string | null): LifecycleMode | null {
  if (value === 'active' || value === 'pregame') return value;
  return null;
}

export function resolveLifecycleModeFromUrlAndStorage(): LifecycleMode {
  if (typeof window === 'undefined') return 'pregame';
  const params = new URLSearchParams(window.location.search);
  const urlMode = parseLifecycleMode(params.get('lifecycle'));
  if (urlMode) {
    window.sessionStorage.setItem(LIFECYCLE_SESSION_KEY, urlMode);
    return urlMode;
  }
  return 'pregame';
}

export function getLifecycleAwareFilters(
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
  const statuses: ('FIRE' | 'WATCH')[] =
    statusesWithoutPass.length > 0 ? statusesWithoutPass : ['FIRE', 'WATCH'];

  return {
    ...filters,
    statuses,
    markets: [],
    onlyGamesWithPicks: false,
    hasClearPlay: true,
  };
}

export function mapPropStatusToExpression(
  status: PropPlayRow['status'],
): 'FIRE' | 'WATCH' | 'PASS' {
  if (status === 'FIRE') return 'FIRE';
  if (status === 'WATCH' || status === 'HOLD') return 'WATCH';
  return 'PASS';
}

export function mapPropTypeToGroup(
  propType: string,
): 'SOG' | 'PTS' | 'AST' | 'REB' | 'PRA' | 'K' | 'OTHER' {
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
  if (normalized.includes('STRIKEOUT') || normalized === 'K') return 'K';

  return 'OTHER';
}

export function filterPropCards(
  cards: import('./types').PropGameCardType[],
  filters: import('./types').GameFilters,
) {
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
    .filter((card): card is import('./types').PropGameCardType => card !== null);

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

export function createGuardrailBreakdownEntry(): GuardrailBreakdownEntry {
  return {
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

export type {
  ApiResponse,
  DropReason,
  DropReasonCounts,
  DroppedMeta,
  GameData,
  GuardrailOutcomeCounts,
  GuardrailTriggeredCounts,
  LifecycleMode,
  PlayStatusCounts,
};
