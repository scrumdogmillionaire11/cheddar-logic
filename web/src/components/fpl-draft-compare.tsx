'use client';

import { useState } from 'react';
import { compareDrafts, type CompareDraftsResponse } from '@/lib/fpl-api';

interface FPLDraftCompareProps {
  userId?: string;
}

function winnerIcon(winner: 'a' | 'b' | 'tie'): string {
  if (winner === 'a') return 'A';
  if (winner === 'b') return 'B';
  return '~';
}

const OVERALL_WINNER_LABELS: Record<string, string> = {
  a: 'Session A',
  b: 'Session B',
  tie: 'Tie',
};

export default function FPLDraftCompare({ userId }: FPLDraftCompareProps) {
  const [sessionAId, setSessionAId] = useState('');
  const [sessionBId, setSessionBId] = useState('');
  const [result, setResult] = useState<CompareDraftsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCompare = async () => {
    if (!sessionAId.trim() || !sessionBId.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await compareDrafts({
        session_ids: [sessionAId.trim(), sessionBId.trim()],
        user_id: userId,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to compare drafts');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 font-display text-2xl font-semibold">Compare Drafts</h2>
        <p className="text-cloud/60">
          Enter two draft session IDs to compare them side-by-side across all dimensions.
        </p>
      </div>

      {/* Session ID inputs */}
      <div className="rounded-xl border border-cloud/10 bg-surface/50 p-5 space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-cloud/60">Session A ID</label>
            <input
              type="text"
              placeholder="e.g. abc123"
              value={sessionAId}
              onChange={(e) => setSessionAId(e.target.value)}
              className="w-full rounded border border-cloud/20 bg-night px-3 py-2 text-sm text-cloud placeholder-cloud/30 focus:border-teal focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-cloud/60">Session B ID</label>
            <input
              type="text"
              placeholder="e.g. def456"
              value={sessionBId}
              onChange={(e) => setSessionBId(e.target.value)}
              className="w-full rounded border border-cloud/20 bg-night px-3 py-2 text-sm text-cloud placeholder-cloud/30 focus:border-teal focus:outline-none"
            />
          </div>
        </div>
        <button
          onClick={handleCompare}
          disabled={loading || !sessionAId.trim() || !sessionBId.trim()}
          className="rounded-lg bg-teal px-5 py-2 text-sm font-semibold text-night transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {loading ? 'Comparing…' : 'Compare'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-5">
          {/* Overall winner badge */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-cloud/60">Overall winner:</span>
            <span
              className={`rounded px-3 py-1 text-sm font-bold ${
                result.overall_winner === 'a'
                  ? 'bg-teal/10 text-teal'
                  : result.overall_winner === 'b'
                  ? 'bg-blue-400/10 text-blue-300'
                  : 'bg-cloud/10 text-cloud/70'
              }`}
            >
              {OVERALL_WINNER_LABELS[result.overall_winner] ?? result.overall_winner}
            </span>
          </div>

          {/* Per-axis dimension table */}
          <div className="rounded-xl border border-cloud/10 bg-surface/50 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-cloud/10 text-xs text-cloud/40">
                  <th className="px-4 py-2.5 text-left font-medium">Dimension</th>
                  <th className="px-4 py-2.5 text-right font-medium">A</th>
                  <th className="px-4 py-2.5 text-right font-medium">B</th>
                  <th className="px-4 py-2.5 text-right font-medium">Delta</th>
                  <th className="px-4 py-2.5 text-right font-medium">Winner</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cloud/5">
                {result.dimensions.map((dim) => (
                  <tr key={dim.dimension} className="hover:bg-cloud/5 transition-colors">
                    <td className="px-4 py-2.5 text-cloud/80 capitalize">
                      {dim.dimension.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-2.5 text-right text-cloud/70">
                      {dim.session_a_score.toFixed(1)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-cloud/70">
                      {dim.session_b_score.toFixed(1)}
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right font-medium ${
                        dim.delta > 0
                          ? 'text-teal'
                          : dim.delta < 0
                          ? 'text-red-400'
                          : 'text-cloud/40'
                      }`}
                    >
                      {dim.delta > 0 ? '+' : ''}
                      {dim.delta.toFixed(1)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-bold ${
                          dim.winner === 'a'
                            ? 'bg-teal/10 text-teal'
                            : dim.winner === 'b'
                            ? 'bg-blue-400/10 text-blue-300'
                            : 'bg-cloud/10 text-cloud/50'
                        }`}
                      >
                        {winnerIcon(dim.winner)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Recommendation */}
          {result.recommendation && (
            <div className="rounded-lg border border-teal/20 bg-teal/5 px-4 py-4 space-y-1">
              <p className="text-xs font-semibold text-teal uppercase tracking-wide">
                Recommendation
              </p>
              <p className="text-sm text-cloud/80">{result.recommendation}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
