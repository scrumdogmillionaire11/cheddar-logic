export type DecisionOutcomeStatus = 'PLAY' | 'SLIGHT_EDGE' | 'PASS';

export interface DecisionOutcomeSelection {
  market: string;
  side: string;
  line?: number;
  price?: number;
}

export interface DecisionOutcomeReasons {
  pass?: string[];
  blockers?: string[];
  warnings?: string[];
}

export interface DecisionOutcomeVerification {
  line_verified: boolean;
  data_fresh: boolean;
  inputs_complete: boolean;
}

export interface DecisionOutcomeSource {
  model: string;
  timestamp: string;
}

export interface DecisionOutcome {
  status: DecisionOutcomeStatus;
  selection: DecisionOutcomeSelection;
  edge: number | null;
  confidence: number | null;
  reasons: DecisionOutcomeReasons;
  verification: DecisionOutcomeVerification;
  source: DecisionOutcomeSource;
}

export interface DecisionOutcomeValidationResult {
  valid: boolean;
  errors?: string[];
}

export interface DecisionOutcomeMetadata {
  model?: string;
  model_name?: string;
  timestamp?: string;
  generated_at?: string;
  market?: string;
  side?: string;
  line?: number;
  price?: number;
  line_verified?: boolean;
  data_fresh?: boolean;
  inputs_complete?: boolean;
}

export declare function normalizeDecisionOutcomeStatus(
  status: unknown,
): DecisionOutcomeStatus;

export declare function mapReasonsToOutcome(
  decisionV2: unknown,
): DecisionOutcomeReasons;

export declare function buildDecisionOutcomeFromDecisionV2(
  decisionV2: unknown,
  metadata?: DecisionOutcomeMetadata,
): DecisionOutcome;

export declare function validateDecisionOutcome(
  candidate: unknown,
): DecisionOutcomeValidationResult;
