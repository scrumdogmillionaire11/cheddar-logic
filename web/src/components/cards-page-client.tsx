'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import FilterPanel from '@/components/filter-panel';
import { transformGames } from '@/lib/game-card/transform';
import { enrichCards } from '@/lib/game-card/tags';
import { applyFilters, getActiveFilterCount, getFilterDebugFlags, resetFilters } from '@/lib/game-card/filters';
import type { GameFilters } from '@/lib/game-card/filters';
import { DEFAULT_FILTERS } from '@/lib/game-card/filters';
import type { Direction, DriverRow, DriverTier, GameCard, Market } from '@/lib/types/game-card';
import { GAME_TAGS } from '@/lib/types/game-card';
import { getPlayDisplayAction, getCardDecisionModel } from '@/lib/game-card/decision';

const TRACKED_SPORTS = ['NCAAM', 'NBA', 'NHL', 'SOCCER'] as const;

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
  const hasBlockedTotals = Boolean(
    card.play?.market_type === 'TOTAL' &&
      card.play?.status === 'PASS' &&
      (card.play?.reason_codes?.includes('PASS_TOTAL_INSUFFICIENT_DATA') ||
        card.play?.tags?.includes('CONSISTENCY_BLOCK_TOTALS'))
  );

  return {
    playCount,
    playStatusCounts,
    playMarkets: Array.from(playMarkets),
    hasAnyPlay,
    hasBettable,
    hasBlockedTotals,
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
    prediction: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';
    confidence: number;
    tier: 'SUPER' | 'BEST' | 'WATCH' | null;
    reasoning: string;
    evPassed: boolean;
    driverKey: string;
    projectedTotal: number | null;
    edge: number | null;
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

export default function CardsPageClient() {
  const [games, setGames] = useState<GameData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<GameFilters>(DEFAULT_FILTERS);
  const isInitialLoad = useRef(true);
  const showTrace = process.env.NODE_ENV !== 'production';

  // Compute enriched and filtered cards
  const { enrichedCards, filteredCards } = useMemo(() => {
    const transformed = transformGames(games);
    const enriched = enrichCards(transformed);
    const filtered = applyFilters(enriched, filters);
    return { enrichedCards: enriched, filteredCards: filtered };
  }, [games, filters]);

  const activeFilterCount = getActiveFilterCount(filters);
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
      const flags = getFilterDebugFlags(card, filters);
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
  }, [enrichedCards, filters]);

  const handleResetFilters = () => {
    setFilters(resetFilters());
  };

  useEffect(() => {
    const fetchGames = async () => {
      try {
        if (isInitialLoad.current) {
          setLoading(true);
        }
        const response = await fetch('/api/games');
        const data: ApiResponse = await response.json();

        if (!response.ok || !data.success) {
          setError(data.error || 'Failed to fetch games');
          setGames([]);
          return;
        }

        setGames(data.data || []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
        setGames([]);
      } finally {
        setLoading(false);
        isInitialLoad.current = false;
      }
    };

    fetchGames();
    // Updates in background every 30s
    const interval = setInterval(fetchGames, 30000);
    return () => clearInterval(interval);
  }, []);

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
  }, [loading, traceStats, todayEtKey, filters, dropTraceStats, enrichedCards]);

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
      classification: decision.status === 'FIRE' ? 'BASE' : decision.status === 'WATCH' ? 'LEAN' : 'PASS',
      action: decision.status === 'FIRE' ? 'FIRE' : decision.status === 'WATCH' ? 'HOLD' : 'PASS',
    };
    
    const [showAllDrivers, setShowAllDrivers] = useState(false);
    const blockedTotals = (originalGame.plays || []).filter((play) => {
      if (play.kind !== 'PLAY') return false;
      if (play.market_type !== 'TOTAL') return false;
      if (play.status && play.status !== 'PASS') return false;
      return true;
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
    const updatedTime = formatDate(displayPlay.updatedAt);

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
              {getStatusBadge(displayPlay.status)}
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
                <span className="text-lg font-bold text-cloud">{displayPlay.classification ?? 'UNKNOWN'}</span>
                {displayPlay.lean && (
                  <span className="text-xs text-cloud/60">({displayPlay.lean})</span>
                )}
                <span className="px-2 py-0.5 text-xs font-semibold rounded border bg-white/10 text-cloud/70 border-white/20">
                  Truth {displayPlay.truthStatus}
                </span>
              </div>
              <div className="text-right text-xs text-cloud/60 space-y-0.5">
                <div>{formatMarketLabel(displayPlay.market)} | {updatedTime}</div>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-3 flex-wrap">
              <span className="text-xs uppercase tracking-widest text-cloud/40 font-semibold">BET:</span>
              <span className="text-xl font-bold text-cloud">{displayPlay.pick}</span>
              {displayPlay.action && (
                <span className={`px-2 py-1 text-xs font-bold rounded border ${displayPlay.action === 'FIRE' ? 'bg-green-700/50 text-green-200 border-green-600/60' : displayPlay.action === 'HOLD' ? 'bg-yellow-700/50 text-yellow-200 border-yellow-600/60' : 'bg-slate-700/50 text-slate-200 border-slate-600/60'}`}>
                  {displayPlay.action}
                </span>
              )}
              <span className="px-2 py-0.5 text-xs font-semibold rounded border bg-white/10 text-cloud/70 border-white/20">
                Value {displayPlay.valueStatus}
              </span>
              {displayPlay.priceFlags.length > 0 && (
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
            {displayPlay.edge !== undefined && (
              <div className="text-xs text-cloud/60">
                Edge {(displayPlay.edge * 100).toFixed(1)}%
              </div>
            )}
          </div>

          <div className="rounded-md border border-white/10 bg-white/5 p-3">
            <p className="text-xs uppercase tracking-widest text-cloud/40 font-semibold mb-1">
              Why
            </p>
            <p className="text-sm text-cloud/80">
              {displayPlay.whyText || displayPlay.whyCode.replace(/_/g, ' ')}
            </p>
          </div>

          <div className="rounded-md border border-white/10 bg-white/5 p-3">
            <p className="text-xs uppercase tracking-widest text-cloud/40 font-semibold mb-2">
              Top Contributors
            </p>
            {decision.topContributors.length === 0 ? (
              <p className="text-xs text-cloud/50">No contributors available.</p>
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

          {(card.evidence?.length ?? 0) > 0 && (
            <div className="rounded-md border border-white/10 bg-white/5 p-3">
              <p className="text-xs uppercase tracking-widest text-cloud/40 font-semibold mb-2">
                Evidence ({card.evidence?.length})
              </p>
              <div className="space-y-2">
                {card.evidence?.slice(0, 5).map((evidence, index) => (
                  <div key={`${evidence.id}-${index}`} className="bg-white/5 rounded-md px-3 py-2">
                    <p className="text-sm text-cloud/80 font-medium">{evidence.cardTitle}</p>
                    {evidence.reasoning && (
                      <p className="text-xs text-cloud/60 mt-1">{evidence.reasoning}</p>
                    )}
                  </div>
                ))}
              </div>
              {displayPlay.pick === 'NO PLAY' && (
                <p className="text-xs text-cloud/50 mt-2">No official play for this game; evidence signals are shown for context.</p>
              )}
            </div>
          )}

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
              {decision.riskCodes.length === 0 ? (
                <p className="text-xs text-cloud/50">No active risk gates.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {decision.riskCodes.map((code) => (
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
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <Link href="/" className="text-sm text-cloud/60 hover:text-cloud/80">
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
            </div>
          )}
        </div>

        {/* Filter Panel */}
        <FilterPanel
          filters={filters}
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

        {!loading && filteredCards.length === 0 && !error && (
          <div className="text-center py-8 space-y-4">
            <div className="text-cloud/60">No games match your filters</div>
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

        {!loading && filteredCards.length > 0 && (
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
