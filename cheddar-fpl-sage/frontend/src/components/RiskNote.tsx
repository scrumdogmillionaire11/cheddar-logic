/**
 * RISK NOTE — Always Visible
 *
 * Shows risk statement and squad health metrics
 */

interface SquadHealth {
  total_players: number;
  available: number;
  injured: number;
  doubtful: number;
  health_pct: number;
  critical_positions: string[];
}

interface RiskNoteProps {
  riskStatement: string;
  squadHealth?: SquadHealth;
}

export default function RiskNote({ riskStatement, squadHealth }: RiskNoteProps) {
  // Determine health status color
  const getHealthColor = (pct: number) => {
    if (pct >= 90) return 'text-execute';
    if (pct >= 75) return 'text-hold';
    return 'text-veto';
  };

  const hasHealthIssues = squadHealth && (squadHealth.injured > 0 || squadHealth.doubtful > 0);

  return (
    <section className="bg-surface-card border border-risky/30 p-8">
      <div className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-2xl">⚠️</span>
          <h2 className="text-section text-risky uppercase tracking-wider">Risk Note</h2>
        </div>

        {/* Squad Health - if available and has issues */}
        {squadHealth && hasHealthIssues && (
          <div className="flex items-center gap-4 py-2 border-b border-surface-elevated">
            <div className="text-body-sm text-sage-muted">Squad Health:</div>
            <div className={`text-body font-medium ${getHealthColor(squadHealth.health_pct)}`}>
              {squadHealth.health_pct.toFixed(0)}%
            </div>
            <div className="text-body-sm text-sage-muted">
              ({squadHealth.available}/{squadHealth.total_players} available
              {squadHealth.injured > 0 && `, ${squadHealth.injured} out`}
              {squadHealth.doubtful > 0 && `, ${squadHealth.doubtful} doubt`})
            </div>
            {squadHealth.critical_positions.length > 0 && (
              <div className="text-body-sm text-veto">
                Watch: {squadHealth.critical_positions.join(', ')}
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-sage-muted italic">
          Important considerations for this gameweek's recommendation
        </p>
        <p className="text-body text-sage-light max-w-xl">
          {riskStatement}
        </p>
      </div>
    </section>
  );
}
