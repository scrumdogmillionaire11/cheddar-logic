import type { WeeklyReportCard } from '@/lib/fpl-api';

interface FPLWeeklyReportCardProps {
  reportCard: WeeklyReportCard | null | undefined;
}

const parseNumeric = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

export default function FPLWeeklyReportCard({
  reportCard,
}: FPLWeeklyReportCardProps) {
  if (!reportCard) {
    return null;
  }

  const expectedPts = parseNumeric(reportCard.expected_pts);
  const actualPts = parseNumeric(reportCard.actual_pts);
  const missedOpps = Array.isArray(reportCard.missed_opportunities)
    ? reportCard.missed_opportunities
    : [];
  const driftFlags = Array.isArray(reportCard.drift_flags)
    ? reportCard.drift_flags
    : [];

  return (
    <div className="rounded-xl border border-white/10 bg-surface/80 p-4 md:p-8">
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-2xl font-semibold">Weekly Report Card</h2>
        {reportCard.gameweek != null && (
          <span className="rounded bg-white/10 px-2 py-1 text-xs font-semibold text-cloud/60">
            GW{reportCard.gameweek}
          </span>
        )}
      </div>

      {/* Expected vs Actual */}
      {(expectedPts !== null || actualPts !== null) && (
        <div className="mt-4 rounded-lg border border-white/10 bg-surface/50 px-4 py-3">
          <div className="text-xs font-semibold uppercase text-cloud/60">
            Points
          </div>
          <div className="mt-1 text-sm text-cloud/70">
            {expectedPts !== null && (
              <span>Expected: {expectedPts.toFixed(1)} pts</span>
            )}
            {expectedPts !== null && actualPts !== null && (
              <span className="mx-2 text-cloud/40">/</span>
            )}
            {actualPts !== null && (
              <span>Actual: {actualPts.toFixed(1)} pts</span>
            )}
          </div>
        </div>
      )}

      {/* Captain accuracy */}
      {reportCard.captain_accuracy != null && (
        <div className="mt-3 flex items-start gap-2 text-sm">
          <span className="text-cloud/60">Captain accuracy:</span>
          <span className="text-teal">{reportCard.captain_accuracy}</span>
        </div>
      )}

      {/* Transfer quality */}
      {reportCard.transfer_quality != null && (
        <div className="mt-2 flex items-start gap-2 text-sm">
          <span className="text-cloud/60">Transfer quality:</span>
          <span className="text-teal">{reportCard.transfer_quality}</span>
        </div>
      )}

      {/* Missed opportunities */}
      {missedOpps.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-semibold uppercase text-cloud/60">
            Missed opportunities
          </div>
          <ul className="space-y-1">
            {missedOpps.map((opp, idx) => (
              <li key={idx} className="text-sm text-rose">
                {opp}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Profile adherence */}
      {reportCard.profile_adherence != null && (
        <div className="mt-3 flex items-start gap-2 text-sm">
          <span className="text-cloud/60">Profile adherence:</span>
          <span className="text-amber">{reportCard.profile_adherence}</span>
        </div>
      )}

      {/* Drift flags */}
      {driftFlags.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-semibold uppercase text-cloud/60">
            Drift flags
          </div>
          <div className="flex flex-wrap gap-2">
            {driftFlags.map((flag, idx) => (
              <span
                key={idx}
                className="rounded bg-amber/20 px-2 py-1 text-xs text-amber"
              >
                {flag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Verdict */}
      {reportCard.verdict != null && (
        <div className="mt-4 rounded-lg border border-white/10 bg-surface/50 px-4 py-3">
          <span className="text-xs font-semibold uppercase text-cloud/60">
            Verdict:{' '}
          </span>
          <span className="text-sm text-cloud/80">{reportCard.verdict}</span>
        </div>
      )}
    </div>
  );
}
