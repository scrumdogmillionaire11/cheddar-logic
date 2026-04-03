'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { StickyBackButton } from '@/components/sticky-back-button';

type ResultsSummary = {
  totalCards: number;
  settledCards: number;
  wins: number;
  losses: number;
  pushes: number;
  totalPnlUnits: number | null;
  winRate: number;
  avgPnl: number | null;
};

type SegmentRow = {
  sport: string;
  cardType: string;
  cardFamily: string;
  modelFamily: string;
  modelVersion: string;
  cardCategory: string;
  recommendedBetType: string;
  settledCards: number;
  wins: number;
  losses: number;
  pushes: number;
  totalPnlUnits: number | null;
  segmentId: DecisionSegmentId;
  segmentLabel: 'PLAY' | 'SLIGHT EDGE';
  decisionTier?: 'PLAY' | 'LEAN';
};

type DecisionSegmentId = 'play' | 'slight_edge';

type SegmentFamily = {
  segmentId: DecisionSegmentId;
  segmentLabel: 'PLAY' | 'SLIGHT EDGE';
  settledCards: number;
};

type LedgerRow = {
  id: string;
  gameId: string;
  sport: string;
  cardType: string;
  result: string | null;
  pnlUnits: number | null;
  settledAt: string | null;
  gameTimeUtc: string | null;
  createdAt: string | null;
  prediction: string | null;
  tier: string | null;
  market: string | null;
  marketType?: string | null;
  selection?: string | null;
  marketSelectionLabel?: string | null;
  line?: number | null;
  marketKey?: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  marketPeriodToken?: string | null;
  price: number | null;
  confidencePct: number | null;
  payloadParseError: boolean;
  payloadMissing?: boolean;
  // WI-0383: 1P and full-game projection totals for NHL cards
  projection1p?: number | null;
  projectionTotal?: number | null;
  decisionTier?: 'PLAY' | 'LEAN' | null;
  decisionLabel?: string | null;
  cardFamily?: string | null;
  modelFamily?: string | null;
};

type ProjectionSummaryRow = {
  actualsAvailable: boolean;
  bias: number | null;
  cardFamily: string;
  directionalAccuracy: number | null;
  familyLabel: string;
  mae: number | null;
  rowsSeen: number;
  sampleSize: number;
};

type ResultsResponse = {
  success: boolean;
  withoutOddsMode?: boolean;
  data?: {
    summary: ResultsSummary;
    segments: SegmentRow[];
    segmentFamilies?: SegmentFamily[];
    projectionSummaries?: ProjectionSummaryRow[];
    ledger: LedgerRow[];
    filters?: {
      sport: string | null;
      cardCategory: string | null;
      minConfidence: number | null;
      market: string | null;
      includeOrphaned?: boolean;
      dedupe?: boolean;
    };
    meta?: {
      totalSettled: number;
      withPayloadSettled: number;
      orphanedSettled: number;
      filteredCount: number;
      returnedCount: number;
      includeOrphaned: boolean;
      dedupe: boolean;
    };
  };
  error?: string;
};

type ResultsMeta = NonNullable<ResultsResponse['data']>['meta'];

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || isNaN(value)) return 'N/A';
  return `${(value * 100).toFixed(1)}%`;
}

function formatUnits(value: number | null | undefined) {
  if (value === null || value === undefined || isNaN(value)) return 'N/A';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}u`;
}

function formatDecimal(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}`;
}

function formatLedgerDate(value: string | null | undefined) {
  if (!value) return '--';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '--';
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatPrice(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  return value > 0 ? `+${value}` : String(value);
}

function formatLabel(value: string | null | undefined) {
  if (!value) return '--';
  return value.replace(/_/g, ' ');
}

function formatMarketSelectionLabel(row: LedgerRow) {
  return row.marketSelectionLabel || '--';
}

function isFirstPeriodRow(row: LedgerRow) {
  return row.marketPeriodToken === '1P';
}

function renderPeriodBadge(row: LedgerRow) {
  if (!isFirstPeriodRow(row)) return null;
  return (
    <span className="rounded-full border border-cyan-400/35 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">
      1P
    </span>
  );
}

function normalizeResult(
  result: string | null | undefined,
): 'WIN' | 'LOSS' | 'PUSH' | 'PENDING' {
  const value = (result || '').toLowerCase();
  if (value === 'win') return 'WIN';
  if (value === 'loss') return 'LOSS';
  if (value === 'push') return 'PUSH';
  return 'PENDING';
}

function resultBadgeClass(result: 'WIN' | 'LOSS' | 'PUSH' | 'PENDING') {
  if (result === 'WIN')
    return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200';
  if (result === 'LOSS')
    return 'border-rose-500/40 bg-rose-500/15 text-rose-200';
  if (result === 'PUSH')
    return 'border-amber-500/40 bg-amber-500/15 text-amber-200';
  return 'border-white/20 bg-white/5 text-cloud/60';
}

function roiTextClass(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value))
    return 'text-cloud/70';
  if (value > 0) return 'text-emerald-300';
  if (value < 0) return 'text-rose-300';
  return 'text-cloud/70';
}

const SEGMENT_DEFINITIONS: SegmentFamily[] = [
  {
    segmentId: 'play',
    segmentLabel: 'PLAY',
    settledCards: 0,
  },
  {
    segmentId: 'slight_edge',
    segmentLabel: 'SLIGHT EDGE',
    settledCards: 0,
  },
];

export default function ResultsPage() {
  const [summary, setSummary] = useState<ResultsSummary | null>(null);
  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [projectionSummaries, setProjectionSummaries] = useState<ProjectionSummaryRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [withoutOddsMode, setWithoutOddsMode] = useState(false);

  // Filter state
  const [filterSport, setFilterSport] = useState<string>('');
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterHighConf, setFilterHighConf] = useState<boolean>(false);
  const [filterMarket, setFilterMarket] = useState<string>('');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState<boolean>(false);
  const [dataMeta, setDataMeta] = useState<ResultsMeta | null>(null);
  const includeOrphanedValue = '0';
  const dedupeValue = '1';

  const loadResults = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (filterSport) params.set('sport', filterSport);
      if (filterCategory) params.set('card_category', filterCategory);
      if (filterHighConf) params.set('min_confidence', '60');
      if (filterMarket) params.set('market', filterMarket);
      if (includeOrphanedValue !== null)
        params.set('include_orphaned', includeOrphanedValue);
      if (dedupeValue !== null) params.set('dedupe', dedupeValue);
      const response = await fetch(`/api/results?${params.toString()}`);

      if (!response.ok) {
        setError(`API error: ${response.status} ${response.statusText}`);
        return;
      }

      let payload: ResultsResponse;
      try {
        payload = await response.json();
      } catch {
        setError('Failed to parse API response');
        return;
      }

      if (payload.withoutOddsMode) {
        setWithoutOddsMode(true);
        setError(null);
        return;
      }

      if (!payload.success || !payload.data) {
        setError(payload.error || 'Failed to load results');
        return;
      }

      setSummary(payload.data.summary);
      setSegments(payload.data.segments);
      setProjectionSummaries(payload.data.projectionSummaries ?? []);
      setLedger(payload.data.ledger);
      setDataMeta(payload.data.meta || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [
    filterSport,
    filterCategory,
    filterHighConf,
    filterMarket,
    includeOrphanedValue,
    dedupeValue,
  ]);

  useEffect(() => {
    loadResults();
  }, [loadResults]);

  const summaryCards = useMemo(() => {
    const isValidSummary = summary && typeof summary.totalCards === 'number';
    const record = summary
      ? `${summary.wins}-${summary.losses}${summary.pushes > 0 ? `-${summary.pushes}` : ''}`
      : 'N/A';
    return [
      {
        label: 'Betting Record',
        value: record,
        note: `ODDS_BACKED only · ${isValidSummary ? formatPercent(summary.winRate) : 'N/A'} win rate`,
      },
      {
        label: 'Units',
        value: isValidSummary ? formatUnits(summary.totalPnlUnits) : 'N/A',
        note: `${isValidSummary ? String(summary.settledCards) : 'N/A'} settled bets`,
      },
      {
        label: 'ROI',
        value: isValidSummary ? formatPercent(summary.avgPnl) : 'N/A',
        note: 'Per 1u stake',
      },
    ];
  }, [summary]);

  const hasActiveFilters =
    filterSport || filterCategory || filterHighConf || filterMarket;
  const activeFilterCount =
    Number(Boolean(filterSport)) +
    Number(Boolean(filterCategory)) +
    Number(Boolean(filterHighConf)) +
    Number(Boolean(filterMarket));
  const clearAllFilters = () => {
    setFilterSport('');
    setFilterCategory('');
    setFilterHighConf(false);
    setFilterMarket('');
  };
  const mobileRecord = summary
    ? `${summary.wins}-${summary.losses}${summary.pushes > 0 ? `-${summary.pushes}` : ''}`
    : '--';
  const visibleLedger = ledger.filter((row) => !row.payloadMissing);
  const segmentFamilies = useMemo(() => {
    if (!summary) return SEGMENT_DEFINITIONS;
    const counts = new Map<DecisionSegmentId, number>();
    for (const row of segments) {
      const id = row.segmentId || 'play';
      counts.set(id, (counts.get(id) || 0) + row.settledCards);
    }
    return SEGMENT_DEFINITIONS.map((segment) => ({
      ...segment,
      settledCards: counts.get(segment.segmentId) || 0,
    }));
  }, [summary, segments]);
  const segmentsByFamily = useMemo(() => {
    const grouped: Record<DecisionSegmentId, SegmentRow[]> = {
      play: [],
      slight_edge: [],
    };
    for (const row of segments) {
      const id = row.segmentId || 'play';
      grouped[id].push(row);
    }
    return grouped;
  }, [segments]);

  return (
    <div className="min-h-screen bg-night text-cloud">
      <StickyBackButton
        fallbackHref="/"
        fallbackLabel="Home"
        showAfterPx={120}
      />

      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute left-1/2 top-0 h-96 w-96 -translate-x-1/2 rounded-full bg-emerald-500/10 blur-[120px]" />
        <div className="pointer-events-none absolute -left-20 top-40 h-80 w-80 rounded-full bg-cyan-400/10 blur-[140px]" />
      </div>

      <div className="relative mx-auto max-w-6xl px-6 py-12">
        <div className="mb-8">
          <Link
            href="/"
            className="hidden text-sm text-cloud/60 hover:text-cloud/80 md:inline-flex"
          >
            &larr; Back to Home
          </Link>
        </div>

        <header className="mb-10 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-cloud/50">
            Accountability Ledger
          </p>
          <h1 className="font-display text-4xl font-semibold sm:text-5xl">
            Results
          </h1>
          <p className="max-w-2xl text-lg text-cloud/70">
            Every call is logged at decision time and graded after the final
            whistle. No recomputation, no deletions, no retroactive edits.
          </p>
          {error ? <p className="text-sm text-rose-200">{error}</p> : null}
          {loading ? (
            <p className="text-sm text-cloud/50">Loading results...</p>
          ) : null}
          {!loading && withoutOddsMode ? (
            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-200">
              <p className="font-semibold">Without Odds Mode — settlement disabled</p>
              <p className="mt-1 text-amber-200/70">
                Results tracking is unavailable. Cards show projection-only model
                views backed by ESPN direct data, not market odds. No settlement
                runs while this mode is active.
              </p>
            </div>
          ) : null}
          {!loading && dataMeta ? (
            <p className="text-xs text-cloud/50">
              Dev view: include orphaned{' '}
              {dataMeta.includeOrphaned ? 'on' : 'off'} · dedupe{' '}
              {dataMeta.dedupe ? 'on' : 'off'} · returned{' '}
              {dataMeta.returnedCount} / filtered {dataMeta.filteredCount} /
              settled {dataMeta.totalSettled}
            </p>
          ) : null}
        </header>

        <section className="sticky top-0 z-10 mb-6 rounded-xl border border-white/10 bg-night/85 px-4 py-3 backdrop-blur md:hidden">
          <div className="flex items-center justify-between text-sm">
            <span className="text-cloud/70">Betting Record</span>
            <span className="font-semibold text-cloud">{mobileRecord}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs text-cloud/60">
            <span>Units</span>
            <span className={roiTextClass(summary?.totalPnlUnits)}>
              {summary ? formatUnits(summary.totalPnlUnits) : 'N/A'}
            </span>
          </div>
        </section>

        <section>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold">Betting Record</h2>
              <p className="mt-2 text-sm text-cloud/70">
                Profit/loss is computed from ODDS_BACKED settled bets only.
                Projection-only rows are excluded from all W-L and units
                totals.
              </p>
            </div>
            <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
              ODDS_BACKED
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {summaryCards.map((card) => (
              <div
                key={card.label}
                className="rounded-2xl border border-white/10 bg-surface/80 p-6 shadow-[0_0_40px_rgba(0,0,0,0.3)]"
              >
                <p className="text-xs uppercase tracking-[0.25em] text-cloud/50">
                  {card.label}
                </p>
                <div className="mt-4 text-3xl font-semibold text-cloud">
                  {card.value}
                </div>
                <p className="mt-2 text-sm text-cloud/60">{card.note}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-12 rounded-2xl border border-white/10 bg-surface/80 p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold">Betting Decision Tiers</h2>
              <p className="mt-2 text-sm text-cloud/70">
                ODDS_BACKED PLAY and SLIGHT EDGE outcomes reconcile directly to
                the Betting Record summary above.
              </p>
            </div>

            {/* Filter controls */}
            <button
              type="button"
              onClick={() => setMobileFiltersOpen((open) => !open)}
              className="rounded-full border border-white/15 bg-night/60 px-4 py-2 text-xs font-semibold tracking-[0.08em] text-cloud/70 md:hidden"
            >
              Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
            </button>

            <div className="hidden flex-wrap items-center gap-3 md:flex">
              {/* Sport select */}
              <select
                value={filterSport}
                onChange={(e) => setFilterSport(e.target.value)}
                className="rounded-full border border-white/15 bg-night/60 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-cloud/70 focus:outline-none"
              >
                <option value="">All Sports</option>
                <option value="NHL">NHL</option>
                <option value="NBA">NBA</option>
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

              {/* Market select */}
              <select
                value={filterMarket}
                onChange={(e) => setFilterMarket(e.target.value)}
                className="rounded-full border border-white/15 bg-night/60 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-cloud/70 focus:outline-none"
              >
                <option value="">All Markets</option>
                <option value="moneyline">Moneyline</option>
                <option value="spread">Spread</option>
                <option value="total">Total</option>
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
                  onClick={clearAllFilters}
                  className="rounded-full border border-white/10 bg-night/40 px-3 py-1.5 text-xs text-cloud/40 hover:text-cloud/60"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {mobileFiltersOpen ? (
            <div className="mt-4 rounded-xl border border-white/10 bg-night/40 p-4 md:hidden">
              <div className="grid gap-3">
                <select
                  value={filterSport}
                  onChange={(e) => setFilterSport(e.target.value)}
                  className="rounded-lg border border-white/15 bg-night/60 px-3 py-2 text-sm text-cloud/80 focus:outline-none"
                >
                  <option value="">All Sports</option>
                  <option value="NHL">NHL</option>
                  <option value="NBA">NBA</option>
                </select>
                <select
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value)}
                  className="rounded-lg border border-white/15 bg-night/60 px-3 py-2 text-sm text-cloud/80 focus:outline-none"
                >
                  <option value="">All Types</option>
                  <option value="driver">Driver</option>
                  <option value="call">Call</option>
                </select>
                <select
                  value={filterMarket}
                  onChange={(e) => setFilterMarket(e.target.value)}
                  className="rounded-lg border border-white/15 bg-night/60 px-3 py-2 text-sm text-cloud/80 focus:outline-none"
                >
                  <option value="">All Markets</option>
                  <option value="moneyline">Moneyline</option>
                  <option value="spread">Spread</option>
                  <option value="total">Total</option>
                </select>
                <button
                  type="button"
                  onClick={() => setFilterHighConf((v) => !v)}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                    filterHighConf
                      ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-300'
                      : 'border-white/15 bg-night/60 text-cloud/60'
                  }`}
                >
                  60%+ Confidence
                </button>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={clearAllFilters}
                    className="rounded-lg border border-white/15 bg-night/60 px-3 py-2 text-sm text-cloud/70"
                  >
                    Clear Filters
                  </button>
                )}
              </div>
            </div>
          ) : null}

          <div className="mt-6 space-y-8">
            {segmentFamilies.map((family) => {
              const familyRows = segmentsByFamily[family.segmentId] || [];
              return (
                <div key={family.segmentId}>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3 className="text-lg font-semibold text-cloud">
                      {family.segmentLabel}
                    </h3>
                    <span className="text-xs uppercase tracking-[0.2em] text-cloud/50">
                      {family.settledCards} settled
                    </span>
                  </div>

                  <div className="hidden overflow-hidden rounded-xl border border-white/10 md:block">
                    <div className="grid grid-cols-6 gap-4 bg-night/70 px-4 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-cloud/60">
                      <span>Sport</span>
                      <span>Family</span>
                      <span>Engine</span>
                      <span>Plays</span>
                      <span>Win Rate</span>
                      <span>ROI</span>
                    </div>
                    {familyRows.length === 0 ? (
                      <div className="px-4 py-6 text-sm text-cloud/60">
                        No graded rows yet for this decision tier.
                      </div>
                    ) : (
                      <div className="divide-y divide-white/10">
                        {familyRows.map((row) => {
                          const total = row.wins + row.losses + row.pushes;
                          const winRate =
                            row.wins + row.losses > 0
                              ? row.wins / (row.wins + row.losses)
                              : 0;
                          const isHighWinRate = winRate >= 0.6;
                          return (
                            <div
                              key={`${family.segmentId}-${row.sport}-${row.cardFamily}-${row.recommendedBetType}`}
                              className={`grid grid-cols-6 gap-4 px-4 py-3 text-sm ${isHighWinRate ? 'bg-emerald-500/10' : ''}`}
                            >
                              <span className="text-cloud/70">{row.sport}</span>
                              <span className="text-cloud/70">
                                {row.cardFamily}
                              </span>
                              <span className="text-cloud/70">
                                {row.modelFamily || '--'}
                              </span>
                              <span className="text-cloud/70">{total}</span>
                              <span
                                className={
                                  isHighWinRate
                                    ? 'text-emerald-300'
                                    : 'text-cloud/70'
                                }
                              >
                                {formatPercent(winRate)}
                              </span>
                              <span className={roiTextClass(row.totalPnlUnits)}>
                                {formatUnits(row.totalPnlUnits)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="mt-3 space-y-3 md:hidden">
                    {familyRows.length === 0 ? (
                      <div className="rounded-xl border border-white/10 bg-night/30 px-4 py-6 text-sm text-cloud/60">
                        No graded rows yet for this decision tier.
                      </div>
                    ) : (
                      familyRows.map((row) => {
                        const total = row.wins + row.losses + row.pushes;
                        const winRate =
                          row.wins + row.losses > 0
                            ? row.wins / (row.wins + row.losses)
                            : 0;
                        return (
                          <article
                            key={`${family.segmentId}-${row.sport}-${row.cardFamily}-${row.recommendedBetType}-mobile`}
                            className="rounded-xl border border-white/10 bg-night/40 px-4 py-4"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="text-sm font-semibold text-cloud">
                                  {row.sport} -{' '}
                                  <span className="text-cloud/75">
                                    {row.cardFamily}
                                  </span>
                                </p>
                                <p className="mt-1 text-xs text-cloud/60">
                                  {row.modelFamily || '--'}
                                </p>
                              </div>
                              <span
                                className={`text-sm font-semibold ${roiTextClass(row.totalPnlUnits)}`}
                              >
                                {formatUnits(row.totalPnlUnits)}
                              </span>
                            </div>
                            <div className="mt-3 grid grid-cols-3 gap-2">
                              <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-center">
                                <p className="text-base font-semibold text-cloud">
                                  {total}
                                </p>
                                <p className="text-[11px] text-cloud/50">Plays</p>
                              </div>
                              <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-center">
                                <p className="text-base font-semibold text-cloud">
                                  {formatPercent(winRate)}
                                </p>
                                <p className="text-[11px] text-cloud/50">Win Rate</p>
                              </div>
                              <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-center">
                                <p
                                  className={`text-base font-semibold ${roiTextClass(row.totalPnlUnits)}`}
                                >
                                  {formatUnits(row.totalPnlUnits)}
                                </p>
                                <p className="text-[11px] text-cloud/50">ROI</p>
                              </div>
                            </div>
                          </article>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {projectionSummaries.length > 0 && (
          <section className="mt-12 rounded-2xl border border-white/10 bg-surface/80 p-8">
            <h2 className="text-2xl font-semibold">Projection Model Accuracy</h2>
            <p className="mt-2 text-sm text-cloud/70">
              Projection-only markets tracked separately — no P&amp;L, just model
              accuracy versus actuals.
            </p>
            <div className="mt-6 overflow-hidden rounded-xl border border-white/10">
              <div className="grid grid-cols-5 gap-4 bg-night/70 px-4 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-cloud/60">
                <span>Model</span>
                <span>Sample</span>
                <span>MAE</span>
                <span>Bias</span>
                <span>Dir. Acc.</span>
              </div>
              <div className="divide-y divide-white/10">
                {projectionSummaries.map((row) => (
                  <div
                    key={row.cardFamily}
                    className="grid grid-cols-5 gap-4 px-4 py-3 text-sm text-cloud/70"
                  >
                    <span className="font-medium text-cloud">{row.familyLabel}</span>
                    <span>{row.sampleSize > 0 ? row.sampleSize : '—'}</span>
                    <span>
                      {row.mae !== null ? formatDecimal(row.mae, 2) : '—'}
                    </span>
                    <span>
                      {row.bias !== null ? formatDecimal(row.bias, 2) : '—'}
                    </span>
                    <span>
                      {row.actualsAvailable && row.directionalAccuracy !== null
                        ? formatPercent(row.directionalAccuracy)
                        : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        <section className="mt-12 rounded-2xl border border-white/10 bg-surface/80 p-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold">Betting Ledger</h2>
              <p className="mt-2 text-sm text-cloud/70">
                A full audit trail of odds-backed calls only. Projection-only
                model accuracy is tracked in the section above.
              </p>
            </div>
            <button
              type="button"
              className="rounded-full border border-white/20 bg-night/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-cloud/60"
            >
              Export CSV
            </button>
          </div>

          <div className="mt-6 hidden overflow-hidden rounded-xl border border-white/10 md:block">
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
            {visibleLedger.length === 0 ? (
              <div className="px-4 py-6 text-sm text-cloud/60">
                No plays logged yet. Once the board fires, every call will
                appear here.
              </div>
            ) : (
              <div className="divide-y divide-white/10">
                {visibleLedger.map((row) => {
                  const outcome = normalizeResult(row.result);
                  return (
                    <div
                      key={row.id}
                      className="grid grid-cols-8 gap-4 px-4 py-3 text-sm text-cloud/70"
                    >
                      <span>
                        {formatLedgerDate(
                          row.gameTimeUtc || row.createdAt || row.settledAt,
                        )}
                      </span>
                      <span className="inline-flex items-center gap-2">
                        <span>{row.sport}</span>
                        {renderPeriodBadge(row)}
                      </span>
                      <span>
                        {row.homeTeam && row.awayTeam
                          ? `${row.awayTeam} @ ${row.homeTeam}`
                          : '--'}
                      </span>
                      <span>{formatMarketSelectionLabel(row)}</span>
                      <span>
                        {row.prediction || '--'}
                        {row.sport === 'NHL' &&
                        (row.projection1p != null ||
                          row.projectionTotal != null) ? (
                          <span className="block text-xs text-cloud/50 mt-0.5">
                            {row.projectionTotal != null
                              ? `Tot: ${row.projectionTotal.toFixed(2)}`
                              : ''}
                            {row.projection1p != null
                              ? ` · 1P: ${row.projection1p.toFixed(2)}`
                              : ''}
                          </span>
                        ) : null}
                      </span>
                      <span>{formatPrice(row.price)}</span>
                      <span className="font-semibold">
                        {row.confidencePct !== null
                          ? `${row.confidencePct}%`
                          : '--'}
                      </span>
                      <span>
                        <span
                          className={`rounded-full border px-2 py-1 text-xs font-semibold ${resultBadgeClass(outcome)}`}
                        >
                          {outcome}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-6 space-y-3 md:hidden">
            {visibleLedger.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-night/30 px-4 py-6 text-sm text-cloud/60">
                No plays logged yet. Once the board fires, every call will
                appear here.
              </div>
            ) : (
              visibleLedger.map((row) => {
                const outcome = normalizeResult(row.result);
                const matchup =
                  row.homeTeam && row.awayTeam
                    ? `${row.awayTeam} @ ${row.homeTeam}`
                    : '--';
                const prediction = row.prediction || '--';
                const marketLabel = formatMarketSelectionLabel(row);
                const predictionLine =
                  `${marketLabel} ${row.price !== null ? `(${formatPrice(row.price)})` : ''}`.trim();
                return (
                  <details
                    key={`${row.id}-mobile`}
                    className="rounded-xl border border-white/10 bg-night/35"
                  >
                    <summary className="cursor-pointer list-none px-4 py-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="inline-flex items-center gap-2 text-xs text-cloud/55">
                          {formatLedgerDate(
                            row.gameTimeUtc || row.createdAt || row.settledAt,
                          )}{' '}
                          ·{' '}
                          <span>{row.sport}</span>
                          {renderPeriodBadge(row)}
                        </p>
                        <span
                          className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${resultBadgeClass(outcome)}`}
                        >
                          {outcome}
                        </span>
                      </div>
                      <p className="mt-1 text-sm font-semibold text-cloud">
                        {matchup}
                      </p>
                      <p className="mt-1 text-sm text-cloud/75">
                        {predictionLine}
                      </p>
                      <div className="mt-2 flex items-center gap-3 text-xs">
                        <span className="font-semibold text-cloud">
                          {row.confidencePct !== null
                            ? `${row.confidencePct}%`
                            : '--'}
                        </span>
                        <span className="text-cloud/50">Confidence</span>
                        <span className={roiTextClass(row.pnlUnits)}>
                          {formatUnits(row.pnlUnits)}
                        </span>
                      </div>
                    </summary>
                    <div className="grid grid-cols-2 gap-3 border-t border-white/10 px-4 py-3 text-xs">
                      <div>
                        <p className="text-cloud/50">Market</p>
                        <p className="mt-0.5 text-cloud/80">{marketLabel}</p>
                      </div>
                      <div>
                        <p className="text-cloud/50">Pick</p>
                        <p className="mt-0.5 text-cloud/80">{prediction}</p>
                      </div>
                      <div>
                        <p className="text-cloud/50">Price</p>
                        <p className="mt-0.5 text-cloud/80">
                          {formatPrice(row.price)}
                        </p>
                      </div>
                      <div>
                        <p className="text-cloud/50">Card Type</p>
                        <p className="mt-0.5 text-cloud/80">
                          {formatLabel(row.cardType)}
                        </p>
                      </div>
                      {row.sport === 'NHL' &&
                      (row.projection1p != null ||
                        row.projectionTotal != null) ? (
                        <div>
                          <p className="text-cloud/50">Projection</p>
                          <p className="mt-0.5 text-cloud/80 text-xs">
                            {row.projectionTotal != null
                              ? `Total: ${row.projectionTotal.toFixed(2)}`
                              : '--'}
                            {row.projection1p != null
                              ? ` | 1P: ${row.projection1p.toFixed(2)}`
                              : ''}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  </details>
                );
              })
            )}
          </div>
        </section>

        <section className="mt-12 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-6 text-sm text-emerald-100">
          <h2 className="text-lg font-semibold text-emerald-100">
            Data Integrity
          </h2>
          <ul className="mt-3 space-y-2 text-emerald-100/80">
            <li>
              Calls are stored at decision time with the exact odds snapshot.
            </li>
            <li>Results are graded automatically from final scores.</li>
            <li>Historical edges are never recalculated.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
