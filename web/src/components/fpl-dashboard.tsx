"use client";

import type { DetailedAnalysisResponse, PlayerProjection, TransferPlan, TransferPlans } from "@/lib/fpl-api";

interface FPLDashboardProps {
  data: DetailedAnalysisResponse;
}

const formatPts = (value?: number) => (value === undefined || value === null ? "-" : value.toFixed(1));

const getConfidenceTone = (confidence: string) => {
  const normalized = confidence.toUpperCase();
  if (normalized === "HIGH") return "text-teal";
  if (normalized === "LOW") return "text-rose";
  return "text-amber";
};

const renderPlayerRow = (player: PlayerProjection, index: number) => (
  <div key={`${player.name}-${index}`} className="flex items-center justify-between rounded-lg border border-white/10 bg-surface/50 px-4 py-2">
    <div>
      <div className="text-sm font-semibold">
        {player.name}
        {player.is_new && <span className="ml-2 rounded bg-teal/15 px-2 py-0.5 text-[10px] uppercase text-teal">New</span>}
      </div>
      <div className="text-xs text-cloud/60">
        {player.team} · {player.position}
      </div>
    </div>
    <div className="text-sm text-cloud/70">{formatPts(player.expected_pts)} pts</div>
  </div>
);

const renderTransferPlan = (label: string, plan: TransferPlan) => (
  <div className="rounded-lg border border-white/10 bg-surface/50 p-4">
    <div className="mb-3 flex items-center justify-between">
      <div className="text-xs font-semibold uppercase text-cloud/60">{label}</div>
      {plan.confidence && (
        <span className={`text-xs font-semibold uppercase ${getConfidenceTone(plan.confidence)}`}>
          {plan.confidence} confidence
        </span>
      )}
    </div>
    <div className="mb-2 text-lg font-semibold">
      {plan.out} → {plan.in}
    </div>
    <div className="flex flex-wrap gap-4 text-xs text-cloud/60">
      <span>Hit: {plan.hit_cost > 0 ? `-${plan.hit_cost} pts` : "Free"}</span>
      <span>Net: {plan.net_cost > 0 ? `+£${plan.net_cost}m` : `${plan.net_cost}m`}</span>
      {plan.delta_pts_4gw !== undefined && (
        <span>Δ 4GW: {plan.delta_pts_4gw > 0 ? "+" : ""}{plan.delta_pts_4gw.toFixed(1)} pts</span>
      )}
    </div>
    {plan.reason && <p className="mt-2 text-sm text-cloud/70">{plan.reason}</p>}
  </div>
);

export default function FPLDashboard({ data }: FPLDashboardProps) {
  if (!data) {
    return null;
  }

  const plans: TransferPlans | null | undefined = data.transfer_plans;
  const hasProjected = (data.projected_xi?.length || 0) + (data.projected_bench?.length || 0) > 0;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="mb-2 text-sm font-semibold uppercase text-cloud/60">Gameweek</div>
            <div className="text-4xl font-semibold">{data.current_gw ?? "-"}</div>
          </div>
          <div>
            <div className="mb-2 text-sm font-semibold uppercase text-cloud/60">Team</div>
            <div className="text-xl font-semibold">{data.team_name}</div>
            <div className="text-sm text-cloud/60">{data.manager_name}</div>
          </div>
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-white/10 bg-surface/50 px-4 py-3">
            <div className="text-xs font-semibold uppercase text-cloud/60">Overall Rank</div>
            <div className="text-lg font-semibold">{data.overall_rank?.toLocaleString() ?? "-"}</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-surface/50 px-4 py-3">
            <div className="text-xs font-semibold uppercase text-cloud/60">Overall Points</div>
            <div className="text-lg font-semibold">{data.overall_points?.toLocaleString() ?? "-"}</div>
          </div>
          {data.squad_health && (
            <div className="rounded-lg border border-white/10 bg-teal/10 px-4 py-3">
              <div className="text-xs font-semibold uppercase text-teal">Squad Health</div>
              <div className="text-lg font-semibold text-cloud">{data.squad_health.health_pct.toFixed(0)}%</div>
            </div>
          )}
        </div>
      </div>

      {/* Decision Brief */}
      <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
        <h2 className="mb-4 text-2xl font-semibold">Decision Brief</h2>
        <div className="mb-2 text-lg font-semibold">{data.primary_decision}</div>
        <div className={`text-sm font-semibold uppercase ${getConfidenceTone(data.confidence)}`}>
          {data.confidence} confidence
        </div>
        {data.reasoning && <p className="mt-3 text-sm text-cloud/70">{data.reasoning}</p>}
      </div>

      {/* Transfers */}
      <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
        <h2 className="mb-6 text-2xl font-semibold">🔄 Transfers</h2>
        {plans?.primary ? (
          <div className="space-y-4">
            {renderTransferPlan("Primary", plans.primary)}
            {plans.secondary && renderTransferPlan("Secondary", plans.secondary)}
            {plans.additional && plans.additional.length > 0 && (
              <div className="space-y-3">
                <div className="text-xs font-semibold uppercase text-cloud/60">
                  Additional Options ({plans.additional.length})
                </div>
                {plans.additional.map((plan, idx) => renderTransferPlan(`Option ${idx + 1}`, plan))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-cloud/60">
            {plans?.no_transfer_reason || "No transfer recommendations available."}
          </p>
        )}
      </div>

      {/* Captaincy */}
      {(data.captain || data.vice_captain) && (
        <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
          <h2 className="mb-6 text-2xl font-semibold">👑 Captaincy</h2>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-surface/50 p-4">
              <div className="text-xs font-semibold uppercase text-teal">Captain</div>
              <div className="mt-2 text-lg font-semibold">{(data.captain as any)?.name || "TBD"}</div>
              <div className="text-sm text-cloud/60">{formatPts((data.captain as any)?.expected_pts)} pts</div>
              {(data.captain as any)?.rationale && (
                <p className="mt-2 text-xs text-cloud/60">{(data.captain as any).rationale}</p>
              )}
            </div>
            <div className="rounded-lg border border-white/10 bg-surface/50 p-4">
              <div className="text-xs font-semibold uppercase text-cloud/60">Vice Captain</div>
              <div className="mt-2 text-lg font-semibold">{(data.vice_captain as any)?.name || "TBD"}</div>
              <div className="text-sm text-cloud/60">{formatPts((data.vice_captain as any)?.expected_pts)} pts</div>
              {(data.vice_captain as any)?.rationale && (
                <p className="mt-2 text-xs text-cloud/60">{(data.vice_captain as any).rationale}</p>
              )}
            </div>
          </div>
          {data.captain_delta?.delta_pts !== undefined && (
            <div className="mt-4 text-xs text-cloud/60">
              Captain delta vs vice: {data.captain_delta.delta_pts?.toFixed(1)} pts
            </div>
          )}
        </div>
      )}

      {/* Current Squad */}
      <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
        <h2 className="mb-6 text-2xl font-semibold">Current Squad</h2>
        <div className="space-y-6">
          <div>
            <div className="mb-3 text-xs font-semibold uppercase text-cloud/60">Starting XI</div>
            <div className="space-y-2">
              {data.starting_xi_projections.map(renderPlayerRow)}
            </div>
          </div>
          <div>
            <div className="mb-3 text-xs font-semibold uppercase text-cloud/60">Bench</div>
            <div className="space-y-2">
              {data.bench_projections.map(renderPlayerRow)}
            </div>
          </div>
        </div>
      </div>

      {/* Projected Squad */}
      {hasProjected && (
        <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
          <h2 className="mb-6 text-2xl font-semibold">Projected Squad</h2>
          <div className="space-y-6">
            <div>
              <div className="mb-3 text-xs font-semibold uppercase text-cloud/60">Projected XI</div>
              <div className="space-y-2">
                {(data.projected_xi || []).map(renderPlayerRow)}
              </div>
            </div>
            <div>
              <div className="mb-3 text-xs font-semibold uppercase text-cloud/60">Projected Bench</div>
              <div className="space-y-2">
                {(data.projected_bench || []).map(renderPlayerRow)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Chip Strategy */}
      {data.chip_recommendation && (
        <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
          <h2 className="mb-6 text-2xl font-semibold">💎 Chip Strategy</h2>
          <div className="text-lg font-semibold">{(data.chip_recommendation as any)?.recommendation || "Hold"}</div>
          {(data.chip_recommendation as any)?.rationale && (
            <p className="mt-2 text-sm text-cloud/70">{(data.chip_recommendation as any).rationale}</p>
          )}
          {(data.chip_recommendation as any)?.timing && (
            <p className="mt-2 text-xs text-cloud/60">Timing: {(data.chip_recommendation as any).timing}</p>
          )}
          {data.available_chips.length > 0 && (
            <p className="mt-3 text-xs text-cloud/60">Available chips: {data.available_chips.join(" · ")}</p>
          )}
        </div>
      )}

      {/* Risk Notes */}
      {(data.risk_scenarios.length > 0 || data.squad_health) && (
        <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
          <h2 className="mb-6 text-2xl font-semibold">⚠️ Risk Notes</h2>
          {data.squad_health && (
            <div className="mb-4 text-sm text-cloud/70">
              {data.squad_health.available}/{data.squad_health.total_players} available · {data.squad_health.injured} out · {data.squad_health.doubtful} doubtful
            </div>
          )}
          {data.risk_scenarios.length > 0 ? (
            <ul className="space-y-2 text-sm text-cloud/70">
              {data.risk_scenarios.map((risk, idx) => (
                <li key={idx} className="rounded-lg border border-white/10 bg-surface/50 px-3 py-2">
                  {(risk as any).scenario || (risk as any).condition || "Risk scenario"}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-cloud/60">No major risk scenarios flagged.</p>
          )}
        </div>
      )}
    </div>
  );
}
