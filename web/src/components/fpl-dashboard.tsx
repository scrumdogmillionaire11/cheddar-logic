'use client';

import { useState } from 'react';
import type {
  DetailedAnalysisResponse,
  FixturePlannerPlayerWindow,
  StrategyPathMove,
  TransferPlan,
  TransferPlans,
} from '@/lib/fpl-api';
import FPLLineupView from '@/components/fpl-lineup-view';
import FPLWeeklyReportCard from '@/components/fpl-weekly-report-card';

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

const formatFixed = (
  value: unknown,
  digits: number,
  fallback = '-',
): string => {
  const parsed = parseNumeric(value);
  return parsed === null ? fallback : parsed.toFixed(digits);
};

const parsePointsFromRationale = (value: unknown): number | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.match(
    /(\d+(?:\.\d+)?)\s*projected\s*pts|\((\d+(?:\.\d+)?)\s*pts\)/i,
  );
  if (!match) {
    return null;
  }
  const extracted = match[1] ?? match[2];
  const parsed = Number(extracted);
  return Number.isFinite(parsed) ? parsed : null;
};

const extractCaptainExpectedPts = (captain: unknown): number | null => {
  if (!captain || typeof captain !== 'object') {
    return null;
  }
  const record = captain as Record<string, unknown>;
  return (
    parseNumeric(record.expected_pts) ??
    parseNumeric(record.expected_points) ??
    parseNumeric(record.nextGW_pts) ??
    parsePointsFromRationale(record.rationale)
  );
};

const formatPtsDisplay = (value: number | null): string => {
  if (value === null) {
    return '-';
  }
  return `${formatPts(value)} pts`;
};

const normalizeDecisionText = (
  value: string | undefined,
  freeTransfers: number,
): string => {
  const raw = String(value || '').trim();
  if (!raw) return '-';
  const normalizedCode = raw.toUpperCase();
  if (
    normalizedCode === 'NO_CHIP_ACTION' ||
    normalizedCode === 'HOLD_TRANSFERS' ||
    normalizedCode === 'ROLL'
  ) {
    if (freeTransfers <= 0) {
      return 'No chip recommended this gameweek.';
    }
    if (freeTransfers === 1) {
      return 'No chip recommended. Use your free transfer to address a weak spot.';
    }
    return `No chip recommended. Use ${freeTransfers} available transfers to improve squad structure.`;
  }
  if (
    raw.includes('urgent transfer(s)') ||
    raw.includes('transfer(s) available')
  ) {
    const transferCount = Number(
      (raw.match(/(\d+)\s+transfer/i) || [])[1] || 0,
    );
    if (transferCount === 1) {
      return 'No chip recommended. Use your free transfer to address a weak spot.';
    }
    if (transferCount > 1) {
      return `No chip recommended. Use ${transferCount} available transfers to improve squad structure.`;
    }
    return 'No chip recommended. Use available transfers to improve weak spots.';
  }
  return raw;
};

const normalizeReasoningText = (
  value: string | undefined,
  freeTransfers: number,
): string | null => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (freeTransfers > 0 && raw.toLowerCase().includes('no free transfers')) {
    if (freeTransfers === 1) {
      return 'No chip passes the strategic windows/risk gates. You have 1 free transfer available.';
    }
    return `No chip passes the strategic windows/risk gates. You have ${freeTransfers} free transfers available.`;
  }
  return raw;
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
      {parseNumeric(plan.delta_pts_4gw) !== null && (
        <span>
          Δ 4GW: {(parseNumeric(plan.delta_pts_4gw) ?? 0) > 0 ? '+' : ''}
          {formatFixed(plan.delta_pts_4gw, 1)} pts
        </span>
      )}
    </div>
    {plan.reason && <p className="mt-2 text-sm text-cloud/70">{plan.reason}</p>}
  </div>
);

const renderFixtureWindowTable = (
  title: string,
  rows: FixturePlannerPlayerWindow[],
  startGw: number,
) => {
  const plannerGwRange = Array.from(
    { length: 8 },
    (_, gwOffset) => startGw + gwOffset,
  );

  return (
    <div className="rounded-lg border border-white/10 bg-surface/50 p-4">
      <div className="mb-3 text-sm font-semibold uppercase text-cloud/60">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-cloud/60">No players in this list.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="border-b border-white/10 text-cloud/60">
                <th className="px-2 py-2 text-left">Player</th>
                <th className="px-2 py-2 text-left">DGW</th>
                <th className="px-2 py-2 text-left">BGW</th>
                <th className="px-2 py-2 text-left">Next DGW</th>
                <th className="px-2 py-2 text-left">Fixture Horizon Score</th>
                {plannerGwRange.map((gw) => (
                  <th key={`${title}-gw-${gw}`} className="px-2 py-2 text-left">
                    GW{gw}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((window, idx) => {
                const summary = window?.summary ?? {
                  dgw_count: 0,
                  bgw_count: 0,
                  next_dgw_gw: null,
                  weighted_fixture_score: 0,
                };
                const upcomingRows = Array.isArray(window?.upcoming)
                  ? window.upcoming
                  : [];
                const upcomingByGw = new Map<number, (typeof upcomingRows)[number]>();
                for (const upcoming of upcomingRows) {
                  const rawGw = parseNumeric(upcoming?.gw);
                  if (rawGw !== null) {
                    const normalizedGw = Math.max(1, Math.trunc(rawGw));
                    upcomingByGw.set(normalizedGw, upcoming);
                  }
                }

                return (
                  <tr
                    key={`${window.player_id || window.name}-${idx}`}
                    className="border-b border-white/5"
                  >
                    <td className="px-2 py-2">
                      <div className="font-semibold">{window.name}</div>
                      <div className="text-cloud/60">{window.team}</div>
                    </td>
                    <td className="px-2 py-2">{summary.dgw_count}</td>
                    <td className="px-2 py-2">{summary.bgw_count}</td>
                    <td className="px-2 py-2">{summary.next_dgw_gw ?? '-'}</td>
                    <td className="px-2 py-2">
                      {formatFixed(summary.weighted_fixture_score, 3)}
                    </td>
                    {plannerGwRange.map((gw) => {
                      const upcoming = upcomingByGw.get(gw);
                      const opponents = Array.isArray(upcoming?.opponents)
                        ? upcoming.opponents
                            .map((opponent) => String(opponent || '').trim())
                            .filter((opponent) => opponent.length > 0)
                        : [];

                      return (
                        <td key={`${window.name}-gw-${gw}`} className="px-2 py-2">
                          <div className="flex min-w-14 flex-col gap-1">
                            {upcoming?.is_blank ? (
                              <span className="rounded bg-rose/20 px-2 py-1 text-center text-rose">
                                BGW
                              </span>
                            ) : (
                              <>
                                {opponents.length > 0 ? (
                                  opponents.map((opponent, opponentIdx) => (
                                    <span
                                      key={`${window.name}-gw-${gw}-opp-${opponentIdx}`}
                                      className={`rounded px-2 py-1 text-center ${
                                        opponents.length > 1
                                          ? 'bg-teal/20 text-teal'
                                          : 'bg-white/10 text-cloud/70'
                                      }`}
                                    >
                                      {opponent}
                                    </span>
                                  ))
                                ) : (
                                  <span className="rounded bg-white/10 px-2 py-1 text-center text-cloud/60">
                                    -
                                  </span>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default function FPLDashboard({ data }: FPLDashboardProps) {
  // Collapsible section state (collapsed by default on mobile)
  const [strategyNotesOpen, setStrategyNotesOpen] = useState(false);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [nearThresholdOpen, setNearThresholdOpen] = useState(false);
  const [strategyPathsOpen, setStrategyPathsOpen] = useState(false);
  const [structuralIssuesOpen, setStructuralIssuesOpen] = useState(false);
  const [riskNotesOpen, setRiskNotesOpen] = useState(false);

  if (!data) {
    return null;
  }

  const plans: TransferPlans | null | undefined = data.transfer_plans;
  const managerState = data.manager_state || {};
  const strategyMode = data.strategy_mode || managerState.strategy_mode;
  const normalizedFreeTransferCount = Math.max(
    0,
    Math.trunc(
      parseNumeric(managerState.free_transfers) ??
        parseNumeric(data.free_transfers) ??
        0,
    ),
  );
  const captainDelta = parseNumeric(data.captain_delta?.delta_pts);
  const plannerStartGw = Math.max(
    1,
    Math.trunc(parseNumeric(data.current_gw) ?? 1),
  );
  const fixturePlanner = data.fixture_planner ?? {
    horizon_gws: 8 as const,
    start_gw: plannerStartGw,
    gw_timeline: [],
    squad_windows: [],
    target_windows: [],
    key_planning_notes: [],
  };
  const plannerTimeline = Array.isArray(fixturePlanner.gw_timeline)
    ? fixturePlanner.gw_timeline
    : [];
  const plannerSquadWindows = Array.isArray(fixturePlanner.squad_windows)
    ? fixturePlanner.squad_windows
    : [];
  const plannerTargetWindows = Array.isArray(fixturePlanner.target_windows)
    ? fixturePlanner.target_windows
    : [];
  const plannerNotes = Array.isArray(fixturePlanner.key_planning_notes)
    ? fixturePlanner.key_planning_notes
    : [];
  const plannerStartGwValue = Math.max(
    1,
    Math.trunc(parseNumeric(fixturePlanner.start_gw) ?? plannerStartGw),
  );
  const captainExpectedPts = extractCaptainExpectedPts(data.captain);
  const viceCaptainExpectedPts = extractCaptainExpectedPts(data.vice_captain);
  const displayDecision = normalizeDecisionText(
    data.primary_decision,
    normalizedFreeTransferCount,
  );
  const displayReasoning = normalizeReasoningText(
    data.reasoning,
    normalizedFreeTransferCount,
  );
  const squadBlankCountsByGw: Record<number, number> = {};
  for (const playerWindow of plannerSquadWindows) {
    const upcomingRows = Array.isArray(playerWindow?.upcoming)
      ? playerWindow.upcoming
      : [];
    for (const row of upcomingRows) {
      if (row.is_blank) {
        squadBlankCountsByGw[row.gw] = (squadBlankCountsByGw[row.gw] || 0) + 1;
      }
    }
  }
  const plannerStructurallyEmpty =
    plannerTimeline.length === 0 &&
    plannerSquadWindows.length === 0 &&
    plannerTargetWindows.length === 0 &&
    plannerNotes.length === 0;
  const plannerEmptyText =
    plannerStructurallyEmpty && data.fixture_planner_reason?.trim()
      ? data.fixture_planner_reason.trim()
      : 'No DGW/BGW events flagged in the current 8-GW horizon.';
  const nearThresholdEmptyText =
    data.near_threshold_reason?.trim() ||
    'No near-threshold moves this gameweek. Candidate swaps were either clearly above threshold or well below required gain.';
  const strategyPathsEmptyText =
    data.strategy_paths_reason?.trim() ||
    'No distinct strategy-path alternatives this gameweek.';
  const strategyPathEntries = [
    { label: 'Safe', move: data.strategy_paths?.safe },
    { label: 'Balanced', move: data.strategy_paths?.balanced },
    { label: 'Aggressive', move: data.strategy_paths?.aggressive },
  ] as Array<{ label: string; move: StrategyPathMove | undefined }>;
  const hasAnyStrategyPath = strategyPathEntries.some(
    ({ move }) => !!move?.out && !!move?.in,
  );

  return (
    <div>
      {/* Sticky mobile header */}
      <div className="sticky top-0 z-10 mb-4 block min-h-[56px] border-b border-white/10 bg-night/95 px-4 py-3 backdrop-blur-sm md:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-cloud/60 shrink-0">
              GW {data.current_gw ?? '-'}
            </span>
            <span className="text-sm font-semibold truncate">
              {data.team_name}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="rounded bg-teal/20 px-2 py-1 text-xs font-semibold text-teal min-h-[28px] flex items-center">
              {normalizedFreeTransferCount} FT
            </span>
            {Boolean(data.captain?.name) && (
              <span className="text-xs text-cloud/70 truncate max-w-[100px]">
                C: {String(data.captain?.name)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Main layout — mobile: flex-col, tablet: 2-col grid, desktop: block space-y-8 */}
      <div className="flex flex-col gap-6 xl:block xl:space-y-8">

        {/* Header */}
        <div className="order-4 rounded-xl border border-white/10 bg-surface/80 p-4 md:order-none md:p-8 xl:col-span-2">
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
                  {formatFixed(data.squad_health.health_pct, 0)}%
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Transfers */}
        <div className="order-1 rounded-xl border border-white/10 bg-surface/80 p-4 md:order-none md:p-8">
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

        {/* Captaincy */}
        {(data.captain || data.vice_captain) && (
          <div className="order-2 rounded-xl border border-white/10 bg-surface/80 p-4 md:order-none md:p-8">
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
                  {formatPtsDisplay(captainExpectedPts)}
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
                  {formatPtsDisplay(viceCaptainExpectedPts)}
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
                Captain delta vs vice: {captainDelta.toFixed(1)} pts
              </div>
            )}
          </div>
        )}

        {/* Squad Lineup with Toggle */}
        <div className="order-3 md:order-none">
          <FPLLineupView
            currentStarting={data.starting_xi_projections}
            currentBench={data.bench_projections}
            lineupDecision={data.lineup_decision}
            projectedStarting={data.projected_xi}
            projectedBench={data.projected_bench}
            captainName={
              typeof data.captain?.name === 'string' ? data.captain.name : null
            }
            viceCaptainName={
              typeof data.vice_captain?.name === 'string'
                ? data.vice_captain.name
                : null
            }
          />
        </div>

        {/* Decision Brief */}
        <div className="order-4 rounded-xl border border-white/10 bg-surface/80 p-4 md:order-none md:p-8">
          <h2 className="mb-4 text-2xl font-semibold">Decision Brief</h2>
          <div className="mb-2 text-lg font-semibold">{displayDecision}</div>
          <div
            className={`text-sm font-semibold uppercase ${getConfidenceTone(data.confidence)}`}
          >
            {data.confidence} confidence
          </div>
          {displayReasoning && (
            <p className="mt-3 text-sm text-cloud/70">{displayReasoning}</p>
          )}
          {strategyMode ? (
            <div className="mt-4 inline-flex rounded-md border border-white/10 bg-surface/50 px-3 py-1 text-xs font-semibold uppercase text-teal">
              Strategy Mode: {String(strategyMode)}
            </div>
          ) : null}
        </div>

        {/* Manager State */}
        <div className="order-4 rounded-xl border border-white/10 bg-surface/80 p-4 md:order-none md:p-8">
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
              <div className="text-lg font-semibold">{strategyMode || '-'}</div>
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

        {/* Chip Strategy */}
        {(data.chip_recommendation || data.chip_timing_outlook) && (
          <div className="order-4 rounded-xl border border-white/10 bg-surface/80 p-4 md:order-none md:p-8">
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
                    Free Hit window:{' '}
                    {data.chip_timing_outlook.free_hit_window || '-'}
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

        {/* Decision Explainability */}
        {data.explainability && (
          <div className="order-4 rounded-xl border border-white/10 bg-surface/80 p-4 md:order-none md:p-8">
            <h2 className="mb-6 text-2xl font-semibold">Decision Explainability</h2>
            <div className="space-y-3">
              {data.explainability.why_this != null && (
                <div className="text-sm">
                  <span className="text-cloud/60">Why this recommendation: </span>
                  <span className="text-cloud/80">{data.explainability.why_this}</span>
                </div>
              )}
              {data.explainability.why_not_alternatives != null && (
                <div className="text-sm">
                  <span className="text-cloud/60">Why not alternatives: </span>
                  <span className="text-cloud/80">{data.explainability.why_not_alternatives}</span>
                </div>
              )}
              {data.explainability.what_would_change != null && (
                <div className="text-sm">
                  <span className="text-cloud/60">What would change this: </span>
                  <span className="text-cloud/80">{data.explainability.what_would_change}</span>
                </div>
              )}
              {Array.isArray(data.explainability.key_risk_drivers) &&
                data.explainability.key_risk_drivers.length > 0 && (
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase text-cloud/60">
                      Key risk drivers
                    </div>
                    <ul className="space-y-1 text-sm text-cloud/70">
                      {(data.explainability.key_risk_drivers as string[]).map((driver, idx) => (
                        <li key={`risk-driver-${idx}`}>{driver}</li>
                      ))}
                    </ul>
                  </div>
                )}
            </div>
          </div>
        )}

        {/* Uncertainty and Risk Framing */}
        {(data.confidence_band || data.relative_risk) && (
          <div className="order-4 rounded-xl border border-white/10 bg-surface/80 p-4 md:order-none md:p-8">
            <h2 className="mb-6 text-2xl font-semibold">Uncertainty and Risk Framing</h2>
            <div className="space-y-3">
              {data.confidence_band?.label != null && (
                <div className="text-sm">
                  <span className="text-cloud/60">Confidence band: </span>
                  <span className="text-cloud/80">{data.confidence_band.label}</span>
                </div>
              )}
              {data.relative_risk?.recommended_risk_posture != null && (
                <div className="text-sm">
                  <span className="text-cloud/60">Risk posture: </span>
                  <span className="text-teal">{data.relative_risk.recommended_risk_posture}</span>
                </div>
              )}
              {data.relative_risk?.framing_note != null && (
                <p className="text-sm text-cloud/70">{data.relative_risk.framing_note}</p>
              )}
              {Array.isArray(data.scenario_notes) && data.scenario_notes.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase text-cloud/60">
                    Scenario notes
                  </div>
                  <ul className="space-y-1 text-sm text-cloud/70">
                    {(data.scenario_notes as string[]).map((note, idx) => (
                      <li key={`scenario-note-${idx}`}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Strategy Notes (collapsible on mobile) */}
        <div className="order-5 rounded-xl border border-white/10 bg-surface/80 md:order-none">
          <button
            className="flex w-full items-center justify-between px-4 py-3 min-h-[44px] md:hidden cursor-pointer"
            onClick={() => setStrategyNotesOpen((v) => !v)}
            aria-expanded={strategyNotesOpen}
          >
            <h2 className="text-xl font-semibold">Strategy Notes</h2>
            <span className="text-cloud/60 text-lg">{strategyNotesOpen ? '▾' : '▸'}</span>
          </button>
          <div className="hidden md:block px-8 pt-8 pb-2">
            <h2 className="text-2xl font-semibold">Strategy Notes</h2>
          </div>
          <div className={strategyNotesOpen ? 'px-4 pb-4' : 'hidden md:block px-8 pb-8'}>
            <div className="mt-4 mb-2 text-lg font-semibold">{displayDecision}</div>
            <div
              className={`text-sm font-semibold uppercase ${getConfidenceTone(data.confidence)}`}
            >
              {data.confidence} confidence
            </div>
            {displayReasoning && (
              <p className="mt-3 text-sm text-cloud/70">{displayReasoning}</p>
            )}
            {strategyMode ? (
              <div className="mt-4 inline-flex rounded-md border border-white/10 bg-surface/50 px-3 py-1 text-xs font-semibold uppercase text-teal">
                Strategy Mode: {String(strategyMode)}
              </div>
            ) : null}
          </div>
        </div>

        {/* DGW/BGW Planner (collapsible on mobile) */}
        <div className="order-6 rounded-xl border border-white/10 bg-surface/80 md:order-none">
          <button
            className="flex w-full items-center justify-between px-4 py-3 min-h-[44px] md:hidden cursor-pointer"
            onClick={() => setPlannerOpen((v) => !v)}
            aria-expanded={plannerOpen}
          >
            <h2 className="text-xl font-semibold">DGW/BGW Planner (Next 8 GWs)</h2>
            <span className="text-cloud/60 text-lg">{plannerOpen ? '▾' : '▸'}</span>
          </button>
          <div className="hidden md:block px-8 pt-8 pb-2">
            <h2 className="mb-6 text-2xl font-semibold">
              DGW/BGW Planner (Next 8 GWs)
            </h2>
          </div>
          <div className={plannerOpen ? 'px-4 pb-4' : 'hidden md:block px-8 pb-8'}>
            <p className="mb-4 text-sm text-cloud/60">
              Fixture Horizon Score: higher is better (more DGW upside, lower BGW
              risk, stronger medium-term fixture profile).
            </p>
            {plannerTimeline.length > 0 ? (
              <div className="mb-6 grid gap-3 md:grid-cols-4 lg:grid-cols-8">
                {plannerTimeline.map((row) => (
                  <div
                    key={`timeline-${row.gw}`}
                    className="rounded-lg border border-white/10 bg-surface/50 p-3"
                  >
                    <div className="text-xs font-semibold uppercase text-cloud/60">
                      GW{row.gw}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <span className="rounded bg-teal/20 px-2 py-1 text-teal">
                        DGW {row.dgw_teams.length}
                      </span>
                      <span className="rounded bg-rose/20 px-2 py-1 text-rose">
                        BGW {row.bgw_teams.length}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-cloud/60">
                      Your squad blanking: {squadBlankCountsByGw[row.gw] || 0}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mb-6 rounded-lg border border-white/10 bg-surface/50 p-3 text-xs text-cloud/60">
                {plannerEmptyText}
              </div>
            )}
            <div className="space-y-4">
              {renderFixtureWindowTable(
                'Your Squad',
                plannerSquadWindows,
                plannerStartGwValue,
              )}
              {renderFixtureWindowTable(
                'Potential Targets',
                plannerTargetWindows,
                plannerStartGwValue,
              )}
            </div>
            {plannerNotes.length > 0 ? (
              <div className="mt-4 rounded-lg border border-white/10 bg-surface/50 p-4">
                <div className="mb-2 text-xs font-semibold uppercase text-cloud/60">
                  Key Planning Notes
                </div>
                <ul className="space-y-1 text-xs text-cloud/70">
                  {plannerNotes.map((note, idx) => (
                    <li key={`planner-note-${idx}`}>{note}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>

        {/* Near Threshold Moves (collapsible on mobile) */}
        <div className="order-6 rounded-xl border border-white/10 bg-surface/80 md:order-none">
          <button
            className="flex w-full items-center justify-between px-4 py-3 min-h-[44px] md:hidden cursor-pointer"
            onClick={() => setNearThresholdOpen((v) => !v)}
            aria-expanded={nearThresholdOpen}
          >
            <h2 className="text-xl font-semibold">Near Threshold Moves</h2>
            <span className="text-cloud/60 text-lg">{nearThresholdOpen ? '▾' : '▸'}</span>
          </button>
          <div className="hidden md:block px-8 pt-8 pb-2">
            <h2 className="mb-6 text-2xl font-semibold">Near Threshold Moves</h2>
          </div>
          <div className={nearThresholdOpen ? 'px-4 pb-4' : 'hidden md:block px-8 pb-8'}>
            {data.near_threshold_moves && data.near_threshold_moves.length > 0 ? (
              <div className="space-y-3">
                {data.near_threshold_moves.map((move, idx) => (
                  <div
                    key={`${move.out_player_id ?? move.out}-${move.in_player_id ?? move.in}-${idx}`}
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
              <p className="text-sm text-cloud/60">{nearThresholdEmptyText}</p>
            )}
          </div>
        </div>

        {/* Strategy Paths (collapsible on mobile) */}
        <div className="order-6 rounded-xl border border-white/10 bg-surface/80 md:order-none">
          <button
            className="flex w-full items-center justify-between px-4 py-3 min-h-[44px] md:hidden cursor-pointer"
            onClick={() => setStrategyPathsOpen((v) => !v)}
            aria-expanded={strategyPathsOpen}
          >
            <h2 className="text-xl font-semibold">Strategy Paths</h2>
            <span className="text-cloud/60 text-lg">{strategyPathsOpen ? '▾' : '▸'}</span>
          </button>
          <div className="hidden md:block px-8 pt-8 pb-2">
            <h2 className="mb-6 text-2xl font-semibold">Strategy Paths</h2>
          </div>
          <div className={strategyPathsOpen ? 'px-4 pb-4' : 'hidden md:block px-8 pb-8'}>
            {data.strategy_paths && hasAnyStrategyPath ? (
              <div className="grid gap-4 md:grid-cols-3">
                {strategyPathEntries.map(({ label, move }) => (
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
                        No distinct alternative this gameweek.
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-cloud/60">{strategyPathsEmptyText}</p>
            )}
          </div>
        </div>

        {/* Structural Issues (collapsible on mobile) */}
        <div className="order-6 rounded-xl border border-white/10 bg-surface/80 md:order-none">
          <button
            className="flex w-full items-center justify-between px-4 py-3 min-h-[44px] md:hidden cursor-pointer"
            onClick={() => setStructuralIssuesOpen((v) => !v)}
            aria-expanded={structuralIssuesOpen}
          >
            <h2 className="text-xl font-semibold">Structural Issues</h2>
            <span className="text-cloud/60 text-lg">{structuralIssuesOpen ? '▾' : '▸'}</span>
          </button>
          <div className="hidden md:block px-8 pt-8 pb-2">
            <h2 className="mb-6 text-2xl font-semibold">Structural Issues</h2>
          </div>
          <div className={structuralIssuesOpen ? 'px-4 pb-4' : 'hidden md:block px-8 pb-8'}>
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
                      <div className="mt-1 text-xs text-cloud/70">
                        {issue.detail}
                      </div>
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
              <p className="text-sm text-cloud/60">No structural issues flagged.</p>
            )}
          </div>
        </div>

        {/* Weekly Report Card */}
        <FPLWeeklyReportCard reportCard={data.weekly_report_card} />

        {/* Risk Notes (collapsible on mobile) */}
        {(data.risk_scenarios.length > 0 || data.squad_health) && (
          <div className="order-6 rounded-xl border border-white/10 bg-surface/80 md:order-none">
            <button
              className="flex w-full items-center justify-between px-4 py-3 min-h-[44px] md:hidden cursor-pointer"
              onClick={() => setRiskNotesOpen((v) => !v)}
              aria-expanded={riskNotesOpen}
            >
              <h2 className="text-xl font-semibold">⚠️ Risk Notes</h2>
              <span className="text-cloud/60 text-lg">{riskNotesOpen ? '▾' : '▸'}</span>
            </button>
            <div className="hidden md:block px-8 pt-8 pb-2">
              <h2 className="mb-6 text-2xl font-semibold">⚠️ Risk Notes</h2>
            </div>
            <div className={riskNotesOpen ? 'px-4 pb-4' : 'hidden md:block px-8 pb-8'}>
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
          </div>
        )}
      </div>
    </div>
  );
}
