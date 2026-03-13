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

const POSITION_ORDER = ['GK', 'DEF', 'MID', 'FWD'] as const;

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
): PlayerProjection => ({
  name: starter.name,
  team: starter.team || '-',
  position: starter.position,
  expected_pts: starter.projected_points,
  injury_status: starter.flags?.join(', '),
  reasoning: starter.start_reason,
});

const mapLineupBenchToProjection = (
  benchPlayer: NonNullable<LineupDecisionPayload['bench']>[number],
): PlayerProjection => ({
  name: benchPlayer.name,
  team: benchPlayer.team || '-',
  position: benchPlayer.position,
  expected_pts: benchPlayer.projected_points,
  injury_status: benchPlayer.flags?.join(', '),
  reasoning: benchPlayer.bench_reason,
});

const renderPlayerRow = (
  player: PlayerProjection,
  index: number,
  isTransferOut?: boolean,
) => (
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
        {player.price && <span className="ml-2">£{player.price}m</span>}
      </div>
    </div>
    <div className="text-right">
      <div className="text-sm font-semibold text-cloud/70">
        {formatPts(player.expected_pts)} pts
      </div>
      {player.ownership !== undefined && (
        <div className="text-xs text-cloud/50">
          {player.ownership.toFixed(1)}% own
        </div>
      )}
    </div>
  </div>
);

const renderPitchPlayerCard = (
  player: PlayerProjection,
  index: number,
  isTransferOut?: boolean,
) => (
  <div
    key={`${player.name}-${index}`}
    className={`w-[130px] rounded border p-2 text-center sm:w-[145px] sm:p-3 ${
      player.is_new
        ? 'border-teal/30 bg-teal/5'
        : isTransferOut
          ? 'border-rose/30 bg-rose/5'
          : 'border-white/10 bg-surface/60'
    }`}
  >
    <div className="text-xs font-semibold sm:text-sm">{player.name}</div>
    <div className="mt-1 text-[10px] text-cloud/60 sm:text-xs">
      {player.team} · {player.position}
    </div>
    <div className="mt-1 text-xs font-semibold text-cloud/70 sm:text-sm">
      {formatPts(player.expected_pts)} pts
    </div>
    <div className="mt-1 text-[10px] text-cloud/50 sm:text-xs">
      {player.price !== undefined ? `£${player.price}m` : '-'} |{' '}
      {player.ownership !== undefined ? `${player.ownership.toFixed(1)}% own` : '-'}
    </div>
  </div>
);

export default function FPLLineupView({
  currentStarting,
  currentBench,
  lineupDecision,
  projectedStarting,
  projectedBench,
}: FPLLineupViewProps) {
  const [view, setView] = useState<'current' | 'recommended'>('current');

  const recommendedFromLineup = (lineupDecision?.starters || []).map(
    mapLineupStarterToProjection,
  );
  const recommendedBenchFromLineup = [...(lineupDecision?.bench || [])]
    .sort((a, b) => (a.bench_order || 99) - (b.bench_order || 99))
    .map(mapLineupBenchToProjection);

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

  // Calculate transfer changes
  const transfersOut = showingRecommended
    ? currentStarting
        .filter((p) => !projectedStarting?.some((proj) => proj.name === p.name))
        .concat(
          currentBench.filter(
            (p) => !projectedBench?.some((proj) => proj.name === p.name),
          ),
        )
    : [];

  const transfersIn = showingRecommended
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
                .reduce((sum, p) => sum + (p.expected_pts || 0), 0)
                .toFixed(1)}{' '}
              pts
            </div>
          </div>
          {showingRecommended && lineupDecision?.formation ? (
            <div className="mb-3 text-xs text-cloud/60">
              Recommended formation: {lineupDecision.formation}
            </div>
          ) : null}
          <div className="relative overflow-hidden rounded-xl border border-white/10 bg-surface/50 p-3 sm:p-4">
            <div className="pointer-events-none absolute inset-0" aria-hidden="true">
              <div className="absolute left-3 right-3 top-3 bottom-3 rounded-lg border border-cloud/20" />
              <div className="absolute left-3 right-3 top-1/2 h-px -translate-y-1/2 bg-cloud/20" />
              <div className="absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cloud/20 sm:h-24 sm:w-24" />
              <div className="absolute left-1/2 top-3 h-14 w-40 -translate-x-1/2 border border-cloud/15 border-t-0 sm:h-16 sm:w-48" />
              <div className="absolute left-1/2 top-3 h-8 w-20 -translate-x-1/2 border border-cloud/10 border-t-0 sm:w-24" />
              <div className="absolute left-1/2 bottom-3 h-14 w-40 -translate-x-1/2 border border-cloud/15 border-b-0 sm:h-16 sm:w-48" />
              <div className="absolute left-1/2 bottom-3 h-8 w-20 -translate-x-1/2 border border-cloud/10 border-b-0 sm:w-24" />
            </div>

            <div className="relative z-10 min-h-[370px] space-y-3 py-2 sm:min-h-[430px] sm:space-y-4 sm:py-3">
            {displayStarting.length > 0 ? (
              POSITION_ORDER.map((position) => {
                const rowPlayers = groupedStarting[position];
                if (rowPlayers.length === 0) {
                  return null;
                }
                return (
                  <div key={position} className="space-y-2">
                    <div className="text-[11px] font-semibold uppercase text-cloud/50">
                      {position} ({rowPlayers.length})
                    </div>
                    <div className="flex flex-wrap justify-center gap-2 sm:gap-3">
                    {rowPlayers.map((player, idx) => {
                      const isOut =
                        showingRecommended &&
                        transfersOut.some((p) => p.name === player.name);
                      return renderPitchPlayerCard(player, idx, isOut);
                    })}
                    </div>
                  </div>
                );
              })
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
                .reduce((sum, p) => sum + (p.expected_pts || 0), 0)
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
