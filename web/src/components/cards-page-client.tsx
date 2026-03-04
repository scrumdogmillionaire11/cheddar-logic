'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import FilterPanel from './filter-panel';
import { transformGames, transformPropGames } from '@/lib/game-card/transform';
import { enrichCards } from '@/lib/game-card/tags';
import { applyFilters, getActiveFilterCount, getDefaultFilters, getFilterDebugFlags, resetFilters } from '@/lib/game-card/filters';
import PropGameCard from './prop-game-card';
import type { GameFilters, ViewMode } from '@/lib/game-card/filters';
import type { Direction, DriverRow, DriverTier, GameCard, Market } from '@/lib/types/game-card';
import { GAME_TAGS } from '@/lib/types/game-card';
import { getPlayDisplayAction, getCardDecisionModel } from '@/lib/game-card/decision';
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

function getFirstDropReason(flags: ReturnType<typeof getFilterDebugFlags>): DropReason {
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
    const statusName = displayAction === 'FIRE' ? 'FIRE' : displayAction === 'HOLD' ? 'WATCH' : 'PASS';
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
  const hasBettable = card.tags.includes(GAME_TAGS.HAS_FIRE) || card.tags.includes(GAME_TAGS.HAS_WATCH);
  const playDisplayAction = getPlayDisplayAction(card.play);
  const hasBlockedTotals = Boolean(
    card.play?.market_type === 'TOTAL' &&
      playDisplayAction === 'PASS' &&
      (card.play?.reason_codes?.includes('PASS_TOTAL_INSUFFICIENT_DATA') ||
        card.play?.tags?.includes('CONSISTENCY_BLOCK_TOTALS'))
  );
  const hasDataError = Boolean(
    card.play?.transform_meta?.quality === 'BROKEN' ||
    card.play?.reason_codes?.includes('PASS_DATA_ERROR') ||
    card.play?.gates?.some((gate) => gate.code === 'PASS_DATA_ERROR')
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
  const base = TRACKED_SPORTS.map((sport) => `${sport} ${counts[sport] || 0}`).join(' | ');
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
    market_type?: 'MONEYLINE' | 'SPREAD' | 'TOTAL' | 'PUCKLINE' | 'TEAM_TOTAL' | 'PROP' | 'INFO';
    selection?: { side: string; team?: string };
    line?: number;
    price?: number;
    reason_codes?: string[];
    tags?: string[];
    consistency?: { total_bias?: 'OK' | 'INSUFFICIENT_DATA' | 'CONFLICTING_SIGNALS' | 'VOLATILE_ENV' | 'UNKNOWN' };
  }>;
  consistency?: { total_bias?: 'OK' | 'INSUFFICIENT_DATA' | 'CONFLICTING_SIGNALS' | 'VOLATILE_ENV' | 'UNKNOWN' };
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

export default function CardsPageClient() {
  const [games, setGames] = useState<GameData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('game');
  const [filters, setFilters] = useState<GameFilters>(getDefaultFilters('game'));
  const isInitialLoad = useRef(true);
  const showTrace = process.env.NODE_ENV !== 'production';
  // Player props feature flag - dev mode OR explicit production opt-in
  const propsEnabled =
    process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_ENABLE_PLAYER_PROPS === 'true';

  // Compute cards based on view mode
  const { enrichedCards, filteredCards, propCards } = useMemo(() => {
    if (viewMode === 'props') {
      // Props mode: use transformPropGames, no enrichment/filters yet
      const propGameCards = transformPropGames(games);
      
      // Props mode debugging
      if (process.env.NODE_ENV !== 'production') {
        console.info('[props-debug]', {
          total_prop_games: propGameCards.length,
          total_prop_plays: propGameCards.reduce((sum, g) => sum + g.propPlays.length, 0),
          sample_prop_game: propGameCards[0] ? {
            gameId: propGameCards[0].gameId,
            sport: propGameCards[0].sport,
            homeTeam: propGameCards[0].homeTeam,
            awayTeam: propGameCards[0].awayTeam,
            propPlays_count: propGameCards[0].propPlays.length,
            sample_play: propGameCards[0].propPlays[0],
          } : null,
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
      games.filter((game) => getEtDayKey(game.gameTimeUtc) === todayEtKey)
    );
    const transformedTodayBySport = countBySport(
      enrichedCards.filter((card) => getEtDayKey(card.startTime) === todayEtKey)
    );
    const displayedTodayBySport = countBySport(
      filteredCards.filter((card) => getEtDayKey(card.startTime) === todayEtKey)
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
  const hiddenDataErrors = useMemo(
    () =>
      Object.values(dropTraceStats.droppedMetaBySport).reduce(
        (sum, meta) => sum + (meta?.hasDataError ?? 0),
        0
      ),
    [dropTraceStats]
  );
  const hiddenDataErrorCards = useMemo(() => {
    const visibleIds = new Set(filteredCards.map((card) => card.id));
    return enrichedCards
      .filter((card) => {
        if (visibleIds.has(card.id)) return false;
        return Boolean(
          card.play?.transform_meta?.quality === 'BROKEN' ||
          card.play?.reason_codes?.includes('PASS_DATA_ERROR') ||
          card.play?.gates?.some((gate) => gate.code === 'PASS_DATA_ERROR')
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
        console.debug('[cards] Skipping fetch - global request already in flight');
        return;
      }

      if (globalGamesBlockedUntil > now) {
        const retryAfterSec = Math.max(1, Math.ceil((globalGamesBlockedUntil - now) / 1000));
        if (!cancelled) {
          setError(`Server rate limited. Retrying in ${retryAfterSec} seconds...`);
        }
        return;
      }

      if (globalGamesLastFetchAt && now - globalGamesLastFetchAt < CLIENT_MIN_FETCH_INTERVAL_MS) {
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
            parseRetryAfterMs(response.headers.get('Retry-After')) ?? CLIENT_DEFAULT_BACKOFF_MS;
          globalGamesBlockedUntil = Date.now() + retryAfterMs;
          const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
          console.warn('[cards] Rate limited, backing off', { retryAfterSec });
          if (!cancelled) {
            setError(`Server rate limited. Retrying in ${retryAfterSec} seconds...`);
          }
          return;
        }

        globalGamesBlockedUntil = 0;
        const data: ApiResponse = await response.json();

        if (!response.ok || !data.success) {
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
    if (loading || !isDevTrace) return;
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
      filters,
    });
    console.warn('[DROP REASONS BY SPORT]', dropTraceStats.droppedByReasonBySport);
    console.warn('[DROPPED META BY SPORT]', dropTraceStats.droppedMetaBySport);

    // DEBUG: Sample NBA plays to understand why they're PASS/not bettable
    const nbaSample = enrichedCards
      .filter((c) => c.sport === 'NBA')
      .flatMap((c) => {
        const displayAction = getPlayDisplayAction(c.play);
        const hasBettable = c.tags.includes(GAME_TAGS.HAS_FIRE) || c.tags.includes(GAME_TAGS.HAS_WATCH);
        // Only sample plays that are PASS or not bettable
        if (displayAction === 'PASS' || !hasBettable) {
          return [{
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
          }];
        }
        return [];
      })
      .slice(0, 10);

    if (nbaSample.length > 0) {
      console.log('[NBA PLAY SAMPLE (PASS or not bettable)]', nbaSample);
    }
  }, [loading, traceStats, todayEtKey, filters, dropTraceStats, enrichedCards, viewMode]);

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
      <span className={`px-2 py-0.5 text-xs font-semibold rounded border ${colorMap[polarity]}`}>
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

  const formatCanonicalBetText = (bet: { market_type: string; side: string; line?: number; odds_american: number } | null | undefined, homeTeam: string, awayTeam: string) => {
    if (!bet) return 'NO PLAY';
    const oddsText = bet.odds_american > 0 ? `+${bet.odds_american}` : `${bet.odds_american}`;
    if (bet.market_type === 'moneyline') {
      const teamLabel = bet.side === 'home' ? homeTeam : bet.side === 'away' ? awayTeam : bet.side.toUpperCase();
      return `${teamLabel} ML ${oddsText}`;
    }
    if (bet.market_type === 'spread') {
      const teamLabel = bet.side === 'home' ? homeTeam : awayTeam;
      const lineText = typeof bet.line === 'number' ? (bet.line > 0 ? `+${bet.line}` : `${bet.line}`) : 'Line N/A';
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
  };

  const formatContributorMarketLabel = (driverMarket: Market, cardMarket: Market | 'NONE') => {
    if (driverMarket === cardMarket) return `${formatMarketLabel(driverMarket)} (native)`;
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
      <span className={`px-2 py-1 text-xs font-bold rounded border ${colorMap[status]}`}>
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

  const GameCardItem = ({ card, originalGame }: { card: (typeof filteredCards)[number]; originalGame: GameData }) => {
    const decision = useMemo(
      () => getCardDecisionModel(card, originalGame?.odds || null) as DecisionModel,
      [card, originalGame]
    );
    
    // Prefer canonical play object from transform, fallback to decision model
    const displayPlay = card.play || {
      status: decision.status,
      market: decision.primaryPlay.market,
      pick: decision.primaryPlay.pick,
      lean: decision.primaryPlay.direction === 'HOME'
        ? card.homeTeam
        : decision.primaryPlay.direction === 'AWAY'
          ? card.awayTeam
          : decision.primaryPlay.direction || 'NO LEAN',
      side: decision.primaryPlay.direction,
      truthStatus: decision.primaryPlay.tier === 'BEST' ? 'STRONG' : decision.primaryPlay.tier === 'SUPER' ? 'MEDIUM' : 'WEAK',
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
      decision: decision.status === 'FIRE' ? 'FIRE' : decision.status === 'WATCH' ? 'WATCH' : 'PASS',
      classificationLabel: decision.status === 'FIRE' ? 'PLAY' : decision.status === 'WATCH' ? 'LEAN' : 'NONE',
      bet: decision.primaryPlay.pick === 'NO PLAY' ? null : undefined,
      gates: [],
      decision_data: {
        status: decision.status === 'FIRE' ? 'FIRE' : decision.status === 'WATCH' ? 'WATCH' : 'PASS',
        truth: decision.primaryPlay.tier === 'BEST' ? 'STRONG' : decision.primaryPlay.tier === 'SUPER' ? 'MEDIUM' : 'WEAK',
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
      classification: decision.status === 'FIRE' ? 'BASE' : decision.status === 'WATCH' ? 'LEAN' : 'PASS',
      action: decision.status === 'FIRE' ? 'FIRE' : decision.status === 'WATCH' ? 'HOLD' : 'PASS',
    };
    const quality = displayPlay.transform_meta?.quality ?? 'OK';
    const isBroken = quality === 'BROKEN';
    const isDegraded = quality === 'DEGRADED';
    const inferredDecision = displayPlay.decision ?? (displayPlay.action === 'FIRE' ? 'FIRE' : displayPlay.action === 'HOLD' ? 'WATCH' : 'PASS');
    const displayDecision = isBroken ? 'PASS' : inferredDecision;
    const displayClassification =
      displayPlay.bet
        ? 'PLAY'
        : displayDecision === 'WATCH'
          ? 'WATCHLIST'
          : 'NO PLAY';
    const canonicalGates = (displayPlay.gates ?? []).map((gate) => gate.code);
    const activeRiskCodes = Array.from(new Set([...canonicalGates, ...decision.riskCodes]));
    const hasActiveTotalBet =
      displayPlay.bet?.market_type === 'total' &&
      displayDecision === 'FIRE';
    const displayBetText = displayPlay.bet
      ? formatCanonicalBetText(displayPlay.bet, card.homeTeam, card.awayTeam)
      : displayPlay.pick;
    const displayMarketText = formatBetMarketLabel(displayPlay.bet?.market_type) ?? (displayPlay.market_key ?? formatMarketLabel(displayPlay.market));
    const updatedTime = formatDate(displayPlay.updatedAt);
    const displayOddsTimestamp = displayPlay.bet?.as_of_iso ? formatDate(displayPlay.bet.as_of_iso) : updatedTime;
    const canRenderModelSummary = !isBroken && card.drivers.length > 0;
    
    const [showAllDrivers, setShowAllDrivers] = useState(false);
    const blockedTotals = hasActiveTotalBet
      ? []
      : (originalGame.plays || []).filter((play) => {
          if (play.kind !== 'PLAY') return false;
          if (play.market_type !== 'TOTAL') return false;
          const blockedByReason =
            play.reason_codes?.includes('PASS_TOTAL_INSUFFICIENT_DATA') ||
            play.tags?.includes('CONSISTENCY_BLOCK_TOTALS');
          const blockedByStatus = play.action === 'PASS' || play.status === 'PASS';
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
              {getStatusBadge(displayDecision === 'WATCH' ? 'WATCH' : displayDecision)}
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
                  {card.homeTeam.split(' ').slice(-1)[0]} {formatOddsLine(originalGame.odds.h2hHome)}
                  {' / '}
                  {card.awayTeam.split(' ').slice(-1)[0]} {formatOddsLine(originalGame.odds.h2hAway)}
                </p>
              </div>
              <div>
                <p className="text-cloud/50 text-xs mb-1">Total</p>
                <p className="font-mono text-cloud/80">
                  {originalGame.odds.total !== null ? `O/U ${originalGame.odds.total}` : '--'}
                </p>
                {(() => {
                  const totalPlay = originalGame.plays.find(p => p.cardType === 'nba-total-projection' || p.cardType === 'nhl-pace-totals');
                  if (!totalPlay?.projectedTotal) return null;
                  const edge = totalPlay.edge ?? 0;
                  const sign = edge >= 0 ? '+' : '';
                  const color = edge >= 0 ? 'text-emerald-400' : 'text-red-400';
                  return (
                    <p className={`font-mono text-xs mt-0.5 ${color}`}>
                      Model: {totalPlay.projectedTotal} ({sign}{edge} {totalPlay.prediction})
                    </p>
                  );
                })()}
              </div>
              <div>
                <p className="text-cloud/50 text-xs mb-1">Odds Updated</p>
                <p className="font-mono text-cloud/80">
                  {originalGame.odds.capturedAt ? formatDate(originalGame.odds.capturedAt) : '--'}
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
              <div className="flex items-center gap-3">
                <span className="text-xs uppercase tracking-widest text-cloud/40 font-semibold">Classification:</span>
                <span className="text-lg font-bold text-cloud">
                  {displayClassification}
                </span>
                {displayPlay.bet && displayPlay.lean && (
                  <span className="text-xs text-cloud/60">({displayPlay.lean})</span>
                )}
                {canRenderModelSummary && (
                  <span className="px-2 py-0.5 text-xs font-semibold rounded border bg-white/10 text-cloud/70 border-white/20">
                    Truth {displayPlay.truthStatus}
                  </span>
                )}
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
              <div className="text-right text-xs text-cloud/60 space-y-0.5">
                <div>{displayMarketText} | Odds as of {displayOddsTimestamp}</div>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-3 flex-wrap">
              <span className="text-xs uppercase tracking-widest text-cloud/40 font-semibold">BET:</span>
              <span className="text-xl font-bold text-cloud">{displayBetText}</span>
              {displayDecision && (
                <span className={`px-2 py-1 text-xs font-bold rounded border ${displayDecision === 'FIRE' ? 'bg-green-700/50 text-green-200 border-green-600/60' : displayDecision === 'WATCH' ? 'bg-yellow-700/50 text-yellow-200 border-yellow-600/60' : 'bg-slate-700/50 text-slate-200 border-slate-600/60'}`}>
                  {displayDecision}
                </span>
              )}
              {canRenderModelSummary && (
                <span className="px-2 py-0.5 text-xs font-semibold rounded border bg-white/10 text-cloud/70 border-white/20">
                  Value {displayPlay.decision_data?.value_tier ?? displayPlay.valueStatus}
                </span>
              )}
              {canRenderModelSummary && displayPlay.decision_data?.coinflip && (
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
            {canRenderModelSummary ? (
              <div className="text-xs text-cloud/60">
                Truth {displayPlay.decision_data?.truth ?? displayPlay.truthStatus} • Edge {(typeof displayPlay.decision_data?.edge_pct === 'number' ? displayPlay.decision_data.edge_pct : (displayPlay.edge ?? 0)) * 100 >= 0 ? '+' : ''}{((typeof displayPlay.decision_data?.edge_pct === 'number' ? displayPlay.decision_data.edge_pct : (displayPlay.edge ?? 0)) * 100).toFixed(1)}% • Tier {displayPlay.decision_data?.edge_tier ?? displayPlay.valueStatus}
              </div>
            ) : (
              <div className="text-xs text-amber-200/90">
                Analysis unavailable (drivers missing).
              </div>
            )}
          </div>

          <div className="rounded-md border border-white/10 bg-white/5 p-3">
            <p className="text-xs uppercase tracking-widest text-cloud/40 font-semibold mb-1">
              Why
            </p>
            <p className="text-sm text-cloud/80">
              {canRenderModelSummary
                ? (displayPlay.whyText || displayPlay.whyCode.replace(/_/g, ' '))
                : 'Data issue: drivers unavailable'}
            </p>
          </div>

          <div className="rounded-md border border-white/10 bg-white/5 p-3">
            <p className="text-xs uppercase tracking-widest text-cloud/40 font-semibold mb-2">
              Top Contributors
            </p>
            {!canRenderModelSummary || decision.topContributors.length === 0 ? (
              <p className="text-xs text-cloud/50">
                {canRenderModelSummary
                  ? 'No strong contributors passed market filters.'
                  : 'Analysis unavailable (drivers missing).'}
              </p>
            ) : (
              <div className="space-y-2">
                {decision.topContributors.map(({ driver, polarity }) => (
                  <div key={driverRowKey(driver)} className="bg-white/5 rounded-md px-3 py-2">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      {getPolarityBadge(polarity)}
                      {getTierBadge(driver.tier)}
                      {getDirectionBadge(driver.direction)}
                      <span className="text-xs font-mono text-cloud/60">
                        {formatConfidence(driver.confidence)}
                      </span>
                      <span className="text-xs font-mono text-cloud/60">
                        {formatContributorMarketLabel(driver.market, displayPlay.market)}
                      </span>
                      <span className="text-xs text-cloud/70 font-medium">
                        {driver.cardTitle}
                      </span>
                    </div>
                    <p className="text-xs text-cloud/50 leading-snug">{driver.note}</p>
                  </div>
                ))}
              </div>
            )}
            {(isBroken || isDegraded) && (displayPlay.transform_meta?.missing_inputs?.length ?? 0) > 0 && (
              <p className="text-xs text-amber-200/90 mt-2">
                Missing inputs: {displayPlay.transform_meta?.missing_inputs.join(', ')}
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
                  <div key={`${totalPlay.cardType}-${totalPlay.cardTitle}`} className="bg-white/5 rounded-md px-3 py-2">
                    <p className="text-sm text-cloud/80 font-medium">{totalPlay.cardTitle}</p>
                    {totalPlay.reason_codes?.length ? (
                      <p className="text-xs text-cloud/60 mt-1">{totalPlay.reason_codes.join(', ')}</p>
                    ) : (
                      <p className="text-xs text-cloud/60 mt-1">PASS</p>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}

          <details className="rounded-md border border-white/10 bg-white/5 p-3">
            <summary className="cursor-pointer text-xs uppercase tracking-widest text-cloud/40 font-semibold">
              Risk / Gates
            </summary>
            <div className="mt-2 space-y-2">
              {activeRiskCodes.length === 0 ? (
                <p className="text-xs text-cloud/50">No active risk gates.</p>
              ) : (
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
              )}

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
                    <div key={`all-${driverRowKey(driver)}`} className="bg-white/5 rounded-md px-3 py-2">
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
                      <p className="text-xs text-cloud/50 leading-snug">{driver.note}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-night text-cloud px-6 py-12">
      <StickyBackButton fallbackHref="/" fallbackLabel="Home" showAfterPx={120} />

      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <Link href="/" className="hidden text-sm text-cloud/60 hover:text-cloud/80 md:inline-flex">
            ← Back to Home
          </Link>
        </div>
        
        <div className="mb-8 space-y-2">
          <h1 className="text-4xl font-bold">🧀 The Cheddar Board 🧀</h1>
          <p className="text-cloud/70">
            {enrichedCards.length} game{enrichedCards.length !== 1 ? 's' : ''} total, showing {filteredCards.length} (updates in background every 30s)
          </p>
          {!loading && !error && showTrace && (
            <div className="rounded-lg border border-white/10 bg-surface/30 px-3 py-2 text-xs text-cloud/70 space-y-1">
              <p>
                Trace (all): fetched {traceStats.fetchedTotal} ({formatSportCounts(traceStats.fetchedBySport)}) → transformed {traceStats.transformedTotal} ({formatSportCounts(traceStats.transformedBySport)}) → displayed {traceStats.displayedTotal} ({formatSportCounts(traceStats.displayedBySport)})
              </p>
              <p>
                Trace (today ET {todayEtKey}): fetched ({formatSportCounts(traceStats.fetchedTodayBySport)}) → transformed ({formatSportCounts(traceStats.transformedTodayBySport)}) → displayed ({formatSportCounts(traceStats.displayedTodayBySport)})
              </p>
              <p>
                Filter drops: status {dropTraceStats.droppedByReason.DROP_NO_BETTABLE_STATUS} • market {dropTraceStats.droppedByReason.DROP_MARKET_NOT_ALLOWED} • time {dropTraceStats.droppedByReason.DROP_TIME_WINDOW} • data errors {hiddenDataErrors}
              </p>
            </div>
          )}
          {!loading && !error && hiddenDataErrors > 0 && (
            <details className="rounded-md border border-amber-600/50 bg-amber-700/20 px-3 py-2 text-xs text-amber-100">
              <summary className="cursor-pointer font-semibold">
                Some cards hidden due to data errors ({hiddenDataErrors})
              </summary>
              {hiddenDataErrorCards.length > 0 && (
                <div className="mt-2 space-y-1">
                  {hiddenDataErrorCards.map((card) => (
                    <div key={`hidden-error-${card.id}`} className="rounded bg-amber-900/20 px-2 py-1">
                      <span className="font-semibold">{card.awayTeam} @ {card.homeTeam}</span>
                      <span className="text-amber-200/90"> · {card.play?.transform_meta?.quality ?? 'BROKEN'}</span>
                      {card.play?.transform_meta?.missing_inputs?.length ? (
                        <span className="text-amber-200/90"> · missing: {card.play.transform_meta.missing_inputs.join(', ')}</span>
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

        {loading && <div className="text-center py-8 text-cloud/60">Loading games...</div>}

        {error && (
          <div className="mb-6 p-4 bg-red-900/20 border border-red-700 rounded-lg text-red-200">
            Error: {error}
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
              const originalGame = games.find((game) => game.gameId === card.gameId);
              if (!originalGame) return null;
              return <GameCardItem key={card.id} card={card} originalGame={originalGame} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}
