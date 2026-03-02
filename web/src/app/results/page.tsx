'use client';

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type ResultsSummary = {
  totalCards: number;
  settledCards: number;
  wins: number;
  losses: number;
  pushes: number;
  totalPnlUnits: number;
  winRate: number;
  avgPnl: number;
};

type SegmentRow = {
  sport: string;
  cardCategory: string;
  settledCards: number;
  wins: number;
  losses: number;
  pushes: number;
  totalPnlUnits: number;
};

type LedgerRow = {
  id: string;
  gameId: string;
  sport: string;
  cardType: string;
  result: string | null;
  pnlUnits: number | null;
  settledAt: string | null;
  createdAt: string | null;
  prediction: string | null;
  tier: string | null;
  market: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  price: number | null;
  confidencePct: number | null;
  payloadParseError: boolean;
};

type ResultsResponse = {
  success: boolean;
  data?: {
    summary: ResultsSummary;
    segments: SegmentRow[];
    ledger: LedgerRow[];
    filters?: { sport: string | null; cardCategory: string | null; minConfidence: number | null };
  };
  error?: string;
};

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatUnits(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}u`;
}

export default function ResultsPage() {
  const [summary, setSummary] = useState<ResultsSummary | null>(null);
  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [filterSport, setFilterSport] = useState<string>('');
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterHighConf, setFilterHighConf] = useState<boolean>(false);

  const loadResults = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (filterSport) params.set('sport', filterSport);
      if (filterCategory) params.set('card_category', filterCategory);
      if (filterHighConf) params.set('min_confidence', '60');
      const response = await fetch(`/api/results?${params.toString()}`);
      const payload: ResultsResponse = await response.json();

      if (!response.ok || !payload.success || !payload.data) {
        setError(payload.error || 'Failed to load results');
        return;
      }

      setSummary(payload.data.summary);
      setSegments(payload.data.segments);
      setLedger(payload.data.ledger);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [filterSport, filterCategory, filterHighConf]);

  useEffect(() => {
    loadResults();
  }, [loadResults]);

  const summaryCards = useMemo(() => {
    return [
      {
        label: "ROI (units)",
        value: summary ? formatUnits(summary.totalPnlUnits) : "N/A",
        note: "Logged plays only",
      },
      {
        label: "Win Rate",
        value: summary ? formatPercent(summary.winRate) : "N/A",
        note: "Graded outcomes",
      },
      {
        label: "Total Settled Plays",
        value: summary ? String(summary.totalCards) : "N/A",
        note: "Graded with outcomes",
      },
      {
        label: "Avg Edge",
        value: "N/A",
        note: "At call time",
      },
    ];
  }, [summary]);

  const hasActiveFilters = filterSport || filterCategory || filterHighConf;

  return (
    <div className="min-h-screen bg-night text-cloud">
      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute left-1/2 top-0 h-96 w-96 -translate-x-1/2 rounded-full bg-emerald-500/10 blur-[120px]" />
        <div className="pointer-events-none absolute -left-20 top-40 h-80 w-80 rounded-full bg-cyan-400/10 blur-[140px]" />
      </div>

      <div className="relative mx-auto max-w-6xl px-6 py-12">
        <div className="mb-8">
          <Link href="/" className="text-sm text-cloud/60 hover:text-cloud/80">
            &larr; Back to Home
          </Link>
        </div>

        <header className="mb-10 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-cloud/50">
            Accountability Ledger
          </p>
          <h1 className="font-display text-4xl font-semibold sm:text-5xl">Results</h1>
          <p className="max-w-2xl text-lg text-cloud/70">
            Every call is logged at decision time and graded after the final whistle. No
            recomputation, no deletions, no retroactive edits.
          </p>
          {error ? (
            <p className="text-sm text-rose-200">{error}</p>
          ) : null}
          {loading ? (
            <p className="text-sm text-cloud/50">Loading results...</p>
          ) : null}
        </header>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {summaryCards.map((card) => (
            <div
              key={card.label}
              className="rounded-2xl border border-white/10 bg-surface/80 p-6 shadow-[0_0_40px_rgba(0,0,0,0.3)]"
            >
              <p className="text-xs uppercase tracking-[0.25em] text-cloud/50">
                {card.label}
              </p>
              <div className="mt-4 text-3xl font-semibold text-cloud">{card.value}</div>
              <p className="mt-2 text-sm text-cloud/60">{card.note}</p>
            </div>
          ))}
        </section>

        <section className="mt-12 rounded-2xl border border-white/10 bg-surface/80 p-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold">Segments</h2>
              <p className="mt-2 text-sm text-cloud/70">
                Slice results by market, tier, and edge band to validate pricing logic.
              </p>
            </div>

            {/* Filter controls */}
            <div className="flex flex-wrap gap-3 items-center">
              {/* Sport select */}
              <select
                value={filterSport}
                onChange={(e) => setFilterSport(e.target.value)}
                className="rounded-full border border-white/15 bg-night/60 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-cloud/70 focus:outline-none"
              >
                <option value="">All Sports</option>
                <option value="NHL">NHL</option>
                <option value="NBA">NBA</option>
                <option value="NCAAM">NCAAM</option>
              </select>

              {/* Card category select */}
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="rounded-full border border-white/15 bg-night/60 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-cloud/70 focus:outline-none"
              >
                <option value="">All Types</option>
                <option value="driver">Driver</option>
                <option value="call">Call</option>
              </select>

              {/* 60% confidence toggle */}
              <button
                type="button"
                onClick={() => setFilterHighConf((v) => !v)}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] transition-colors ${
                  filterHighConf
                    ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-300'
                    : 'border-white/15 bg-night/60 text-cloud/60'
                }`}
              >
                60%+ Confidence
              </button>

              {/* Reset */}
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => { setFilterSport(''); setFilterCategory(''); setFilterHighConf(false); }}
                  className="rounded-full border border-white/10 bg-night/40 px-3 py-1.5 text-xs text-cloud/40 hover:text-cloud/60"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="mt-6 overflow-hidden rounded-xl border border-white/10">
            {/* 6-column header: Segment | Type | Plays | Win Rate | ROI | Avg Edge */}
            <div className="grid grid-cols-6 gap-4 bg-night/70 px-4 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-cloud/60">
              <span>Segment</span>
              <span>Type</span>
              <span>Plays</span>
              <span>Win Rate</span>
              <span>ROI</span>
              <span>Avg Edge</span>
            </div>
            {segments.length === 0 ? (
              <div className="px-4 py-6 text-sm text-cloud/60">
                No graded segments yet. This table populates automatically once plays are graded.
              </div>
            ) : (
              <div className="divide-y divide-white/10">
                {segments.map((row) => {
                  const total = row.wins + row.losses + row.pushes;
                  const winRate = row.wins + row.losses > 0 ? row.wins / (row.wins + row.losses) : 0;
                  const isHighWinRate = winRate >= 0.6;
                  return (
                    <div
                      key={`${row.sport}-${row.cardCategory}`}
                      className={`grid grid-cols-6 gap-4 px-4 py-3 text-sm ${isHighWinRate ? 'bg-emerald-500/10' : ''}`}
                    >
                      <span className="text-cloud/70">{row.sport}</span>
                      <span className="text-cloud/70 capitalize">{row.cardCategory}</span>
                      <span className="text-cloud/70">{total}</span>
                      <span className={isHighWinRate ? 'text-emerald-300' : 'text-cloud/70'}>
                        {formatPercent(winRate)}
                      </span>
                      <span className="text-cloud/70">{formatUnits(row.totalPnlUnits)}</span>
                      <span className="text-cloud/70">N/A</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="mt-12 rounded-2xl border border-white/10 bg-surface/80 p-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold">Play Ledger</h2>
              <p className="mt-2 text-sm text-cloud/70">
                A full audit trail of every logged call, sortable and exportable.
              </p>
            </div>
            <button
              type="button"
              className="rounded-full border border-white/20 bg-night/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-cloud/60"
            >
              Export CSV
            </button>
          </div>

          <div className="mt-6 overflow-hidden rounded-xl border border-white/10">
            <div className="grid grid-cols-8 gap-4 bg-night/70 px-4 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-cloud/60">
              <span>Date</span>
              <span>Sport</span>
              <span>Matchup</span>
              <span>Market</span>
              <span>Pick</span>
              <span>Price</span>
              <span>Confidence</span>
              <span>Result</span>
            </div>
            {ledger.length === 0 ? (
              <div className="px-4 py-6 text-sm text-cloud/60">
                No plays logged yet. Once the board fires, every call will appear here.
              </div>
            ) : (
              <div className="divide-y divide-white/10">
                {ledger.map((row) => (
                  <div key={row.id} className="grid grid-cols-8 gap-4 px-4 py-3 text-sm text-cloud/70">
                    <span>{row.settledAt ? row.settledAt.split('T')[0] : '--'}</span>
                    <span>{row.sport}</span>
                    <span>{row.homeTeam && row.awayTeam ? `${row.awayTeam} @ ${row.homeTeam}` : '--'}</span>
                    <span>{row.market || '--'}</span>
                    <span>{row.prediction || '--'}</span>
                    <span>{row.price !== null ? String(row.price) : '--'}</span>
                    <span>{row.confidencePct !== null ? `${row.confidencePct}%` : '--'}</span>
                    <span>{row.result ? row.result.toUpperCase() : '--'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="mt-12 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-6 text-sm text-emerald-100">
          <h2 className="text-lg font-semibold text-emerald-100">Data Integrity</h2>
          <ul className="mt-3 space-y-2 text-emerald-100/80">
            <li>Calls are stored at decision time with the exact odds snapshot.</li>
            <li>Results are graded automatically from final scores.</li>
            <li>Historical edges are never recalculated.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
