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

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    ok: 'bg-green-500/20 text-green-400 border border-green-500/30',
    warning: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
    failed: 'bg-red-500/20 text-red-400 border border-red-500/30',
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
    warning: 'bg-yellow-400',
    failed: 'bg-red-400',
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

function computeStreak(
  rows: PipelineHealthRow[],
  phase: string,
  checkName: string,
): number {
  const filtered = rows.filter(
    (r) => r.phase === phase && r.check_name === checkName,
  );
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
 * Derive the single latest row per (phase, check_name) combination.
 * Since rows are already ordered newest-first from the API, first-seen wins.
 */
function buildSnapshot(rows: PipelineHealthRow[]): PipelineHealthRow[] {
  const seen = new Set<string>();
  const snapshot: PipelineHealthRow[] = [];
  for (const row of rows) {
    const key = `${row.phase}:${row.check_name}`;
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
  const [outputs, setOutputs] = useState<ModelOutputRow[]>([]);
  const [healthLoading, setHealthLoading] = useState(true);
  const [outputsLoading, setOutputsLoading] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [outputsError, setOutputsError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const loadHealth = useCallback(() => {
    fetch('/api/admin/pipeline-health')
      .then((r) => r.json())
      .then(
        (body: { success: boolean; data?: PipelineHealthRow[]; error?: string }) => {
          if (body.success && body.data) {
            setHealth(body.data);
            setLastRefresh(new Date());
          } else setHealthError(body.error ?? 'unknown error');
        },
      )
      .catch((e: unknown) => setHealthError(String(e)))
      .finally(() => setHealthLoading(false));
  }, []);

  useEffect(() => {
    loadHealth();
    fetch('/api/model-outputs')
      .then((r) => r.json())
      .then(
        (body: { success: boolean; data?: ModelOutputRow[]; error?: string }) => {
          if (body.success && body.data) setOutputs(body.data.slice(0, 50));
          else setOutputsError(body.error ?? 'unknown error');
        },
      )
      .catch((e: unknown) => setOutputsError(String(e)))
      .finally(() => setOutputsLoading(false));
  }, [loadHealth]);

  // Auto-refresh health every 60s
  useEffect(() => {
    const id = setInterval(loadHealth, 60_000);
    return () => clearInterval(id);
  }, [loadHealth]);

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

          {/* Current Health Snapshot */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Current Snapshot</h2>
              <div className="flex items-center gap-3 text-xs text-cloud/40">
                {lastRefresh && <span>Updated {formatAge(lastRefresh.toISOString())}</span>}
                <button
                  onClick={loadHealth}
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
                    const streak = computeStreak(health, row.phase, row.check_name);
                    const stale = isStale(row.created_at);
                    return (
                      <div
                        key={`${row.phase}:${row.check_name}`}
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
                            <span className="text-xs text-cloud/30">{formatAge(row.created_at)}</span>
                          )}
                        </div>
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
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Reason</th>
                        <th className="px-4 py-3">Timestamp</th>
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
                            <StatusBadge status={row.status} />
                          </td>
                          <td className="max-w-xs truncate px-4 py-3 text-cloud/60">
                            {row.reason ?? '—'}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-xs text-cloud/50">
                            {formatTs(row.created_at)}
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
