import type { AnalysisResults } from '@/lib/api';

interface PlayerView {
  name: string;
  team?: string;
  position?: string;
  expected_pts?: number;
}

interface CaptainView extends PlayerView {
  rationale?: string;
  ownership_pct?: number;
  ownership_insight?: string;
  form_avg?: number;
  fixture_difficulty?: number;
}

interface TransferView {
  out: string;
  in: string;
  hitCost: number;
  netCost: number;
  deltaPoints4GW?: number;
  deltaPoints6GW?: number;
  reason: string;
  confidence?: string;
  confidence_context?: string;
  urgency?: string;
  strategyType?: 'SAFE' | 'BALANCED' | 'AGGRESSIVE';
}

interface TransferSectionView {
  primaryPlan?: TransferView;
  secondaryPlan?: TransferView;
  additionalPlans?: TransferView[];
  noTransferReason?: string;
}

interface OpportunityCost {
  current_value: number;
  best_value: number;
  best_gw?: number;
  delta: number;
}

interface WeeklyReviewView {
  summary: string;
  highlights: string[];
  previousGw?: number;
  points?: number;
  pointsDelta?: number;
  rank?: number;
  rankDelta?: number;
  recommendationFollowed?: boolean;
  processVerdict?: string;
  driftFlags: string[];
}

export interface DecisionViewModel {
  primaryAction: string;
  confidence: 'HIGH' | 'MED' | 'LOW';
  confidenceLabel?: string;
  confidenceSummary?: string;
  justification: string;
  captain?: CaptainView;
  viceCaptain?: CaptainView;
  captainDelta?: {
    delta_pts?: number;
    delta_pts_4gw?: number;
  };
  transfer: TransferSectionView;
  chipVerdict: 'NONE' | 'BB' | 'FH' | 'WC' | 'TC';
  chipStatus: 'FIRE' | 'WATCH' | 'PASS';
  chipExplanation: string;
  availableChips?: string[];
  squadHealth?: AnalysisResults['squad_health'];
  riskStatement: string;
  startingXI: PlayerView[];
  bench: PlayerView[];
  projectedXI: PlayerView[];
  projectedBench: PlayerView[];
  hasProjectedTransfers: boolean;
  gwTimeline?: string[];
  generatedAt?: string;
  freeTransfers?: number;
  gameweek?: number;
  benchWarning?: AnalysisResults['bench_warning'];
  projectionWindow: string;
  riskPosture?: string;
  strategyMode?: string;
  formation?: string;
  lineupConfidence?: string;
  formationReason?: string;
  riskProfileEffect?: string;
  lineupNotes?: string[];
  captainPlayerId?: number | string | null;
  viceCaptainPlayerId?: number | string | null;
  opportunityCost?: OpportunityCost | null;
  bestGw?: number;
  currentWindowName?: string;
  bestFutureWindowName?: string;
  weeklyReview?: WeeklyReviewView | null;
}

const toConfidence = (label?: string, fallback?: string): 'HIGH' | 'MED' | 'LOW' => {
  const value = (label || fallback || 'MED').toUpperCase();
  if (value.includes('HIGH')) return 'HIGH';
  if (value.includes('LOW')) return 'LOW';
  return 'MED';
};

const toPlainText = (value?: string): string => {
  if (!value) return '';
  return value
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
};

const toPrimaryAction = (value?: string): string => {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return 'ROLL';
  return raw.replace(/_/g, ' ');
};

const normalizeRiskPosture = (value?: string): string | undefined => {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === 'conservative' || normalized === 'balanced' || normalized === 'aggressive') {
    return normalized;
  }
  return value;
};

const toChipStatus = (value?: string): 'FIRE' | 'WATCH' | 'PASS' => {
  const status = String(value || '').toUpperCase();
  if (status === 'FIRE' || status === 'WATCH' || status === 'PASS') return status;
  return 'PASS';
};

const toChipVerdict = (value?: string): 'NONE' | 'BB' | 'FH' | 'WC' | 'TC' => {
  const verdict = String(value || '').toUpperCase();
  if (verdict === 'BB' || verdict === 'FH' || verdict === 'WC' || verdict === 'TC') return verdict;
  return 'NONE';
};

const withChipPrefix = (chipStatus: 'FIRE' | 'WATCH' | 'PASS', explanation?: string): string => {
  const plain = toPlainText(explanation) || 'No chip recommendation available.';
  return `${chipStatus}: ${plain}`;
};

const toTransferView = (plan?: {
  out: string;
  in: string;
  hit_cost: number;
  net_cost: number;
  delta_pts_4gw?: number;
  delta_pts_6gw?: number;
  reason: string;
  confidence?: string;
  why_now?: string;
  risk_note?: string;
}): TransferView | undefined => {
  if (!plan) return undefined;

  return {
    out: plan.out,
    in: plan.in,
    hitCost: plan.hit_cost,
    netCost: plan.net_cost,
    deltaPoints4GW: plan.delta_pts_4gw,
    deltaPoints6GW: plan.delta_pts_6gw,
    reason: plan.reason,
    confidence: plan.confidence,
    urgency: plan.why_now,
    confidence_context: plan.risk_note,
  };
};

const toTransferSectionView = (results: AnalysisResults): TransferSectionView => {
  const transferPlans =
    results.transfer_recommendation.metrics.transfer_plans ||
    results.transfer_plans;

  if (!transferPlans) {
    return {
      noTransferReason: 'No transfer recommendation available.',
    };
  }

  const primaryPlan = toTransferView(transferPlans.primary);
  const secondaryPlan = toTransferView(transferPlans.secondary);
  const additionalPlans = (transferPlans.additional || [])
    .map((plan) => toTransferView(plan))
    .filter((plan): plan is TransferView => Boolean(plan));

  return {
    primaryPlan,
    secondaryPlan,
    additionalPlans: additionalPlans.length > 0 ? additionalPlans : undefined,
    noTransferReason: transferPlans.no_transfer_reason,
  };
};

export function buildDecisionViewModel(results: AnalysisResults): DecisionViewModel {
  const squadMetrics = results.squad_state.metrics;
  const planMetrics = results.gameweek_plan.metrics;
  const captaincyMetrics = results.captaincy.metrics;
  const chipMetrics = results.chip_strategy.metrics;
  const horizonMetrics = results.horizon_watch.metrics;
  const lineupDecision = squadMetrics.lineup_decision || results.lineup_decision;

  const transfer = toTransferSectionView(results);
  const confidence = toConfidence(results.decision_confidence.confidence, results.confidence_label || results.confidence);
  const chipStatus = toChipStatus(chipMetrics.status);
  const chipVerdict = toChipVerdict(chipMetrics.verdict || results.chip_verdict);
  const primaryAction = toPrimaryAction(planMetrics.primary_action || results.primary_decision);

  const gameweek = planMetrics.gameweek || results.current_gw;
  const projectionWindow = planMetrics.projection_window || (gameweek ? `GW${gameweek} to GW${gameweek + 5}` : 'Unknown');
  const riskPosture = normalizeRiskPosture(
    planMetrics.risk_posture || squadMetrics.risk_posture || results.manager_state?.risk_posture || results.risk_posture,
  );
  const strategyMode =
    (typeof planMetrics.strategy_mode === 'string' ? planMetrics.strategy_mode : undefined) ||
    (typeof squadMetrics.strategy_mode === 'string' ? squadMetrics.strategy_mode : undefined) ||
    (typeof results.strategy_mode === 'string' ? results.strategy_mode : undefined) ||
    (typeof results.manager_state?.strategy_mode === 'string'
      ? results.manager_state.strategy_mode
      : undefined);
  const justification =
    toPlainText(planMetrics.justification) ||
    toPlainText(results.decision_confidence.rationale) ||
    toPlainText(results.gameweek_plan.summary) ||
    'Analysis complete.';

  const startingXI =
    squadMetrics.starting_xi ||
    lineupDecision?.starters?.map((player) => ({
      player_id: player.player_id,
      name: player.name,
      team: player.team,
      position: player.position,
      expected_pts: player.projected_points,
      expected_minutes: player.expected_minutes,
      flags: player.flags,
      badges: player.badges,
      start_reason: player.start_reason,
    })) ||
    results.starting_xi ||
    [];

  const bench =
    squadMetrics.bench ||
    lineupDecision?.bench?.map((player) => ({
      player_id: player.player_id,
      name: player.name,
      team: player.team,
      position: player.position,
      expected_pts: player.projected_points,
      expected_minutes: player.expected_minutes,
      flags: player.flags,
      bench_order: player.bench_order,
      bench_reason: player.bench_reason,
    })) ||
    results.bench ||
    [];

  const chipExplanation = withChipPrefix(
    chipStatus,
    chipMetrics.explanation || results.chip_explanation || results.chip_strategy.summary,
  );

  const weeklyReviewCard = (
    results as unknown as {
      weekly_review?: {
        summary?: string | null;
        highlights?: string[];
        metrics?: Record<string, unknown>;
      } | null;
    }
  ).weekly_review;

  const weeklyReviewMetrics =
    weeklyReviewCard && typeof weeklyReviewCard.metrics === 'object' && weeklyReviewCard.metrics
      ? (weeklyReviewCard.metrics as Record<string, unknown>)
      : null;

  const weeklyReview = weeklyReviewCard
    ? {
        summary: toPlainText(weeklyReviewCard.summary),
        highlights: Array.isArray(weeklyReviewCard.highlights)
          ? weeklyReviewCard.highlights.filter((item): item is string => typeof item === 'string')
          : [],
        previousGw:
          weeklyReviewMetrics && typeof weeklyReviewMetrics.previous_gw === 'number'
            ? weeklyReviewMetrics.previous_gw
            : undefined,
        points:
          weeklyReviewMetrics && typeof weeklyReviewMetrics.points === 'number'
            ? weeklyReviewMetrics.points
            : undefined,
        pointsDelta:
          weeklyReviewMetrics && typeof weeklyReviewMetrics.points_delta === 'number'
            ? weeklyReviewMetrics.points_delta
            : undefined,
        rank:
          weeklyReviewMetrics && typeof weeklyReviewMetrics.rank === 'number'
            ? weeklyReviewMetrics.rank
            : undefined,
        rankDelta:
          weeklyReviewMetrics && typeof weeklyReviewMetrics.rank_delta === 'number'
            ? weeklyReviewMetrics.rank_delta
            : undefined,
        recommendationFollowed:
          weeklyReviewMetrics && typeof weeklyReviewMetrics.recommendation_followed === 'boolean'
            ? weeklyReviewMetrics.recommendation_followed
            : undefined,
        processVerdict:
          weeklyReviewMetrics && typeof weeklyReviewMetrics.process_verdict === 'string'
            ? weeklyReviewMetrics.process_verdict
            : undefined,
        driftFlags:
          weeklyReviewMetrics && Array.isArray(weeklyReviewMetrics.drift_flags)
            ? weeklyReviewMetrics.drift_flags.filter((flag): flag is string => typeof flag === 'string')
            : [],
      }
    : null;

  return {
    primaryAction,
    confidence,
    confidenceLabel: results.decision_confidence.confidence,
    confidenceSummary: toPlainText(results.decision_confidence.rationale),
    justification,
    captain: captaincyMetrics.captain || results.captain,
    viceCaptain: captaincyMetrics.vice_captain || results.vice_captain,
    captainDelta: captaincyMetrics.captain_delta || results.captain_delta,
    transfer,
    chipVerdict,
    chipStatus,
    chipExplanation,
    availableChips: chipMetrics.available_chips || squadMetrics.available_chips || results.available_chips,
    squadHealth: squadMetrics.squad_health || results.squad_health,
    riskStatement: results.squad_state.summary,
    startingXI,
    bench,
    projectedXI: squadMetrics.projected_xi || results.projected_xi || [],
    projectedBench: squadMetrics.projected_bench || results.projected_bench || [],
    hasProjectedTransfers: Boolean((transfer.additionalPlans || []).length > 0),
    gwTimeline: horizonMetrics.gw_timeline || results.fixture_planner?.gw_timeline,
    generatedAt: planMetrics.generated_at || results.generated_at,
    freeTransfers: planMetrics.free_transfers ?? results.free_transfers,
    gameweek,
    benchWarning: squadMetrics.bench_warning || results.bench_warning,
    projectionWindow,
    riskPosture,
    strategyMode,
    formation: lineupDecision?.formation,
    lineupConfidence: lineupDecision?.lineup_confidence,
    formationReason: lineupDecision?.formation_reason,
    riskProfileEffect: lineupDecision?.risk_profile_effect,
    lineupNotes: lineupDecision?.notes || [],
    captainPlayerId: lineupDecision?.captain_player_id,
    viceCaptainPlayerId: lineupDecision?.vice_captain_player_id,
    opportunityCost: chipMetrics.recommendation?.opportunity_cost || results.chip_recommendation?.opportunity_cost || null,
    bestGw: chipMetrics.recommendation?.best_gw || results.chip_recommendation?.best_gw,
    currentWindowName:
      chipMetrics.recommendation?.current_window_name || results.chip_recommendation?.current_window_name,
    bestFutureWindowName:
      chipMetrics.recommendation?.best_future_window_name || results.chip_recommendation?.best_future_window_name,
    weeklyReview,
  };
}
