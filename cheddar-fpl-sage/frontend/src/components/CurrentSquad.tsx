/**
 * Current Squad Display
 * Shows current starting 11 and bench with positions
 */

interface Player {
  name: string;
  position?: string;
  team?: string;
  expected_pts?: number;
  is_new?: boolean;
}

interface CurrentSquadProps {
  startingXI?: Player[];
  bench?: Player[];
  title?: string;
}

export default function CurrentSquad({
  startingXI = [],
  bench = [],
  title = 'Current Squad',
}: CurrentSquadProps) {
  const formatPosition = (pos?: string) => {
    if (!pos) return '';
    // GK, DEF, MID, FWD
    return pos.toUpperCase();
  };

  const getPositionColor = (pos?: string) => {
    if (!pos) return 'text-sage-muted';
    const p = pos.toUpperCase();
    if (p === 'GK') return 'text-yellow-400';
    if (p === 'DEF') return 'text-green-400';
    if (p === 'MID') return 'text-blue-400';
    if (p === 'FWD') return 'text-red-400';
    return 'text-sage-muted';
  };

  // Group by position
  const byPosition = (players: Player[]) => {
    const groups: Record<string, Player[]> = {
      GK: [],
      DEF: [],
      MID: [],
      FWD: [],
    };
    
    players.forEach(player => {
      const pos = formatPosition(player.position);
      if (pos && groups[pos]) {
        groups[pos].push(player);
      }
    });
    
    return groups;
  };

  const startingGroups = byPosition(startingXI);

  return (
    <section className="bg-surface-card border border-surface-elevated p-6">
      <h2 className="text-section text-sage-muted uppercase tracking-wider mb-6">
        {title}
      </h2>

      {/* Starting XI by Position */}
      {startingXI.length > 0 && (
        <div className="space-y-4 mb-6">
          <div className="text-sm font-medium text-sage-light mb-3">Starting XI</div>
          
          {(['GK', 'DEF', 'MID', 'FWD'] as const).map((pos) => {
            const players = startingGroups[pos];
            if (players.length === 0) return null;
            
            return (
              <div key={pos} className="space-y-2">
                <div className={`text-xs font-semibold uppercase tracking-wider ${getPositionColor(pos)}`}>
                  {pos} ({players.length})
                </div>
                <div className="space-y-1">
                  {players.map((player, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between py-2 px-3 bg-surface-elevated/50 rounded"
                    >
                      <div className="flex items-center gap-3">
                        <span className={`text-body text-sage-white ${player.is_new ? 'font-semibold' : ''}`}>
                          {player.name}
                          {player.is_new && <span className="ml-2 text-xs text-execute">NEW</span>}
                        </span>
                        {player.team && (
                          <span className="text-xs text-sage-muted uppercase">{player.team}</span>
                        )}
                      </div>
                      {player.expected_pts !== undefined && (
                        <div className="text-sm text-sage-light font-medium">
                          {player.expected_pts.toFixed(1)} pts
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Bench */}
      {bench.length > 0 && (
        <div className="pt-4 border-t border-surface-elevated">
          <div className="text-sm font-medium text-sage-muted mb-3">Bench ({bench.length})</div>
          <div className="space-y-1">
            {bench.map((player, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between py-2 px-3 bg-surface-elevated/30 rounded"
              >
                <div className="flex items-center gap-3">
                  <span className={`text-xs ${getPositionColor(player.position)} font-semibold w-8`}>
                    {formatPosition(player.position)}
                  </span>
                  <span className={`text-sm text-sage-muted ${player.is_new ? 'font-semibold text-sage-white' : ''}`}>
                    {player.name}
                    {player.is_new && <span className="ml-2 text-xs text-execute">NEW</span>}
                  </span>
                  {player.team && (
                    <span className="text-xs text-sage-muted/70 uppercase">{player.team}</span>
                  )}
                </div>
                {player.expected_pts !== undefined && (
                  <div className="text-sm text-sage-muted">
                    {player.expected_pts.toFixed(1)} pts
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {startingXI.length === 0 && bench.length === 0 && (
        <div className="text-center text-sage-muted py-8">
          No squad data available
        </div>
      )}
    </section>
  );
}
