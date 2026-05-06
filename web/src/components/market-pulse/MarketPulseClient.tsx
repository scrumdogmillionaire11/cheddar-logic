'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MarketPulseOpportunity,
  MarketPulseResponse,
  SportFilter,
} from '@/lib/types/market-pulse';

const POLL_INTERVAL_MS = 60 * 60 * 1000;
const STALENESS_RECOMPUTE_MS = 30 * 1000;
const SPORT_TABS: SportFilter[] = ['ALL', 'NBA', 'MLB', 'NHL'];

function minutesAgoFrom(isoTimestamp: string): number {
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 60_000),
  );
}

function buildUrl(sport: SportFilter, includeWatch: boolean): string {
  const params = new URLSearchParams();
  if (sport !== 'ALL') params.set('sport', sport);
  if (includeWatch) params.set('includeWatch', 'true');
  const queryString = params.toString();
  return `/api/market-pulse${queryString ? `?${queryString}` : ''}`;
}

function formatAmerican(price: number | null | undefined): string {
  if (!Number.isFinite(price)) return 'N/A';
  return (price as number) > 0 ? `+${price}` : `${price}`;
}

function formatLine(line: number | null): string {
  if (!Number.isFinite(line)) return 'moneyline';
  return Number(line).toFixed(1);
}

function formatProjectionValue(opportunity: MarketPulseOpportunity): string | null {
  if (!Number.isFinite(opportunity.projectionValue)) return null;

  if (opportunity.marketType === 'TOTAL') {
    return `${(opportunity.projectionValue as number).toFixed(1)} projected total`;
  }

  return `${Math.round((opportunity.projectionValue as number) * 100)}% model win`;
}

function matchupLabel(homeTeam: string | null, awayTeam: string | null): string {
  return `${awayTeam?.trim() || 'Away'} @ ${homeTeam?.trim() || 'Home'}`;
}

function marketLabel(opportunity: MarketPulseOpportunity): string {
  if (opportunity.marketType === 'MONEYLINE') {
    return `${opportunity.displayMarket} · ${opportunity.side}`;
  }
  return `${opportunity.displayMarket} ${formatLine(opportunity.line)} · ${opportunity.side}`;
}

function tierBadgeClass(tier: MarketPulseOpportunity['displayTier']): string {
  if (tier === 'SCOUT') {
    return 'border border-emerald-300/30 bg-emerald-400/15 text-emerald-200';
  }
  if (tier === 'WATCH') {
    return 'border border-amber-300/30 bg-amber-400/15 text-amber-200';
  }
  if (tier === 'EXPIRED') {
    return 'border border-white/10 bg-white/5 text-cloud/45';
  }
  return 'border border-sky-300/30 bg-sky-400/15 text-sky-200';
}

function projectionStatusLabel(
  opportunity: MarketPulseOpportunity,
): string {
  if (opportunity.projectionStatus === 'CONFIRMED') {
    return 'Projection aligned watch';
  }
  if (opportunity.projectionStatus === 'MISMATCHED') {
    return 'Model disagreement';
  }
  if (opportunity.projectionStatus === 'UNSUPPORTED_SPORT') {
    return 'Projection unsupported';
  }
  return 'Projection unavailable';
}

function SportTabs({
  active,
  onChange,
}: {
  active: SportFilter;
  onChange: (sport: SportFilter) => void;
}) {
  return (
    <div className="flex gap-1" role="tablist" aria-label="Sport filter">
      {SPORT_TABS.map((sport) => (
        <button
          key={sport}
          role="tab"
          aria-selected={active === sport}
          onClick={() => onChange(sport)}
          className={[
            'rounded px-3 py-1 text-sm font-medium transition-colors',
            active === sport
              ? 'bg-zinc-800 text-white'
              : 'border border-white/10 bg-white/5 text-cloud/60 hover:border-white/20 hover:bg-white/10',
          ].join(' ')}
        >
          {sport === 'ALL' ? 'All' : sport}
        </button>
      ))}
    </div>
  );
}

function FilterToggle({
  active,
  label,
  onToggle,
}: {
  active: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={[
        'rounded border px-3 py-1 text-sm transition-colors',
        active
          ? 'border-cyan-300/50 bg-cyan-300/15 text-cloud'
          : 'border-white/10 bg-white/5 text-cloud/60 hover:border-white/20 hover:bg-white/10',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function OpportunityCard({
  opportunity,
}: {
  opportunity: MarketPulseOpportunity;
}) {
  const projectionValue = formatProjectionValue(opportunity);

  return (
    <li className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4 shadow-[0_12px_32px_rgba(0,0,0,0.2)] backdrop-blur-sm">
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex-1">
          <p className="font-medium text-cloud">
            {matchupLabel(opportunity.homeTeam, opportunity.awayTeam)}
          </p>
          <p className="mt-1 text-sm text-cloud/55">{marketLabel(opportunity)}</p>
        </div>
        <span
          className={[
            'rounded px-2 py-0.5 text-xs font-semibold',
            tierBadgeClass(opportunity.displayTier),
          ].join(' ')}
        >
          {opportunity.displayTier}
        </span>
      </div>

      <div className="mt-3 grid gap-2 text-sm text-cloud/70 sm:grid-cols-2">
        <p>
          Best observed price: <span className="font-medium">{opportunity.bestBook}</span>{' '}
          {formatAmerican(opportunity.bestPrice)}
        </p>
        <p>
          Comparison reference: <span className="font-medium">{opportunity.referenceBook}</span>{' '}
          {formatAmerican(opportunity.referencePrice)}
        </p>
        <p>Market discrepancy: {opportunity.marketGapPct !== null ? `${(opportunity.marketGapPct * 100).toFixed(1)}%` : 'N/A'}</p>
        <p>Line delta: {opportunity.lineDelta !== null ? `${opportunity.lineDelta.toFixed(1)} pts` : 'N/A'}</p>
        <p>{projectionStatusLabel(opportunity)}</p>
        <p>Freshness: {opportunity.freshnessStatus}</p>
      </div>

      {(projectionValue || Number.isFinite(opportunity.fairPrice)) && (
        <p className="mt-3 text-sm text-cloud/65">
          {projectionValue ?? 'Model reference available'}
          {Number.isFinite(opportunity.fairPrice) ? ` · fair price ${formatAmerican(opportunity.fairPrice)}` : ''}
        </p>
      )}

      {opportunity.verifyBeforeBetLabel && (
        <p className="mt-3 text-sm font-medium text-amber-700">
          {opportunity.verifyBeforeBetLabel}
        </p>
      )}

      {opportunity.freshnessStatus === 'EXPIRED' && (
        <p className="mt-2 text-sm text-cloud/50">Possible stale price</p>
      )}

      <p className="mt-3 text-xs text-cloud/40">
        Last updated {opportunity.minutesAgo} min ago
        {opportunity.suppressionReason ? ' · composite signal merged' : ''}
      </p>
    </li>
  );
}

function StalenessFooter({
  minutesAgo,
  scheduleLabel,
}: {
  minutesAgo: number;
  scheduleLabel: string;
}) {
  return (
    <p className="mt-6 text-xs text-cloud/40">
      Last scanned {minutesAgo} min ago · {scheduleLabel}
    </p>
  );
}

export default function MarketPulseClient({
  scheduleLabel,
}: {
  scheduleLabel: string;
}) {
  const [sport, setSport] = useState<SportFilter>('ALL');
  const [includeWatch, setIncludeWatch] = useState(false);
  const [showExpired, setShowExpired] = useState(false);
  const [projectionOnly, setProjectionOnly] = useState(false);
  const [data, setData] = useState<MarketPulseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minutesAgo, setMinutesAgo] = useState(0);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stalenessRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(
    async (nextSport: SportFilter, nextIncludeWatch: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(buildUrl(nextSport, nextIncludeWatch));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload: MarketPulseResponse = await response.json();
        setData(payload);
        setMinutesAgo(minutesAgoFrom(payload.scannedAt));
      } catch (fetchError) {
        setError(
          fetchError instanceof Error ? fetchError.message : 'Failed to load',
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    fetchData(sport, includeWatch);

    pollRef.current = setInterval(() => {
      fetchData(sport, includeWatch);
    }, POLL_INTERVAL_MS);

    stalenessRef.current = setInterval(() => {
      setData((current) => {
        if (current) setMinutesAgo(minutesAgoFrom(current.scannedAt));
        return current;
      });
    }, STALENESS_RECOMPUTE_MS);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (stalenessRef.current) clearInterval(stalenessRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetPoll = useCallback(
    (nextSport: SportFilter, nextIncludeWatch: boolean) => {
      if (pollRef.current) clearInterval(pollRef.current);
      fetchData(nextSport, nextIncludeWatch);
      pollRef.current = setInterval(() => {
        fetchData(nextSport, nextIncludeWatch);
      }, POLL_INTERVAL_MS);
    },
    [fetchData],
  );

  const handleSportChange = useCallback(
    (nextSport: SportFilter) => {
      setSport(nextSport);
      resetPoll(nextSport, includeWatch);
    },
    [includeWatch, resetPoll],
  );

  const handleWatchToggle = useCallback(() => {
    const nextIncludeWatch = !includeWatch;
    setIncludeWatch(nextIncludeWatch);
    resetPoll(sport, nextIncludeWatch);
  }, [includeWatch, resetPoll, sport]);

  const visibleOpportunities = (data?.opportunities ?? []).filter((opportunity) => {
    if (!showExpired && opportunity.freshnessStatus === 'EXPIRED') {
      return false;
    }
    if (projectionOnly && opportunity.projectionStatus !== 'CONFIRMED') {
      return false;
    }
    return true;
  });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <SportTabs active={sport} onChange={handleSportChange} />
        <div className="flex-1" />
        <div className="flex flex-wrap gap-2">
          <FilterToggle
            active={includeWatch}
            label={includeWatch ? 'Hide watch' : 'Show watch'}
            onToggle={handleWatchToggle}
          />
          <FilterToggle
            active={showExpired}
            label={showExpired ? 'Hide expired' : 'Show expired'}
            onToggle={() => setShowExpired((current) => !current)}
          />
          <FilterToggle
            active={projectionOnly}
            label={projectionOnly ? 'Show all cards' : 'Projection only'}
            onToggle={() => setProjectionOnly((current) => !current)}
          />
        </div>
      </div>

      {loading && (
        <div className="mt-8 animate-pulse space-y-3">
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-24 rounded-2xl border border-white/10 bg-white/5" />
          ))}
        </div>
      )}

      {!loading && error && <p className="mt-8 text-sm text-rose-300">Error: {error}</p>}

      {!loading && !error && data && (
        <>
          {data.meta.gamesScanned === 0 ? (
            <div className="mt-12 rounded-2xl border border-white/10 bg-white/5 px-6 py-8 text-center text-cloud/60">
              <p className="text-base">No games in current scan window.</p>
              <p className="mt-1 text-sm">{scheduleLabel}</p>
            </div>
          ) : visibleOpportunities.length === 0 ? (
            <div className="mt-12 rounded-2xl border border-white/10 bg-white/5 px-6 py-8 text-center text-cloud/60">
              <p className="text-base">No Market Pulse cards match the current filters.</p>
              <p className="mt-1 text-sm">
                Last scanned {minutesAgo} min ago · {scheduleLabel}
              </p>
            </div>
          ) : (
            <>
              <ul className="mt-6 space-y-3">
                {visibleOpportunities.map((opportunity) => (
                  <OpportunityCard
                    key={opportunity.opportunityId}
                    opportunity={opportunity}
                  />
                ))}
              </ul>
              <StalenessFooter
                minutesAgo={minutesAgo}
                scheduleLabel={scheduleLabel}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
