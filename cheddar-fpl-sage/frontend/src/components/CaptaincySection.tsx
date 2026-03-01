/**
 * CAPTAINCY — Always Visible
 *
 * Shows captain + vice with delta comparison
 */

interface Captain {
  name: string;
  team?: string;
  position?: string;
  rationale?: string;
  expected_pts?: number;
  ownership_pct?: number;
  ownership_insight?: string;
  form_avg?: number;
  fixture_difficulty?: number;
}

interface CaptainDelta {
  delta_pts?: number;
  delta_pts_4gw?: number;
}

interface CaptaincySectionProps {
  captain: Captain;
  viceCaptain: Captain;
  delta?: CaptainDelta;
}

export default function CaptaincySection({ captain, viceCaptain, delta }: CaptaincySectionProps) {
  // Format delta display
  const formatDelta = (pts: number | undefined) => {
    if (pts === undefined || pts === null) return null;
    return pts > 0 ? `+${pts.toFixed(1)}` : pts.toFixed(1);
  };

  const deltaDisplay = formatDelta(delta?.delta_pts);

  return (
    <section className="bg-surface-card border border-surface-elevated p-8">
      <h2 className="text-section text-sage-muted mb-6 uppercase tracking-wider">Captaincy</h2>

      <div className="space-y-6">
        {/* Captain */}
        <div className="space-y-2">
          <div className="text-xs text-sage-muted uppercase tracking-wider mb-2">
            Captain (2x points)
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-2xl">🎯</span>
            <span className="text-page-title text-sage-white font-semibold">
              {captain.name}
            </span>
            {captain.team && (
              <span className="text-body-sm text-sage-muted">
                {captain.team} · {captain.position}
              </span>
            )}
            {captain.expected_pts && (
              <span className="text-body-sm text-execute font-medium">
                {captain.expected_pts.toFixed(1)} pts
              </span>
            )}
          </div>

          {/* Context badges - ownership, form, fixture */}
          <div className="flex flex-wrap gap-2 mt-3">
            {captain.ownership_pct !== undefined && captain.ownership_insight && (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-surface-elevated rounded text-body-sm">
                <span className="text-sage-muted">{captain.ownership_pct.toFixed(1)}% owned</span>
                <span className="text-sage-light">·</span>
                <span className="text-sage-white">{captain.ownership_insight}</span>
              </div>
            )}
            {captain.form_avg && captain.form_avg > 6 && (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-surface-elevated rounded text-body-sm">
                <span className="text-execute">🔥</span>
                <span className="text-sage-white">Hot form: {captain.form_avg} pts/game avg</span>
              </div>
            )}
            {captain.fixture_difficulty !== undefined && captain.fixture_difficulty <= 2 && (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-surface-elevated rounded text-body-sm">
                <span className="text-execute">🎯</span>
                <span className="text-sage-white">Great matchup</span>
              </div>
            )}
            {captain.fixture_difficulty !== undefined && captain.fixture_difficulty >= 4 && (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-surface-elevated rounded text-body-sm">
                <span className="text-veto">⚠️</span>
                <span className="text-sage-white">Tough fixture</span>
              </div>
            )}
          </div>

          {/* Delta indicator */}
          {deltaDisplay && (
            <div className="flex items-center gap-2 mt-2">
              <span className="text-body-sm text-sage-muted">vs Vice:</span>
              <span className={`text-body font-medium ${delta!.delta_pts! > 0 ? 'text-execute' : 'text-hold'}`}>
                {deltaDisplay} pts
              </span>
              {delta?.delta_pts_4gw && (
                <span className="text-body-sm text-sage-muted">
                  ({formatDelta(delta.delta_pts_4gw)} over 4 GWs)
                </span>
              )}
            </div>
          )}

          {captain.rationale && (
            <p className="text-body text-sage-light max-w-xl mt-2">
              {captain.rationale}
            </p>
          )}
        </div>

        {/* Vice Captain - De-emphasized */}
        <div className="pt-4 border-t border-surface-elevated space-y-2">
          <div className="text-xs text-sage-muted uppercase tracking-wider mb-2">
            Vice Captain (backup if captain doesn't play)
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-decision text-sage-white font-medium">
              {viceCaptain.name}
            </span>
            {viceCaptain.team && (
              <span className="text-body-sm text-sage-muted">
                {viceCaptain.team} · {viceCaptain.position}
              </span>
            )}
            {viceCaptain.expected_pts && (
              <span className="text-body-sm text-sage-muted">
                {viceCaptain.expected_pts.toFixed(1)} pts
              </span>
            )}
          </div>
          {viceCaptain.rationale && (
            <p className="text-body-sm text-sage-muted max-w-xl">
              {viceCaptain.rationale}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
