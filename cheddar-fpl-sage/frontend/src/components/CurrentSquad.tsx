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
  price?: number;
  ownership?: number;
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

  const positionRows: Array<'FWD' | 'MID' | 'DEF' | 'GK'> = ['FWD', 'MID', 'DEF', 'GK'];

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

  const renderPlayerCard = (player: Player, key: string, compact = false) => (
    <div
      key={key}
      className={`rounded border ${player.is_new ? 'border-execute/40 bg-execute/10' : 'border-surface-elevated bg-surface-elevated/50'} ${compact ? 'w-[120px] p-2' : 'w-[150px] p-3'} text-center`}
    >
      <div className={`font-medium text-sage-white ${compact ? 'text-xs' : 'text-sm'}`}>
        {player.name}
      </div>
      <div className={`mt-1 ${compact ? 'text-[10px]' : 'text-xs'} text-sage-muted uppercase`}>
        {player.team || '-'} · {formatPosition(player.position)}
      </div>
      {player.expected_pts !== undefined && (
        <div className={`mt-1 ${compact ? 'text-xs' : 'text-sm'} text-sage-light`}>
          {player.expected_pts.toFixed(1)} pts
        </div>
      )}
      <div className={`mt-1 ${compact ? 'text-[10px]' : 'text-xs'} text-sage-muted`}>
        {player.price !== undefined ? `£${player.price.toFixed(1)}m` : '-'}
        {' | '}
        {player.ownership !== undefined ? `${player.ownership.toFixed(1)}% own` : '-'}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-1">
        {badgeForPlayer(player).map((badge) => (
          <span key={`${player.name}-${badge}`} className="rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] text-sage-light">
            {badge}
          </span>
        ))}
        {player.flags && player.flags.length > 0 && (
          <span className="text-[10px] text-hold">{player.flags[0]}</span>
        )}
      </div>
    </div>
  );

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

      {/* Starting XI as pitch layout */}
      {startingXI.length > 0 && (
        <div className="mb-6 space-y-4">
          <div className="text-sm font-medium text-sage-light mb-3">Starting XI</div>

          <div className="relative overflow-hidden rounded-xl border border-surface-elevated bg-surface-primary/40 p-3 sm:p-4">
            <div className="pointer-events-none absolute inset-0" aria-hidden="true">
              <div className="absolute left-3 right-3 top-3 bottom-3 rounded-lg border border-sage-muted/35" />
              <div className="absolute left-3 right-3 top-1/2 h-px -translate-y-1/2 bg-sage-muted/35" />
              <div className="absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-sage-muted/35 sm:h-24 sm:w-24" />

              <div className="absolute left-1/2 top-3 h-14 w-40 -translate-x-1/2 border border-sage-muted/30 border-t-0 sm:h-16 sm:w-48" />
              <div className="absolute left-1/2 top-3 h-8 w-20 -translate-x-1/2 border border-sage-muted/25 border-t-0 sm:w-24" />

              <div className="absolute left-1/2 bottom-3 h-14 w-40 -translate-x-1/2 border border-sage-muted/30 border-b-0 sm:h-16 sm:w-48" />
              <div className="absolute left-1/2 bottom-3 h-8 w-20 -translate-x-1/2 border border-sage-muted/25 border-b-0 sm:w-24" />
            </div>

            <div className="relative z-10">
              <div className="mb-2 text-center text-[11px] uppercase tracking-widest text-sage-muted/80">
                Aerial pitch view
              </div>
              <div className="min-h-[370px] sm:min-h-[430px] flex flex-col justify-between py-2 sm:py-3">
                {positionRows.map((pos) => {
                  const players = startingGroups[pos];
                  if (players.length === 0) return null;

                  return (
                    <div key={pos} className="space-y-2">
                      <div className={`text-center text-xs font-semibold uppercase tracking-wider ${getPositionColor(pos)}`}>
                        {pos} ({players.length})
                      </div>
                      <div className="flex flex-wrap justify-center gap-2 sm:gap-3">
                        {players.map((player, idx) =>
                          renderPlayerCard(player, `${pos}-${player.name}-${idx}`, true),
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
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
                <div className="flex items-center gap-3 text-xs text-sage-muted">
                  {player.expected_pts !== undefined && <span>{player.expected_pts.toFixed(1)} pts</span>}
                  <span>{player.price !== undefined ? `£${player.price.toFixed(1)}m` : '-'}</span>
                  <span>{player.ownership !== undefined ? `${player.ownership.toFixed(1)}% own` : '-'}</span>
                </div>
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
