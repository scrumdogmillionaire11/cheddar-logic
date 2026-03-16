'use client';

export interface RawProjectionPlay {
  projectedTotal: number | null;
  line?: number;
  selection?: { side: string };
  reason_codes?: string[];
  confidence: number;
  tier: 'SUPER' | 'BEST' | 'WATCH' | null;
  reasoning: string;
  goalie_home_name?: string | null;
  goalie_away_name?: string | null;
  goalie_home_status?: 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | null;
  goalie_away_status?: 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | null;
}

interface ProjectionCardProps {
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  play: RawProjectionPlay;
}

function formatGameTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return '';
  }
}

function goalieStatusColor(status?: string | null): string {
  if (status === 'CONFIRMED') return 'text-green-400';
  if (status === 'EXPECTED') return 'text-yellow-400';
  return 'text-cloud/40';
}

function goalieStatusLabel(status?: string | null): string {
  if (status === 'CONFIRMED') return 'confirmed';
  if (status === 'EXPECTED') return 'expected';
  return 'unknown';
}

export default function ProjectionCard({
  homeTeam,
  awayTeam,
  startTime,
  play,
}: ProjectionCardProps) {
  const side = play.selection?.side ?? 'NONE';
  const projectedTotal =
    typeof play.projectedTotal === 'number' ? play.projectedTotal : null;
  const line = typeof play.line === 'number' ? play.line : 1.5;
  const delta =
    projectedTotal !== null
      ? Math.round((projectedTotal - line) * 100) / 100
      : null;

  const reasonCodes = Array.isArray(play.reason_codes) ? play.reason_codes : [];
  const isGoalieUncertain = reasonCodes.includes('NHL_1P_GOALIE_UNCERTAIN');

  const confidence =
    typeof play.confidence === 'number' ? play.confidence : null;
  const tier = play.tier ?? 'WATCH';
  const tierColor =
    tier === 'BEST'
      ? 'text-green-400'
      : tier === 'SUPER'
        ? 'text-yellow-400'
        : 'text-cloud/50';

  const sideLabel = side === 'NONE' ? 'PASS' : side;
  const sideBg =
    side === 'OVER'
      ? 'bg-cyan-700/40 text-cyan-200 border-cyan-600/40'
      : side === 'UNDER'
        ? 'bg-orange-700/40 text-orange-200 border-orange-600/40'
        : 'bg-white/5 text-cloud/40 border-white/10';

  const deltaColor =
    delta === null
      ? 'text-cloud/40'
      : delta > 0
        ? 'text-cyan-400'
        : delta < 0
          ? 'text-orange-400'
          : 'text-cloud/40';

  const hasGoalieContext =
    play.goalie_home_name || play.goalie_away_name || isGoalieUncertain;

  const displayReasonCodes = reasonCodes.filter(
    (c) => c !== 'NHL_1P_GOALIE_UNCERTAIN',
  );

  return (
    <div className="rounded-lg border border-white/10 bg-surface/60 p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 text-xs font-bold rounded bg-blue-900/40 text-blue-300 border border-blue-700/40">
            NHL
          </span>
          <span className="text-[10px] font-mono tracking-widest text-cloud/30 uppercase">
            1P Projection
          </span>
        </div>
        <span className="text-xs font-mono text-cloud/40">
          {formatGameTime(startTime)}
        </span>
      </div>

      {/* Matchup */}
      <div className="text-sm font-semibold text-cloud/90">
        {awayTeam} @ {homeTeam}
      </div>

      {/* Hero */}
      <div className="flex items-center gap-5">
        {/* Projected value */}
        <div className="text-center min-w-[56px]">
          <div className="text-3xl font-bold font-mono text-cloud leading-none">
            {projectedTotal !== null ? projectedTotal.toFixed(2) : '—'}
          </div>
          <div className="text-[10px] text-cloud/30 mt-1">proj. goals</div>
        </div>

        {/* Line + delta */}
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-mono text-cloud/40">
            line{' '}
            <span className="text-cloud/70 font-semibold">
              {line.toFixed(1)}
            </span>
          </span>
          {delta !== null && (
            <span className={`text-xs font-mono font-semibold ${deltaColor}`}>
              {delta > 0 ? '+' : ''}
              {delta.toFixed(2)} goals
            </span>
          )}
        </div>

        {/* Call badge + confidence */}
        <div className="ml-auto flex flex-col items-end gap-1.5">
          <span
            className={`px-3 py-1 text-sm font-bold rounded border ${sideBg}`}
          >
            {sideLabel}
          </span>
          {confidence !== null && (
            <span className={`text-xs font-mono ${tierColor}`}>
              {Math.round(confidence * 100)}%{' '}
              <span className="opacity-60">{tier}</span>
            </span>
          )}
        </div>
      </div>

      {/* Goalie context */}
      {hasGoalieContext && (
        <div className="border-t border-white/5 pt-3 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-cloud/30">
            Goalie Context
          </p>
          {isGoalieUncertain ? (
            <p className="text-xs text-amber-400/80">
              Uncertain — capped to PASS
            </p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono">
              {play.goalie_away_name && (
                <span>
                  <span className="text-cloud/40">{awayTeam}: </span>
                  <span className={goalieStatusColor(play.goalie_away_status)}>
                    {play.goalie_away_name}
                  </span>
                  <span className="text-cloud/25 ml-1">
                    ({goalieStatusLabel(play.goalie_away_status)})
                  </span>
                </span>
              )}
              {play.goalie_home_name && (
                <span>
                  <span className="text-cloud/40">{homeTeam}: </span>
                  <span className={goalieStatusColor(play.goalie_home_status)}>
                    {play.goalie_home_name}
                  </span>
                  <span className="text-cloud/25 ml-1">
                    ({goalieStatusLabel(play.goalie_home_status)})
                  </span>
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Reasoning note */}
      {play.reasoning && (
        <div className="border-t border-white/5 pt-3">
          <p className="text-xs text-cloud/40 italic leading-relaxed">
            {play.reasoning}
          </p>
        </div>
      )}

      {/* Ancillary reason codes */}
      {displayReasonCodes.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {displayReasonCodes.map((code) => (
            <span
              key={code}
              className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-white/5 text-cloud/35 border border-white/5"
            >
              {code}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
