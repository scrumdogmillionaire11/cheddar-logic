/**
 * Market type detection, period inference, and wave-1 decision logic
 * extracted from route.ts (WI-0621)
 */

import {
  normalizeSport,
  toObject,
  firstNumber,
} from './normalizers';

// Local type aliases matching route.ts Play interface fields used here
type MarketType =
  | 'MONEYLINE'
  | 'SPREAD'
  | 'TOTAL'
  | 'PUCKLINE'
  | 'TEAM_TOTAL'
  | 'FIRST_PERIOD'
  | 'FIRST_5_INNINGS'
  | 'PROP'
  | 'INFO';
type Classification = 'BASE' | 'LEAN' | 'PASS';
type Action = 'FIRE' | 'HOLD' | 'PASS';
type Status = 'FIRE' | 'WATCH' | 'PASS';
type Prediction = 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';
type Kind = 'PLAY' | 'EVIDENCE';
type DecisionV2OfficialStatus = 'PLAY' | 'LEAN' | 'PASS';
type DecisionV2Direction = 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NONE';
type DecisionV2WatchdogStatus = 'OK' | 'CAUTION' | 'BLOCKED';
type DecisionV2SharpPriceStatus = 'CHEDDAR' | 'COTTAGE' | 'UNPRICED' | 'PENDING_VERIFICATION';
type DecisionV2PlayTier = 'BEST' | 'GOOD' | 'OK' | 'BAD';

// Minimal shape for the fields modified by these helpers
export interface PlayMutable {
  action?: Action;
  classification?: Classification;
  status?: Status;
  pass_reason_code?: string | null;
  decision_v2?: DecisionV2Shape;
  kind?: Kind;
}

export interface DecisionV2Shape {
  direction: DecisionV2Direction;
  support_score: number;
  conflict_score: number;
  drivers_used: string[];
  driver_reasons: string[];
  watchdog_status: DecisionV2WatchdogStatus;
  watchdog_reason_codes: string[];
  missing_data: {
    missing_fields: string[];
    source_attempts: Array<{
      field: string;
      source: string;
      result: 'FOUND' | 'MISSING' | 'ERROR';
      note?: string;
    }>;
    severity: 'INFO' | 'WARNING' | 'BLOCKING';
  };
  consistency: {
    pace_tier: string;
    event_env: string;
    event_direction_tag: string;
    vol_env: string;
    total_bias: string;
  };
  fair_prob: number | null;
  implied_prob: number | null;
  edge_pct: number | null;
  edge_delta_pct?: number | null;
  edge_method?: 'ML_PROB' | 'MARGIN_DELTA' | 'TOTAL_DELTA' | 'ONE_PERIOD_DELTA' | null;
  edge_line_delta?: number | null;
  edge_lean?: 'OVER' | 'UNDER' | null;
  proxy_used?: boolean;
  proxy_capped?: boolean;
  exact_wager_valid?: boolean;
  pricing_trace?: {
    market_type?: string | null;
    market_side?: string | null;
    market_line?: number | null;
    market_price?: number | null;
    line_source?: string | null;
    price_source?: string | null;
  };
  sharp_price_status: DecisionV2SharpPriceStatus;
  price_reason_codes: string[];
  official_status: DecisionV2OfficialStatus;
  play_tier: DecisionV2PlayTier;
  primary_reason_code: string;
  pipeline_version: 'v2';
  decided_at: string;
  canonical_envelope_v2?: {
    official_status?: 'PLAY' | 'LEAN' | 'PASS';
    terminal_reason_family?: string;
    primary_reason_code?: string;
    reason_codes?: string[];
    is_actionable?: boolean;
    execution_status?: 'EXECUTABLE' | 'PROJECTION_ONLY' | 'BLOCKED';
    publish_ready?: boolean;
    selection_side?: string;
    direction?: string;
    selection_team?: string;
  };
}

const WAVE1_SPORTS = new Set(['NBA', 'NHL', 'MLB']);
const WAVE1_MARKETS = new Set<MarketType>([
  'MONEYLINE',
  'SPREAD',
  'TOTAL',
  'PUCKLINE',
  'TEAM_TOTAL',
  'FIRST_PERIOD',
  'FIRST_5_INNINGS',
  'PROP',
]);

export function inferMarketFromCardType(cardType: string): MarketType | undefined {
  const normalized = cardType.trim().toLowerCase();
  if (normalized.includes('1p') || normalized.includes('first-period')) {
    return 'FIRST_PERIOD';
  }
  if (
    normalized.includes('double_chance') ||
    normalized.includes('double-chance')
  ) {
    return 'MONEYLINE';
  }
  if (normalized.includes('moneyline') || normalized.includes('-ml-')) {
    return 'MONEYLINE';
  }
  if (
    normalized.includes('spread') ||
    normalized.includes('puckline') ||
    normalized.includes('puck-line')
  ) {
    return 'SPREAD';
  }
  if (normalized.includes('total')) {
    return 'TOTAL';
  }
  if (
    normalized.includes('player-shots') ||
    normalized.includes('player_shots') ||
    normalized.includes('player-blk') ||
    normalized.includes('blocked-shots') ||
    normalized === 'mlb-strikeout' ||
    normalized === 'mlb-pitcher-k'
  ) {
    return 'PROP';
  }
  if (normalized === 'mlb-full-game-ml') {
    return 'MONEYLINE';
  }
  if (normalized === 'mlb-full-game') {
    return 'TOTAL';
  }
  if (normalized === 'mlb-f5') {
    return 'FIRST_5_INNINGS';
  }
  return undefined;
}

export interface SportCardTypeContract {
  playProducerCardTypes: Set<string>;
  evidenceOnlyCardTypes: Set<string>;
  expectedPlayableMarkets: Set<MarketType>;
}

export const ACTIVE_SPORT_CARD_TYPE_CONTRACT: Record<string, SportCardTypeContract> = {
  NBA: {
    playProducerCardTypes: new Set([
      'nba-totals-call',
      'nba-spread-call',
    ]),
    evidenceOnlyCardTypes: new Set([
      'nba-base-projection',
      'nba-total-projection',
      'nba-rest-advantage',
      'nba-matchup-style',
      'nba-blowout-risk',
      'nba-travel',
      'nba-lineup',
      'welcome-home',
      'welcome-home-v2',
      'nba-model-output',
    ]),
    expectedPlayableMarkets: new Set<MarketType>(['SPREAD', 'TOTAL']),
  },
  NHL: {
    playProducerCardTypes: new Set([
      'nhl-totals-call',
      'nhl-spread-call',
      'nhl-moneyline-call',
      'nhl-pace-totals',
      'nhl-pace-1p',
      'nhl-player-shots',
      'nhl-player-shots-1p',
      'nhl-player-blk',
    ]),
    evidenceOnlyCardTypes: new Set([
      'nhl-base-projection',
      'nhl-rest-advantage',
      'nhl-goalie',
      'nhl-goalie-certainty',
      'nhl-model-output',
      'nhl-shot-environment',
      'welcome-home',
      'welcome-home-v2',
      'nhl-welcome-home',
    ]),
    expectedPlayableMarkets: new Set<MarketType>([
      'MONEYLINE',
      'SPREAD',
      'TOTAL',
      'FIRST_PERIOD',
      'PROP',
    ]),
  },
  MLB: {
    playProducerCardTypes: new Set([
      'mlb-strikeout',
      'mlb-f5',
      'mlb-pitcher-k',
      'mlb-full-game',
      'mlb-full-game-ml',
    ]),
    evidenceOnlyCardTypes: new Set(['mlb-model-output']),
    // FULL_GAME pathways are represented as canonical TOTAL and MONEYLINE markets.
    expectedPlayableMarkets: new Set<MarketType>([
      'PROP',
      'FIRST_5_INNINGS',
      'TOTAL',
      'MONEYLINE',
    ]),
  },
};

export function getSportCardTypeContract(
  sport?: unknown,
): SportCardTypeContract | undefined {
  const normalizedSport = normalizeSport(sport);
  if (!normalizedSport) return undefined;
  return ACTIVE_SPORT_CARD_TYPE_CONTRACT[normalizedSport];
}

export function applyCardTypeKindContract(
  sport: unknown,
  cardType: string,
  fallbackKind: Kind | undefined,
  contract: SportCardTypeContract | undefined,
): {
  kind: Kind;
  downgradedOutOfContractPlay: boolean;
} {
  const normalizedCardType = cardType.trim().toLowerCase();
  const inferredKind = fallbackKind ?? 'PLAY';
  if (!contract) {
    return { kind: inferredKind, downgradedOutOfContractPlay: false };
  }
  if (contract.evidenceOnlyCardTypes.has(normalizedCardType)) {
    return { kind: 'EVIDENCE', downgradedOutOfContractPlay: false };
  }
  if (
    inferredKind === 'PLAY' &&
    !contract.playProducerCardTypes.has(normalizedCardType)
  ) {
    return { kind: 'EVIDENCE', downgradedOutOfContractPlay: true };
  }
  return { kind: inferredKind, downgradedOutOfContractPlay: false };
}

export function isFirstPeriodCardType(cardType: string): boolean {
  const normalized = cardType.trim().toLowerCase();
  return normalized.includes('1p') || normalized.includes('first-period');
}

export interface TotalsCallPlay {
  kind?: Kind;
  market_type?: MarketType;
  projectedTotal?: number | null;
  cardType: string;
}

export function isCanonicalTotalsCallPlay(play: TotalsCallPlay): boolean {
  if (play.kind !== 'PLAY') return false;
  if (play.market_type !== 'TOTAL') return false;
  if (typeof play.projectedTotal !== 'number') return false;
  const normalizedCardType = String(play.cardType || '').toLowerCase();
  if (isFirstPeriodCardType(normalizedCardType)) return false;
  return normalizedCardType.includes('totals-call');
}

export function isFallbackEvidenceTotalProjectionPlay(play: TotalsCallPlay): boolean {
  if (play.kind !== 'EVIDENCE') return false;
  if (typeof play.projectedTotal !== 'number') return false;
  const normalizedCardType = String(play.cardType || '').toLowerCase();
  if (isFirstPeriodCardType(normalizedCardType)) return false;
  return normalizedCardType.includes('total-projection');
}

export function isWave1EligibleRow(
  sport: unknown,
  kind: Kind | undefined,
  marketType: MarketType | undefined,
): boolean {
  const normalizedSport = normalizeSport(sport);
  if (!normalizedSport || !WAVE1_SPORTS.has(normalizedSport)) return false;
  if ((kind ?? 'PLAY') !== 'PLAY') return false;
  if (!marketType) return false;
  return WAVE1_MARKETS.has(marketType);
}

export function deriveNhl1PModelCall(
  reasonCodes: string[],
  prediction?: Prediction,
): 'BEST_OVER' | 'PLAY_OVER' | 'LEAN_OVER' | 'BEST_UNDER' | 'PLAY_UNDER' | 'LEAN_UNDER' | 'PASS' | null {
  if (reasonCodes.includes('NHL_1P_OVER_BEST')) return 'BEST_OVER';
  if (reasonCodes.includes('NHL_1P_OVER_PLAY')) return 'PLAY_OVER';
  if (reasonCodes.includes('NHL_1P_OVER_LEAN')) return 'LEAN_OVER';
  if (reasonCodes.includes('NHL_1P_UNDER_BEST')) return 'BEST_UNDER';
  if (reasonCodes.includes('NHL_1P_UNDER_PLAY')) return 'PLAY_UNDER';
  if (reasonCodes.includes('NHL_1P_UNDER_LEAN')) return 'LEAN_UNDER';
  if (reasonCodes.includes('NHL_1P_PASS_DEAD_ZONE')) return 'PASS';
  if (prediction === 'OVER') return 'LEAN_OVER';
  if (prediction === 'UNDER') return 'LEAN_UNDER';
  return null;
}

export function normalizeDecisionV2(value: unknown): DecisionV2Shape | undefined {
  const input = toObject(value);
  if (!input) return undefined;

  const officialStatusRaw =
    typeof input.official_status === 'string'
      ? input.official_status.toUpperCase()
      : '';
  const official_status =
    officialStatusRaw === 'PLAY' ||
    officialStatusRaw === 'LEAN' ||
    officialStatusRaw === 'PASS'
      ? (officialStatusRaw as DecisionV2OfficialStatus)
      : null;
  if (!official_status) return undefined;

  const directionRaw =
    typeof input.direction === 'string' ? input.direction.toUpperCase() : '';
  const direction =
    directionRaw === 'HOME' ||
    directionRaw === 'AWAY' ||
    directionRaw === 'OVER' ||
    directionRaw === 'UNDER' ||
    directionRaw === 'NONE'
      ? (directionRaw as DecisionV2Direction)
      : 'NONE';

  const watchdogStatusRaw =
    typeof input.watchdog_status === 'string'
      ? input.watchdog_status.toUpperCase()
      : '';
  const watchdog_status =
    watchdogStatusRaw === 'OK' ||
    watchdogStatusRaw === 'CAUTION' ||
    watchdogStatusRaw === 'BLOCKED'
      ? (watchdogStatusRaw as DecisionV2WatchdogStatus)
      : 'BLOCKED';

  const sharpStatusRaw =
    typeof input.sharp_price_status === 'string'
      ? input.sharp_price_status.toUpperCase()
      : '';
  const sharp_price_status =
    sharpStatusRaw === 'CHEDDAR' ||
    sharpStatusRaw === 'COTTAGE' ||
    sharpStatusRaw === 'PENDING_VERIFICATION' ||
    sharpStatusRaw === 'UNPRICED'
      ? (sharpStatusRaw as DecisionV2SharpPriceStatus)
      : 'UNPRICED';

  const playTierRaw =
    typeof input.play_tier === 'string' ? input.play_tier.toUpperCase() : '';
  const play_tier =
    playTierRaw === 'BEST' ||
    playTierRaw === 'GOOD' ||
    playTierRaw === 'OK' ||
    playTierRaw === 'BAD'
      ? (playTierRaw as DecisionV2PlayTier)
      : 'BAD';

  const missingDataObject = toObject(input.missing_data);
  const consistencyObject = toObject(input.consistency);
  // Allow missing_data to be absent (it's optional), but consistency is required
  if (!consistencyObject) return undefined;

  return {
    direction,
    support_score: firstNumber(input.support_score, 0) ?? 0,
    conflict_score: firstNumber(input.conflict_score, 0) ?? 0,
    drivers_used: Array.isArray(input.drivers_used)
      ? input.drivers_used.map((item) => String(item))
      : [],
    driver_reasons: Array.isArray(input.driver_reasons)
      ? input.driver_reasons.map((item) => String(item))
      : [],
    watchdog_status,
    watchdog_reason_codes: Array.isArray(input.watchdog_reason_codes)
      ? input.watchdog_reason_codes.map((item) => String(item))
      : [],
    missing_data: {
      missing_fields: Array.isArray(missingDataObject?.missing_fields)
        ? missingDataObject.missing_fields.map((item) => String(item))
        : [],
      source_attempts: Array.isArray(missingDataObject?.source_attempts)
        ? missingDataObject.source_attempts
            .map((attempt) => toObject(attempt))
            .filter((attempt): attempt is Record<string, unknown> =>
              Boolean(attempt),
            )
            .map((attempt) => {
              const resultRaw =
                typeof attempt.result === 'string'
                  ? attempt.result.toUpperCase()
                  : 'ERROR';
              const result =
                resultRaw === 'FOUND' ||
                resultRaw === 'MISSING' ||
                resultRaw === 'ERROR'
                  ? (resultRaw as 'FOUND' | 'MISSING' | 'ERROR')
                  : 'ERROR';
              return {
                field: String(attempt.field ?? ''),
                source: String(attempt.source ?? ''),
                result,
                note:
                  typeof attempt.note === 'string' ? attempt.note : undefined,
              };
            })
        : [],
      severity:
        missingDataObject?.severity === 'INFO' ||
        missingDataObject?.severity === 'WARNING' ||
        missingDataObject?.severity === 'BLOCKING'
          ? (missingDataObject.severity as 'INFO' | 'WARNING' | 'BLOCKING')
          : 'INFO',
    },
    consistency: {
      pace_tier: String(consistencyObject.pace_tier ?? 'MISSING'),
      event_env: String(consistencyObject.event_env ?? 'MISSING'),
      event_direction_tag: String(
        consistencyObject.event_direction_tag ?? 'MISSING',
      ),
      vol_env: String(consistencyObject.vol_env ?? 'MISSING'),
      total_bias: String(consistencyObject.total_bias ?? 'MISSING'),
    },
    fair_prob:
      typeof input.fair_prob === 'number' && Number.isFinite(input.fair_prob)
        ? input.fair_prob
        : null,
    implied_prob:
      typeof input.implied_prob === 'number' &&
      Number.isFinite(input.implied_prob)
        ? input.implied_prob
        : null,
    edge_pct:
      typeof input.edge_pct === 'number' && Number.isFinite(input.edge_pct)
        ? input.edge_pct
        : null,
    edge_delta_pct:
      typeof resolveDecisionV2EdgePct(input) === 'number'
        ? resolveDecisionV2EdgePct(input)
        : null,
    edge_method:
      input.edge_method === 'ML_PROB' ||
      input.edge_method === 'MARGIN_DELTA' ||
      input.edge_method === 'TOTAL_DELTA' ||
      input.edge_method === 'ONE_PERIOD_DELTA'
        ? (input.edge_method as 'ML_PROB' | 'MARGIN_DELTA' | 'TOTAL_DELTA' | 'ONE_PERIOD_DELTA')
        : null,
    edge_line_delta:
      typeof input.edge_line_delta === 'number' &&
      Number.isFinite(input.edge_line_delta)
        ? input.edge_line_delta
        : null,
    edge_lean:
      input.edge_lean === 'OVER' || input.edge_lean === 'UNDER'
        ? (input.edge_lean as 'OVER' | 'UNDER')
        : null,
    proxy_used:
      typeof input.proxy_used === 'boolean' ? input.proxy_used : undefined,
    proxy_capped:
      typeof input.proxy_capped === 'boolean' ? input.proxy_capped : undefined,
    exact_wager_valid:
      typeof input.exact_wager_valid === 'boolean'
        ? input.exact_wager_valid
        : undefined,
    pricing_trace: toObject(input.pricing_trace)
      ? {
          market_type:
            typeof toObject(input.pricing_trace)?.market_type === 'string'
              ? String(toObject(input.pricing_trace)?.market_type)
              : null,
          market_side:
            typeof toObject(input.pricing_trace)?.market_side === 'string'
              ? String(toObject(input.pricing_trace)?.market_side)
              : null,
          market_line:
            firstNumber(toObject(input.pricing_trace)?.market_line) ?? null,
          market_price:
            firstNumber(toObject(input.pricing_trace)?.market_price) ?? null,
          line_source:
            typeof toObject(input.pricing_trace)?.line_source === 'string'
              ? String(toObject(input.pricing_trace)?.line_source)
              : null,
          price_source:
            typeof toObject(input.pricing_trace)?.price_source === 'string'
              ? String(toObject(input.pricing_trace)?.price_source)
              : null,
        }
      : undefined,
    sharp_price_status,
    price_reason_codes: Array.isArray(input.price_reason_codes)
      ? input.price_reason_codes.map((item) => String(item))
      : [],
    official_status,
    play_tier,
    primary_reason_code: String(input.primary_reason_code ?? 'UNKNOWN'),
    pipeline_version: 'v2',
    decided_at:
      typeof input.decided_at === 'string' && input.decided_at.trim().length > 0
        ? input.decided_at
        : new Date().toISOString(),
  };
}

export function resolveDecisionV2EdgePct(
  value: { edge_delta_pct?: unknown; edge_pct?: unknown } | null | undefined,
): number | undefined {
  if (!value) return undefined;
  return firstNumber(value.edge_delta_pct, value.edge_pct);
}

export function applyWave1DecisionFields(play: PlayMutable): void {
  const decisionV2 = play.decision_v2;
  if (!decisionV2) return;
  if (decisionV2.official_status === 'PLAY') {
    play.action = 'FIRE';
    play.classification = 'BASE';
    play.pass_reason_code = null;
    return;
  }
  if (decisionV2.official_status === 'LEAN') {
    play.action = 'HOLD';
    play.classification = 'LEAN';
    play.pass_reason_code = null;
    return;
  }
  play.action = 'PASS';
  play.classification = 'PASS';
  play.pass_reason_code = decisionV2.primary_reason_code;
}

export function actionFromClassification(
  classification?: Classification,
): Action | undefined {
  if (classification === 'BASE') return 'FIRE';
  if (classification === 'LEAN') return 'HOLD';
  if (classification === 'PASS') return 'PASS';
  return undefined;
}

export function classificationFromAction(
  action?: Action,
): Classification | undefined {
  if (action === 'FIRE') return 'BASE';
  if (action === 'HOLD') return 'LEAN';
  if (action === 'PASS') return 'PASS';
  return undefined;
}

export function statusFromAction(action?: Action): Status | undefined {
  if (action === 'FIRE') return 'FIRE';
  if (action === 'HOLD') return 'WATCH';
  if (action === 'PASS') return 'PASS';
  return undefined;
}

export function actionFromTier(tier?: 'SUPER' | 'BEST' | 'WATCH' | null): Action | undefined {
  if (tier === 'BEST' || tier === 'SUPER') return 'FIRE';
  if (tier === 'WATCH') return 'HOLD';
  return undefined;
}
