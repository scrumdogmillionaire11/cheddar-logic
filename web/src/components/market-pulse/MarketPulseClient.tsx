'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type {
  LineGap,
  MarketPulseResponse,
  OddsGap,
  SportFilter,
} from '@/lib/types/market-pulse';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STALENESS_RECOMPUTE_MS = 30 * 1000; // 30 seconds
const LINE_GAP_DEFAULT_THRESHOLD = 1.5;
const SPORT_TABS: SportFilter[] = ['ALL', 'NBA', 'MLB', 'NHL'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minutesAgoFrom(isoTimestamp: string): number {
  return Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 60_000);
}

function buildUrl(sport: SportFilter, includeWatch: boolean): string {
  const params = new URLSearchParams();
  if (sport !== 'ALL') params.set('sport', sport);
  if (includeWatch) params.set('includeWatch', 'true');
  const qs = params.toString();
  return `/api/market-pulse${qs ? `?${qs}` : ''}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SportTabs({
  active,
  onChange,
}: {
  active: SportFilter;
  onChange: (s: SportFilter) => void;
}) {
  return (
    <div className="flex gap-1" role="tablist" aria-label="Sport filter">
      {SPORT_TABS.map((s) => (
        <button
          key={s}
          role="tab"
          aria-selected={active === s}
          onClick={() => onChange(s)}
          className={[
            'rounded px-3 py-1 text-sm font-medium transition-colors',
            active === s
              ? 'bg-zinc-800 text-white'
              : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200',
          ].join(' ')}
        >
          {s === 'ALL' ? 'All' : s}
        </button>
      ))}
    </div>
  );
}

function WatchToggle({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="rounded border border-zinc-300 px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-100"
    >
      {enabled ? 'Hide minor ▴' : 'Show minor ▾'}
    </button>
  );
}

function StalenessFooter({
  minutesAgo,
  minutesUntilRefresh,
}: {
  minutesAgo: number;
  minutesUntilRefresh: number;
}) {
  return (
    <p className="mt-6 text-xs text-zinc-400">
      Last scanned {minutesAgo} min ago · Next refresh in {minutesUntilRefresh}{' '}
      min
    </p>
  );
}

function LineDiscrepanciesSection({
  gaps,
  includeWatch,
}: {
  gaps: LineGap[];
  includeWatch: boolean;
}) {
  const visible = gaps.filter(
    (g) =>
      g.delta >= LINE_GAP_DEFAULT_THRESHOLD || (includeWatch && g.tier === 'WATCH'),
  );

  if (visible.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
        Line Discrepancies
      </h2>
      <p className="mb-3 text-xs text-zinc-400">
        Books diverging on the number itself
      </p>
      <ul className="space-y-3">
        {visible.map((g) => {
          const isWatch = g.tier === 'WATCH';
          return (
            <li
              key={`${g.gameId}-${g.market}-${g.outlierBook}`}
              className={[
                'rounded border border-zinc-200 bg-white px-4 py-3',
                isWatch ? 'opacity-50' : '',
              ].join(' ')}
            >
              <div
                className={[
                  'flex items-start gap-4',
                  isWatch ? 'text-sm' : '',
                ].join(' ')}
              >
                <div className="flex-1">
                  <span className="font-medium">
                    {g.away} @ {g.home}
                  </span>
                  <span className="ml-2 text-zinc-500">{g.market}</span>
                </div>
                <span className="shrink-0 rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                  OUTLIER
                </span>
              </div>
              <p className="mt-1 text-sm text-zinc-600">
                {g.outlierBook} · {g.delta.toFixed(1)} pt gap ·{' '}
                <span className="text-zinc-400">
                  {minutesAgoFrom(g.capturedAt as string)} min ago
                </span>
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function OddsDiscrepanciesSection({
  gaps,
  includeWatch,
}: {
  gaps: OddsGap[];
  includeWatch: boolean;
}) {
  const visible = includeWatch ? gaps : gaps.filter((g) => g.tier === 'TRIGGER');

  if (visible.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
        Odds Discrepancies
      </h2>
      <p className="mb-3 text-xs text-zinc-400">
        Same number, price varies across books
      </p>
      <ul className="space-y-3">
        {visible.map((g) => {
          const isWatch = g.tier === 'WATCH';
          return (
            <li
              key={`${g.gameId}-${g.market}-${g.outlierBook}`}
              className={[
                'rounded border border-zinc-200 bg-white px-4 py-3',
                isWatch ? 'opacity-50' : '',
              ].join(' ')}
            >
              <div
                className={[
                  'flex items-start gap-4',
                  isWatch ? 'text-sm' : '',
                ].join(' ')}
              >
                <div className="flex-1">
                  <span className="font-medium">
                    {g.away} @ {g.home}
                  </span>
                  <span className="ml-2 text-zinc-500">{g.market}</span>
                </div>
                <span className="shrink-0 rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                  OUTLIER
                </span>
              </div>
              <p className="mt-1 text-sm text-zinc-600">
                {g.outlierBook} · {(g.impliedEdgePct * 100).toFixed(1)}% spread ·{' '}
                price varies across books ·{' '}
                <span className="text-zinc-400">
                  {minutesAgoFrom(g.capturedAt as string)} min ago
                </span>
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main client component
// ---------------------------------------------------------------------------

export default function MarketPulseClient() {
  const [sport, setSport] = useState<SportFilter>('ALL');
  const [includeWatch, setIncludeWatch] = useState(false);
  const [data, setData] = useState<MarketPulseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minutesAgo, setMinutesAgo] = useState(0);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stalenessRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastFetchRef = useRef<number>(Date.now());

  const fetchData = useCallback(
    async (currentSport: SportFilter, currentIncludeWatch: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(buildUrl(currentSport, currentIncludeWatch));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: MarketPulseResponse = await res.json();
        setData(json);
        setMinutesAgo(minutesAgoFrom(json.scannedAt));
        lastFetchRef.current = Date.now();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Mount: initial fetch + start polling
  useEffect(() => {
    fetchData(sport, includeWatch);

    pollRef.current = setInterval(() => {
      fetchData(sport, includeWatch);
    }, POLL_INTERVAL_MS);

    stalenessRef.current = setInterval(() => {
      setData((prev) => {
        if (prev) setMinutesAgo(minutesAgoFrom(prev.scannedAt));
        return prev;
      });
    }, STALENESS_RECOMPUTE_MS);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (stalenessRef.current) clearInterval(stalenessRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch and reset poll when sport or includeWatch changes
  const handleSportChange = useCallback(
    (newSport: SportFilter) => {
      setSport(newSport);
      if (pollRef.current) clearInterval(pollRef.current);
      fetchData(newSport, includeWatch);
      pollRef.current = setInterval(() => {
        fetchData(newSport, includeWatch);
      }, POLL_INTERVAL_MS);
    },
    [fetchData, includeWatch],
  );

  const handleWatchToggle = useCallback(() => {
    const next = !includeWatch;
    setIncludeWatch(next);
    if (pollRef.current) clearInterval(pollRef.current);
    fetchData(sport, next);
    pollRef.current = setInterval(() => {
      fetchData(sport, next);
    }, POLL_INTERVAL_MS);
  }, [fetchData, includeWatch, sport]);

  // Minutes until next auto-refresh (approximate)
  const minutesUntilRefresh = Math.max(
    0,
    Math.ceil((POLL_INTERVAL_MS - (Date.now() - lastFetchRef.current)) / 60_000),
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <SportTabs active={sport} onChange={handleSportChange} />
        <div className="flex-1" />
        <WatchToggle enabled={includeWatch} onToggle={handleWatchToggle} />
      </div>

      {loading && (
        <div className="mt-8 animate-pulse space-y-3">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-16 rounded bg-zinc-100" />
          ))}
        </div>
      )}

      {!loading && error && (
        <p className="mt-8 text-sm text-red-500">Error: {error}</p>
      )}

      {!loading && !error && data && (
        <>
          {data.meta.gamesScanned === 0 ? (
            // State 3 — outside scan window
            <div className="mt-12 text-center text-zinc-500">
              <p className="text-base">No games in current scan window.</p>
              <p className="mt-1 text-sm">
                Next check in {minutesUntilRefresh} min.
              </p>
            </div>
          ) : data.lineGaps.length === 0 && data.oddsGaps.length === 0 ? (
            // State 2 — market is tight
            <div className="mt-12 text-center text-zinc-500">
              <p className="text-base">Market is tight right now.</p>
              <p className="mt-1 text-sm">
                Last scanned {minutesAgo} min ago · Next scan in{' '}
                {minutesUntilRefresh} min
              </p>
            </div>
          ) : (
            // State 1 — discrepancies present
            <>
              <LineDiscrepanciesSection
                gaps={data.lineGaps}
                includeWatch={includeWatch}
              />
              <OddsDiscrepanciesSection
                gaps={data.oddsGaps}
                includeWatch={includeWatch}
              />
              <StalenessFooter
                minutesAgo={minutesAgo}
                minutesUntilRefresh={minutesUntilRefresh}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
