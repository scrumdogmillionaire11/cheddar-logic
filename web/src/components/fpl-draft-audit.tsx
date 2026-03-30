'use client';

import { useEffect, useState } from 'react';
import { auditDraft, type DraftAuditResponse, type AuditDimension } from '@/lib/fpl-api';

interface FPLDraftAuditProps {
  sessionId: string;
  userId?: string;
}

const DIMENSION_ORDER = [
  'structure_quality',
  'fixture_quality',
  'minutes_security',
  'volatility',
  'flexibility',
  'profile_fit',
];

const GRADE_COLORS: Record<string, string> = {
  A: 'text-teal bg-teal/10',
  B: 'text-green-400 bg-green-400/10',
  C: 'text-yellow-400 bg-yellow-400/10',
  D: 'text-orange-400 bg-orange-400/10',
  F: 'text-red-400 bg-red-400/10',
};

function DimensionRow({ dim }: { dim: AuditDimension }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-cloud/80 capitalize">
          {dim.label || dim.dimension.replace(/_/g, ' ')}
        </p>
        <span className="text-sm font-semibold text-cloud">{dim.score.toFixed(1)}</span>
      </div>
      {/* Score bar 0–10 */}
      <div className="h-1.5 rounded-full bg-cloud/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-teal"
          style={{ width: `${Math.min(100, (dim.score / 10) * 100)}%` }}
        />
      </div>
      {dim.rationale && (
        <p className="text-xs text-cloud/50">{dim.rationale}</p>
      )}
      {dim.flags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {dim.flags.map((flag) => (
            <span
              key={flag}
              className="rounded bg-cloud/10 px-1.5 py-0.5 text-xs text-cloud/60"
            >
              {flag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface AuditResult {
  forSessionId: string;
  forUserId: string | undefined;
  audit: DraftAuditResponse | null;
  error: string | null;
}

export default function FPLDraftAudit({ sessionId, userId }: FPLDraftAuditProps) {
  const [result, setResult] = useState<AuditResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    auditDraft(sessionId, userId ? { user_id: userId } : {})
      .then((data) => {
        if (!cancelled) {
          setResult({ forSessionId: sessionId, forUserId: userId, audit: data, error: null });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setResult({
            forSessionId: sessionId,
            forUserId: userId,
            audit: null,
            error: err instanceof Error ? err.message : 'Failed to load audit',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, userId]);

  const resolved = result?.forSessionId === sessionId && result?.forUserId === userId;
  const loading = !resolved;
  const error = resolved ? result.error : null;
  const audit = resolved ? result.audit : null;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-cloud/60">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-teal border-t-transparent" />
        Loading audit…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
        {error}
      </div>
    );
  }

  if (!audit) return null;

  // Sort dimensions by the canonical order; any extra dimensions fall to the end
  const sortedDimensions = [...audit.dimensions].sort((a, b) => {
    const ai = DIMENSION_ORDER.indexOf(a.dimension);
    const bi = DIMENSION_ORDER.indexOf(b.dimension);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  const gradeClass = GRADE_COLORS[audit.grade.toUpperCase()] ?? 'text-cloud bg-cloud/10';

  return (
    <div className="space-y-6">
      {/* Header: overall score + grade */}
      <div className="flex items-center gap-4">
        <div className="text-center">
          <p className="font-display text-5xl font-bold text-cloud">
            {audit.overall_score.toFixed(1)}
          </p>
          <p className="text-xs text-cloud/40 mt-0.5">Overall score</p>
        </div>
        <span className={`rounded px-3 py-1 text-xl font-bold ${gradeClass}`}>
          {audit.grade}
        </span>
      </div>

      {/* Summary */}
      {audit.summary && (
        <blockquote className="border-l-2 border-teal/30 pl-3 text-sm text-cloud/70 italic">
          {audit.summary}
        </blockquote>
      )}

      {/* Dimensions */}
      <div className="rounded-xl border border-cloud/10 bg-surface/50 p-5 space-y-5">
        <p className="text-sm font-medium text-cloud/80">Dimensions</p>
        <div className="space-y-5 divide-y divide-cloud/5">
          {sortedDimensions.map((dim, i) => (
            <div key={dim.dimension} className={i > 0 ? 'pt-5' : ''}>
              <DimensionRow dim={dim} />
            </div>
          ))}
        </div>
      </div>

      {/* Strengths + risks */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {audit.top_strengths.length > 0 && (
          <div className="rounded-lg border border-teal/20 bg-teal/5 px-4 py-3 space-y-2">
            <p className="text-xs font-semibold text-teal">Top strengths</p>
            <ul className="space-y-1">
              {audit.top_strengths.map((s) => (
                <li key={s} className="text-xs text-cloud/70 flex gap-1.5">
                  <span className="text-teal">+</span>
                  {s}
                </li>
              ))}
            </ul>
          </div>
        )}
        {audit.top_risks.length > 0 && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 space-y-2">
            <p className="text-xs font-semibold text-red-400">Top risks</p>
            <ul className="space-y-1">
              {audit.top_risks.map((r) => (
                <li key={r} className="text-xs text-cloud/70 flex gap-1.5">
                  <span className="text-red-400">-</span>
                  {r}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
