/**
 * Current Squad Display
 * Shows current starting 11 and bench with positions
 */

interface Player {
  player_id?: number | string;
  name: string;
  position?: string;
  team?: string;
  expected_pts?: number;
  expected_minutes?: number;
  flags?: string[];
  badges?: string[];
  start_reason?: string;
  bench_reason?: string;
  bench_order?: number;
  is_new?: boolean;
}

interface CurrentSquadProps {
  startingXI?: Player[];
  bench?: Player[];
  title?: string;
  formation?: string;
  lineupConfidence?: string;
  formationReason?: string;
  riskProfileEffect?: string;
  captainPlayerId?: number | string | null;
  viceCaptainPlayerId?: number | string | null;
  notes?: string[];
}

export default function CurrentSquad({
  startingXI = [],
  bench = [],
  title = 'Current Squad',
  formation,
  lineupConfidence,
  formationReason,
  riskProfileEffect,
  captainPlayerId,
  viceCaptainPlayerId,
  notes = [],
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
  const orderedBench = [...bench].sort((a, b) => (a.bench_order || 99) - (b.bench_order || 99));

  const badgeForPlayer = (player: Player): string[] => {
    const badges = [...(player.badges || [])];
    const playerId = player.player_id;
    if (playerId !== undefined && playerId !== null) {
      if (captainPlayerId !== null && captainPlayerId !== undefined && String(playerId) === String(captainPlayerId)) {
        badges.unshift('C');
      } else if (viceCaptainPlayerId !== null && viceCaptainPlayerId !== undefined && String(playerId) === String(viceCaptainPlayerId)) {
        badges.unshift('VC');
      }
    }
    return badges;
  };

  return (
    <section className="bg-surface-card border border-surface-elevated p-6">
      <div className="mb-6">
        <h2 className="text-section text-sage-muted uppercase tracking-wider">
          {title}
        </h2>
        <div className="mt-2 text-xs text-sage-muted flex flex-wrap gap-3">
          {formation && <span>Formation: {formation}</span>}
          {lineupConfidence && <span>Lineup confidence: {lineupConfidence}</span>}
        </div>
        {formationReason && <p className="mt-2 text-body-sm text-sage-light">{formationReason}</p>}
        {riskProfileEffect && <p className="mt-1 text-body-sm text-sage-muted">{riskProfileEffect}</p>}
        {notes.length > 0 && (
          <ul className="mt-2 text-body-sm text-sage-muted list-disc list-inside">
            {notes.map((note, index) => (
              <li key={`${note}-${index}`}>{note}</li>
            ))}
          </ul>
        )}
      </div>

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
                      className="flex flex-col gap-1 py-2 px-3 bg-surface-elevated/50 rounded"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className={`text-body text-sage-white ${player.is_new ? 'font-semibold' : ''}`}>
                          {player.name}
                          {player.is_new && <span className="ml-2 text-xs text-execute">NEW</span>}
                        </span>
                        <div className="flex items-center gap-2">
                          {badgeForPlayer(player).map((badge) => (
                            <span key={`${player.name}-${badge}`} className="text-xs px-2 py-0.5 bg-surface-elevated text-sage-light rounded">
                              {badge}
                            </span>
                          ))}
                          {player.team && (
                            <span className="text-xs text-sage-muted uppercase">{player.team}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-sage-muted">
                          {player.expected_minutes !== undefined ? `${player.expected_minutes.toFixed(0)} mins` : ''}
                        </div>
                        {player.expected_pts !== undefined && (
                          <div className="text-sm text-sage-light font-medium">
                            {player.expected_pts.toFixed(1)} pts
                          </div>
                        )}
                      </div>
                      {player.flags && player.flags.length > 0 && (
                        <div className="text-xs text-hold">{player.flags.join(' • ')}</div>
                      )}
                      {player.start_reason && <div className="text-xs text-sage-muted">{player.start_reason}</div>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Bench */}
      {orderedBench.length > 0 && (
        <div className="pt-4 border-t border-surface-elevated">
          <div className="text-sm font-medium text-sage-muted mb-3">Bench ({orderedBench.length})</div>
          <div className="space-y-1">
            {orderedBench.map((player, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between py-2 px-3 bg-surface-elevated/30 rounded"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs text-sage-muted w-6">{player.bench_order ?? idx + 1}</span>
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
          {orderedBench.some((player) => player.bench_reason) && (
            <div className="mt-2 text-xs text-sage-muted space-y-1">
              {orderedBench.map((player, idx) => (
                player.bench_reason ? <div key={`bench-reason-${idx}`}>#{player.bench_order ?? idx + 1} {player.name}: {player.bench_reason}</div> : null
              ))}
            </div>
          )}
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
