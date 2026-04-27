'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

interface PipelineHealthRow {
  id: number;
  phase: string;
  check_name: string;
  status: string;
  reason: string | null;
  created_at: string;
  check_id?: string | null;
  dedupe_key?: string | null;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  resolved_at?: string | null;
}

interface ModelOutputRow {
  id: string;
  game_id: string;
  sport: string;
  model_name: string;
  model_version: string;
  prediction_type: string;
  predicted_at: string;
  confidence: number | null;
}

interface ModelHealthSnapshot {
  sport: string;
  run_at: string;
  hit_rate: number | null;
  roi_units: number | null;
  roi_pct: number | null;
  total_unique: number;
  wins: number;
  losses: number;
  streak: string | null;
  last10_hit_rate: number | null;
  status: string;
  signals: string[];
  lookback_days: number;
}

interface PotdHealth {
  status: string;
  last_run_at: string | null;
  last_run_age?: string;
  today_state: string;
  play_date: string;
  candidate_count: number;
  viable_count: number | null;
  near_miss: {
    last_settled_at: string | null;
    last_settled_age?: string;
    counts: {
      total: number;
      pending: number;
      settled: number;
      win: number;
      loss: number;
      push: number;
    };
  };
  signals: string[];
}

interface PotdLane {
  phase: string;
  check_name: string;
  status: string;
  reason: string;
  created_at: string;
  virtual: true;
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    ok: 'bg-green-500/20 text-green-400 border border-green-500/30',
    healthy: 'bg-green-500/20 text-green-400 border border-green-500/30',
    warning: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
    degraded: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
    stale: 'bg-orange-500/20 text-orange-300 border border-orange-500/30',
    failed: 'bg-red-500/20 text-red-400 border border-red-500/30',
    critical: 'bg-red-500/20 text-red-400 border border-red-500/30',
    'no-data': 'bg-white/10 text-cloud/70 border border-white/20',
  };
  const cls =
    colorMap[status.toLowerCase()] ??
    'bg-white/10 text-cloud/70 border border-white/20';
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${cls}`}
    >
      {status}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    ok: 'bg-green-400',
    healthy: 'bg-green-400',
    warning: 'bg-yellow-400',
    degraded: 'bg-yellow-400',
    stale: 'bg-orange-300',
    failed: 'bg-red-400',
    critical: 'bg-red-400',
    'no-data': 'bg-white/30',
  };
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${colorMap[status.toLowerCase()] ?? 'bg-white/30'}`}
    />
  );
}

function formatTs(ts: string) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function lifecycleLabel(row: PipelineHealthRow): 'active' | 'resolved' {
  return row.resolved_at ? 'resolved' : 'active';
}

function formatPct(value: number | null) {
  if (value == null) return 'N/A';
  return `${(value * 100).toFixed(1)}%`;
}

function formatUnits(value: number | null) {
  if (value == null) return 'N/A';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}u`;
}

function formatAge(ts: string) {
  try {
    const ageMs = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(ageMs / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return '?';
  }
}

const STALE_THRESHOLD_MS = 35 * 60 * 1000;

function healthIdentity(row: Pick<PipelineHealthRow, 'phase' | 'check_name' | 'check_id'>): string {
  return row.check_id && row.check_id.length > 0
    ? row.check_id
    : `${row.phase}:${row.check_name}`;
}

function computeStreak(
  rows: PipelineHealthRow[],
  identity: string,
): number {
  const filtered = rows.filter((r) => healthIdentity(r) === identity);
  if (filtered.length === 0) return 0;
  const currentStatus = filtered[0].status.toLowerCase();
  let streak = 1;
  for (let i = 1; i < filtered.length; i++) {
    if (filtered[i].status.toLowerCase() === currentStatus) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function isStale(ts: string): boolean {
  try {
    return Date.now() - new Date(ts).getTime() > STALE_THRESHOLD_MS;
  } catch {
    return false;
  }
}

function StreakBadge({ status, streak }: { status: string; streak: number }) {
  if (status.toLowerCase() === 'ok' || streak < 2) return null;
  const colorMap: Record<string, string> = {
    failed:
      'bg-red-500/10 text-red-400/70 border border-red-500/20',
    warning:
      'bg-yellow-500/10 text-yellow-400/70 border border-yellow-500/20',
  };
  const cls =
    colorMap[status.toLowerCase()] ??
    'bg-white/10 text-cloud/50 border border-white/20';
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs ${cls}`}
    >
      {status.toLowerCase()} &times; {streak}
    </span>
  );
}

/**
 * Derive the single latest row per logical health identity.
 * Since rows are already ordered newest-first from the API, first-seen wins.
 */
function buildSnapshot(rows: PipelineHealthRow[]): PipelineHealthRow[] {
  const seen = new Set<string>();
  const snapshot: PipelineHealthRow[] = [];
  for (const row of rows) {
    const key = healthIdentity(row);
    if (!seen.has(key)) {
      seen.add(key);
      snapshot.push(row);
    }
  }
  return snapshot.sort((a, b) => {
    // Sort: failed first, then warning, then ok; within each group alphabetical phase
    const order: Record<string, number> = { failed: 0, warning: 1, ok: 2 };
    const ao = order[a.status.toLowerCase()] ?? 3;
    const bo = order[b.status.toLowerCase()] ?? 3;
    if (ao !== bo) return ao - bo;
    return `${a.phase}:${a.check_name}`.localeCompare(`${b.phase}:${b.check_name}`);
  });
}

export default function AdminPage() {
  const [health, setHealth] = useState<PipelineHealthRow[]>([]);
  const [modelHealth, setModelHealth] = useState<ModelHealthSnapshot[]>([]);
  const [potdHealth, setPotdHealth] = useState<PotdHealth | null>(null);
  const [potdLanes, setPotdLanes] = useState<PotdLane[]>([]);
  const [outputs, setOutputs] = useState<ModelOutputRow[]>([]);
  const [healthLoading, setHealthLoading] = useState(true);
  const [modelHealthLoading, setModelHealthLoading] = useState(true);
  const [outputsLoading, setOutputsLoading] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [modelHealthError, setModelHealthError] = useState<string | null>(null);
  const [outputsError, setOutputsError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const loadHealth = useCallback(() => {
    fetch('/api/admin/pipeline-health')
      .then((r) => r.json())
      .then(
        (body: {
          success: boolean;
          data?: PipelineHealthRow[];
          potd_lanes?: PotdLane[];
          error?: string;
        }) => {
          if (body.success && body.data) {
            setHealthError(null);
            setHealth(body.data);
            setPotdLanes(body.potd_lanes ?? []);
            setLastRefresh(new Date());
          } else setHealthError(body.error ?? 'unknown error');
        },
      )
      .catch((e: unknown) => setHealthError(String(e)))
      .finally(() => setHealthLoading(false));
  }, []);

  const loadModelHealth = useCallback(() => {
    fetch('/api/admin/model-health')
      .then((r) => r.json())
      .then(
        (
          body: {
            success: boolean;
            data?: ModelHealthSnapshot[];
            potd_health?: PotdHealth;
            error?: string;
          },
        ) => {
          if (body.success && body.data) {
            setModelHealthError(null);
            setModelHealth(body.data);
            setPotdHealth(body.potd_health ?? null);
            setLastRefresh(new Date());
          } else setModelHealthError(body.error ?? 'unknown error');
        },
      )
      .catch((e: unknown) => setModelHealthError(String(e)))
      .finally(() => setModelHealthLoading(false));
  }, []);

  const refreshAdminHealth = useCallback(() => {
    loadHealth();
    loadModelHealth();
  }, [loadHealth, loadModelHealth]);

  useEffect(() => {
    refreshAdminHealth();
    fetch('/api/model-outputs')
      .then((r) => r.json())
      .then(
        (body: { success: boolean; data?: ModelOutputRow[]; error?: string }) => {
          if (body.success && body.data) {
            setOutputsError(null);
            setOutputs(body.data.slice(0, 50));
          }
          else setOutputsError(body.error ?? 'unknown error');
        },
      )
      .catch((e: unknown) => setOutputsError(String(e)))
      .finally(() => setOutputsLoading(false));
  }, [refreshAdminHealth]);

  // Auto-refresh health every 60s
  useEffect(() => {
    const id = setInterval(refreshAdminHealth, 60_000);
    return () => clearInterval(id);
  }, [refreshAdminHealth]);

  const snapshot = buildSnapshot(health);
  const overallOk =
    snapshot.length > 0 && snapshot.every((r) => r.status.toLowerCase() === 'ok');
  const hasFailure = snapshot.some((r) => r.status.toLowerCase() === 'failed');

  return (
    <div className="min-h-screen bg-night px-6 py-12 text-cloud">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8">
          <Link href="/" className="text-sm text-cloud/60 hover:text-cloud/80">
            ← Back to Home
          </Link>
        </div>

        <div className="space-y-10">
          <div>
            <h1 className="mb-2 font-display text-4xl font-semibold">
              Model Health
            </h1>
            <p className="text-lg text-cloud/70">
              Live pipeline health checks and recent model outputs
            </p>
          </div>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xl font-semibold">POTD Health</h2>
              <div className="text-xs text-cloud/40">
                {lastRefresh && <span>Updated {formatAge(lastRefresh.toISOString())}</span>}
              </div>
            </div>

            {(modelHealthLoading || healthLoading) && (
              <div className="rounded-xl border border-white/10 bg-surface/80 p-6 text-sm text-cloud/50">
                Loading…
              </div>
            )}
            {!modelHealthLoading && !healthLoading && !potdHealth && (
              <div className="rounded-xl border border-white/10 bg-surface/80 p-6 text-sm text-cloud/50">
                No POTD health payload returned.
              </div>
            )}
            {!modelHealthLoading && !healthLoading && potdHealth && (
              <div className="rounded-xl border border-white/10 bg-surface/80 p-4">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <StatusDot status={potdHealth.status} />
                      <h3 className="font-mono text-sm font-semibold uppercase tracking-wide text-cloud/85">
                        Play of the Day
                      </h3>
                    </div>
                    <p className="mt-1 text-xs text-cloud/45">
                      {potdHealth.play_date} · {potdHealth.last_run_age ?? 'never'}
                    </p>
                  </div>
                  <StatusBadge status={potdHealth.status} />
                </div>

                <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-lg border border-white/8 bg-night/40 px-3 py-2">
                    <div className="text-xs uppercase tracking-wide text-cloud/40">
                      Today
                    </div>
                    <div className="mt-1 font-semibold text-cloud">
                      {potdHealth.today_state}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/8 bg-night/40 px-3 py-2">
                    <div className="text-xs uppercase tracking-wide text-cloud/40">
                      Candidates
                    </div>
                    <div className="mt-1 font-semibold text-cloud">
                      {potdHealth.candidate_count}
                      {potdHealth.viable_count != null ? ` / ${potdHealth.viable_count} viable` : ''}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/8 bg-night/40 px-3 py-2">
                    <div className="text-xs uppercase tracking-wide text-cloud/40">
                      Near-Miss
                    </div>
                    <div className="mt-1 font-semibold text-cloud">
                      {potdHealth.near_miss.counts.settled} settled · {potdHealth.near_miss.counts.pending} pending
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/8 bg-night/40 px-3 py-2">
                    <div className="text-xs uppercase tracking-wide text-cloud/40">
                      Last Shadow
                    </div>
                    <div className="mt-1 font-semibold text-cloud">
                      {potdHealth.near_miss.last_settled_age ?? 'never'}
                    </div>
                  </div>
                </div>

                {potdLanes.length > 0 && (
                  <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {potdLanes.map((lane) => (
                      <div
                        key={lane.check_name}
                        className="rounded-lg border border-white/8 bg-night/30 px-3 py-2"
                        title={lane.reason}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="font-mono text-xs text-cloud/60">
                            {lane.check_name}
                          </span>
                          <StatusDot status={lane.status} />
                        </div>
                        <StatusBadge status={lane.status} />
                      </div>
                    ))}
                  </div>
                )}

                {potdHealth.signals.length > 0 && (
                  <div className="mt-4 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3">
                    <div className="mb-2 text-xs uppercase tracking-wide text-yellow-300/80">
                      Signals
                    </div>
                    <ul className="space-y-1 text-sm text-cloud/70">
                      {potdHealth.signals.map((signal) => (
                        <li key={signal}>{signal}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Model Performance (30d)</h2>
              <div className="flex items-center gap-3 text-xs text-cloud/40">
                {lastRefresh && <span>Updated {formatAge(lastRefresh.toISOString())}</span>}
                <button
                  onClick={refreshAdminHealth}
                  className="rounded border border-white/10 px-2 py-1 hover:border-white/20 hover:text-cloud/70"
                >
                  Refresh
                </button>
              </div>
            </div>

            {modelHealthLoading && (
              <div className="rounded-xl border border-white/10 bg-surface/80 p-6 text-sm text-cloud/50">
                Loading…
              </div>
            )}
            {modelHealthError && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-6 text-sm text-red-400">
                Error: {modelHealthError}
              </div>
            )}
            {!modelHealthLoading && !modelHealthError && modelHealth.length === 0 && (
              <div className="rounded-xl border border-white/10 bg-surface/80 p-6 text-sm text-cloud/50">
                No model health snapshots yet. Run{' '}
                <code className="font-mono">npm run job:dr-claire -- --persist</code>{' '}
                from apps/worker to seed.
              </div>
            )}
            {!modelHealthLoading && !modelHealthError && modelHealth.length > 0 && (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {modelHealth.map((snapshot) => (
                  <article
                    key={snapshot.sport}
                    className="rounded-xl border border-white/10 bg-surface/80 p-4"
                  >
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <StatusDot status={snapshot.status} />
                          <h3 className="font-mono text-sm font-semibold uppercase tracking-wide text-cloud/85">
                            {snapshot.sport}
                          </h3>
                        </div>
                        <p className="mt-1 text-xs text-cloud/40">
                          Updated {formatAge(snapshot.run_at)}
                        </p>
                      </div>
                      <StatusBadge status={snapshot.status} />
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-lg border border-white/8 bg-night/40 px-3 py-2">
                        <div className="text-xs uppercase tracking-wide text-cloud/40">
                          Hit Rate
                        </div>
                        <div className="mt-1 font-semibold text-cloud">
                          {formatPct(snapshot.hit_rate)}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/8 bg-night/40 px-3 py-2">
                        <div className="text-xs uppercase tracking-wide text-cloud/40">
                          ROI Units
                        </div>
                        <div className="mt-1 font-semibold text-cloud">
                          {formatUnits(snapshot.roi_units)}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/8 bg-night/40 px-3 py-2">
                        <div className="text-xs uppercase tracking-wide text-cloud/40">
                          Last 10
                        </div>
                        <div className="mt-1 font-semibold text-cloud">
                          {formatPct(snapshot.last10_hit_rate)}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/8 bg-night/40 px-3 py-2">
                        <div className="text-xs uppercase tracking-wide text-cloud/40">
                          Streak
                        </div>
                        <div className="mt-1 font-semibold text-cloud">
                          {snapshot.streak ?? 'N/A'}
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 flex items-center justify-between text-xs text-cloud/55">
                      <span>
                        {snapshot.wins}W {snapshot.losses}L
                      </span>
                      <span>{snapshot.total_unique} unique markets</span>
                    </div>

                    {snapshot.signals.length > 0 && (
                      <div className="mt-4 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3">
                        <div className="mb-2 text-xs uppercase tracking-wide text-yellow-300/80">
                          Degradation Signals
                        </div>
                        <ul className="space-y-1 text-sm text-cloud/70">
                          {snapshot.signals.map((signal) => (
                            <li key={signal}>{signal}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>

          {/* Current Health Snapshot */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Current Snapshot</h2>
              <div className="flex items-center gap-3 text-xs text-cloud/40">
                {lastRefresh && <span>Updated {formatAge(lastRefresh.toISOString())}</span>}
                <button
                  onClick={refreshAdminHealth}
                  className="rounded border border-white/10 px-2 py-1 hover:border-white/20 hover:text-cloud/70"
                >
                  Refresh
                </button>
              </div>
            </div>

            {healthLoading && (
              <div className="rounded-xl border border-white/10 bg-surface/80 p-6 text-sm text-cloud/50">
                Loading…
              </div>
            )}
            {healthError && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-6 text-sm text-red-400">
                Error: {healthError}
              </div>
            )}
            {!healthLoading && !healthError && snapshot.length === 0 && (
              <div className="rounded-xl border border-white/10 bg-surface/80 p-6 text-sm text-cloud/50">
                No health data yet. Run{' '}
                <code className="font-mono">npm run job:check-pipeline-health</code>{' '}
                from apps/worker to seed.
              </div>
            )}
            {!healthLoading && !healthError && snapshot.length > 0 && (
              <div
                className={`rounded-xl border p-4 ${
                  hasFailure
                    ? 'border-red-500/30 bg-red-500/5'
                    : overallOk
                      ? 'border-green-500/20 bg-green-500/5'
                      : 'border-yellow-500/20 bg-yellow-500/5'
                }`}
              >
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {snapshot.map((row) => {
                    const streak = computeStreak(health, healthIdentity(row));
                    const stale = isStale(row.created_at);
                    const lifecycle = lifecycleLabel(row);
                    return (
                      <div
                        key={healthIdentity(row)}
                        className={`flex flex-col gap-1 rounded-lg border border-white/8 bg-surface/60 px-3 py-2 ${stale ? 'opacity-50' : ''}`}
                        title={row.reason ?? ''}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-mono text-xs font-semibold uppercase text-cloud/80">
                            {row.phase}
                          </span>
                          <StatusDot status={row.status} />
                        </div>
                        <span className="text-xs text-cloud/50">{row.check_name}</span>
                        <div className="flex items-center justify-between">
                          <StatusBadge status={row.status} />
                          {stale ? (
                            <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-cloud/30">
                              check dormant
                            </span>
                          ) : (
                            <span className="text-xs text-cloud/30">{formatAge(row.last_seen_at || row.created_at)}</span>
                          )}
                        </div>
                        <span className="text-xs text-cloud/35">
                          {lifecycle === 'active' ? 'active condition' : 'resolved condition'}
                        </span>
                        <StreakBadge status={row.status} streak={streak} />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          {/* Pipeline Health History */}
          <section>
            <h2 className="mb-4 text-xl font-semibold">Health History</h2>
            <div className="overflow-hidden rounded-xl border border-white/10 bg-surface/80">
              {!healthLoading && !healthError && health.length === 0 && (
                <div className="p-6 text-sm text-cloud/50">
                  No pipeline health records found.
                </div>
              )}
              {!healthLoading && !healthError && health.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-cloud/50">
                        <th className="px-4 py-3">Phase</th>
                        <th className="px-4 py-3">Check</th>
                        <th className="px-4 py-3">State</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Reason</th>
                        <th className="px-4 py-3">Seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {health.map((row) => (
                        <tr
                          key={row.id}
                          className="border-b border-white/5 hover:bg-white/5"
                        >
                          <td className="px-4 py-3 font-mono text-xs text-cloud/80">
                            {row.phase}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-cloud/80">
                            {row.check_name}
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-xs text-cloud/60">
                              {lifecycleLabel(row)}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge status={row.status} />
                          </td>
                          <td className="max-w-xs truncate px-4 py-3 text-cloud/60">
                            {row.reason ?? '—'}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-xs text-cloud/50">
                            {row.first_seen_at && row.last_seen_at
                              ? `${formatTs(row.first_seen_at)} -> ${formatTs(row.last_seen_at)}`
                              : formatTs(row.created_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {/* Recent Model Outputs */}
          <section>
            <h2 className="mb-4 text-xl font-semibold">Recent Model Outputs</h2>
            <div className="overflow-hidden rounded-xl border border-white/10 bg-surface/80">
              {outputsLoading && (
                <div className="p-6 text-sm text-cloud/50">Loading…</div>
              )}
              {outputsError && (
                <div className="p-6 text-sm text-red-400">
                  Error: {outputsError}
                </div>
              )}
              {!outputsLoading && !outputsError && outputs.length === 0 && (
                <div className="p-6 text-sm text-cloud/50">
                  No model outputs found.
                </div>
              )}
              {!outputsLoading && !outputsError && outputs.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-cloud/50">
                        <th className="px-4 py-3">Sport</th>
                        <th className="px-4 py-3">Model</th>
                        <th className="px-4 py-3">Version</th>
                        <th className="px-4 py-3">Type</th>
                        <th className="px-4 py-3">Confidence</th>
                        <th className="px-4 py-3">Predicted At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outputs.map((row) => (
                        <tr
                          key={row.id}
                          className="border-b border-white/5 hover:bg-white/5"
                        >
                          <td className="px-4 py-3 font-mono text-xs uppercase text-cloud/80">
                            {row.sport}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-cloud/80">
                            {row.model_name}
                          </td>
                          <td className="px-4 py-3 text-xs text-cloud/50">
                            {row.model_version}
                          </td>
                          <td className="px-4 py-3 text-xs text-cloud/60">
                            {row.prediction_type}
                          </td>
                          <td className="px-4 py-3 text-xs text-cloud/60">
                            {row.confidence != null
                              ? (row.confidence * 100).toFixed(1) + '%'
                              : '—'}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-xs text-cloud/50">
                            {formatTs(row.predicted_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
