'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import FilterPanel from './filter-panel';
import { transformGames, transformPropGames } from '@/lib/game-card/transform';
import { enrichCards } from '@/lib/game-card/tags';
import {
  applyFilters,
  getActiveFilterCount,
  getDefaultFilters,
  getFilterDebugFlags,
  resetFilters,
} from '@/lib/game-card/filters';
import PropGameCard from './prop-game-card';
import type { GameFilters, ViewMode } from '@/lib/game-card/filters';
import type {
  Direction,
  DriverRow,
  DriverTier,
  GameCard,
  Market,
  SupportGrade,
  PassReasonCode,
  SpreadCompare,
} from '@/lib/types/game-card';
import { GAME_TAGS } from '@/lib/types/game-card';
import {
  getPlayDisplayAction,
  getCardDecisionModel,
} from '@/lib/game-card/decision';
import { StickyBackButton } from '@/components/sticky-back-button';

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
  }>;
  consistency?: {
    total_bias?:
      | 'OK'
      | 'INSUFFICIENT_DATA'
      | 'CONFLICTING_SIGNALS'
      | 'VOLATILE_ENV'
      | 'UNKNOWN';
  };
}

interface ApiResponse {
  success: boolean;
  data: GameData[];
  error?: string;
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
    market: Market;
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
const CLIENT_FETCH_TIMEOUT_MS = 10_000;
const CLIENT_DEFAULT_BACKOFF_MS = 30_000;

let globalGamesFetchInFlight = false;
let globalGamesLastFetchAt = 0;
let globalGamesBlockedUntil = 0;

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

export default function CardsPageClient() {
  const [games, setGames] = useState<GameData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('game');
  const [filters, setFilters] = useState<GameFilters>(
    getDefaultFilters('game'),
  );
  const isInitialLoad = useRef(true);
  const [diagnosticFilter, setDiagnosticFilter] = useState<{
    sport: string;
    bucket: 'missingMapping' | 'driverLoadFailed' | 'noOdds' | 'noProjection';
  } | null>(null);
  const showTrace =
    process.env.NODE_ENV !== 'production' ||
    process.env.NEXT_PUBLIC_CARDS_TRACE === 'true';
  // Player props feature flag - explicit opt-in only (hidden by default)
  const propsEnabled = process.env.NEXT_PUBLIC_ENABLE_PLAYER_PROPS === 'true';

  // Compute cards based on view mode
  const { enrichedCards, filteredCards, propCards } = useMemo(() => {
    if (viewMode === 'props') {
      // Props mode: use transformPropGames, no enrichment/filters yet
      const propGameCards = transformPropGames(games);

      // Props mode debugging
      if (process.env.NODE_ENV !== 'production') {
        console.info('[props-debug]', {
          total_prop_games: propGameCards.length,
          total_prop_plays: propGameCards.reduce(
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

      return { enrichedCards: [], filteredCards: [], propCards: propGameCards };
    }

    // Game mode: existing pipeline
    const transformed = transformGames(games);
    const enriched = enrichCards(transformed);
    const filtered = applyFilters(enriched, filters, viewMode);

    return { enrichedCards: enriched, filteredCards: filtered, propCards: [] };
  }, [games, filters, viewMode]);

  const activeFilterCount = getActiveFilterCount(filters, viewMode);
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

  const dropTraceStats = useMemo(() => {
    const droppedByReason = createDropReasonCounts();
    const droppedByReasonBySport: Record<string, DropReasonCounts> = {};
    const droppedMetaBySport: Record<string, DroppedMeta> = {};

    for (const card of enrichedCards) {
      const flags = getFilterDebugFlags(card, filters, viewMode);
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
  }, [enrichedCards, filters, viewMode]);
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
        codes.includes('MISSING_DATA_NO_PLAYS') ||
        codes.includes('PASS_MISSING_MARKET_TYPE')
      ) {
        buckets.missingMapping += 1;
      } else if (
        codes.includes('MISSING_DATA_DRIVERS') ||
        codes.includes('PASS_DATA_ERROR')
      ) {
        buckets.driverLoadFailed += 1;
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
      if ((card.sport || 'UNKNOWN').toUpperCase() !== diagnosticFilter.sport) return false;
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
            !codes.includes('MISSING_DATA_NO_ODDS') &&
            !missingInputs.includes('odds_timestamp') &&
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

  useEffect(() => {
    let cancelled = false;

    const fetchGames = async () => {
      const now = Date.now();

      if (globalGamesFetchInFlight) {
        console.debug(
          '[cards] Skipping fetch - global request already in flight',
        );
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
        }
        return;
      }

      if (
        globalGamesLastFetchAt &&
        now - globalGamesLastFetchAt < CLIENT_MIN_FETCH_INTERVAL_MS
      ) {
        console.debug('[cards] Skipping fetch - throttled');
        return;
      }

      try {
        globalGamesFetchInFlight = true;
        globalGamesLastFetchAt = now;

        if (isInitialLoad.current) {
          setLoading(true);
        }

        const response = await fetch('/api/games', {
          signal: AbortSignal.timeout(CLIENT_FETCH_TIMEOUT_MS),
          cache: 'no-store',
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
              responseText
                ? `: ${summarizeNonJsonBody(responseText)}`
                : ''
            }`;
          if (!cancelled) {
            setError(nonJsonDetail);
            setGames([]);
          }
          return;
        }

        if (!data) {
          if (!cancelled) {
            setError(
              `Invalid API response format (expected JSON, got ${contentType || 'unknown content-type'})`,
            );
            setGames([]);
          }
          return;
        }

        if (!data.success) {
          if (!cancelled) {
            setError(data.error || 'Failed to fetch games');
            setGames([]);
          }
          return;
        }

        if (!cancelled) {
          setGames(data.data || []);
          setError(null);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        if (!cancelled && message !== 'The operation was aborted') {
          setError(message);
          setGames([]);
        }
      } finally {
        globalGamesFetchInFlight = false;
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
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
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
    window.history.replaceState({}, '', url.toString());
  }, [viewMode]);

  useEffect(() => {
    const isDevTrace = process.env.NODE_ENV !== 'production';
    const isVerboseCardsTrace =
      process.env.NEXT_PUBLIC_CARDS_TRACE_VERBOSE === 'true';
    if (loading || !isDevTrace || !isVerboseCardsTrace) return;

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

    // DEBUG: Sample NBA plays to understand why they're PASS/not bettable
    const nbaSample = enrichedCards
      .filter((c) => c.sport === 'NBA')
      .flatMap((c) => {
        const displayAction = getPlayDisplayAction(c.play);
        const hasBettable =
          c.tags.includes(GAME_TAGS.HAS_FIRE) ||
          c.tags.includes(GAME_TAGS.HAS_WATCH);
        // Only sample plays that are PASS or not bettable
        if (displayAction === 'PASS' || !hasBettable) {
          return [
            {
              gameId: c.gameId,
              homeTeam: c.homeTeam,
              awayTeam: c.awayTeam,
              playMarket: c.play?.market_type,
              action: c.play?.action,
              status: c.play?.status,
              classification: c.play?.classification,
              displayAction,
              hasBettable,
              truthStrength: c.play?.truthStrength,
              edge: c.play?.edge,
              line: c.play?.line,
              price: c.play?.price,
              updatedAt: c.play?.updatedAt,
              reasonCodes: c.play?.reason_codes,
              tags: c.play?.tags,
              driverCount: c.drivers.length,
              driverMarkets: c.drivers.map((d) => d.market).join(','),
              modelProb: c.play?.modelProb,
              impliedProb: c.play?.impliedProb,
            },
          ];
        }
        return [];
      })
      .slice(0, 10);

    if (nbaSample.length > 0) {
      console.log('[NBA FILTERED OUT SAMPLE (PASS or not bettable)]', nbaSample);
    }

    const nbaDisplayedSample = filteredCards
      .filter((c) => c.sport === 'NBA')
      .flatMap((c) => {
        const displayAction = getPlayDisplayAction(c.play);
        const hasBettable =
          c.tags.includes(GAME_TAGS.HAS_FIRE) ||
          c.tags.includes(GAME_TAGS.HAS_WATCH);

        if (displayAction === 'FIRE' || displayAction === 'HOLD' || hasBettable) {
          return [
            {
              gameId: c.gameId,
              homeTeam: c.homeTeam,
              awayTeam: c.awayTeam,
              playMarket: c.play?.market_type,
              action: c.play?.action,
              status: c.play?.status,
              classification: c.play?.classification,
              displayAction,
              hasBettable,
              truthStrength: c.play?.truthStrength,
              edge: c.play?.edge,
              line: c.play?.line,
              price: c.play?.price,
              updatedAt: c.play?.updatedAt,
              reasonCodes: c.play?.reason_codes,
              tags: c.play?.tags,
              driverCount: c.drivers.length,
              driverMarkets: c.drivers.map((d) => d.market).join(','),
              modelProb: c.play?.modelProb,
              impliedProb: c.play?.impliedProb,
            },
          ];
        }
        return [];
      })
      .slice(0, 10);

    if (nbaDisplayedSample.length > 0) {
      console.log('[NBA DISPLAYED SAMPLE (FIRE/WATCH/bettable)]', nbaDisplayedSample);
    }
  }, [
    loading,
    traceStats,
    todayEtKey,
    filters,
    dropTraceStats,
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

  const getTierBadge = (tier: DriverTier | null) => {
    switch (tier) {
      case 'SUPER':
        return (
          <span className="px-2 py-0.5 text-xs font-bold bg-green-700/50 text-green-300 rounded border border-green-600/60">
            SUPER
          </span>
        );
      case 'BEST':
        return (
          <span className="px-2 py-0.5 text-xs font-bold bg-blue-700/50 text-blue-300 rounded border border-blue-600/60">
            BEST
          </span>
        );
      case 'WATCH':
        return (
          <span className="px-2 py-0.5 text-xs font-bold bg-yellow-700/50 text-yellow-300 rounded border border-yellow-600/60">
            WATCH
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

  const formatBetMarketLabel = (marketType?: string) => {
    if (!marketType) return null;
    if (marketType === 'moneyline') return 'ML';
    if (marketType === 'spread') return 'SPREAD';
    if (marketType === 'total') return 'TOTAL';
    if (marketType === 'team_total') return 'TT';
    if (marketType === 'player_prop') return 'PROP';
    return marketType.toUpperCase();
  };

  const getMarketTypeBadge = (betMarketType?: string | null, market?: Market | 'NONE') => {
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
  ) => {
    if (!bet) return 'NO PLAY';
    const oddsText =
      bet.odds_american > 0 ? `+${bet.odds_american}` : `${bet.odds_american}`;
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

  const getStatusBadge = (status: 'FIRE' | 'WATCH' | 'PASS') => {
    const colorMap = {
      FIRE: 'bg-green-700/50 text-green-200 border-green-600/60',
      WATCH: 'bg-yellow-700/50 text-yellow-200 border-yellow-600/60',
      PASS: 'bg-slate-700/50 text-slate-200 border-slate-600/60',
    };
    return (
      <span
        className={`px-2 py-1 text-xs font-bold rounded border ${colorMap[status]}`}
      >
        {status}
      </span>
    );
  };

  const formatPriceFlagLabel = (flag: string) => {
    const labels: Record<string, string> = {
      PRICE_TOO_STEEP: 'Price Too Steep',
      COINFLIP: 'Coinflip Zone',
      CHASED_LINE: 'Chased Line',
      VIG_HEAVY: 'Vig Heavy',
    };
    return labels[flag] || flag.replace(/_/g, ' ');
  };

  const getPriceFlagClass = (flag: string) => {
    if (flag === 'COINFLIP') {
      return 'bg-blue-700/30 text-blue-200 border-blue-600/50';
    }

    return 'bg-amber-700/30 text-amber-200 border-amber-600/50';
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
          Diagnostics — {totalBlocked} game{totalBlocked !== 1 ? 's' : ''} blocked
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs text-cloud/50">
            <thead>
              <tr>
                <th className="text-left pr-4 pb-1 font-normal">Sport</th>
                <th className="text-center px-2 pb-1 font-normal">No odds</th>
                <th className="text-center px-2 pb-1 font-normal">Missing map</th>
                <th className="text-center px-2 pb-1 font-normal">Driver failed</th>
                <th className="text-center px-2 pb-1 font-normal">No projection</th>
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
        getCardDecisionModel(card, originalGame?.odds || null) as DecisionModel,
      [card, originalGame],
    );

    // Prefer canonical play object from transform, fallback to decision model
    const displayPlay = card.play || {
      status: decision.status,
      market: decision.primaryPlay.market,
      pick: decision.primaryPlay.pick,
      lean:
        decision.primaryPlay.direction === 'HOME'
          ? card.homeTeam
          : decision.primaryPlay.direction === 'AWAY'
            ? card.awayTeam
            : decision.primaryPlay.direction || 'NO LEAN',
      side: decision.primaryPlay.direction,
      truthStatus:
        decision.primaryPlay.tier === 'BEST'
          ? 'STRONG'
          : decision.primaryPlay.tier === 'SUPER'
            ? 'MEDIUM'
            : 'WEAK',
      truthStrength: decision.primaryPlay.confidence ?? 0.5,
      conflict: 0,
      modelProb: undefined,
      impliedProb: undefined,
      edge: undefined,
      valueStatus: 'BAD',
      betAction: decision.primaryPlay.pick === 'NO PLAY' ? 'NO_PLAY' : 'BET',
      priceFlags: [],
      updatedAt: card.updatedAt,
      whyCode: decision.whyReason,
      whyText: decision.whyReason.replace(/_/g, ' '),
      // Canonical fields (fallback from decision)
      market_key: undefined,
      decision:
        decision.status === 'FIRE'
          ? 'FIRE'
          : decision.status === 'WATCH'
            ? 'WATCH'
            : 'PASS',
      classificationLabel:
        decision.status === 'FIRE'
          ? 'PLAY'
          : decision.status === 'WATCH'
            ? 'LEAN'
            : 'NONE',
      bet: decision.primaryPlay.pick === 'NO PLAY' ? null : undefined,
      gates: [],
      decision_data: {
        status:
          decision.status === 'FIRE'
            ? 'FIRE'
            : decision.status === 'WATCH'
              ? 'WATCH'
              : 'PASS',
        truth:
          decision.primaryPlay.tier === 'BEST'
            ? 'STRONG'
            : decision.primaryPlay.tier === 'SUPER'
              ? 'MEDIUM'
              : 'WEAK',
        value_tier: 'BAD',
        edge_pct: null,
        edge_tier: 'BAD',
        coinflip: false,
        reason_code: decision.whyReason,
      },
      transform_meta: {
        quality: 'BROKEN',
        missing_inputs: ['play'],
        placeholders_found: [],
      },
      classification:
        decision.status === 'FIRE'
          ? 'BASE'
          : decision.status === 'WATCH'
            ? 'LEAN'
            : 'PASS',
      action:
        decision.status === 'FIRE'
          ? 'FIRE'
          : decision.status === 'WATCH'
            ? 'HOLD'
            : 'PASS',
    };
    const quality = displayPlay.transform_meta?.quality ?? 'OK';
    const isBroken = quality === 'BROKEN';
    const isDegraded = quality === 'DEGRADED';
    const inferredDecision =
      displayPlay.decision ??
      (displayPlay.action === 'FIRE'
        ? 'FIRE'
        : displayPlay.action === 'HOLD'
          ? 'WATCH'
          : 'PASS');
    const displayDecision = isBroken ? 'PASS' : inferredDecision;
    const canonicalGates = (displayPlay.gates ?? []).map((gate) => gate.code);
    const activeRiskCodes = Array.from(
      new Set([...canonicalGates, ...decision.riskCodes]),
    );
    const hasActiveTotalBet =
      displayPlay.bet?.market_type === 'total' && displayDecision === 'FIRE';
    const displayBetText = displayPlay.bet
      ? formatCanonicalBetText(displayPlay.bet, card.homeTeam, card.awayTeam)
      : displayPlay.pick;
    const displayMarketText =
      formatBetMarketLabel(displayPlay.bet?.market_type) ??
      displayPlay.market_key ??
      formatMarketLabel(displayPlay.market);
    const updatedTime = formatDate(displayPlay.updatedAt);
    const displayOddsTimestamp = displayPlay.bet?.as_of_iso
      ? formatDate(displayPlay.bet.as_of_iso)
      : updatedTime;
    const canRenderModelSummary = !isBroken && card.drivers.length > 0;
    const effectiveEdgePct =
      typeof displayPlay.decision_data?.edge_pct === 'number'
        ? displayPlay.decision_data.edge_pct
        : (displayPlay.edge ?? 0);
    const isCoinflip = Boolean(canRenderModelSummary && displayPlay.decision_data?.coinflip);
    const isCoinflipHighEdge = isCoinflip && effectiveEdgePct > 0.05;
    const isCoinflipLowEdge = isCoinflip && effectiveEdgePct <= 0.05;

    const [showAllDrivers, setShowAllDrivers] = useState(false);
    const blockedTotals = hasActiveTotalBet
      ? []
      : (originalGame.plays || []).filter((play) => {
          if (play.kind !== 'PLAY') return false;
          if (play.market_type !== 'TOTAL') return false;
          const blockedByReason =
            play.reason_codes?.includes('PASS_TOTAL_INSUFFICIENT_DATA') ||
            play.tags?.includes('CONSISTENCY_BLOCK_TOTALS');
          const blockedByStatus =
            play.action === 'PASS' || play.status === 'PASS';
          return Boolean(blockedByReason || blockedByStatus);
        });
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
    const isNotScheduled = card.status && card.status !== 'scheduled';

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
              {isNotScheduled && (
                <span className="px-2 py-1 text-xs font-semibold bg-blue-600/40 text-blue-200 rounded border border-blue-600/60">
                  {card.status}
                </span>
              )}
              {getStatusBadge(
                displayDecision === 'WATCH' ? 'WATCH' : displayDecision,
              )}
            </div>
            <div className="text-sm text-cloud/70">
              <span>{gameTime}</span>
            </div>
          </div>
        </div>

        <div className="border-t border-white/5 pt-3">
          {originalGame.odds ? (
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-cloud/50 text-xs mb-1">Moneyline</p>
                <p className="font-mono text-cloud/80">
                  {(() => {
                    const homeMascot = card.homeTeam.split(' ').slice(-1)[0];
                    const awayMascot = card.awayTeam.split(' ').slice(-1)[0];
                    const useFullNames = homeMascot === awayMascot;
                    const homeDisplay = useFullNames ? card.homeTeam : homeMascot;
                    const awayDisplay = useFullNames ? card.awayTeam : awayMascot;
                    return `${homeDisplay} ${formatOddsLine(originalGame.odds.h2hHome)} / ${awayDisplay} ${formatOddsLine(originalGame.odds.h2hAway)}`;
                  })()}
                </p>
              </div>
              <div>
                <p className="text-cloud/50 text-xs mb-1">Total</p>
                <p className="font-mono text-cloud/80">
                  {originalGame.odds.total !== null
                    ? `O/U ${originalGame.odds.total}`
                    : '--'}
                </p>
                {(() => {
                  const totalPlay = originalGame.plays.find(
                    (p) =>
                      p.cardType === 'nba-total-projection' ||
                      p.cardType === 'nhl-pace-totals',
                  );
                  if (!totalPlay?.projectedTotal) return null;
                  const edge = totalPlay.edge ?? 0;
                  const sign = edge >= 0 ? '+' : '';
                  const color = edge >= 0 ? 'text-emerald-400' : 'text-red-400';
                  return (
                    <p className={`font-mono text-xs mt-0.5 ${color}`}>
                      Model: {totalPlay.projectedTotal} ({sign}
                      {edge} {totalPlay.prediction})
                    </p>
                  );
                })()}
                {(() => {
                  const total1pPlay = originalGame.plays.find(
                    (p) => p.cardType === 'nhl-pace-1p',
                  );
                  if (!total1pPlay?.projectedTotal) return null;
                  const edge1p = total1pPlay.edge ?? 0;
                  const sign1p = edge1p >= 0 ? '+' : '';
                  const color1p =
                    edge1p >= 0 ? 'text-emerald-400' : 'text-red-400';
                  return (
                    <p
                      className={`font-mono text-xs mt-0.5 opacity-75 ${color1p}`}
                    >
                      1P: {total1pPlay.projectedTotal} ({sign1p}
                      {edge1p} {total1pPlay.prediction})
                    </p>
                  );
                })()}
              </div>
              <div>
                <p className="text-cloud/50 text-xs mb-1">Odds Updated</p>
                <p className="font-mono text-cloud/80">
                  {originalGame.odds.capturedAt
                    ? formatDate(originalGame.odds.capturedAt)
                    : '--'}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-cloud/40 italic">No odds data</p>
          )}
        </div>

        <div className="border-t border-white/5 mt-3 pt-3 space-y-3">
          {/* Compact Play Strip */}
          <div className="rounded-md border border-white/10 bg-white/5 p-3">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                {/* WI-0331: Market type badge */}
                {getMarketTypeBadge(displayPlay.bet?.market_type, displayPlay.market)}
                {/* Decision badge — muted when coinflip + low edge */}
                {displayDecision && (
                  <span
                    className={`px-2 py-1 text-xs font-bold rounded border ${
                      isCoinflipLowEdge
                        ? 'bg-slate-700/50 text-slate-300 border-slate-600/60'
                        : displayDecision === 'FIRE'
                          ? 'bg-green-700/50 text-green-200 border-green-600/60'
                          : displayDecision === 'WATCH'
                            ? 'bg-yellow-700/50 text-yellow-200 border-yellow-600/60'
                            : 'bg-slate-700/50 text-slate-200 border-slate-600/60'
                    }`}
                  >
                    {displayDecision}
                  </span>
                )}
                {/* Quality badges */}
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
                {/* Flags */}
                {isCoinflip && (
                  <span className="px-2 py-0.5 text-xs font-semibold rounded border bg-blue-700/30 text-blue-200 border-blue-600/50">
                    Coinflip
                  </span>
                )}
                {canRenderModelSummary && displayPlay.priceFlags.length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {displayPlay.priceFlags.map((flag) => (
                      <span
                        key={flag}
                        className={`px-2 py-0.5 text-xs font-semibold rounded border ${getPriceFlagClass(flag)}`}
                      >
                        {formatPriceFlagLabel(flag)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="text-right text-xs text-cloud/60 space-y-0.5">
                <div>
                  {displayMarketText} | Odds as of {displayOddsTimestamp}
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-3 flex-wrap">
              <span className="text-xs uppercase tracking-widest text-cloud/40 font-semibold">
                BET:
              </span>
              <span className="text-xl font-bold text-cloud">
                {displayBetText}
              </span>
            </div>
            {canRenderModelSummary ? (
              <div className="mt-1 text-xs text-cloud/60">
                Edge{' '}
                {effectiveEdgePct * 100 >= 0 ? '+' : ''}
                {(effectiveEdgePct * 100).toFixed(1)}% • Tier{' '}
                {displayPlay.decision_data?.edge_tier ?? displayPlay.valueStatus}
              </div>
            ) : (
              <div className="mt-1 text-xs text-amber-200/90">
                {displayPlay.whyText || displayPlay.decision_data?.reason_code?.replace(/^PASS_/, '').replace(/_/g, ' ').toLowerCase() || 'Analysis unavailable (drivers missing).'}
              </div>
            )}
          </div>

          {/* WI-0327: Edge Math section */}
          {canRenderModelSummary &&
            typeof displayPlay.modelProb === 'number' &&
            typeof displayPlay.impliedProb === 'number' &&
            typeof effectiveEdgePct === 'number' && (
              <div className="rounded-md border border-white/10 bg-white/5 p-3">
                <p className="text-xs uppercase tracking-widest text-cloud/40 font-semibold mb-2">
                  Edge Math
                </p>
                <div className="flex items-center gap-4 text-xs font-mono flex-wrap">
                  <span className="text-cloud/60">
                    Fair{' '}
                    <span className="text-cloud/90 font-bold">
                      {(displayPlay.modelProb * 100).toFixed(1)}%
                    </span>
                  </span>
                  <span className="text-cloud/40">→</span>
                  <span className="text-cloud/60">
                    Implied{' '}
                    <span className="text-cloud/90 font-bold">
                      {(displayPlay.impliedProb * 100).toFixed(1)}%
                    </span>
                  </span>
                  <span className="text-cloud/40">→</span>
                  <span className="text-cloud/60">
                    Edge{' '}
                    <span
                      className={`font-bold ${effectiveEdgePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
                    >
                      {effectiveEdgePct >= 0 ? '+' : ''}
                      {(effectiveEdgePct * 100).toFixed(1)}%
                    </span>
                  </span>
                </div>
                <p className="text-xs text-cloud/50 mt-1">
                  Edge = Fair% − Implied%
                </p>
                {effectiveEdgePct > 0.3 && (
                  <p className="text-xs text-amber-300/90 mt-1 font-semibold">
                    Caution: edge above 30% — verify line freshness
                  </p>
                )}
              </div>
            )}

          {/* WI-0332: Coinflip + edge messaging */}
          {isCoinflipHighEdge && (
            <div className="rounded-md border border-blue-600/40 bg-blue-900/20 p-3">
              <p className="text-xs font-semibold text-blue-200 mb-1">
                Pricing Inefficiency Detected
              </p>
              <p className="text-xs text-blue-100/80">
                Model fair probability: {typeof displayPlay.modelProb === 'number' ? `${(displayPlay.modelProb * 100).toFixed(1)}%` : '~50%'}, 
                but market pricing is significantly off (edge {(effectiveEdgePct * 100).toFixed(1)}%). 
                The edge here comes from an exploitable line, not a strong directional signal.
              </p>
            </div>
          )}
          {isCoinflipLowEdge && (
            <div className="rounded-md border border-white/5 bg-white/3 p-3">
              <p className="text-xs text-cloud/50">
                Near-even matchup with minimal market edge. Treat with caution —
                small variance swings could flip this outcome.
              </p>
            </div>
          )}

          {/* WI-0337: Spread line compare */}
          {decision.spreadCompare && (
            <div className="rounded-md border border-white/10 bg-white/5 p-3">
              <p className="text-xs uppercase tracking-widest text-cloud/40 font-semibold mb-2">
                Spread Compare
              </p>
              <div className="flex items-center gap-3 text-xs font-mono flex-wrap">
                {decision.spreadCompare.projectedSpread !== null ? (
                  <>
                    <span className="text-cloud/60">
                      Proj{' '}
                      <span className="text-cloud/90 font-bold">
                        {decision.spreadCompare.projectedSpread > 0
                          ? `+${decision.spreadCompare.projectedSpread}`
                          : `${decision.spreadCompare.projectedSpread}`}
                      </span>
                    </span>
                    <span className="text-cloud/40">vs</span>
                    <span className="text-cloud/60">
                      Market{' '}
                      <span className="text-cloud/90 font-bold">
                        {decision.spreadCompare.marketLine !== null
                          ? decision.spreadCompare.marketLine > 0
                            ? `+${decision.spreadCompare.marketLine}`
                            : `${decision.spreadCompare.marketLine}`
                          : 'N/A'}
                      </span>
                    </span>
                  </>
                ) : (
                  <span className="text-cloud/60">
                    Market line{' '}
                    <span className="text-cloud/90 font-bold">
                      {decision.spreadCompare.marketLine !== null
                        ? decision.spreadCompare.marketLine > 0
                          ? `+${decision.spreadCompare.marketLine}`
                          : `${decision.spreadCompare.marketLine}`
                        : 'N/A'}
                    </span>
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="rounded-md border border-white/10 bg-white/5 p-3">
            <p className="text-xs uppercase tracking-widest text-cloud/40 font-semibold mb-1">
              Why
            </p>
            <p className="text-sm text-cloud/80">
              {canRenderModelSummary
                ? displayPlay.whyText || displayPlay.whyCode.replace(/_/g, ' ')
                : 'Data issue: drivers unavailable'}
            </p>
          </div>

          <div className="rounded-md border border-white/10 bg-white/5 p-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs uppercase tracking-widest text-cloud/40 font-semibold">
                Top Contributors
              </p>
              {canRenderModelSummary && decision.supportGrade === 'STRONG' && (
                <span className="text-xs font-semibold text-emerald-400">Strong</span>
              )}
              {canRenderModelSummary && decision.supportGrade === 'MIXED' && (
                <span className="text-xs font-semibold text-amber-400">
                  Mixed signals
                  {decision.topContributors.length > 0 && (
                    <span className="font-normal text-cloud/50 ml-1">
                      ({decision.topContributors.filter(c => c.polarity === 'pro').length} aligned
                      {decision.topContributors.some(c => c.polarity === 'contra')
                        ? `, ${decision.topContributors.filter(c => c.polarity === 'contra').length} opposing`
                        : ''})
                    </span>
                  )}
                </span>
              )}
              {canRenderModelSummary && decision.supportGrade === 'WEAK' && (
                <span className="text-xs font-semibold text-cloud/40">
                  {displayDecision === 'PASS' &&
                   decision.topContributors.length > 0 &&
                   (decision.passReasonCode === 'PASS_DRIVER_SUPPORT_WEAK' ||
                    decision.passReasonCode === 'PASS_NO_EDGE')
                    ? 'Model lean only — no betting edge'
                    : decision.passReasonCode === 'PASS_MISSING_PRIMARY_DRIVER'
                      ? 'No primary driver'
                      : decision.passReasonCode === 'PASS_CONFLICT_HIGH'
                        ? 'High conflict'
                        : 'Weak support'}
                </span>
              )}
            </div>
            {!canRenderModelSummary || decision.topContributors.length === 0 ? (
              <p className="text-xs text-cloud/50">
                {canRenderModelSummary
                  ? 'No strong contributors passed market filters.'
                  : (displayPlay.whyText || displayPlay.decision_data?.reason_code?.replace(/^PASS_/, '').replace(/_/g, ' ').toLowerCase() || 'Analysis unavailable (drivers missing).')}
              </p>
            ) : (
              <div className="space-y-2">
                {decision.topContributors.map(({ driver, polarity }) => (
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
                      {displayPlay.decision === 'PASS' && driver.tier === 'BEST' && (
                        <span className="text-xs text-amber-400">(Overridden)</span>
                      )}
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
                    <p className="text-xs text-cloud/50 leading-snug">
                      {driver.note}
                    </p>
                  </div>
                ))}
              </div>
            )}
            {(isBroken || isDegraded) &&
              (displayPlay.transform_meta?.missing_inputs?.length ?? 0) > 0 && (
                <p className="text-xs text-amber-200/90 mt-2">
                  Missing inputs:{' '}
                  {displayPlay.transform_meta?.missing_inputs.join(', ')}
                </p>
              )}
          </div>

          {blockedTotals.length > 0 && (
            <details className="rounded-md border border-white/10 bg-white/5 p-3">
              <summary className="cursor-pointer text-xs uppercase tracking-widest text-cloud/40 font-semibold">
                Totals (Blocked)
              </summary>
              <div className="mt-2 space-y-2">
                {blockedTotals.map((totalPlay) => (
                  <div
                    key={`${totalPlay.cardType}-${totalPlay.cardTitle}`}
                    className="bg-white/5 rounded-md px-3 py-2"
                  >
                    <p className="text-sm text-cloud/80 font-medium">
                      {totalPlay.cardTitle}
                    </p>
                    {totalPlay.reason_codes?.length ? (
                      <p className="text-xs text-cloud/60 mt-1">
                        {totalPlay.reason_codes.join(', ')}
                      </p>
                    ) : (
                      <p className="text-xs text-cloud/60 mt-1">PASS</p>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* WI-0328: only render Risk/Gates when there are active codes */}
          {activeRiskCodes.length > 0 && (
            <details className="rounded-md border border-white/10 bg-white/5 p-3">
              <summary className="cursor-pointer text-xs uppercase tracking-widest text-cloud/40 font-semibold">
                Risk / Gates
              </summary>
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap gap-2">
                  {activeRiskCodes.map((code) => (
                    <span
                      key={code}
                      className="px-2 py-0.5 text-xs font-semibold rounded border bg-amber-700/30 text-amber-200 border-amber-600/50"
                    >
                      {code}
                    </span>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={toggleDrivers}
                  className="text-xs text-cloud/60 hover:text-cloud underline underline-offset-4"
                >
                  {showAllDrivers ? 'Hide all drivers' : 'Show all drivers'}
                </button>

                {showAllDrivers && (
                  <div className="space-y-2">
                    {decision.allDrivers.map((driver) => (
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
            {enrichedCards.length} game{enrichedCards.length !== 1 ? 's' : ''}{' '}
            total, showing {filteredCards.length} (updates in background every
            30s)
          </p>
          {!loading && !error && showTrace && (
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
            </div>
          )}
          {!loading && !error && hiddenDataErrors > 0 && (
            <details className="rounded-md border border-amber-600/50 bg-amber-700/20 px-3 py-2 text-xs text-amber-100">
              <summary className="cursor-pointer font-semibold">
                {hiddenDataErrors} game{hiddenDataErrors !== 1 ? 's' : ''} excluded due to incomplete data
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

        {!loading && viewMode === 'game' && !error && enrichedCards.length > 0 && (
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

        {!loading && viewMode === 'game' && diagnosticFilter && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-white/10 bg-surface/40 px-3 py-1.5 text-xs text-cloud/70">
            <span>
              Showing {diagnosticCards.length} blocked {diagnosticFilter.sport} games
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
            (viewMode === 'game' && filteredCards.length === 0)) &&
          !error && (
            <div className="text-center py-8 space-y-4">
              <div className="text-cloud/60">
                {viewMode === 'props'
                  ? 'No qualified props match your filters'
                  : 'No games match your filters'}
              </div>
              {viewMode === 'game' && enrichedCards.length > 0 && (
                <div className="mt-2 text-left mx-auto max-w-sm text-xs text-cloud/40 space-y-1">
                  <div className="font-semibold text-cloud/50 mb-1">
                    {enrichedCards.length} game{enrichedCards.length !== 1 ? 's' : ''} excluded — breakdown by sport:
                  </div>
                  {Object.entries(sportDiagnostics)
                    .filter(
                      ([, b]) =>
                        b.missingMapping + b.driverLoadFailed + b.noOdds + b.noProjection > 0,
                    )
                    .map(([sport, b]) => (
                      <div key={sport} className="flex gap-2 font-mono">
                        <span className="w-16">{sport}</span>
                        {b.noOdds > 0 && <span>no-odds:{b.noOdds}</span>}
                        {b.missingMapping > 0 && <span>no-map:{b.missingMapping}</span>}
                        {b.driverLoadFailed > 0 && <span>driver-fail:{b.driverLoadFailed}</span>}
                        {b.noProjection > 0 && <span>no-proj:{b.noProjection}</span>}
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

        {!loading && viewMode === 'props' && propCards.length > 0 && (
          <div className="space-y-4">
            {propCards.map((card) => (
              <PropGameCard key={card.gameId} card={card} />
            ))}
          </div>
        )}

        {!loading && viewMode === 'game' && filteredCards.length > 0 && (
          <div className="space-y-4">
            {filteredCards.map((card) => {
              const originalGame = games.find(
                (game) => game.gameId === card.gameId,
              );
              if (!originalGame) return null;
              return (
                <GameCardItem
                  key={card.id}
                  card={card}
                  originalGame={originalGame}
                />
              );
            })}
          </div>
        )}

        {!loading && viewMode === 'game' && diagnosticFilter && diagnosticCards.length > 0 && (
          <div className="mt-6 space-y-2">
            <div className="text-xs text-cloud/40 border-t border-white/10 pt-3 mb-2">
              Blocked games — {BUCKET_LABELS[diagnosticFilter.bucket]}
            </div>
            {diagnosticCards.map((card) => {
              const codes = card.play?.reason_codes ?? [];
              const badge = codes
                .filter((c) =>
                  c.startsWith('MISSING_DATA') ||
                  c.startsWith('PASS_DATA') ||
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
