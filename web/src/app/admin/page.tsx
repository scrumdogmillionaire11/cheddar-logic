'use client';

import { useEffect, useState } from 'react';
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

function formatTs(ts: string) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

export default function AdminPage() {
  const [health, setHealth] = useState<PipelineHealthRow[]>([]);
  const [outputs, setOutputs] = useState<ModelOutputRow[]>([]);
  const [healthLoading, setHealthLoading] = useState(true);
  const [outputsLoading, setOutputsLoading] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [outputsError, setOutputsError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/pipeline-health')
      .then((r) => r.json())
      .then((body: { success: boolean; data?: PipelineHealthRow[]; error?: string }) => {
        if (body.success && body.data) setHealth(body.data);
        else setHealthError(body.error ?? 'unknown error');
      })
      .catch((e: unknown) => setHealthError(String(e)))
      .finally(() => setHealthLoading(false));

    fetch('/api/model-outputs')
      .then((r) => r.json())
      .then((body: { success: boolean; data?: ModelOutputRow[]; error?: string }) => {
        if (body.success && body.data) setOutputs(body.data.slice(0, 50));
        else setOutputsError(body.error ?? 'unknown error');
      })
      .catch((e: unknown) => setOutputsError(String(e)))
      .finally(() => setOutputsLoading(false));
  }, []);

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

          {/* Pipeline Health */}
          <section>
            <h2 className="mb-4 text-xl font-semibold">Pipeline Health</h2>
            <div className="overflow-hidden rounded-xl border border-white/10 bg-surface/80">
              {healthLoading && (
                <div className="p-6 text-sm text-cloud/50">Loading…</div>
              )}
              {healthError && (
                <div className="p-6 text-sm text-red-400">
                  Error: {healthError}
                </div>
              )}
              {!healthLoading && !healthError && health.length === 0 && (
                <div className="p-6 text-sm text-cloud/50">
                  No pipeline health records found. Run{' '}
                  <code className="font-mono">check_pipeline_health.js</code> to
                  seed.
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
