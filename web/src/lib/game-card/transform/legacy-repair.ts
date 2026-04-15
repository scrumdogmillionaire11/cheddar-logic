/**
 * Sport card type contract helpers, play/evidence classification, and legacy source helpers
 * Extracted from game-card/transform.ts (WI-0622)
 */

import type { CanonicalMarketType, ExpressionStatus } from '../../types';
import type { DecisionV2 } from '../../types';
import { resolvePlayDisplayDecision } from '../decision';
import { getSportCardTypeContract as getSharedSportCardTypeContract } from '../../games/market-inference';
import { isWelcomeHomeCardType } from '../welcome-home';

// NOTE: ApiPlay is redefined here as a local interface to avoid circular imports.
// It must stay structurally compatible with the ApiPlay interface in transform/index.ts.
interface ApiPlay {
  source_card_id?: string;
  cardType: string;
  cardTitle: string;
  prediction: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';
  confidence: number;
  tier: 'SUPER' | 'BEST' | 'WATCH' | null;
  reasoning: string;
  evPassed: boolean;
  driverKey: string;
  projectedTotal?: number | null;
  edge?: number | null;
  edge_points?: number | null;
  odds_context?: Record<string, unknown> | null;
  p_fair?: number | null;
  p_implied?: number | null;
  edge_pct?: number | null;
  edge_delta_pct?: number | null;
  model_prob?: number | null;
  proxy_used?: boolean;
  line_source?: string | null;
  price_source?: string | null;
  projection?: {
    margin_home?: number | null;
    total?: number | null;
    team_total?: number | null;
    goal_diff?: number | null;
    score_home?: number | null;
    score_away?: number | null;
    projected_margin?: number | null;
    projected_total?: number | null;
    projected_team_total?: number | null;
    projected_goal_diff?: number | null;
    projected_score_home?: number | null;
    projected_score_away?: number | null;
    win_prob_home?: number | null;
  };
  status?: 'FIRE' | 'WATCH' | 'PASS';
  classification?: 'BASE' | 'LEAN' | 'PASS';
  action?: 'FIRE' | 'HOLD' | 'PASS';
  pass_reason_code?: string | null;
  pass_reason?: string | null;
  run_id?: string;
  created_at?: string;
  player_id?: string;
  player_name?: string;
  team_abbr?: string;
  game_id?: string;
  mu?: number | null;
  suggested_line?: number | null;
  threshold?: number | null;
  is_trending?: boolean;
  role_gate_pass?: boolean;
  data_quality?: string | null;
  l5_sog?: number[] | null;
  l5_mean?: number | null;
  market_type?: CanonicalMarketType;
  selection?: { side?: string; team?: string };
  line?: number;
  price?: number;
  reason_codes?: string[];
  projection_inputs_complete?: boolean | null;
  missing_inputs?: string[];
  source_mapping_ok?: boolean | null;
  source_mapping_failures?: string[];
  tags?: string[];
  recommendation?: { type?: string };
  recommended_bet_type?: string;
  canonical_market_key?: string;
  kind?: 'PLAY' | 'EVIDENCE';
  evidence_for_play_id?: string;
  aggregation_key?: string;
  goalie_home_name?: string | null;
  goalie_away_name?: string | null;
  goalie_home_status?: 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | null;
  goalie_away_status?: 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | null;
  consistency?: {
    total_bias?:
      | 'OK'
      | 'INSUFFICIENT_DATA'
      | 'CONFLICTING_SIGNALS'
      | 'VOLATILE_ENV'
      | 'UNKNOWN';
  };
  decision_v2?: DecisionV2;
}

export function normalizeCardType(cardType: string): string {
  return cardType.trim().toLowerCase();
}

export function getSportCardTypeContract(
  sport?: unknown,
):
  | { playProducerCardTypes: Set<string>; evidenceOnlyCardTypes: Set<string> }
  | undefined {
  if (!sport) return undefined;
  return getSharedSportCardTypeContract(sport);
}

export function isPlayItem(play: ApiPlay, sport?: string): boolean {
  const contract = getSportCardTypeContract(sport);
  const cardType = normalizeCardType(play.cardType || '');
  const kind = play.kind ?? 'PLAY';
  if (contract) {
    if (contract.evidenceOnlyCardTypes.has(cardType)) return false;
    if (kind === 'PLAY' && !contract.playProducerCardTypes.has(cardType)) {
      return false;
    }
  }
  return kind === 'PLAY';
}

export function isEvidenceItem(play: ApiPlay, sport?: string): boolean {
  const contract = getSportCardTypeContract(sport);
  const cardType = normalizeCardType(play.cardType || '');
  if (contract?.evidenceOnlyCardTypes.has(cardType)) {
    return true;
  }
  if (contract && !contract.playProducerCardTypes.has(cardType)) {
    return true;
  }
  return (play.kind ?? 'PLAY') === 'EVIDENCE';
}

export function isWelcomeHomePlay(play: ApiPlay): boolean {
  return isWelcomeHomeCardType(play.cardType);
}

export function getSourcePlayAction(
  play?: ApiPlay,
): 'FIRE' | 'HOLD' | 'PASS' | undefined {
  if (!play) return undefined;
  const legacyStatus = String(play.status ?? '').toUpperCase();
  const hasExplicitAction =
    play.action === 'FIRE' || play.action === 'HOLD' || play.action === 'PASS';
  const hasClassification =
    play.classification === 'BASE' ||
    play.classification === 'LEAN' ||
    play.classification === 'PASS';
  const normalizedLegacyStatus: ExpressionStatus | undefined =
    legacyStatus === 'FIRE'
      ? 'FIRE'
      : legacyStatus === 'PASS'
        ? 'PASS'
        : legacyStatus === 'WATCH' || legacyStatus === 'HOLD'
          ? 'WATCH'
          : undefined;

  if (!hasExplicitAction && !hasClassification && !normalizedLegacyStatus) {
    return undefined;
  }

  return resolvePlayDisplayDecision({
    action: hasExplicitAction ? play.action : undefined,
    classification: hasClassification ? play.classification : undefined,
    status: normalizedLegacyStatus,
  }).action;
}

function _clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function _clamp01(value: number): number {
  return _clamp(value, 0, 1);
}

export function resolveSourceModelProb(play?: ApiPlay): number | undefined {
  const raw = play?.model_prob;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  if (raw < 0 || raw > 1) return undefined;
  return _clamp01(raw);
}
