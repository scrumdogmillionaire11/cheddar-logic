'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { StickyBackButton } from '@/components/sticky-back-button';
import { ProjectionResultsTable } from '@/components/results/ProjectionResultsTable';
import type { ProjectionProxyRow } from '@/app/api/results/projection-settled/route';
import {
  normalizeToConfidenceTier,
  type ConfidenceTier,
  type ProjectionAccuracyRecord,
  type ProjectionAccuracyResponse,
} from '@/lib/types/projection-accuracy';
import {
  PROJECTION_RESULTS_FAMILY_OPTIONS as FAMILY_OPTIONS,
  PROJECTION_RESULTS_FAMILY_TOKEN_ALIASES as FAMILY_TOKEN_ALIASES,
  PROJECTION_RESULTS_SUPPORTED_FAMILY_SET as SUPPORTED_FAMILY_SET,
  type FamilyOption,
} from '@/lib/results/projection-results-contract';

type ProjectionConfidenceFilter = 'ALL' | ConfidenceTier;

type ProjectionSettledResponse = {
  success: boolean;
  data?: {
    settledRows: ProjectionProxyRow[];
    totalSettled: number;
    actualsReady: boolean;
  };
  error?: string;
};

function normalizeFamily(value: string | null | undefined) {
  const token = String(value || '').trim().toUpperCase();
  return FAMILY_TOKEN_ALIASES[token] || token;
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return `${(value * 100).toFixed(1)}%`;
}

function formatDecimal(
  value: number | null | undefined,
  digits = 1,
  options: { signed?: boolean } = {},
) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  const { signed = true } = options;
  if (!signed) return Math.abs(value).toFixed(digits);
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}`;
}

function marketHealthLabel(status: string | null | undefined) {
  if (status === 'NOISE') return 'direction not trusted';
  if (status === 'WATCH') return 'confidence bands need more separation';
  if (status === 'TRUSTED') return 'directional signal usable';
  if (status === 'SHARP') return 'directional signal is leading';
  return 'awaiting 25 graded directional rows';
}

function marketHealthClass(status: string | null | undefined) {
  if (status === 'NOISE') return 'text-rose-200';
  if (status === 'WATCH') return 'text-amber-200';
  if (status === 'TRUSTED') return 'text-emerald-200';
  if (status === 'SHARP') return 'text-cyan-200';
  return 'text-cloud/60';
}

function hasDisplaySignal(row: ProjectionProxyRow): boolean {
  const family = normalizeFamily(row.cardFamily);
  const isMoneylineFamily =
    family === 'MLB_F5_ML' || family === 'MLB_F5_MONEYLINE';
  if (!isMoneylineFamily) return true;
  if (row.predictionSignalMissing) return false;
  return typeof row.winProbability === 'number' && Number.isFinite(row.winProbability);
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return '--';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function confidenceTierBandClass(tier: ConfidenceTier, active: boolean): string {
  if (tier === 'HIGH') {
    return active
      ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-200'
      : 'border-emerald-400/20 bg-emerald-500/10 text-emerald-300/70 hover:border-emerald-400/40';
  }
  if (tier === 'MED') {
    return active
      ? 'border-amber-400/50 bg-amber-500/20 text-amber-200'
      : 'border-amber-400/20 bg-amber-500/10 text-amber-300/70 hover:border-amber-400/40';
  }
  return active
    ? 'border-white/25 bg-white/10 text-cloud/80'
    : 'border-white/10 bg-white/5 text-cloud/50 hover:border-white/20';
}

function confidencePillClass(active: boolean) {
  return active
    ? 'border-emerald-400/40 bg-emerald-400/15 text-emerald-200'
    : 'border-white/10 bg-night/40 text-cloud/60';
}

function familyPillClass(active: boolean) {
  return active
    ? 'border-cyan-400/45 bg-cyan-400/15 text-cyan-100'
    : 'border-white/10 bg-night/40 text-cloud/60 hover:border-white/20';
}

function average(values: Array<number | null | undefined>) {
  const finite = values.filter(
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value),
  );
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function familyLabel(family: string) {
  if (family === 'NHL_1P_TOTAL') return 'NHL 1P';
  if (family === 'MLB_F5_TOTAL') return 'MLB F5 Total';
  if (family === 'MLB_F5_ML' || family === 'MLB_F5_MONEYLINE') {
    return 'MLB F5 Moneyline';
  }
  return family.replaceAll('_', ' ');
}

export function ProjectionAccuracyClient() {
  const [settledRows, setSettledRows] = useState<ProjectionProxyRow[]>([]);
  const [accuracy, setAccuracy] = useState<ProjectionAccuracyResponse | null>(null);
  const [actualsReady, setActualsReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFamilyId, setSelectedFamilyId] = useState('ALL');
  const [confidenceFilter, setConfidenceFilter] =
    useState<ProjectionConfidenceFilter>('ALL');
  const [expandedConfidenceBand, setExpandedConfidenceBand] =
    useState<ConfidenceTier | null>(null);
  const [expandedRangeFamilies, setExpandedRangeFamilies] = useState<Set<string>>(
    () => new Set(),
  );

  const loadProjectionResults = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [settledResponse, accuracyResponse] = await Promise.all([
        fetch('/api/results/projection-settled'),
        fetch('/api/results/projection-accuracy'),
      ]);

      if (!settledResponse.ok) {
        throw new Error(
          `Projection settlement API error: ${settledResponse.status}`,
        );
      }
      if (!accuracyResponse.ok) {
        throw new Error(
          `Projection accuracy API error: ${accuracyResponse.status}`,
        );
      }

      const settledPayload =
        (await settledResponse.json()) as ProjectionSettledResponse;
      const accuracyPayload =
        (await accuracyResponse.json()) as ProjectionAccuracyResponse;

      if (!settledPayload.success || !settledPayload.data) {
        throw new Error(settledPayload.error || 'Failed to load projection settlement');
      }

      setSettledRows(settledPayload.data.settledRows);
      setActualsReady(settledPayload.data.actualsReady);
      setAccuracy(accuracyPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjectionResults();
  }, [loadProjectionResults]);


  const selectedFamily = useMemo(
    () =>
      FAMILY_OPTIONS.find((option) => option.id === selectedFamilyId) ||
      FAMILY_OPTIONS[0],
    [selectedFamilyId],
  );

  const selectedFamilySet = useMemo(() => {
    const families =
      selectedFamily.id === 'ALL'
        ? Array.from(SUPPORTED_FAMILY_SET)
        : selectedFamily.families;
    return new Set(families);
  }, [selectedFamily]);

  const supportedSettledRows = useMemo(
    () =>
      settledRows.filter((row) => {
        const family = normalizeFamily(row.cardFamily);
        return SUPPORTED_FAMILY_SET.has(family) && hasDisplaySignal(row);
      }),
    [settledRows],
  );

  const filteredSettledRows = useMemo(
    () =>
      supportedSettledRows.filter((row) =>
        selectedFamilySet.has(normalizeFamily(row.cardFamily)),
      ),
    [selectedFamilySet, supportedSettledRows],
  );

  const filteredAccuracyRows = useMemo(() => {
    const rows = accuracy?.rows || [];
    const familyRows = rows.filter((row) =>
      selectedFamilySet.has(normalizeFamily(row.market_family)),
    );
    const settledCardIds = new Set(
      filteredSettledRows.map((row) => String(row.cardId || '').trim()),
    );
    const matchingSettledRows = familyRows.filter((row) =>
      settledCardIds.has(String(row.card_id || '').trim()),
    );
    return matchingSettledRows.length > 0 ? matchingSettledRows : familyRows;
  }, [accuracy?.rows, filteredSettledRows, selectedFamilySet]);

  const confidenceCounts = useMemo(() => {
    const counts: Record<ProjectionConfidenceFilter, number> = {
      ALL: filteredSettledRows.length,
      HIGH: 0,
      MED: 0,
      LOW: 0,
    };
    for (const row of filteredSettledRows) {
      counts[row.confidenceTier] += 1;
    }
    return counts;
  }, [filteredSettledRows]);

  const accuracySummary = useMemo(() => {
    const eligibleRows = filteredAccuracyRows.filter(
      (row) => row.weak_direction_flag !== 1,
    );
    const wins = eligibleRows.filter((row) => row.graded_result === 'WIN').length;
    const losses = eligibleRows.filter((row) => row.graded_result === 'LOSS').length;
    const pushes = eligibleRows.filter((row) => row.graded_result === 'PUSH').length;
    const noBets = eligibleRows.filter((row) => row.graded_result === 'NO_BET').length;
    const graded = wins + losses;
    const brierFromAccuracy = filteredAccuracyRows.map((row) => row.brier_score);
    const brierFromSettled = filteredSettledRows.map((row) => row.brierScore);

    return {
      wins,
      losses,
      pushes,
      noBets,
      hitRate: graded > 0 ? wins / graded : null,
      mae: average(filteredAccuracyRows.map((row) => row.abs_error)),
      bias: average(filteredAccuracyRows.map((row) => row.signed_error)),
      weakDirections: filteredAccuracyRows.filter(
        (row) => row.weak_direction_flag === 1,
      ).length,
      avgBrier: average([...brierFromAccuracy, ...brierFromSettled]),
      rows: filteredAccuracyRows.length,
    };
  }, [filteredAccuracyRows, filteredSettledRows]);

  const confidenceSummary = useMemo(() => {
    const tiers = new Map<ConfidenceTier, { wins: number; losses: number; rows: number }>([
      ['HIGH', { wins: 0, losses: 0, rows: 0 }],
      ['MED', { wins: 0, losses: 0, rows: 0 }],
      ['LOW', { wins: 0, losses: 0, rows: 0 }],
    ]);

    for (const row of filteredAccuracyRows) {
      const tier = normalizeToConfidenceTier(row.confidence_band);
      const bucket = tiers.get(tier);
      if (!bucket) continue;
      bucket.rows += 1;
      if (row.graded_result === 'WIN') bucket.wins += 1;
      if (row.graded_result === 'LOSS') bucket.losses += 1;
    }

    return Array.from(tiers.entries()).filter(([, bucket]) => bucket.rows > 0);
  }, [filteredAccuracyRows]);

  const familySummaryRows = useMemo(() => {
    const groups = new Map<string, ProjectionProxyRow[]>();
    for (const row of filteredSettledRows) {
      const family = normalizeFamily(row.cardFamily);
      const group = groups.get(family);
      if (group) group.push(row);
      else groups.set(family, [row]);
    }

    return Array.from(groups.entries()).map(([family, rows]) => {
      const isMoneylineFamily =
        family === 'MLB_F5_ML' || family === 'MLB_F5_MONEYLINE';
      const gradedRows = rows.filter(
        (row) =>
          (row.gradedResult === 'WIN' || row.gradedResult === 'LOSS') &&
          (!isMoneylineFamily || row.trackingRole === 'OFFICIAL_PICK'),
      );
      const wins = gradedRows.filter((row) => row.gradedResult === 'WIN').length;
      const losses = gradedRows.filter((row) => row.gradedResult === 'LOSS').length;
      const errorRows = rows.filter(
        (row) => Number.isFinite(row.projValue) && Number.isFinite(row.actualValue),
      );
      const mae = average(
        errorRows.map((row) =>
          Math.abs((row.projValue as number) - (row.actualValue as number)),
        ),
      );
      const bias = average(
        errorRows.map(
          (row) => (row.projValue as number) - (row.actualValue as number),
        ),
      );

      return {
        family,
        label: familyLabel(family),
        rows: wins + losses,
        wins,
        losses,
        hitRate: wins + losses > 0 ? wins / (wins + losses) : null,
        mae,
        bias,
      };
    });
  }, [filteredSettledRows]);

  const projectionRangeBreakdown = useMemo(() => {
    const BUCKET = 0.5;
    const familyBuckets = new Map<
      string,
      Map<string, { min: number; max: number; wins: number; losses: number }>
    >();

    for (const row of filteredSettledRows) {
      const family = normalizeFamily(row.cardFamily);
      if (family !== 'NHL_1P_TOTAL' && family !== 'MLB_F5_TOTAL') continue;
      if (row.gradedResult !== 'WIN' && row.gradedResult !== 'LOSS') continue;
      if (typeof row.projValue !== 'number' || !Number.isFinite(row.projValue)) continue;

      if (!familyBuckets.has(family)) familyBuckets.set(family, new Map());
      const buckets = familyBuckets.get(family)!;
      const bucketMin = Math.floor(row.projValue / BUCKET) * BUCKET;
      const key = bucketMin.toFixed(1);
      if (!buckets.has(key)) {
        buckets.set(key, { min: bucketMin, max: bucketMin + BUCKET, wins: 0, losses: 0 });
      }
      const b = buckets.get(key)!;
      if (row.gradedResult === 'WIN') b.wins++;
      else b.losses++;
    }

    return Array.from(familyBuckets.entries()).map(([family, buckets]) => ({
      family,
      label: familyLabel(family),
      buckets: Array.from(buckets.values())
        .sort((a, b) => a.min - b.min)
        .map((b) => ({
          ...b,
          total: b.wins + b.losses,
          hitRate: b.wins / (b.wins + b.losses),
        })),
    }));
  }, [filteredSettledRows]);

  const marketTrustStatus = useMemo(() => {
    if (!accuracy) return null;
    if (selectedFamily.id === 'ALL') return accuracy.summary.market_trust_status;
    const match = accuracy.marketHealth.find((row) =>
      selectedFamilySet.has(normalizeFamily(row.market_family)),
    );
    return match?.market_trust_status || accuracy.summary.market_trust_status;
  }, [accuracy, selectedFamily.id, selectedFamilySet]);

  const settledByCardId = useMemo(() => {
    const map = new Map<string, (typeof filteredSettledRows)[0]>();
    for (const row of filteredSettledRows) {
      if (row.cardId) map.set(String(row.cardId), row);
    }
    return map;
  }, [filteredSettledRows]);

  const drilldownByTier = useMemo(() => {
    const result = new Map<ConfidenceTier, { eligible: ProjectionAccuracyRecord[]; excludedCount: number }>();
    for (const tier of ['HIGH', 'MED', 'LOW'] as ConfidenceTier[]) {
      const forTier = filteredAccuracyRows.filter(
        (r) => normalizeToConfidenceTier(r.confidence_band) === tier,
      );
      const eligible = forTier.filter((r) => r.weak_direction_flag !== 1);
      result.set(tier, { eligible, excludedCount: forTier.length - eligible.length });
    }
    return result;
  }, [filteredAccuracyRows]);

  return (
    <div className="min-h-screen bg-night text-cloud">
      <StickyBackButton
        fallbackHref="/results"
        fallbackLabel="Betting Results"
        showAfterPx={120}
      />

      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute left-1/2 top-0 h-96 w-96 -translate-x-1/2 rounded-full bg-cyan-500/10 blur-[120px]" />
        <div className="pointer-events-none absolute -left-20 top-40 h-80 w-80 rounded-full bg-emerald-400/10 blur-[140px]" />
      </div>

      <div className="relative mx-auto max-w-6xl px-6 py-12">
        <div className="mb-8">
          <Link
            href="/results"
            className="hidden text-sm text-cloud/60 hover:text-cloud/80 md:inline-flex"
          >
            &larr; Betting Results
          </Link>
        </div>

        <header className="mb-10 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-cloud/50">
            Projection Accuracy
          </p>
          <h1 className="font-display text-4xl font-semibold sm:text-5xl">
            Projection Accuracy
          </h1>
          <p className="max-w-2xl text-lg text-cloud/70">
            Projection-only settlement and accuracy metrics for active NHL 1P
            and MLB F5 model families.
          </p>
          {error ? <p className="text-sm text-rose-200">{error}</p> : null}
          {loading ? (
            <p className="text-sm text-cloud/50">Loading projection results...</p>
          ) : null}
          {!loading && !actualsReady ? (
            <p className="text-sm text-amber-200">
              Actuals are not ready yet; rows will populate as projection
              outcomes are ingested.
            </p>
          ) : null}
        </header>

        <section className="rounded-2xl border border-white/10 bg-surface/80 p-5 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold">Projection Families</h2>
              <p className="mt-2 text-sm text-cloud/70">
                Family controls scope both settlement rows and the accuracy
                metrics below.
              </p>
            </div>
            <span className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">
              PROJECTION_ONLY
            </span>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {FAMILY_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  setSelectedFamilyId(option.id);
                  setConfidenceFilter('ALL');
                }}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition-colors ${familyPillClass(
                  selectedFamily.id === option.id,
                )}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-xl border border-white/10 bg-surface/80 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-cloud/50">
              Directional Record
            </p>
            <p className="mt-3 font-mono text-2xl text-cloud">
              {accuracySummary.wins}-{accuracySummary.losses}
            </p>
            <p className="mt-1 text-xs text-cloud/55">
              Weak directions excluded
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-surface/80 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-cloud/50">
              Directional Hit Rate
            </p>
            <p className="mt-3 font-mono text-2xl text-cloud">
              {formatPercent(accuracySummary.hitRate)}
            </p>
            <p className="mt-1 text-xs text-cloud/55">
              Wins / wins plus losses
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-surface/80 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-cloud/50">
              MAE (runs/goals)
            </p>
            <p className="mt-3 font-mono text-2xl text-cloud">
              {formatDecimal(accuracySummary.mae, 2, { signed: false })}
            </p>
            <p className="mt-1 text-xs text-cloud/55">
              Mean absolute projection error
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-surface/80 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-cloud/50">
              Bias (proj - actual)
            </p>
            <p className="mt-3 font-mono text-2xl text-cloud">
              {formatDecimal(accuracySummary.bias, 2)}
            </p>
            <p className="mt-1 text-xs text-cloud/55">
              Signed projection error
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-surface/80 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-cloud/50">
              Brier Score
            </p>
            <p className="mt-3 font-mono text-2xl text-cloud">
              {formatDecimal(accuracySummary.avgBrier, 3, { signed: false })}
            </p>
            <p className="mt-1 text-xs text-cloud/55">
              Lower is better for probabilities
            </p>
          </div>
        </section>

        <section className="mt-6 rounded-2xl border border-white/10 bg-surface/80 p-5 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold">Projection Settlement</h2>
              <p className="mt-2 text-sm text-cloud/70">
                Settled projection-only cards graded against actual game
                outcomes.
              </p>
            </div>
            <p className={`text-sm font-semibold ${marketHealthClass(marketTrustStatus)}`}>
              {marketTrustStatus || 'PENDING'} - {marketHealthLabel(marketTrustStatus)}
            </p>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cloud/50">
              Confidence
            </span>
            {(['ALL', 'HIGH', 'MED', 'LOW'] as ProjectionConfidenceFilter[]).map(
              (tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => setConfidenceFilter(tier)}
                  className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] transition-colors ${confidencePillClass(
                    confidenceFilter === tier,
                  )}`}
                >
                  {tier} ({confidenceCounts[tier]})
                </button>
              ),
            )}
          </div>

          <ProjectionResultsTable
            rows={filteredSettledRows}
            attributionRows={filteredAccuracyRows}
            confidenceFilter={confidenceFilter}
          />
        </section>

        <section className="mt-6 rounded-2xl border border-white/10 bg-surface/80 p-5 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold">Accuracy Breakdown</h2>
              <p className="mt-2 text-sm text-cloud/70">
                Metric rows recalculate from the selected projection family.
              </p>
            </div>
            <p className="text-xs uppercase tracking-[0.18em] text-cloud/50">
              {accuracySummary.rows} accuracy rows
            </p>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <div className="overflow-hidden rounded-xl border border-white/10">
              <div className="hidden grid-cols-6 gap-4 bg-night/70 px-4 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-cloud/60 md:grid">
                <span>Family</span>
                <span>Rows</span>
                <span>Record</span>
                <span>Hit Rate</span>
                <span>MAE</span>
                <span>Bias</span>
              </div>
              {familySummaryRows.length === 0 ? (
                <div className="px-4 py-6 text-sm text-cloud/60">
                  No settled projection records match this family.
                </div>
              ) : (
                <div className="divide-y divide-white/10">
                  {familySummaryRows.map((row) => (
                    <div
                      key={row.family}
                      className="grid gap-3 px-4 py-4 text-sm text-cloud/70 md:grid-cols-6 md:gap-4 md:py-3"
                    >
                      <span className="font-medium text-cloud">{row.label}</span>
                      <span>{row.rows}</span>
                      <span>
                        {row.wins + row.losses > 0
                          ? `${row.wins}-${row.losses}`
                          : 'N/A'}
                      </span>
                      <span>{formatPercent(row.hitRate)}</span>
                      <span>{formatDecimal(row.mae, 2, { signed: false })}</span>
                      <span>{formatDecimal(row.bias, 2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-white/10 bg-night/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cloud/50">
                Confidence Bands
              </p>
              {confidenceSummary.length === 0 ? (
                <p className="mt-3 text-sm text-cloud/60">
                  No confidence-band accuracy rows for this family.
                </p>
              ) : (
                <div className="mt-3 space-y-2">
                  {confidenceSummary.map(([tier, bucket]) => {
                    const drilldown = drilldownByTier.get(tier);
                    const hasEligible = (drilldown?.eligible.length ?? 0) > 0;
                    const isExpanded = expandedConfidenceBand === tier;
                    return (
                      <div key={tier}>
                        {hasEligible ? (
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedConfidenceBand(isExpanded ? null : tier)
                            }
                            className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition-colors ${confidenceTierBandClass(tier, isExpanded)}`}
                          >
                            <span className="font-semibold">{tier}</span>
                            <div className="flex items-center gap-3">
                              <span className="font-mono">
                                {bucket.wins}–{bucket.losses} / {bucket.rows} rows
                              </span>
                              <span className="text-xs opacity-60">
                                {isExpanded ? '▲' : '▼'}
                              </span>
                            </div>
                          </button>
                        ) : (
                          <div className="flex cursor-default items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm opacity-50">
                            <span className="font-semibold text-cloud">{tier}</span>
                            <span className="font-mono text-cloud/70">
                              {bucket.wins}–{bucket.losses} / {bucket.rows} rows
                            </span>
                          </div>
                        )}
                        {isExpanded && drilldown && (
                          <div className="mt-1 overflow-hidden rounded-lg border border-white/10 bg-night/50 p-3">
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-cloud/50">
                                {tier} band — row evidence
                              </p>
                              {drilldown.excludedCount > 0 && (
                                <p className="text-[11px] text-cloud/40">
                                  {drilldown.excludedCount} weak-direction row{drilldown.excludedCount !== 1 ? 's' : ''} excluded
                                </p>
                              )}
                            </div>
                            {drilldown.eligible.length === 0 ? (
                              <p className="text-xs text-cloud/50">No eligible rows for this band.</p>
                            ) : (
                              <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="border-b border-white/10 text-[10px] uppercase tracking-[0.14em] text-cloud/40">
                                      <th className="pb-1 pr-3 text-left font-semibold">Date</th>
                                      <th className="pb-1 pr-3 text-left font-semibold">Matchup</th>
                                      <th className="pb-1 pr-3 text-left font-semibold">Direction</th>
                                      <th className="pb-1 pr-3 text-left font-semibold">Outcome</th>
                                      <th className="pb-1 text-left font-semibold">Confidence</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-white/5">
                                    {drilldown.eligible.map((row) => {
                                      const settled = settledByCardId.get(String(row.card_id || ''));
                                      const date = settled ? fmtDate(settled.gameDateUtc) : '--';
                                      const matchup = settled
                                        ? (settled.homeTeam && settled.awayTeam
                                            ? `${settled.awayTeam} @ ${settled.homeTeam}`
                                            : settled.cardTitle || '--')
                                        : (row.game_id ? String(row.game_id).slice(0, 20) : '--');
                                      const direction = row.synthetic_direction || '--';
                                      const outcome = row.graded_result || '--';
                                      const confidence =
                                        row.projection_confidence !== null &&
                                        row.projection_confidence !== undefined
                                          ? `${Math.round(row.projection_confidence)}%`
                                          : '--';
                                      const outcomeClass =
                                        outcome === 'WIN'
                                          ? 'text-emerald-300'
                                          : outcome === 'LOSS'
                                            ? 'text-rose-300'
                                            : 'text-cloud/50';
                                      return (
                                        <tr key={`${row.card_id}-${row.game_id}`}>
                                          <td className="py-1 pr-3 text-cloud/55">{date}</td>
                                          <td className="py-1 pr-3 text-cloud/70">{matchup}</td>
                                          <td className="py-1 pr-3 text-cloud/70">{direction}</td>
                                          <td className={`py-1 pr-3 font-semibold ${outcomeClass}`}>{outcome}</td>
                                          <td className="py-1 text-cloud/60">{confidence}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>

        {projectionRangeBreakdown.length > 0 && (
          <section className="mt-6 rounded-2xl border border-white/10 bg-surface/80 p-5 sm:p-8">
            <div className="mb-5">
              <h2 className="text-2xl font-semibold">Projection Range Breakdown</h2>
              <p className="mt-2 text-sm text-cloud/70">
                Win-loss record segmented by model projection value (0.5-unit buckets).
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {projectionRangeBreakdown.map(({ family, label, buckets }) => {
                const isExpanded = expandedRangeFamilies.has(family);
                const totalGraded = buckets.reduce((s, b) => s + b.total, 0);
                const totalWins = buckets.reduce((s, b) => s + b.wins, 0);
                const totalLosses = buckets.reduce((s, b) => s + b.losses, 0);
                const overallHitRate = totalGraded > 0 ? totalWins / totalGraded : null;
                return (
                  <div key={family} className="overflow-hidden rounded-xl border border-white/10">
                    <button
                      type="button"
                      onClick={() => {
                        setExpandedRangeFamilies((prev) => {
                          const next = new Set(prev);
                          if (next.has(family)) next.delete(family);
                          else next.add(family);
                          return next;
                        });
                      }}
                      className="flex w-full items-center justify-between bg-night/70 px-4 py-3 text-left transition-colors hover:bg-night/90"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-cloud/60">
                          {label}
                        </span>
                        {overallHitRate !== null && (
                          <span className="font-mono text-xs text-cloud/40">
                            {totalWins}-{totalLosses} · {(overallHitRate * 100).toFixed(1)}%
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-cloud/40">{isExpanded ? '▲' : '▼'}</span>
                    </button>
                    {isExpanded && (
                      <>
                        <div className="grid grid-cols-[1fr_80px_64px_48px] gap-3 border-t border-white/5 bg-night/40 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-cloud/40">
                          <span>Range</span>
                          <span>Record</span>
                          <span>Hit %</span>
                          <span className="text-right">n</span>
                        </div>
                        <div className="divide-y divide-white/5">
                          {buckets.map((b) => {
                            const pct = b.hitRate;
                            const barWidth = Math.round(pct * 100);
                            const barColor =
                              pct >= 0.60
                                ? 'bg-emerald-400/50'
                                : pct >= 0.50
                                  ? 'bg-cyan-400/40'
                                  : pct >= 0.40
                                    ? 'bg-amber-400/40'
                                    : 'bg-rose-400/40';
                            const textColor =
                              pct >= 0.60
                                ? 'text-emerald-200'
                                : pct >= 0.50
                                  ? 'text-cyan-200'
                                  : pct >= 0.40
                                    ? 'text-amber-200'
                                    : 'text-rose-200';
                            return (
                              <div
                                key={b.min}
                                className="grid grid-cols-[1fr_80px_64px_48px] items-center gap-3 px-4 py-2.5 text-sm"
                              >
                                <div className="relative">
                                  <div
                                    className={`absolute inset-y-0 left-0 rounded-sm ${barColor}`}
                                    style={{ width: `${barWidth}%`, opacity: 0.35 }}
                                  />
                                  <span className="relative font-mono text-[12px] text-cloud/70">
                                    {b.min.toFixed(1)}–{b.max.toFixed(1)}
                                  </span>
                                </div>
                                <span className="font-mono text-[12px] text-cloud/80">
                                  {b.wins}-{b.losses}
                                </span>
                                <span className={`font-mono text-[12px] font-semibold ${textColor}`}>
                                  {(pct * 100).toFixed(1)}%
                                </span>
                                <span className="text-right font-mono text-[12px] text-cloud/50">
                                  {b.total}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
