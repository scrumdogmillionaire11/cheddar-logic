import cheddarData from '@cheddar-logic/data';
import {
  hasActionableProjectionCall,
  buildProjectionSummaries,
  deriveCardFamily,
  deriveModelFamily,
  deriveModelVersion,
  deriveResultCardMode,
} from '@/app/api/results/projection-metrics';
import type {
  ActionableSourceRow,
  LedgerRow,
  ProjectionTrackingRow,
  ResultsQueryData,
  ResultsRequestFilters,
} from './query-layer';

type LockedMarketContext = {
  marketType: string;
  selection: string;
  line: number | null;
  marketKey: string;
  lockedPrice: number | null;
};

const buildDecisionOutcomeFromDecisionV2 = (
  cheddarData as {
    buildDecisionOutcomeFromDecisionV2: (decisionV2: unknown) => {
      status: 'PLAY' | 'SLIGHT_EDGE' | 'PASS' | 'INVALID';
      reasons?: { blockers?: string[] };
    };
  }
).buildDecisionOutcomeFromDecisionV2;

const deriveLockedMarketContext = (
  cheddarData as {
    deriveLockedMarketContext: (
      payload: Record<string, unknown>,
      options: {
        gameId?: string | null;
        homeTeam?: string | null;
        awayTeam?: string | null;
        requirePrice?: boolean;
        requireLineForMarket?: boolean;
      },
    ) => LockedMarketContext | null;
  }
).deriveLockedMarketContext;

const formatMarketSelectionLabel = (
  cheddarData as {
    formatMarketSelectionLabel: (
      marketType: string,
      selection: string,
    ) => string;
  }
).formatMarketSelectionLabel;

export type DecisionSegmentId = 'play' | 'slight_edge';
type DecisionTierStatus = 'PLAY' | 'LEAN' | 'PASS' | 'INVALID';
export type DecisionTierSource =
  | 'DECISION_V2'
  | 'FAIL_CLOSED';

type DecisionTierResolution = {
  tier: DecisionTierStatus;
  source: DecisionTierSource;
};

type DecisionTierContext = {
  sport: string | null;
  cardType: string | null;
  result: string | null;
};

type DecisionSegmentMeta = {
  id: DecisionSegmentId;
  label: string;
  canonicalStatus: 'PLAY' | 'LEAN';
};

export const DECISION_SEGMENTS: DecisionSegmentMeta[] = [
  { id: 'play', label: 'PLAY', canonicalStatus: 'PLAY' },
  { id: 'slight_edge', label: 'SLIGHT EDGE', canonicalStatus: 'LEAN' },
];

const CALL_SUFFIXES = ['%-totals-call', '%-spread-call'].map((pattern) =>
  pattern.replace('%', '').toLowerCase(),
);

function safeJsonParse(payload: string | null) {
  if (!payload) return { data: null, error: false, missing: true };
  try {
    return { data: JSON.parse(payload), error: false, missing: false };
  } catch {
    return { data: null, error: true, missing: false };
  }
}

export function resolveDecisionTierResolution(
  payload: Record<string, unknown> | null,
  context: DecisionTierContext,
): DecisionTierResolution {
  const play =
    payload?.play && typeof payload.play === 'object'
      ? (payload.play as Record<string, unknown>)
      : null;
  const decisionV2 =
    payload?.decision_v2 && typeof payload.decision_v2 === 'object'
      ? (payload.decision_v2 as Record<string, unknown>)
      : play?.decision_v2 && typeof play.decision_v2 === 'object'
        ? (play.decision_v2 as Record<string, unknown>)
        : null;

  if (!decisionV2) {
    const invalidEnforcementEnabled = process.env.ENABLE_INVALID_DECISION_ENFORCEMENT !== 'false';
    return {
      tier: invalidEnforcementEnabled ? 'INVALID' : 'PASS',
      source: 'FAIL_CLOSED',
    };
  }

  if (!hasActionableProjectionCall(payload)) {
    return { tier: 'PASS', source: 'DECISION_V2' };
  }

  const outcome = buildDecisionOutcomeFromDecisionV2(decisionV2);
  const status = String(outcome?.status || '').toUpperCase();
  if (status === 'PLAY') return { tier: 'PLAY', source: 'DECISION_V2' };
  if (status === 'SLIGHT_EDGE' || status === 'LEAN') {
    return { tier: 'LEAN', source: 'DECISION_V2' };
  }
  if (status === 'INVALID') {
    return { tier: 'INVALID', source: 'DECISION_V2' };
  }
  return { tier: 'PASS', source: 'DECISION_V2' };
}

export function resolveDecisionTier(
  payload: Record<string, unknown> | null,
  context?: Partial<DecisionTierContext>,
): DecisionTierStatus {
  return resolveDecisionTierResolution(payload, {
    sport: context?.sport ?? null,
    cardType: context?.cardType ?? null,
    result: context?.result ?? null,
  }).tier;
}

export function deriveDecisionSegment(
  tier: 'PLAY' | 'LEAN',
): DecisionSegmentMeta {
  return tier === 'PLAY' ? DECISION_SEGMENTS[0] : DECISION_SEGMENTS[1];
}

function deriveCardCategoryFromType(cardType: string | null | undefined) {
  const normalized = String(cardType || '').toLowerCase();
  return CALL_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
    ? 'call'
    : 'driver';
}

export function shouldTrackInResults(
  cardType: string | null | undefined,
): boolean {
  const normalized = String(cardType || '').trim().toLowerCase();
  if (!normalized) return true;
  return normalized !== 'potd-call';
}

type SegmentAccumulator = {
  sport: string;
  cardType: string;
  cardFamily: string;
  modelFamily: string;
  modelVersion: string;
  cardCategory: string;
  recommendedBetType: string;
  settledCards: number;
  wins: number;
  losses: number;
  pushes: number;
  pnlSum: number;
  hasPnl: boolean;
  segmentId: DecisionSegmentId;
  segmentLabel: string;
  decisionTier: 'PLAY' | 'LEAN';
};

export function buildResultsAggregation(
  actionableRows: ActionableSourceRow[],
  projectionTrackingRows: ProjectionTrackingRow[],
) {
  // WI-1140: pass canonical analytics scalars straight through to projection metrics.
  // Status/actionability signals remain payload-derived in query-layer, but the summary
  // math no longer needs a reconstructed pseudo-payload for covered families.
  const projectionSummaries = buildProjectionSummaries(
    projectionTrackingRows.map((row) => ({
      sport: row.sport,
      cardType: row.card_type,
      payload: null,
      actualResult: row.actual_result,
      periodToken: row.period_token,
      playerId: row.player_id,
      playerName: row.player_name,
      canonicalMarketKey: row.canonical_market_key,
      propType: row.prop_type,
      directionToken: row.direction_token,
      officialStatus: row.official_status,
      fallbackStatus: row.fallback_status,
      canonicalProjectionRaw: row.canonical_projection_raw,
      canonicalProjectionValue: row.canonical_projection_value,
      canonicalWinProbability: row.canonical_win_probability,
      canonicalEdgePp: row.canonical_edge_pp,
      canonicalConfidenceScore: row.canonical_confidence_score,
      canonicalConfidenceBand: row.canonical_confidence_band,
      canonicalTrackingRole: row.canonical_tracking_role,
      gameResultMetadata: safeJsonParse(row.game_result_metadata)
        .data as Record<string, unknown> | null,
    })),
  );
  const oddsBackedLedgerIds: string[] = [];
  const segmentMap = new Map<string, SegmentAccumulator>();

  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let settledCards = 0;
  let totalCards = 0;
  let totalPnlSum = 0;
  let hasTotalPnl = false;
  let totalClvPctSum = 0;
  let totalClvPctCount = 0;
  let invalidDecisionCount = 0;
  let missingDecisionV2Count = 0;

  for (const row of actionableRows) {
    if (!shouldTrackInResults(row.card_type)) {
      continue;
    }

    const parsed = safeJsonParse(row.payload_data);
    const payload = parsed.data as Record<string, unknown> | null;
    if (deriveResultCardMode(payload, row.card_type) !== 'ODDS_BACKED') {
      continue;
    }

    oddsBackedLedgerIds.push(row.id);

    const decisionResolution = resolveDecisionTierResolution(payload, {
      sport: row.sport,
      cardType: row.card_type,
      result: row.result,
    });
    const decisionTier = decisionResolution.tier;
    if (decisionTier === 'INVALID') {
      invalidDecisionCount += 1;
      if (decisionResolution.source === 'FAIL_CLOSED') {
        missingDecisionV2Count += 1;
      }
      continue;
    }
    if (decisionTier === 'PASS') {
      continue;
    }

    const decisionSegment = deriveDecisionSegment(decisionTier);
    const cardFamily = deriveCardFamily(row.sport, row.card_type);
    const modelFamily = deriveModelFamily(row.sport, row.card_type);
    const modelVersion = deriveModelVersion(row.sport, row.card_type);

    totalCards += 1;
    settledCards += 1;
    if (row.result === 'win') wins += 1;
    else if (row.result === 'loss') losses += 1;
    else if (row.result === 'push') pushes += 1;

    if (typeof row.pnl_units === 'number' && Number.isFinite(row.pnl_units)) {
      totalPnlSum += row.pnl_units;
      hasTotalPnl = true;
    }
    if (typeof row.clv_pct === 'number' && Number.isFinite(row.clv_pct)) {
      totalClvPctSum += row.clv_pct;
      totalClvPctCount += 1;
    }

    const cardCategory = deriveCardCategoryFromType(row.card_type);
    const recommendedBetType = row.recommended_bet_type || 'unknown';
    const key = [
      decisionSegment.id,
      row.sport,
      cardFamily,
      recommendedBetType,
    ].join('||');
    const existing = segmentMap.get(key);
    if (!existing) {
      segmentMap.set(key, {
        sport: row.sport,
        cardType: row.card_type,
        cardFamily,
        modelFamily,
        modelVersion,
        cardCategory,
        recommendedBetType,
        settledCards: 1,
        wins: row.result === 'win' ? 1 : 0,
        losses: row.result === 'loss' ? 1 : 0,
        pushes: row.result === 'push' ? 1 : 0,
        pnlSum:
          typeof row.pnl_units === 'number' && Number.isFinite(row.pnl_units)
            ? row.pnl_units
            : 0,
        hasPnl:
          typeof row.pnl_units === 'number' && Number.isFinite(row.pnl_units),
        segmentId: decisionSegment.id,
        segmentLabel: decisionSegment.label,
        decisionTier,
      });
    } else {
      existing.settledCards += 1;
      if (row.result === 'win') existing.wins += 1;
      else if (row.result === 'loss') existing.losses += 1;
      else if (row.result === 'push') existing.pushes += 1;

      if (typeof row.pnl_units === 'number' && Number.isFinite(row.pnl_units)) {
        existing.pnlSum += row.pnl_units;
        existing.hasPnl = true;
      }
    }
  }

  const segments = Array.from(segmentMap.values())
    .map((row) => ({
      sport: row.sport,
      cardType: row.cardType,
      cardFamily: row.cardFamily,
      modelFamily: row.modelFamily,
      modelVersion: row.modelVersion,
      cardCategory: row.cardCategory,
      recommendedBetType: row.recommendedBetType,
      settledCards: row.settledCards,
      wins: row.wins,
      losses: row.losses,
      pushes: row.pushes,
      totalPnlUnits: row.hasPnl ? row.pnlSum : null,
      segmentId: row.segmentId,
      segmentLabel: row.segmentLabel,
      decisionTier: row.decisionTier,
    }))
    .sort((a, b) => {
      if (a.segmentId !== b.segmentId) {
        return a.segmentId.localeCompare(b.segmentId);
      }
      if (a.sport !== b.sport) return a.sport.localeCompare(b.sport);
      if (a.cardFamily !== b.cardFamily) {
        return a.cardFamily.localeCompare(b.cardFamily);
      }
      return a.recommendedBetType.localeCompare(b.recommendedBetType);
    });

  const segmentFamilies = DECISION_SEGMENTS.map((segment) => ({
    segmentId: segment.id,
    segmentLabel: segment.label,
    settledCards: segments
      .filter((row) => row.segmentId === segment.id)
      .reduce((sum, row) => sum + row.settledCards, 0),
  }));

  const totalPnlUnits = hasTotalPnl ? totalPnlSum : null;
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;
  const avgPnl =
    totalPnlUnits !== null && settledCards > 0
      ? totalPnlUnits / settledCards
      : null;
  const avgClvPct =
    totalClvPctCount > 0 ? totalClvPctSum / totalClvPctCount : null;

  return {
    oddsBackedLedgerIds,
    projectionSummaries,
    segments,
    segmentFamilies,
    summary: {
      totalCards,
      settledCards,
      wins,
      losses,
      pushes,
      totalPnlUnits,
      winRate,
      avgPnl,
      avgClvPct,
    },
    diagnostics: {
      invalidDecisionCount,
      missingDecisionV2Count,
    },
  };
}

export function buildLedgerRows(ledger: LedgerRow[]) {
  return ledger.flatMap((row) => {
    if (!shouldTrackInResults(row.card_type)) {
      return [];
    }

    const parsed = safeJsonParse(row.payload_data);
    const payload = parsed.data as Record<string, unknown> | null;
    if (deriveResultCardMode(payload, row.card_type) !== 'ODDS_BACKED') {
      return [];
    }

    const cardFamily = deriveCardFamily(row.sport, row.card_type);
    const modelFamily = deriveModelFamily(row.sport, row.card_type);
    const tier =
      payload && typeof payload.tier === 'string' ? payload.tier : null;
    const decisionResolution = resolveDecisionTierResolution(payload, {
      sport: row.sport,
      cardType: row.card_type,
      result: row.result,
    });
    const decisionTier = decisionResolution.tier;
    const decisionLabel =
      decisionTier === 'PLAY'
        ? 'PLAY'
        : decisionTier === 'LEAN'
          ? 'SLIGHT EDGE'
          : null;
    const market =
      payload && typeof payload.recommended_bet_type === 'string'
        ? payload.recommended_bet_type
        : row.recommended_bet_type;
    let marketType = row.market_type;
    let selection = row.selection;
    let line = row.line ?? null;
    let marketKey = row.market_key;
    let lockedPrice =
      typeof row.locked_price === 'number' ? row.locked_price : null;

    const homeTeam =
      payload && typeof payload.home_team === 'string'
        ? payload.home_team
        : row.game_home_team;
    const awayTeam =
      payload && typeof payload.away_team === 'string'
        ? payload.away_team
        : row.game_away_team;

    if (
      (!marketType || !selection || marketKey == null || lockedPrice == null) &&
      payload &&
      typeof payload === 'object'
    ) {
      try {
        const derived = deriveLockedMarketContext(payload, {
          gameId: row.game_id,
          homeTeam,
          awayTeam,
          requirePrice: true,
          requireLineForMarket: true,
        });
        if (derived) {
          marketType = derived.marketType;
          selection = derived.selection;
          line = derived.line;
          marketKey = derived.marketKey;
          lockedPrice = derived.lockedPrice;
        }
      } catch {
        // Keep DB-backed values when payload contract cannot be derived.
      }
    }

    let prediction: string | null = selection ?? null;
    let marketSelectionLabel: string | null = null;
    if (marketType && selection) {
      try {
        marketSelectionLabel = formatMarketSelectionLabel(
          marketType,
          selection,
        );
        prediction = selection;
      } catch {
        marketSelectionLabel = null;
      }
    }

    const recType =
      payload &&
      typeof (
        payload.recommendation as Record<string, unknown> | null | undefined
      )?.['type'] === 'string'
        ? ((payload.recommendation as Record<string, unknown>)['type'] as string)
        : null;

    if (!prediction && payload && typeof payload.prediction === 'string') {
      prediction = payload.prediction;
    }

    if (!marketSelectionLabel) {
      if (recType === 'ML_HOME') marketSelectionLabel = 'ML/Home';
      else if (recType === 'ML_AWAY') marketSelectionLabel = 'ML/Away';
      else if (recType === 'SPREAD_HOME') {
        marketSelectionLabel = 'Spread/Home';
      } else if (recType === 'SPREAD_AWAY') {
        marketSelectionLabel = 'Spread/Away';
      } else if (recType === 'TOTAL_OVER') {
        marketSelectionLabel = 'Total/Over';
      } else if (recType === 'TOTAL_UNDER') {
        marketSelectionLabel = 'Total/Under';
      } else if (market && prediction) {
        marketSelectionLabel = `${String(market).toUpperCase()}/${prediction}`;
      }
    }

    if (
      lockedPrice == null &&
      payload &&
      payload.odds_context &&
      typeof payload.odds_context === 'object'
    ) {
      const oddsCtx = payload.odds_context as Record<string, unknown>;
      if (recType === 'ML_HOME') {
        lockedPrice =
          typeof oddsCtx.h2h_home === 'number' ? oddsCtx.h2h_home : null;
      } else if (recType === 'ML_AWAY') {
        lockedPrice =
          typeof oddsCtx.h2h_away === 'number' ? oddsCtx.h2h_away : null;
      } else if (recType === 'TOTAL_OVER') {
        lockedPrice =
          typeof oddsCtx.total_price_over === 'number'
            ? oddsCtx.total_price_over
            : null;
      } else if (recType === 'TOTAL_UNDER') {
        lockedPrice =
          typeof oddsCtx.total_price_under === 'number'
            ? oddsCtx.total_price_under
            : null;
      } else if (recType === 'SPREAD_HOME') {
        lockedPrice =
          typeof oddsCtx.spread_price_home === 'number'
            ? oddsCtx.spread_price_home
            : null;
      } else if (recType === 'SPREAD_AWAY') {
        lockedPrice =
          typeof oddsCtx.spread_price_away === 'number'
            ? oddsCtx.spread_price_away
            : null;
      } else if (prediction === 'HOME') {
        lockedPrice =
          typeof oddsCtx.h2h_home === 'number' ? oddsCtx.h2h_home : null;
      } else if (prediction === 'AWAY') {
        lockedPrice =
          typeof oddsCtx.h2h_away === 'number' ? oddsCtx.h2h_away : null;
      } else if (prediction === 'OVER') {
        lockedPrice =
          typeof oddsCtx.total_price_over === 'number'
            ? oddsCtx.total_price_over
            : null;
      } else if (prediction === 'UNDER') {
        lockedPrice =
          typeof oddsCtx.total_price_under === 'number'
            ? oddsCtx.total_price_under
            : null;
      }
    }

    let confidencePct: number | null = null;
    if (payload) {
      if (typeof payload.confidence_pct === 'number') {
        confidencePct = Math.round(payload.confidence_pct * 10) / 10;
      } else if (typeof payload.confidence === 'number') {
        confidencePct = Math.round(payload.confidence * 100 * 10) / 10;
      }
    }

    let projection1p: number | null = null;
    let projectionTotal: number | null = null;
    if (row.sport === 'NHL' && payload) {
      const model = payload.model as Record<string, unknown> | null | undefined;
      const fp = payload.first_period_model as
        | Record<string, unknown>
        | null
        | undefined;
      projectionTotal =
        typeof model?.expectedTotal === 'number'
          ? (model.expectedTotal as number)
          : null;
      projection1p =
        typeof model?.expected1pTotal === 'number'
          ? (model.expected1pTotal as number)
          : typeof fp?.projection_final === 'number'
            ? (fp.projection_final as number)
            : null;
    }

    const clv =
      row.clv_recorded_at !== null ||
      row.clv_closed_at !== null ||
      row.clv_odds_at_pick !== null ||
      row.clv_closing_odds !== null ||
      row.clv_pct !== null
        ? {
            oddsAtPick: row.clv_odds_at_pick,
            closingOdds: row.clv_closing_odds,
            clvPct: row.clv_pct,
            recordedAt: row.clv_recorded_at,
            closedAt: row.clv_closed_at,
          }
        : null;

    return [
      {
        id: row.id,
        gameId: row.game_id,
        sport: row.sport,
        cardType: row.card_type,
        cardFamily,
        modelFamily,
        result: row.result,
        pnlUnits: row.pnl_units,
        settledAt: row.settled_at,
        gameTimeUtc: row.game_time_utc,
        createdAt: row.created_at,
        prediction,
        tier,
        decisionTier: decisionTier !== 'PASS' ? decisionTier : null,
        decisionTierSource: decisionResolution.source,
        decisionLabel,
        market,
        marketType,
        selection,
        marketSelectionLabel,
        homeTeam,
        awayTeam,
        marketPeriodToken: row.market_period_token,
        line,
        marketKey,
        price: lockedPrice,
        confidencePct,
        payloadParseError: parsed.error,
        payloadMissing: parsed.missing || row.payload_id === null,
        projection1p,
        projectionTotal,
        clv,
      },
    ];
  });
}

function responseFilters(filters: ResultsRequestFilters) {
  return {
    sport: filters.sport,
    cardCategory: filters.cardCategory,
    minConfidence: filters.minConfidence,
    market: filters.market,
    includeOrphaned: filters.includeOrphaned,
    dedupe: filters.dedupe,
    includeProjectionSummaries: filters.includeProjectionSummaries,
    includeLedger: filters.includeLedger,
  };
}

function responseMeta(
  queryMeta: ResultsQueryData['meta'],
  filters: ResultsRequestFilters,
) {
  return {
    totalSettled: queryMeta.totalSettled,
    withPayloadSettled: queryMeta.withPayloadSettled,
    orphanedSettled: queryMeta.orphanedSettled,
    displayedFinal: queryMeta.displayedFinal,
    settledFinalDisplayed: queryMeta.settledFinalDisplayed,
    missingFinalDisplayed: queryMeta.missingFinalDisplayed,
    ...(filters.diagnosticsEnabled
      ? { filteredCount: queryMeta.filteredCount }
      : {}),
    returnedCount: queryMeta.returnedCount,
    includeOrphaned: filters.includeOrphaned,
    dedupe: filters.dedupe,
  };
}

export function buildEmptyResultsResponseBody(
  filters?: ResultsRequestFilters,
  meta?: ResultsQueryData['meta'],
) {
  return {
    success: true,
    data: {
      summary: {
        totalCards: 0,
        settledCards: 0,
        wins: 0,
        losses: 0,
        pushes: 0,
        totalPnlUnits: null,
        winRate: 0,
        avgPnl: null,
        avgClvPct: null,
      },
      segments: [],
      segmentFamilies: DECISION_SEGMENTS.map((segment) => ({
        segmentId: segment.id,
        segmentLabel: segment.label,
        settledCards: 0,
      })),
      projectionSummaries: [],
      ledger: [],
      ...(filters
        ? {
            filters: responseFilters(filters),
            meta: responseMeta(
              meta ?? {
                totalSettled: 0,
                withPayloadSettled: 0,
                orphanedSettled: 0,
                displayedFinal: 0,
                settledFinalDisplayed: 0,
                missingFinalDisplayed: 0,
                filteredCount: null,
                returnedCount: 0,
              },
              filters,
            ),
          }
        : {}),
    },
  };
}

export function buildResultsResponseBody(
  aggregation: ReturnType<typeof buildResultsAggregation>,
  ledgerRows: LedgerRow[],
  filters: ResultsRequestFilters,
  queryMeta: ResultsQueryData['meta'],
) {
  return {
    success: true,
    data: {
      summary: aggregation.summary,
      segments: aggregation.segments,
      segmentFamilies: aggregation.segmentFamilies,
      projectionSummaries: aggregation.projectionSummaries,
      ledger: buildLedgerRows(ledgerRows),
      filters: responseFilters(filters),
      meta: responseMeta(queryMeta, filters),
    },
  };
}

export function buildSettlementCoverageHeader(
  queryMeta: Pick<ResultsQueryData['meta'], 'settledFinalDisplayed' | 'displayedFinal'>,
): string {
  return `${queryMeta.settledFinalDisplayed}/${queryMeta.displayedFinal}`;
}
