/**
 * Types for the projection-only accuracy and confidence engine.
 */

export interface ProjectionAccuracyBucket {
  line_evals: number;
  wins: number;
  losses: number;
  pushes: number;
  no_bets: number;
  hit_rate: number | null;
  avg_absolute_error: number | null;
}

export interface ProjectionAccuracySummary {
  line_role: string;
  total_cards: number;
  total_line_evals: number;
  graded_line_evals: number;
  wins: number;
  losses: number;
  pushes: number;
  no_bets: number;
  hit_rate: number | null;
  weak_direction_count: number;
  weak_direction_share: number;
  avg_absolute_error: number | null;
  avg_signed_error: number | null;
  avg_projection_confidence: number | null;
  calibration_gap: number | null;
  market_trust_status: string;
  by_card_type: Record<string, ProjectionAccuracyBucket>;
  by_market_trust: Record<string, ProjectionAccuracyBucket>;
  by_confidence_band: Record<string, ProjectionAccuracyBucket>;
}

export interface ProjectionAccuracyRecord {
  card_id: string;
  game_id: string;
  sport: string | null;
  card_type: string;
  market_family: string;
  market_type: string | null;
  player_or_game_id: string | null;
  projection_raw: number | null;
  projection_value: number;
  synthetic_line: number | null;
  synthetic_rule: string;
  synthetic_direction: string | null;
  direction_strength: string | null;
  weak_direction_flag: number | null;
  edge_distance: number | null;
  actual: number | null;
  actual_value: number | null;
  graded_result: string | null;
  abs_error: number | null;
  signed_error: number | null;
  projection_confidence: number | null;
  confidence_band: string;
  edge_pp?: number | null;
  brier_score?: number | null;
  tracking_role?: string | null;
  expected_outcome_label?: string | null;
  market_trust_status: string;
  failure_flags: string | null;
}

export interface ProjectionAccuracyMarketHealth {
  market_family: string;
  line_role: string;
  generated_at: string;
  sample_size: number;
  wins: number;
  losses: number;
  pushes: number;
  no_bets: number;
  win_rate: number | null;
  mae: number | null;
  bias: number | null;
  calibration_gap: number | null;
  avg_confidence: number | null;
  weak_direction_share: number | null;
  confidence_lift_json?: string | null;
  confidence_lift?: Record<string, {
    wins: number;
    losses: number;
    sample_size: number;
    win_rate: number | null;
    mae: number | null;
    bias: number | null;
  }>;
  market_trust_status: string;
}

export interface ProjectionAccuracyResponse {
  generatedAt: string;
  lookbackDays: number;
  summary: ProjectionAccuracySummary;
  marketHealth: ProjectionAccuracyMarketHealth[];
  rows: ProjectionAccuracyRecord[];
}
