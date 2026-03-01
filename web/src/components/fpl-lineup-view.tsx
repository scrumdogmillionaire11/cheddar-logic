"use client";

import { useState } from "react";
import type { PlayerProjection } from "@/lib/fpl-api";

interface FPLLineupViewProps {
  currentStarting: PlayerProjection[];
  currentBench: PlayerProjection[];
  projectedStarting?: PlayerProjection[] | null;
  projectedBench?: PlayerProjection[] | null;
}

const formatPts = (value?: number) => (value === undefined || value === null ? "-" : value.toFixed(1));

const renderPlayerRow = (player: PlayerProjection, index: number, isTransferOut?: boolean) => (
  <div 
    key={`${player.name}-${index}`} 
    className={`flex items-center justify-between rounded-lg border px-4 py-2 ${
      player.is_new 
        ? "border-teal/30 bg-teal/5"
        : isTransferOut
          ? "border-rose/30 bg-rose/5"
          : "border-white/10 bg-surface/50"
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
      <div className="text-sm font-semibold text-cloud/70">{formatPts(player.expected_pts)} pts</div>
      {player.ownership !== undefined && (
        <div className="text-xs text-cloud/50">{player.ownership.toFixed(1)}% own</div>
      )}
    </div>
  </div>
);

export default function FPLLineupView({
  currentStarting,
  currentBench,
  projectedStarting,
  projectedBench,
}: FPLLineupViewProps) {
  const [view, setView] = useState<"current" | "recommended">("current");
  
  const hasProjected = (projectedStarting?.length || 0) + (projectedBench?.length || 0) > 0;
  const showingCurrent = view === "current";
  const showingRecommended = view === "recommended" && hasProjected;

  // Get the data to display based on view
  const displayStarting = showingRecommended ? projectedStarting || [] : currentStarting;
  const displayBench = showingRecommended ? projectedBench || [] : currentBench;

  // Calculate transfer changes
  const transfersOut = showingRecommended 
    ? currentStarting
        .filter(p => !projectedStarting?.some(proj => proj.name === p.name))
        .concat(currentBench.filter(p => !projectedBench?.some(proj => proj.name === p.name)))
    : [];

  const transfersIn = showingRecommended
    ? (projectedStarting || [])
        .filter(p => p.is_new)
        .concat((projectedBench || []).filter(p => p.is_new))
    : [];

  return (
    <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
      {/* Header with Toggle */}
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-semibold">⚽ Squad Lineup</h2>
        
        {hasProjected && (
          <div className="flex rounded-lg border border-white/20 bg-surface/50 p-1">
            <button
              onClick={() => setView("current")}
              className={`rounded-md px-4 py-2 text-sm font-semibold transition ${
                showingCurrent
                  ? "bg-cloud text-night"
                  : "text-cloud/60 hover:text-cloud/80"
              }`}
            >
              Current
            </button>
            <button
              onClick={() => setView("recommended")}
              className={`rounded-md px-4 py-2 text-sm font-semibold transition ${
                showingRecommended
                  ? "bg-teal text-night"
                  : "text-cloud/60 hover:text-cloud/80"
              }`}
            >
              Recommended
            </button>
          </div>
        )}
      </div>

      {/* Transfer Summary (when showing recommended) */}
      {showingRecommended && (transfersIn.length > 0 || transfersOut.length > 0) && (
        <div className="mb-6 rounded-lg border border-teal/30 bg-teal/5 p-4">
          <div className="text-sm font-semibold text-teal">Transfer Changes</div>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-xs text-cloud/70">
            {transfersIn.length > 0 && (
              <div>
                <span className="font-semibold text-teal">In:</span> {transfersIn.map(p => p.name).join(", ")}
              </div>
            )}
            {transfersOut.length > 0 && (
              <div>
                <span className="font-semibold text-rose">Out:</span> {transfersOut.map(p => p.name).join(", ")}
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
              {displayStarting.reduce((sum, p) => sum + (p.expected_pts || 0), 0).toFixed(1)} pts
            </div>
          </div>
          <div className="space-y-2">
            {displayStarting.length > 0 ? (
              displayStarting.map((player, idx) => {
                const isOut = showingRecommended && transfersOut.some(p => p.name === player.name);
                return renderPlayerRow(player, idx, isOut);
              })
            ) : (
              <div className="rounded-lg border border-white/10 bg-surface/50 px-4 py-3 text-center text-sm text-cloud/60">
                No starting XI data available
              </div>
            )}
          </div>
        </div>

        {/* Bench */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase text-cloud/60">
              Bench
            </div>
            <div className="text-xs text-cloud/50">
              {displayBench.reduce((sum, p) => sum + (p.expected_pts || 0), 0).toFixed(1)} pts
            </div>
          </div>
          <div className="space-y-2">
            {displayBench.length > 0 ? (
              displayBench.map((player, idx) => {
                const isOut = showingRecommended && transfersOut.some(p => p.name === player.name);
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
          No transfers recommended — this is your optimal lineup for the upcoming gameweek
        </div>
      )}
    </div>
  );
}
