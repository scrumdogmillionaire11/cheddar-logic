'use client';

import { useState } from 'react';
import type { LineupDecisionPayload, PlayerProjection } from '@/lib/fpl-api';

interface FPLLineupViewProps {
  currentStarting: PlayerProjection[];
  currentBench: PlayerProjection[];
  lineupDecision?: LineupDecisionPayload | null;
  projectedStarting?: PlayerProjection[] | null;
  projectedBench?: PlayerProjection[] | null;
}

const formatPts = (value?: number) =>
  value === undefined || value === null ? '-' : value.toFixed(1);

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

const POSITION_ORDER = ['GK', 'DEF', 'MID', 'FWD'] as const;

const parsePlayerId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
};

const groupByPosition = (players: PlayerProjection[]) => {
  const grouped = {
    GK: [] as PlayerProjection[],
    DEF: [] as PlayerProjection[],
    MID: [] as PlayerProjection[],
    FWD: [] as PlayerProjection[],
  };

  players.forEach((player) => {
    const position = String(player.position || '').toUpperCase();
    if (position === 'GK' || position === 'DEF' || position === 'MID' || position === 'FWD') {
      grouped[position].push(player);
    }
  });

  return grouped;
};

const mapLineupStarterToProjection = (
  starter: NonNullable<LineupDecisionPayload['starters']>[number],
  reference?: PlayerProjection,
): PlayerProjection => ({
  name: starter.name,
  team: starter.team || reference?.team || '-',
  position: starter.position,
  price: reference?.price,
  ownership: reference?.ownership,
  expected_pts: starter.projected_points ?? reference?.expected_pts,
  injury_status: starter.flags?.join(', '),
  reasoning: starter.start_reason,
});

const mapLineupBenchToProjection = (
  benchPlayer: NonNullable<LineupDecisionPayload['bench']>[number],
  reference?: PlayerProjection,
): PlayerProjection => ({
  name: benchPlayer.name,
  team: benchPlayer.team || reference?.team || '-',
  position: benchPlayer.position,
  price: reference?.price,
  ownership: reference?.ownership,
  expected_pts: benchPlayer.projected_points ?? reference?.expected_pts,
  injury_status: benchPlayer.flags?.join(', '),
  reasoning: benchPlayer.bench_reason,
});

const renderPlayerRow = (
  player: PlayerProjection,
  index: number,
  isTransferOut?: boolean,
) => {
  const ownership = parseNumeric(player.ownership);
  const price = parseNumeric(player.price);
  return (
    <div
    key={`${player.name}-${index}`}
    className={`flex items-center justify-between rounded-lg border px-4 py-2 ${
      player.is_new
        ? 'border-teal/30 bg-teal/5'
        : isTransferOut
          ? 'border-rose/30 bg-rose/5'
          : 'border-white/10 bg-surface/50'
    }`}
  >
    <div className="flex-1">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{player.name}</span>
        {player.is_new && (
          <span className="rounded bg-teal/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-teal">
            In
          </span>
        )}
        {isTransferOut && (
          <span className="rounded bg-rose/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-rose">
            Out
          </span>
        )}
      </div>
      <div className="text-xs text-cloud/60">
        {player.team} · {player.position}
        {price !== null && <span className="ml-2">£{price}m</span>}
      </div>
    </div>
    <div className="text-right">
      <div className="text-sm font-semibold text-cloud/70">
        {formatPts(player.expected_pts)} pts
      </div>
      {ownership !== null && (
        <div className="text-xs text-cloud/50">
          {ownership.toFixed(1)}% own
        </div>
      )}
    </div>
  </div>
  );
};

const renderPitchPlayerCard = (
  player: PlayerProjection,
  index: number,
  isTransferOut?: boolean,
) => {
  const ownership = parseNumeric(player.ownership);
  const price = parseNumeric(player.price);
  return (
    <div
    key={`${player.name}-${index}`}
    className={`w-[132px] rounded-lg border px-3 py-2 text-center shadow-sm sm:w-[168px] sm:px-4 sm:py-3 ${
      player.is_new
        ? 'border-teal/35 bg-teal/10'
        : isTransferOut
          ? 'border-rose/35 bg-rose/10'
          : 'border-white/15 bg-surface/65'
    }`}
  >
    <div className="truncate text-sm font-semibold sm:text-[1.05rem]">
      {player.name}
    </div>
    <div className="mt-1 text-[11px] uppercase tracking-wide text-cloud/60 sm:text-xs">
      {player.team} · {player.position}
    </div>
    <div className="mt-1 text-sm font-semibold text-cloud/75 sm:text-[1.05rem]">
      {formatPts(player.expected_pts)} pts
    </div>
    <div className="mt-1 text-[11px] text-cloud/55 sm:text-xs">
      {price !== null ? `£${price}m` : '-'} |{' '}
      {ownership !== null ? `${ownership.toFixed(1)}% own` : '-'}
    </div>
  </div>
  );
};

export default function FPLLineupView({
  currentStarting,
  currentBench,
  lineupDecision,
  projectedStarting,
  projectedBench,
}: FPLLineupViewProps) {
  const [view, setView] = useState<'current' | 'recommended'>('current');

  const referencePlayers = [
    ...(projectedStarting || []),
    ...(projectedBench || []),
    ...currentStarting,
    ...currentBench,
  ];
  const resolveLineupReference = (
    playerId: number | string | undefined,
    name: string,
    team?: string,
    position?: string,
  ): PlayerProjection | undefined => {
    const normalizedName = String(name || '').trim().toLowerCase();
    const normalizedTeam = String(team || '').trim().toLowerCase();
    const normalizedPosition = String(position || '').trim().toUpperCase();
    const normalizedId = parsePlayerId(playerId);
    if (normalizedId !== null) {
      const byId = referencePlayers.find(
        (player) => parsePlayerId(player.player_id) === normalizedId,
      );
      if (byId) {
        return byId;
      }
    }
    return referencePlayers.find((player) => {
      if (String(player.name || '').trim().toLowerCase() !== normalizedName) {
        return false;
      }
      if (
        normalizedTeam &&
        String(player.team || '').trim().toLowerCase() !== normalizedTeam
      ) {
        return false;
      }
      if (
        normalizedPosition &&
        String(player.position || '').trim().toUpperCase() !== normalizedPosition
      ) {
        return false;
      }
      return true;
    });
  };

  const recommendedFromLineup = (lineupDecision?.starters || []).map((starter) =>
    mapLineupStarterToProjection(
      starter,
      resolveLineupReference(
        starter.player_id,
        starter.name,
        starter.team,
        starter.position,
      ),
    ),
  );
  const recommendedBenchFromLineup = [...(lineupDecision?.bench || [])]
    .sort((a, b) => (a.bench_order || 99) - (b.bench_order || 99))
    .map((benchPlayer) =>
      mapLineupBenchToProjection(
        benchPlayer,
        resolveLineupReference(
          benchPlayer.player_id,
          benchPlayer.name,
          benchPlayer.team,
          benchPlayer.position,
        ),
      ),
    );

  const hasProjected =
    (projectedStarting?.length || 0) +
      (projectedBench?.length || 0) +
      recommendedFromLineup.length +
      recommendedBenchFromLineup.length >
    0;
  const showingCurrent = view === 'current';
  const showingRecommended = view === 'recommended' && hasProjected;

  const hasLineupDecisionRecommended = recommendedFromLineup.length > 0;

  // Get the data to display based on view
  const displayStarting = showingRecommended
    ? hasLineupDecisionRecommended
      ? recommendedFromLineup
      : projectedStarting || []
    : currentStarting;
  const displayBench = showingRecommended
    ? hasLineupDecisionRecommended
      ? recommendedBenchFromLineup
      : projectedBench || []
    : currentBench;

  const groupedStarting = groupByPosition(displayStarting);

  const hasProjectedTransferSwaps =
    (projectedStarting?.length || 0) + (projectedBench?.length || 0) > 0;

  // Calculate transfer changes
  const transfersOut = showingRecommended && hasProjectedTransferSwaps
    ? currentStarting
        .filter((p) => !projectedStarting?.some((proj) => proj.name === p.name))
        .concat(
          currentBench.filter(
            (p) => !projectedBench?.some((proj) => proj.name === p.name),
          ),
        )
    : [];

  const transfersIn = showingRecommended && hasProjectedTransferSwaps
    ? (projectedStarting || [])
        .filter((p) => p.is_new)
        .concat((projectedBench || []).filter((p) => p.is_new))
    : [];

  return (
    <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
      {/* Header with Toggle */}
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-semibold">⚽ Squad Lineup</h2>

        {hasProjected && (
          <div className="flex rounded-lg border border-white/20 bg-surface/50 p-1">
            <button
              onClick={() => setView('current')}
              className={`rounded-md px-4 py-2 text-sm font-semibold transition ${
                showingCurrent
                  ? 'bg-cloud text-night'
                  : 'text-cloud/60 hover:text-cloud/80'
              }`}
            >
              Current
            </button>
            <button
              onClick={() => setView('recommended')}
              className={`rounded-md px-4 py-2 text-sm font-semibold transition ${
                showingRecommended
                  ? 'bg-teal text-night'
                  : 'text-cloud/60 hover:text-cloud/80'
              }`}
            >
              Recommended
            </button>
          </div>
        )}
      </div>

      {/* Transfer Summary (when showing recommended) */}
      {showingRecommended &&
        (transfersIn.length > 0 || transfersOut.length > 0) && (
          <div className="mb-6 rounded-lg border border-teal/30 bg-teal/5 p-4">
            <div className="text-sm font-semibold text-teal">
              Transfer Changes
            </div>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-xs text-cloud/70">
              {transfersIn.length > 0 && (
                <div>
                  <span className="font-semibold text-teal">In:</span>{' '}
                  {transfersIn.map((p) => p.name).join(', ')}
                </div>
              )}
              {transfersOut.length > 0 && (
                <div>
                  <span className="font-semibold text-rose">Out:</span>{' '}
                  {transfersOut.map((p) => p.name).join(', ')}
                </div>
              )}
            </div>
          </div>
        )}

      {/* Starting XI */}
      <div className="space-y-6">
        <div>
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase text-cloud/60">
              Starting XI
            </div>
            <div className="text-xs text-cloud/50">
              {displayStarting
                .reduce((sum, p) => sum + (parseNumeric(p.expected_pts) ?? 0), 0)
                .toFixed(1)}{' '}
              pts
            </div>
          </div>
          {showingRecommended && lineupDecision?.formation ? (
            <div className="mb-3 text-xs text-cloud/60">
              Recommended formation: {lineupDecision.formation}
            </div>
          ) : null}
          <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-night/40 p-3 sm:p-4">
            <div className="pointer-events-none absolute inset-0" aria-hidden="true">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(70,130,180,0.08),rgba(5,10,24,0)_65%)]" />
              <div className="absolute left-3 right-3 top-3 bottom-3 rounded-xl border border-cloud/20" />
              <div className="absolute left-3 right-3 top-1/2 h-px -translate-y-1/2 bg-cloud/20" />
              <div className="absolute left-3 right-3 top-[34%] h-px -translate-y-1/2 bg-cloud/15" />
              <div className="absolute left-3 right-3 top-[68%] h-px -translate-y-1/2 bg-cloud/15" />
              <div className="absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cloud/20 sm:h-24 sm:w-24" />
              <div className="absolute left-1/2 top-3 h-14 w-40 -translate-x-1/2 border border-cloud/15 border-t-0 sm:h-16 sm:w-48" />
              <div className="absolute left-1/2 top-3 h-8 w-20 -translate-x-1/2 border border-cloud/10 border-t-0 sm:w-24" />
              <div className="absolute left-1/2 bottom-3 h-14 w-40 -translate-x-1/2 border border-cloud/15 border-b-0 sm:h-16 sm:w-48" />
              <div className="absolute left-1/2 bottom-3 h-8 w-20 -translate-x-1/2 border border-cloud/10 border-b-0 sm:w-24" />
            </div>

            <div className="relative z-10 min-h-[440px] py-2 sm:min-h-[560px] sm:py-3">
              {displayStarting.length > 0 ? (
                <div className="grid min-h-[420px] grid-rows-[1.05fr_1.2fr_1.2fr_1.05fr] gap-1 px-1 sm:min-h-[530px] sm:px-3">
                  {POSITION_ORDER.map((position) => {
                    const rowPlayers = groupedStarting[position];
                    if (rowPlayers.length === 0) {
                      return (
                        <div
                          key={position}
                          className="relative flex items-center justify-center rounded-lg border border-transparent"
                        >
                          <div className="absolute left-0 top-2 text-[11px] font-semibold uppercase tracking-wide text-cloud/45 sm:left-1 sm:top-3">
                            {position} (0)
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div
                        key={position}
                        className="relative flex items-center justify-center rounded-lg border border-white/5 bg-white/[0.02] px-8 py-2 sm:px-10 sm:py-3"
                      >
                        <div className="absolute left-0 top-2 text-[11px] font-semibold uppercase tracking-wide text-cloud/50 sm:left-1 sm:top-3">
                          {position} ({rowPlayers.length})
                        </div>
                        <div className="flex w-full flex-wrap items-center justify-center gap-2 sm:gap-3">
                          {rowPlayers.map((player, idx) => {
                            const isOut =
                              showingRecommended &&
                              transfersOut.some((p) => p.name === player.name);
                            return renderPitchPlayerCard(player, idx, isOut);
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-white/10 bg-surface/50 px-4 py-3 text-center text-sm text-cloud/60">
                  No starting XI data available
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Bench */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase text-cloud/60">
              Bench
            </div>
            <div className="text-xs text-cloud/50">
              {displayBench
                .reduce((sum, p) => sum + (parseNumeric(p.expected_pts) ?? 0), 0)
                .toFixed(1)}{' '}
              pts
            </div>
          </div>
          <div className="space-y-2">
            {displayBench.length > 0 ? (
              displayBench.map((player, idx) => {
                const isOut =
                  showingRecommended &&
                  transfersOut.some((p) => p.name === player.name);
                return renderPlayerRow(player, idx, isOut);
              })
            ) : (
              <div className="rounded-lg border border-white/10 bg-surface/50 px-4 py-3 text-center text-sm text-cloud/60">
                No bench data available
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Info message when no projected squad */}
      {!hasProjected && (
        <div className="mt-6 rounded-lg border border-white/10 bg-surface/50 p-4 text-center text-sm text-cloud/60">
          No transfers recommended — this is your optimal lineup for the
          upcoming gameweek
        </div>
      )}
    </div>
  );
}
