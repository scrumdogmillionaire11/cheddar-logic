/**
 * FPL Sage API Client
 * Communicates with the FastAPI backend for FPL analysis
 */

// Production should always use same-origin /api/v1 so Next.js rewrites handle backend routing.
// NEXT_PUBLIC_FPL_API_URL is kept as a development override only.
const FPL_API_BASE_URL =
  process.env.NODE_ENV === 'development'
    ? process.env.NEXT_PUBLIC_FPL_API_URL || '/api/v1'
    : '/api/v1';

export interface AnalyzeRequest {
  team_id: number;
  gameweek?: number;
  available_chips?: string[];
  free_transfers?: number;
  risk_posture?: 'conservative' | 'balanced' | 'aggressive';
  thresholds?: {
    transferGainFloor?: number;
    hitNetFloor?: number;
    maxHitsPerGW?: number;
    chipDeployBoost?: number;
    captainDiffMaxOwnership?: number;
    bbMinBenchXPts?: number;
    tcRequiresDGW?: boolean;
  };
  manual_transfers?: Array<{
    player_out: string;
    player_in: string;
  }>;
  injury_overrides?: Array<{
    player_name: string;
    status: 'FIT' | 'DOUBTFUL' | 'OUT';
    chance?: number;
  }>;
  force_refresh?: boolean;
}

export interface AnalyzeResponse {
  analysis_id: string;
  status: string;
  estimated_duration: number;
}

export interface PlayerData {
  name: string;
  team: string;
  position: string;
  cost?: number;
  ownership_pct?: number;
  expected_points?: number;
  injury_status?: string;
  is_captain: boolean;
  is_vice_captain: boolean;
  in_starting_11: boolean;
}

export interface WeaknessData {
  type: string;
  severity: string;
  player: string;
  detail: string;
  action: string;
}

export interface TransferTarget {
  name: string;
  team: string;
  position: string;
  cost?: number;
  expected_points?: number;
  priority?: string;
  reason?: string;
  injury_status?: string;
}

export interface ChipAdvice {
  chip: string;
  recommendation: string;
  reason: string;
  timing?: string;
}

export interface PlayerProjection {
  player_id?: number | string;
  name: string;
  team: string;
  position: string;
  price?: number;
  expected_pts?: number;
  ownership?: number;
  form?: number;
  fixture_difficulty?: number;
  injury_status?: string;
  playing_chance?: number;
  reasoning?: string;
  is_new?: boolean;
}

export interface TransferPlan {
  out: string;
  in: string;
  hit_cost: number;
  net_cost: number;
  delta_pts_4gw?: number;
  delta_pts_6gw?: number;
  reason: string;
  confidence?: string;
  confidence_context?: string;
  urgency?: string;
  is_marginal?: boolean;
  alternatives?: Array<{
    name: string;
    price: number;
    points: number;
    strategy: 'VALUE' | 'PREMIUM' | 'BALANCED';
  }>;
}

export interface TransferPlans {
  primary?: TransferPlan;
  secondary?: TransferPlan;
  additional?: TransferPlan[];
  no_transfer_reason?: string;
}

export interface SquadHealth {
  total_players: number;
  available: number;
  injured: number;
  doubtful: number;
  health_pct: number;
  critical_positions: string[];
}

export interface ManagerState {
  overall_rank?: number | null;
  risk_posture?: string;
  strategy_mode?: string;
  rank_bucket?: string;
  free_transfers?: number;
}

export interface NearThresholdMove {
  out: string;
  in: string;
  out_player_id?: number;
  in_player_id?: number;
  hit_cost?: number;
  delta_pts_4gw?: number;
  delta_pts_6gw?: number;
  threshold_required?: number;
  rejection_reason?: string;
}

export interface StrategyPathMove {
  out: string;
  in: string;
  out_player_id?: number;
  in_player_id?: number;
  hit_cost?: number;
  delta_pts_4gw?: number;
  delta_pts_6gw?: number;
  confidence?: string;
  rationale?: string;
}

export interface StrategyPaths {
  safe?: StrategyPathMove;
  balanced?: StrategyPathMove;
  aggressive?: StrategyPathMove;
}

export interface SquadIssue {
  category?: string;
  severity?: string;
  title?: string;
  detail?: string;
  players?: string[];
}

export interface ChipTimingOutlook {
  bench_boost_window?: string;
  triple_captain_window?: string;
  free_hit_window?: string;
  rationale?: string;
}

export interface FixturePlannerTimelineCell {
  gw: number;
  dgw_teams: string[];
  bgw_teams: string[];
  fixture_count_total: number;
}

export interface FixturePlannerUpcomingRow {
  gw: number;
  fixture_count: number;
  is_blank: boolean;
  is_double: boolean;
  opponents: string[];
  avg_difficulty: number;
}

export interface FixturePlannerPlayerWindow {
  player_id?: number;
  name: string;
  team: string;
  summary: {
    dgw_count: number;
    bgw_count: number;
    next_dgw_gw?: number;
    next_bgw_gw?: number;
    weighted_fixture_score: number;
    next6_pts?: number;
  };
  upcoming: FixturePlannerUpcomingRow[];
}

export interface FixturePlannerData {
  horizon_gws: 8;
  start_gw: number;
  gw_timeline: FixturePlannerTimelineCell[];
  squad_windows: FixturePlannerPlayerWindow[];
  target_windows: FixturePlannerPlayerWindow[];
  key_planning_notes: string[];
}

export interface LineupDecisionStarter {
  player_id?: number | string;
  name: string;
  team?: string;
  position: 'GK' | 'DEF' | 'MID' | 'FWD' | string;
  projected_points?: number;
  expected_minutes?: number;
  flags?: string[];
  badges?: string[];
  start_reason?: string;
}

export interface LineupDecisionBench {
  player_id?: number | string;
  name: string;
  team?: string;
  position: 'GK' | 'DEF' | 'MID' | 'FWD' | string;
  projected_points?: number;
  expected_minutes?: number;
  flags?: string[];
  bench_order?: number;
  bench_reason?: string;
}

export interface LineupDecisionPayload {
  formation: string;
  risk_profile: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE' | string;
  lineup_confidence: 'HIGH' | 'MEDIUM' | 'LOW' | string;
  formation_reason: string;
  risk_profile_effect?: string;
  notes: string[];
  starters: LineupDecisionStarter[];
  bench: LineupDecisionBench[];
  captain_player_id?: number | string;
  vice_captain_player_id?: number | string;
}

export interface DetailedAnalysisResponse {
  team_name: string;
  manager_name: string;
  current_gw?: number | null;
  overall_rank?: number | null;
  overall_points?: number | null;
  free_transfers?: number | null;
  risk_posture?: string | null;
  primary_decision: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | string;
  reasoning: string;
  strategy_mode?: string | null;
  manager_state?: ManagerState | null;
  transfer_recommendations: Array<Record<string, unknown>>;
  transfer_plans?: TransferPlans | null;
  near_threshold_moves?: NearThresholdMove[] | null;
  near_threshold_reason?: string | null;
  strategy_paths?: StrategyPaths | null;
  strategy_paths_reason?: string | null;
  squad_issues?: SquadIssue[] | null;
  captain?: Record<string, unknown> | null;
  vice_captain?: Record<string, unknown> | null;
  captain_delta?: { delta_pts?: number; delta_pts_4gw?: number } | null;
  starting_xi_projections: PlayerProjection[];
  bench_projections: PlayerProjection[];
  lineup_decision?: LineupDecisionPayload | null;
  projected_xi?: PlayerProjection[] | null;
  projected_bench?: PlayerProjection[] | null;
  transfer_targets?: PlayerProjection[] | null;
  risk_scenarios: Array<Record<string, unknown>>;
  chip_recommendation?: Record<string, unknown> | null;
  chip_timing_outlook?: ChipTimingOutlook | null;
  fixture_planner?: FixturePlannerData | null;
  fixture_planner_reason?: string | null;
  available_chips: string[];
  squad_health?: SquadHealth | null;
}

export interface DashboardData {
  analysis_id: string;
  team_id: number;
  status: string;
  gameweek: number | null;
  quick_actions: Array<{
    action: string;
    priority?: string;
    from_player?: string;
    to_player?: string;
    gain?: number;
  }>;
  captain?: {
    player?: string | null;
    expected_points?: number | null;
    confidence?: number;
  };
  chips?: {
    bench_boost?: string;
    triple_captain?: string;
    free_hit?: string;
  };
  health_score?: number;
  key_risks?: string[];
}

export interface AnalysisStatusResponse {
  status: 'queued' | 'running' | 'analyzing' | 'complete' | 'failed';
  progress?: number;
  phase?: string;
  error?: string;
  results?: Record<string, unknown>;
}

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const extractErrorMessage = (value: unknown, fallback: string): string => {
  const payload = toRecord(value);
  if (!payload) {
    return fallback;
  }

  const detail = payload.detail;
  if (typeof detail === 'string' && detail.trim().length > 0) {
    return detail.trim();
  }

  const nestedDetail = toRecord(detail)?.detail;
  if (typeof nestedDetail === 'string' && nestedDetail.trim().length > 0) {
    return nestedDetail.trim();
  }

  const message = payload.message;
  if (typeof message === 'string' && message.trim().length > 0) {
    return message.trim();
  }

  return fallback;
};

const isFailedAnalysisNotReady = (value: unknown): boolean => {
  const payload = toRecord(value);
  if (!payload) {
    return false;
  }

  const parts: string[] = [];
  const directFields = [
    payload.error,
    payload.message,
    payload.detail,
    payload.code,
    payload.error_code,
  ];
  for (const field of directFields) {
    if (typeof field === 'string' && field.trim().length > 0) {
      parts.push(field.trim().toLowerCase());
    }
  }

  const nestedDetail = toRecord(payload.detail)?.detail;
  if (typeof nestedDetail === 'string' && nestedDetail.trim().length > 0) {
    parts.push(nestedDetail.trim().toLowerCase());
  }

  return parts.join(' ').includes('failed');
};

/**
 * Trigger a new FPL analysis
 */
export async function triggerAnalysis(
  request: AnalyzeRequest,
): Promise<AnalyzeResponse> {
  const response = await fetch(`${FPL_API_BASE_URL}/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    let errorMessage = 'Analysis failed to start';
    try {
      const errorData = await response.json();
      errorMessage =
        errorData.detail?.detail || errorData.detail || errorMessage;
    } catch {
      // If response isn't JSON, try to get text
      try {
        const text = await response.text();
        errorMessage =
          text || `HTTP ${response.status}: ${response.statusText}`;
      } catch {
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }
    }
    throw new Error(errorMessage);
  }

  return response.json();
}

/**
 * Check analysis status
 */
export async function getAnalysisStatus(
  analysisId: string,
): Promise<AnalysisStatusResponse> {
  const response = await fetch(
    `${FPL_API_BASE_URL}/analyze/${analysisId}/status`,
  );

  if (!response.ok) {
    let errorMessage = `Failed to fetch analysis status: ${response.statusText}`;
    try {
      const error = await response.json();
      errorMessage = error.detail || errorMessage;
    } catch {
      // Response isn't JSON, use status text
    }
    throw new Error(errorMessage);
  }

  return response.json();
}

/**
 * Get dashboard data for a completed analysis
 */
export async function getDashboardData(
  analysisId: string,
): Promise<DashboardData> {
  const response = await fetch(
    `${FPL_API_BASE_URL}/analyze/${analysisId}/dashboard`,
  );

  if (!response.ok) {
    if (response.status === 202) {
      throw new Error('STILL_RUNNING');
    }
    let errorMessage = 'Failed to fetch dashboard data';
    try {
      const error = await response.json();
      errorMessage = error.detail || errorMessage;
    } catch {
      // Response isn't JSON, use status text
      errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    }
    throw new Error(errorMessage);
  }

  const data = await response.json();

  // Backend may return 200 with status="analyzing" instead of 202
  if (data.status === 'analyzing' || data.status === 'queued') {
    throw new Error('STILL_RUNNING');
  }

  return data;
}

/**
 * Get detailed projections for a completed analysis
 */
export async function getDetailedProjections(
  analysisId: string,
): Promise<DetailedAnalysisResponse> {
  const response = await fetch(
    `${FPL_API_BASE_URL}/analyze/${analysisId}/projections`,
  );

  if (!response.ok) {
    const fallbackError = `HTTP ${response.status}: ${response.statusText}`;
    let parsedError: unknown = null;
    try {
      parsedError = await response.json();
    } catch {
      // Response isn't JSON; fallbackError handles this path.
    }
    const errorMessage = extractErrorMessage(
      parsedError,
      'Failed to fetch detailed projections',
    );

    if (response.status === 425 || response.status === 202) {
      if (!isFailedAnalysisNotReady(parsedError)) {
        throw new Error('STILL_RUNNING');
      }
      throw new Error(
        errorMessage === 'Failed to fetch detailed projections'
          ? fallbackError
          : errorMessage,
      );
    }

    throw new Error(errorMessage);
  }

  return response.json();
}

/**
 * Poll for analysis completion and return dashboard data
 */
export async function pollForDashboard(
  analysisId: string,
  maxAttempts = 60,
  intervalMs = 2000,
): Promise<DashboardData> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const data = await getDashboardData(analysisId);
      return data;
    } catch (error) {
      if (error instanceof Error && error.message === 'STILL_RUNNING') {
        // Still running, wait and try again
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Analysis timed out. Please try again.');
}

/**
 * Poll for detailed projections
 */
export async function pollForDetailedProjections(
  analysisId: string,
  maxAttempts = 60,
  intervalMs = 2000,
): Promise<DetailedAnalysisResponse> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const data = await getDetailedProjections(analysisId);
      return data;
    } catch (error) {
      if (error instanceof Error && error.message === 'STILL_RUNNING') {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Analysis timed out. Please try again.');
}
