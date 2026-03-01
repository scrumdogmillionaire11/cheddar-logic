/**
 * Team Info Display
 * Shows team value, bank, overall rank, and points
 */

interface TeamInfoProps {
  teamName?: string;
  managerName?: string;
  teamValue?: number;
  bank?: number;
  overallRank?: number;
  overallPoints?: number;
}

export default function TeamInfo({
  teamName,
  managerName,
  teamValue,
  bank,
  overallRank,
  overallPoints,
}: TeamInfoProps) {
  return (
    <section className="bg-surface-card border border-surface-elevated p-6">
      <div className="space-y-4">
        {/* Team Name and Manager */}
        <div>
          <h2 className="text-xl font-bold text-sage-white">{teamName || 'Your Team'}</h2>
          {managerName && (
            <p className="text-sm text-sage-muted">{managerName}</p>
          )}
        </div>

        {/* Financial Info */}
        {(teamValue !== undefined || bank !== undefined) && (
          <div className="flex gap-6 pt-2">
            {teamValue !== undefined && (
              <div>
                <div className="text-meta text-sage-muted uppercase tracking-wider mb-1">
                  Team Value
                </div>
                <div className="text-2xl font-semibold text-sage-white">
                  £{teamValue.toFixed(1)}m
                </div>
              </div>
            )}
            {bank !== undefined && (
              <div>
                <div className="text-meta text-sage-muted uppercase tracking-wider mb-1">
                  In The Bank
                </div>
                <div className="text-2xl font-semibold text-sage-light">
                  £{bank.toFixed(1)}m
                </div>
              </div>
            )}
          </div>
        )}

        {/* Rank and Points */}
        {(overallRank !== undefined || overallPoints !== undefined) && (
          <div className="flex gap-6 pt-2 border-t border-surface-elevated">
            {overallRank !== undefined && (
              <div className="pt-3">
                <div className="text-meta text-sage-muted uppercase tracking-wider mb-1">
                  Overall Rank
                </div>
                <div className="text-lg font-medium text-sage-white">
                  {overallRank.toLocaleString()}
                </div>
              </div>
            )}
            {overallPoints !== undefined && (
              <div className="pt-3">
                <div className="text-meta text-sage-muted uppercase tracking-wider mb-1">
                  Total Points
                </div>
                <div className="text-lg font-medium text-sage-light">
                  {overallPoints.toLocaleString()}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
