'use client';

import type {
  DetailedAnalysisResponse,
  StrategyPathMove,
  TransferPlan,
  TransferPlans,
} from '@/lib/fpl-api';
import FPLLineupView from '@/components/fpl-lineup-view';

interface FPLDashboardProps {
  data: DetailedAnalysisResponse;
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

const getConfidenceTone = (confidence: string) => {
  const normalized = confidence.toUpperCase();
  if (normalized === 'HIGH') return 'text-teal';
  if (normalized === 'LOW') return 'text-rose';
  return 'text-amber';
};

const renderTransferPlan = (label: string, plan: TransferPlan) => (
  <div className="rounded-lg border border-white/10 bg-surface/50 p-4">
    <div className="mb-3 flex items-center justify-between">
      <div className="text-xs font-semibold uppercase text-cloud/60">
        {label}
      </div>
      {plan.confidence && (
        <span
          className={`text-xs font-semibold uppercase ${getConfidenceTone(plan.confidence)}`}
        >
          {plan.confidence} confidence
        </span>
      )}
    </div>
    <div className="mb-2 text-lg font-semibold">
      {plan.out} → {plan.in}
    </div>
    <div className="flex flex-wrap gap-4 text-xs text-cloud/60">
      <span>Hit: {plan.hit_cost > 0 ? `-${plan.hit_cost} pts` : 'Free'}</span>
      <span>
        Net: {plan.net_cost > 0 ? `+£${plan.net_cost}m` : `${plan.net_cost}m`}
      </span>
      {plan.delta_pts_4gw !== undefined && (
        <span>
          Δ 4GW: {plan.delta_pts_4gw > 0 ? '+' : ''}
          {plan.delta_pts_4gw.toFixed(1)} pts
        </span>
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
  const managerState = data.manager_state || {};
  const strategyMode = data.strategy_mode || managerState.strategy_mode;
  const captainDelta = parseNumeric(data.captain_delta?.delta_pts);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="mb-2 text-sm font-semibold uppercase text-cloud/60">
              Gameweek
            </div>
            <div className="text-4xl font-semibold">
              {data.current_gw ?? '-'}
            </div>
          </div>
          <div>
            <div className="mb-2 text-sm font-semibold uppercase text-cloud/60">
              Team
            </div>
            <div className="text-xl font-semibold">{data.team_name}</div>
            <div className="text-sm text-cloud/60">{data.manager_name}</div>
          </div>
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-white/10 bg-surface/50 px-4 py-3">
            <div className="text-xs font-semibold uppercase text-cloud/60">
              Overall Rank
            </div>
            <div className="text-lg font-semibold">
              {data.overall_rank?.toLocaleString() ?? '-'}
            </div>
          </div>
          <div className="rounded-lg border border-white/10 bg-surface/50 px-4 py-3">
            <div className="text-xs font-semibold uppercase text-cloud/60">
              Overall Points
            </div>
            <div className="text-lg font-semibold">
              {data.overall_points?.toLocaleString() ?? '-'}
            </div>
          </div>
          {data.squad_health && (
            <div className="rounded-lg border border-white/10 bg-teal/10 px-4 py-3">
              <div className="text-xs font-semibold uppercase text-teal">
                Squad Health
              </div>
              <div className="text-lg font-semibold text-cloud">
                {data.squad_health.health_pct.toFixed(0)}%
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Decision Brief */}
      <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
        <h2 className="mb-4 text-2xl font-semibold">Decision Brief</h2>
        <div className="mb-2 text-lg font-semibold">
          {data.primary_decision}
        </div>
        <div
          className={`text-sm font-semibold uppercase ${getConfidenceTone(data.confidence)}`}
        >
          {data.confidence} confidence
        </div>
        {data.reasoning && (
          <p className="mt-3 text-sm text-cloud/70">{data.reasoning}</p>
        )}
        {strategyMode ? (
          <div className="mt-4 inline-flex rounded-md border border-white/10 bg-surface/50 px-3 py-1 text-xs font-semibold uppercase text-teal">
            Strategy Mode: {String(strategyMode)}
          </div>
        ) : null}
      </div>

      {/* Manager State */}
      <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
        <h2 className="mb-6 text-2xl font-semibold">Manager State</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-white/10 bg-surface/50 px-4 py-3">
            <div className="text-xs font-semibold uppercase text-cloud/60">
              Overall Rank
            </div>
            <div className="text-lg font-semibold">
              {managerState.overall_rank?.toLocaleString() ??
                data.overall_rank?.toLocaleString() ??
                '-'}
            </div>
          </div>
          <div className="rounded-lg border border-white/10 bg-surface/50 px-4 py-3">
            <div className="text-xs font-semibold uppercase text-cloud/60">
              Risk Posture
            </div>
            <div className="text-lg font-semibold">
              {managerState.risk_posture || '-'}
            </div>
          </div>
          <div className="rounded-lg border border-white/10 bg-surface/50 px-4 py-3">
            <div className="text-xs font-semibold uppercase text-cloud/60">
              Strategy Mode
            </div>
            <div className="text-lg font-semibold">
              {strategyMode || '-'}
            </div>
          </div>
          <div className="rounded-lg border border-white/10 bg-surface/50 px-4 py-3">
            <div className="text-xs font-semibold uppercase text-cloud/60">
              Free Transfers
            </div>
            <div className="text-lg font-semibold">
              {managerState.free_transfers ?? '-'}
            </div>
          </div>
        </div>
      </div>

      {/* Transfers */}
      <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
        <h2 className="mb-6 text-2xl font-semibold">🔄 Transfers</h2>
        {plans?.primary ? (
          <div className="space-y-4">
            {renderTransferPlan('Primary', plans.primary)}
            {plans.secondary &&
              renderTransferPlan('Secondary', plans.secondary)}
            {plans.additional && plans.additional.length > 0 && (
              <div className="space-y-3">
                <div className="text-xs font-semibold uppercase text-cloud/60">
                  Additional Options ({plans.additional.length})
                </div>
                {plans.additional.map((plan, idx) =>
                  renderTransferPlan(`Option ${idx + 1}`, plan),
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-cloud/60">
            {plans?.no_transfer_reason ||
              'No transfer recommendations available.'}
          </p>
        )}
      </div>

      {/* Near Threshold Moves */}
      <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
        <h2 className="mb-6 text-2xl font-semibold">Near Threshold Moves</h2>
        {data.near_threshold_moves && data.near_threshold_moves.length > 0 ? (
          <div className="space-y-3">
            {data.near_threshold_moves.map((move, idx) => (
              <div
                key={`${move.out}-${move.in}-${idx}`}
                className="rounded-lg border border-white/10 bg-surface/50 px-4 py-3"
              >
                <div className="text-sm font-semibold">
                  {move.out} → {move.in}
                </div>
                <div className="mt-1 text-xs text-cloud/60">
                  Δ4GW: {move.delta_pts_4gw ?? '-'} pts · Δ6GW:{' '}
                  {move.delta_pts_6gw ?? '-'} pts · Required:{' '}
                  {move.threshold_required ?? '-'}
                </div>
                {move.rejection_reason ? (
                  <div className="mt-1 text-xs text-amber">
                    {move.rejection_reason}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-cloud/60">
            No near-threshold alternatives available this gameweek.
          </p>
        )}
      </div>

      {/* Strategy Paths */}
      <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
        <h2 className="mb-6 text-2xl font-semibold">Strategy Paths</h2>
        {data.strategy_paths ? (
          <div className="grid gap-4 md:grid-cols-3">
            {(
              [
                { label: 'Safe', move: data.strategy_paths.safe },
                { label: 'Balanced', move: data.strategy_paths.balanced },
                { label: 'Aggressive', move: data.strategy_paths.aggressive },
              ] as Array<{ label: string; move: StrategyPathMove | undefined }>
            ).map(({ label, move }) => (
              <div
                key={label}
                className="rounded-lg border border-white/10 bg-surface/50 p-4"
              >
                <div className="text-xs font-semibold uppercase text-cloud/60">
                  {label}
                </div>
                {move ? (
                  <>
                    <div className="mt-2 text-sm font-semibold">
                      {move.out} → {move.in}
                    </div>
                    <div className="mt-1 text-xs text-cloud/60">
                      Δ4GW: {move.delta_pts_4gw ?? '-'} pts
                    </div>
                    {move.rationale ? (
                      <div className="mt-1 text-xs text-cloud/60">
                        {move.rationale}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="mt-2 text-sm text-cloud/60">
                    No path generated
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-cloud/60">
            Strategy alternatives unavailable for this dataset.
          </p>
        )}
      </div>

      {/* Captaincy */}
      {(data.captain || data.vice_captain) && (
        <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
          <h2 className="mb-6 text-2xl font-semibold">👑 Captaincy</h2>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-surface/50 p-4">
              <div className="text-xs font-semibold uppercase text-teal">
                Captain
              </div>
              <div className="mt-2 text-lg font-semibold">
                {String(data.captain?.name ?? 'TBD')}
              </div>
              <div className="text-sm text-cloud/60">
                {formatPts(Number(data.captain?.expected_pts) || undefined)} pts
              </div>
              {data.captain?.rationale ? (
                <p className="mt-2 text-xs text-cloud/60">
                  {String(data.captain.rationale)}
                </p>
              ) : null}
            </div>
            <div className="rounded-lg border border-white/10 bg-surface/50 p-4">
              <div className="text-xs font-semibold uppercase text-cloud/60">
                Vice Captain
              </div>
              <div className="mt-2 text-lg font-semibold">
                {String(data.vice_captain?.name ?? 'TBD')}
              </div>
              <div className="text-sm text-cloud/60">
                {formatPts(
                  Number(data.vice_captain?.expected_pts) || undefined,
                )}{' '}
                pts
              </div>
              {data.vice_captain?.rationale ? (
                <p className="mt-2 text-xs text-cloud/60">
                  {String(data.vice_captain.rationale)}
                </p>
              ) : null}
            </div>
          </div>
          {captainDelta !== null && (
            <div className="mt-4 text-xs text-cloud/60">
              Captain delta vs vice: {captainDelta.toFixed(1)}{' '}
              pts
            </div>
          )}
        </div>
      )}

      {/* Squad Lineup with Toggle */}
      <FPLLineupView
        currentStarting={data.starting_xi_projections}
        currentBench={data.bench_projections}
        projectedStarting={data.projected_xi}
        projectedBench={data.projected_bench}
      />

      {/* Chip Strategy */}
      {(data.chip_recommendation || data.chip_timing_outlook) && (
        <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
          <h2 className="mb-6 text-2xl font-semibold">💎 Chip Strategy</h2>
          {data.chip_recommendation ? (
            <div className="text-lg font-semibold">
              {String(data.chip_recommendation?.recommendation ?? 'Hold')}
            </div>
          ) : null}
          {data.chip_recommendation?.rationale ? (
            <p className="mt-2 text-sm text-cloud/70">
              {String(data.chip_recommendation.rationale)}
            </p>
          ) : null}
          {data.chip_recommendation?.timing ? (
            <p className="mt-2 text-xs text-cloud/60">
              Timing: {String(data.chip_recommendation.timing)}
            </p>
          ) : null}
          {data.available_chips.length > 0 ? (
            <p className="mt-3 text-xs text-cloud/60">
              Available chips: {data.available_chips.join(' · ')}
            </p>
          ) : null}
          {data.chip_timing_outlook ? (
            <div className="mt-4 rounded-lg border border-white/10 bg-surface/50 p-4">
              <div className="mb-2 text-xs font-semibold uppercase text-cloud/60">
                Chip Timing Outlook
              </div>
              <div className="space-y-1 text-sm text-cloud/70">
                <div>
                  Bench Boost window:{' '}
                  {data.chip_timing_outlook.bench_boost_window || '-'}
                </div>
                <div>
                  Triple Captain window:{' '}
                  {data.chip_timing_outlook.triple_captain_window || '-'}
                </div>
                <div>
                  Free Hit window: {data.chip_timing_outlook.free_hit_window || '-'}
                </div>
              </div>
              {data.chip_timing_outlook.rationale ? (
                <p className="mt-2 text-xs text-cloud/60">
                  {data.chip_timing_outlook.rationale}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {/* Structural Issues */}
      <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
        <h2 className="mb-6 text-2xl font-semibold">Structural Issues</h2>
        {data.squad_issues && data.squad_issues.length > 0 ? (
          <div className="space-y-3">
            {data.squad_issues.map((issue, idx) => (
              <div
                key={`${issue.category}-${issue.title}-${idx}`}
                className="rounded-lg border border-white/10 bg-surface/50 px-4 py-3"
              >
                <div className="text-sm font-semibold">
                  {issue.title || 'Issue'}
                </div>
                <div className="mt-1 text-xs uppercase text-cloud/60">
                  {issue.category || 'general'} · {issue.severity || 'MEDIUM'}
                </div>
                {issue.detail ? (
                  <div className="mt-1 text-xs text-cloud/70">{issue.detail}</div>
                ) : null}
                {issue.players && issue.players.length > 0 ? (
                  <div className="mt-1 text-xs text-cloud/60">
                    Players: {issue.players.join(', ')}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-cloud/60">
            No structural issues flagged.
          </p>
        )}
      </div>

      {/* Risk Notes */}
      {(data.risk_scenarios.length > 0 || data.squad_health) && (
        <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
          <h2 className="mb-6 text-2xl font-semibold">⚠️ Risk Notes</h2>
          {data.squad_health && (
            <div className="mb-4 text-sm text-cloud/70">
              {data.squad_health.available}/{data.squad_health.total_players}{' '}
              available · {data.squad_health.injured} out ·{' '}
              {data.squad_health.doubtful} doubtful
            </div>
          )}
          {data.risk_scenarios.length > 0 ? (
            <ul className="space-y-2 text-sm text-cloud/70">
              {data.risk_scenarios.map((risk, idx) => (
                <li
                  key={idx}
                  className="rounded-lg border border-white/10 bg-surface/50 px-3 py-2"
                >
                  {String(risk.scenario || risk.condition || 'Risk scenario')}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-cloud/60">
              No major risk scenarios flagged.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
