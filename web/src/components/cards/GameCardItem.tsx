'use client';

import { useMemo, useSyncExternalStore } from 'react';
import {
  getCardDecisionModel,
} from '@/lib/game-card/decision';
import { getDisplayVerdict } from '@/lib/game-card/display-verdict';
import {
  hasEdgeVerification,
  hasProxyCap,
} from '@/lib/game-card/tags';
import type { DecisionModel, GameCard, GameData } from './types';
import {
  deriveOnePModelCallFromReasons,
  hasProjectedTotal,
  isFullGameTotalsCallPlay,
  resolvePrimaryTotalProjectionPlay,
} from './shared';
import {
  INFORMATIONAL_CODES,
  driverRowKey,
  fairProbToAmericanOdds,
  formatBookName,
  formatCanonicalBetText,
  formatConfidence,
  formatConsensusConfidence,
  formatContributorMarketLabel,
  formatDate,
  formatMarketLabel,
  formatOddsLine,
  formatProjectedSentence,
  formatReasonCode,
  formatSharpPriceStatus,
  formatSignedDecimal,
  getDirectionBadge,
  getMarketTypeBadge,
  getPolarityBadge,
  getTierBadge,
  impliedProbFromOdds,
  normalizeSelectionSide,
  resolvePlayLiveBook,
  resolvePlayLiveLine,
  resolvePlayLiveLineBook,
  resolvePlayLivePrice,
  resolveProjectedValueForMarketContext,
} from './game-card-helpers';

const driverVisibilityListeners = new Set<() => void>();

function subscribeDriverVisibility(listener: () => void) {
  driverVisibilityListeners.add(listener);
  return () => {
    driverVisibilityListeners.delete(listener);
  };
}

function emitDriverVisibilityChange() {
  for (const listener of driverVisibilityListeners) {
    listener();
  }
}

function readDriverVisibility(storageKey: string) {
  if (typeof window === 'undefined') return false;
  return window.sessionStorage.getItem(storageKey) === 'true';
}

export default function GameCardItem({
  card,
  originalGame,
}: {
  card: GameCard;
  originalGame: GameData;
}) {
  const decision = useMemo(
    () =>
      card.play?.decision_v2
        ? null
        : (getCardDecisionModel(
            card,
            originalGame?.odds || null,
          ) as DecisionModel),
    [card, originalGame],
  );
  const fallbackDecision: DecisionModel =
    decision ??
    ({
      status: 'PASS',
      primaryPlay: {
        pick: 'NO PLAY',
        market: 'NONE',
        status: 'PASS',
        direction: null,
        tier: null,
        confidence: null,
        source: 'none',
      },
      whyReason: 'NO_DECISION',
      riskCodes: [],
      topContributors: [],
      allDrivers: card.drivers,
      supportGrade: 'WEAK',
      passReasonCode: 'PASS_NO_EDGE',
      spreadCompare: null,
    } as DecisionModel);

  const displayPlay = card.play || {
    status: fallbackDecision.status,
    market: fallbackDecision.primaryPlay.market,
    pick: fallbackDecision.primaryPlay.pick,
    lean:
      fallbackDecision.primaryPlay.direction === 'HOME'
        ? card.homeTeam
        : fallbackDecision.primaryPlay.direction === 'AWAY'
          ? card.awayTeam
          : fallbackDecision.primaryPlay.direction || 'NO LEAN',
    side: fallbackDecision.primaryPlay.direction,
    truthStatus:
      fallbackDecision.primaryPlay.tier === 'BEST'
        ? 'STRONG'
        : fallbackDecision.primaryPlay.tier === 'SUPER'
          ? 'MEDIUM'
          : 'WEAK',
    truthStrength: fallbackDecision.primaryPlay.confidence ?? 0.5,
    conflict: 0,
    modelProb: undefined,
    impliedProb: undefined,
    edge: undefined,
    valueStatus: 'BAD',
    betAction:
      fallbackDecision.primaryPlay.pick === 'NO PLAY' ? 'NO_PLAY' : 'BET',
    priceFlags: [],
    updatedAt: card.updatedAt,
    whyCode: fallbackDecision.whyReason,
    whyText: fallbackDecision.whyReason.replace(/_/g, ' '),
    market_key: undefined,
    decision:
      fallbackDecision.status === 'FIRE'
        ? 'FIRE'
        : fallbackDecision.status === 'WATCH'
          ? 'WATCH'
          : 'PASS',
    classificationLabel:
      fallbackDecision.status === 'FIRE'
        ? 'PLAY'
        : fallbackDecision.status === 'WATCH'
          ? 'LEAN'
          : 'NONE',
    bet: fallbackDecision.primaryPlay.pick === 'NO PLAY' ? null : undefined,
    gates: [],
    decision_data: {
      status:
        fallbackDecision.status === 'FIRE'
          ? 'FIRE'
          : fallbackDecision.status === 'WATCH'
            ? 'WATCH'
            : 'PASS',
      truth:
        fallbackDecision.primaryPlay.tier === 'BEST'
          ? 'STRONG'
          : fallbackDecision.primaryPlay.tier === 'SUPER'
            ? 'MEDIUM'
            : 'WEAK',
      value_tier: 'BAD',
      edge_pct: null,
      edge_tier: 'BAD',
      coinflip: false,
      reason_code: fallbackDecision.whyReason,
    },
    transform_meta: {
      quality: 'BROKEN',
      missing_inputs: ['play'],
      placeholders_found: [],
    },
    classification:
      fallbackDecision.status === 'FIRE'
        ? 'BASE'
        : fallbackDecision.status === 'WATCH'
          ? 'LEAN'
          : 'PASS',
    action:
      fallbackDecision.status === 'FIRE'
        ? 'FIRE'
        : fallbackDecision.status === 'WATCH'
          ? 'HOLD'
          : 'PASS',
  };
  const quality = displayPlay.transform_meta?.quality ?? 'OK';
  const isBroken = quality === 'BROKEN';
  const isDegraded = quality === 'DEGRADED';
  const decisionV2 = displayPlay.decision_v2;
  const canonicalTruePlay = originalGame?.true_play;
  const totalProjectionFallback = resolvePrimaryTotalProjectionPlay(
    originalGame?.plays || [],
    card.sport,
  );
  const totalFallbackPlay =
    !canonicalTruePlay &&
    (displayPlay.market_type === 'TOTAL' ||
      displayPlay.market_type === 'TEAM_TOTAL')
      ? totalProjectionFallback &&
        (totalProjectionFallback.market_type === 'TOTAL' ||
          totalProjectionFallback.market_type === 'TEAM_TOTAL') &&
        (typeof totalProjectionFallback.model_prob === 'number' ||
          typeof (
            totalProjectionFallback as {
              decision_v2?: { fair_prob?: number };
            }
          ).decision_v2?.fair_prob === 'number')
        ? totalProjectionFallback
        : undefined
      : undefined;
  const totalFallbackDecision = (
    totalFallbackPlay as { decision_v2?: typeof decisionV2 }
  )?.decision_v2;
  const resolvedDecisionV2 =
    !decisionV2 && totalFallbackDecision
      ? totalFallbackDecision
      : decisionV2;
  const inferredDecision =
    resolvedDecisionV2?.official_status ??
    (displayPlay.decision === 'FIRE'
      ? 'PLAY'
      : displayPlay.decision === 'WATCH'
        ? 'LEAN'
        : displayPlay.action === 'FIRE'
          ? 'PLAY'
          : displayPlay.action === 'HOLD'
            ? 'LEAN'
            : 'PASS');
  const isEdgeVerification = hasEdgeVerification(card);
  const isProxyCapped = hasProxyCap(card);
  const hasCanonicalBet = Boolean(displayPlay.bet);
  const shouldPreserveNoBetLean = isEdgeVerification || isProxyCapped;
  const displayDecision =
    isBroken ||
    (!hasCanonicalBet &&
      inferredDecision !== 'PASS' &&
      !shouldPreserveNoBetLean)
      ? 'PASS'
      : inferredDecision;
  const canonicalGates = (displayPlay.gates ?? []).map((gate) => gate.code);
  const activeRiskCodes = Array.from(
    new Set(
      resolvedDecisionV2
        ? [
            ...canonicalGates,
            ...resolvedDecisionV2.watchdog_reason_codes,
            ...resolvedDecisionV2.price_reason_codes,
          ]
        : [...canonicalGates, ...fallbackDecision.riskCodes],
    ),
  ).filter((code) => !INFORMATIONAL_CODES.has(code));
  const livePrice = resolvePlayLivePrice(
    displayPlay.market_type ?? displayPlay.bet?.market_type?.toUpperCase(),
    displayPlay.selection?.side ?? displayPlay.bet?.side?.toUpperCase(),
    originalGame.odds,
  );
  const liveBook = resolvePlayLiveBook(
    displayPlay.market_type ?? displayPlay.bet?.market_type?.toUpperCase(),
    displayPlay.selection?.side ?? displayPlay.bet?.side?.toUpperCase(),
    originalGame.odds,
  );
  const liveLine = resolvePlayLiveLine(
    displayPlay.market_type ?? displayPlay.bet?.market_type?.toUpperCase(),
    displayPlay.selection?.side ?? displayPlay.bet?.side?.toUpperCase(),
    originalGame.odds,
  );
  const displayBetText = displayPlay.bet
    ? formatCanonicalBetText(
        liveLine !== undefined
          ? { ...displayPlay.bet, line: liveLine }
          : displayPlay.bet,
        card.homeTeam,
        card.awayTeam,
        livePrice,
      )
    : displayPlay.pick === 'NO PLAY'
      ? 'NO PLAY'
      : livePrice != null
        ? `${displayPlay.pick} (${livePrice > 0 ? '+' : ''}${livePrice})`
        : displayPlay.pick;
  const updatedTime = formatDate(displayPlay.updatedAt);
  const displayOddsTimestamp = originalGame.odds?.capturedAt
    ? formatDate(originalGame.odds.capturedAt)
    : displayPlay.bet?.as_of_iso
      ? formatDate(displayPlay.bet.as_of_iso)
      : updatedTime;
  const canRenderModelSummary = !isBroken && card.drivers.length > 0;
  const resolvedDecisionV2EdgePct =
    typeof resolvedDecisionV2?.edge_delta_pct === 'number'
      ? resolvedDecisionV2.edge_delta_pct
      : typeof resolvedDecisionV2?.edge_pct === 'number'
        ? resolvedDecisionV2.edge_pct
        : undefined;
  const effectiveEdgePct =
    typeof resolvedDecisionV2EdgePct === 'number'
      ? resolvedDecisionV2EdgePct
      : typeof displayPlay.decision_data?.edge_pct === 'number'
        ? displayPlay.decision_data.edge_pct
        : typeof displayPlay.edge === 'number'
          ? displayPlay.edge
          : undefined;
  const hasMarketSpecificEdge = typeof effectiveEdgePct === 'number';
  const primaryReasonCode =
    resolvedDecisionV2?.primary_reason_code ??
    displayPlay.pass_reason_code ??
    displayPlay.decision_data?.reason_code ??
    displayPlay.whyCode;
  const isNoEdgeAtPrice =
    primaryReasonCode === 'NO_EDGE_AT_PRICE' ||
    (hasMarketSpecificEdge && Math.abs(effectiveEdgePct) < 0.0005);
  const hasActionableEdge = hasMarketSpecificEdge && !isNoEdgeAtPrice;
  const marketType = displayPlay.market_type;
  const isSpreadLikeMarket =
    marketType === 'SPREAD' || marketType === 'PUCKLINE';
  const isTotalLikeMarket =
    marketType === 'TOTAL' || marketType === 'TEAM_TOTAL';
  const projectedMargin =
    typeof displayPlay.projectedMargin === 'number'
      ? displayPlay.projectedMargin
      : undefined;
  const projectedSpreadHome =
    typeof projectedMargin === 'number' ? -1 * projectedMargin : undefined;
  const nhlDecisionProjectionPlay =
    card.sport === 'NHL'
      ? originalGame.plays.find(
          (play) => isFullGameTotalsCallPlay(play) && hasProjectedTotal(play),
        )
      : undefined;
  const projectedTotal =
    card.sport === 'NHL' &&
    typeof nhlDecisionProjectionPlay?.projectedTotal === 'number'
      ? nhlDecisionProjectionPlay.projectedTotal
      : typeof displayPlay.projectedTotal === 'number'
        ? displayPlay.projectedTotal
        : typeof totalFallbackPlay?.projectedTotal === 'number'
          ? totalFallbackPlay.projectedTotal
          : undefined;
  const onePeriodTotalsPlay = originalGame.plays.find(
    (p) => p.cardType === 'nhl-pace-1p',
  );
  const projectedTotal1p =
    typeof onePeriodTotalsPlay?.projectedTotal === 'number'
      ? onePeriodTotalsPlay.projectedTotal
      : undefined;
  const reasonCodes1p = Array.isArray(onePeriodTotalsPlay?.reason_codes)
    ? onePeriodTotalsPlay.reason_codes
    : [];
  const onePModelCall =
    onePeriodTotalsPlay?.one_p_model_call ??
    deriveOnePModelCallFromReasons(
      reasonCodes1p,
      onePeriodTotalsPlay?.prediction,
    );
  const goalieUncertain1p = reasonCodes1p.includes('NHL_1P_GOALIE_UNCERTAIN');
  const goalieContextNames = [
    onePeriodTotalsPlay?.goalie_away_name,
    onePeriodTotalsPlay?.goalie_home_name,
  ].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const goalieContextStatuses = [
    onePeriodTotalsPlay?.goalie_away_status,
    onePeriodTotalsPlay?.goalie_home_status,
  ].filter(
    (
      value,
    ): value is NonNullable<GameData['plays'][number]['goalie_home_status']> =>
      typeof value === 'string' && value.length > 0,
  );
  const onePeriodMarketLine =
    typeof onePeriodTotalsPlay?.line === 'number'
      ? onePeriodTotalsPlay.line
      : 1.5;
  const edgePoints1p =
    typeof onePeriodTotalsPlay?.edge === 'number'
      ? onePeriodTotalsPlay.edge
      : typeof projectedTotal1p === 'number' &&
          typeof onePeriodMarketLine === 'number'
        ? Number((projectedTotal1p - onePeriodMarketLine).toFixed(2))
        : undefined;
  const resolvedModelProb =
    typeof displayPlay.modelProb === 'number'
      ? displayPlay.modelProb
      : typeof resolvedDecisionV2?.fair_prob === 'number'
        ? resolvedDecisionV2.fair_prob
        : typeof totalFallbackPlay?.model_prob === 'number'
          ? totalFallbackPlay.model_prob
          : undefined;
  const resolvedImpliedProb =
    typeof displayPlay.impliedProb === 'number'
      ? displayPlay.impliedProb
      : typeof resolvedDecisionV2?.implied_prob === 'number'
        ? resolvedDecisionV2.implied_prob
        : !decisionV2 && livePrice != null
          ? impliedProbFromOdds(livePrice)
          : undefined;
  const mlBreakEvenPrice =
    typeof resolvedModelProb === 'number'
      ? fairProbToAmericanOdds(resolvedModelProb)
      : undefined;
  const projectedTeamTotal =
    typeof displayPlay.projectedTeamTotal === 'number'
      ? displayPlay.projectedTeamTotal
      : undefined;
  const projectedScoreHome =
    typeof displayPlay.projectedScoreHome === 'number'
      ? displayPlay.projectedScoreHome
      : undefined;
  const projectedScoreAway =
    typeof displayPlay.projectedScoreAway === 'number'
      ? displayPlay.projectedScoreAway
      : undefined;
  const bakedLine =
    typeof displayPlay.line === 'number' ? displayPlay.line : undefined;
  const spreadSelectionSide = (
    displayPlay.selection?.side ?? displayPlay.bet?.side
  )?.toUpperCase();
  const displaySelectionSide = normalizeSelectionSide(
    displayPlay.selection?.side ?? displayPlay.bet?.side ?? displayPlay.side,
  );
  const isAwaySpread = spreadSelectionSide === 'AWAY';
  const consensusSpreadHomeLine =
    isSpreadLikeMarket &&
    typeof originalGame.odds?.spreadConsensusLine === 'number'
      ? originalGame.odds.spreadConsensusLine
      : undefined;
  const liveSpreadLine =
    consensusSpreadHomeLine !== undefined
      ? isAwaySpread
        ? -consensusSpreadHomeLine
        : consensusSpreadHomeLine
      : isSpreadLikeMarket && typeof originalGame.odds?.spreadHome === 'number'
        ? isAwaySpread
          ? -originalGame.odds.spreadHome
          : originalGame.odds.spreadHome
        : undefined;
  const bestSpreadBook =
    isSpreadLikeMarket
      ? resolvePlayLiveLineBook(
          marketType,
          displaySelectionSide,
          originalGame.odds,
        )
      : null;
  const bestSpreadPriceBook =
    isSpreadLikeMarket
      ? resolvePlayLiveBook(marketType, displaySelectionSide, originalGame.odds)
      : null;
  const bestTotalBook =
    isTotalLikeMarket
      ? resolvePlayLiveLineBook(marketType, displaySelectionSide, originalGame.odds)
      : null;
  const bestTotalPriceBook =
    isTotalLikeMarket
      ? resolvePlayLiveBook(marketType, displaySelectionSide, originalGame.odds)
      : null;
  const spreadSoftLineFlag =
    isSpreadLikeMarket &&
    originalGame.odds?.spreadIsMispriced === true &&
    originalGame.odds?.spreadMispriceType === 'SOFT_LINE';
  const spreadReviewFlag =
    isSpreadLikeMarket && originalGame.odds?.spreadReviewFlag === true;
  const totalSoftLineFlag =
    isTotalLikeMarket &&
    originalGame.odds?.totalIsMispriced === true &&
    originalGame.odds?.totalMispriceType === 'SOFT_LINE';
  const totalReviewFlag =
    isTotalLikeMarket && originalGame.odds?.totalReviewFlag === true;
  const usingConsensusSpreadLine =
    isSpreadLikeMarket && consensusSpreadHomeLine !== undefined;
  const spreadConsensusConfidenceLabel =
    usingConsensusSpreadLine
      ? formatConsensusConfidence(
          originalGame.odds?.spreadConsensusConfidence ?? null,
        )
      : null;
  const marketLine =
    isTotalLikeMarket && typeof originalGame.odds?.total === 'number'
      ? originalGame.odds.total
      : liveSpreadLine ?? bakedLine;
  const lineMoved =
    isTotalLikeMarket &&
    typeof bakedLine === 'number' &&
    typeof originalGame.odds?.total === 'number' &&
    Math.abs(originalGame.odds.total - bakedLine) >= 0.5;
  const projectedLineValue =
    typeof projectedTeamTotal === 'number'
      ? projectedTeamTotal
      : typeof projectedTotal === 'number'
        ? projectedTotal
        : undefined;
  const edgePoints =
    card.sport === 'NHL' && isTotalLikeMarket
      ? typeof projectedLineValue === 'number' && typeof marketLine === 'number'
        ? Number((projectedLineValue - marketLine).toFixed(2))
        : undefined
      : typeof displayPlay.edgePoints === 'number'
        ? displayPlay.edgePoints
        : typeof projectedLineValue === 'number' && typeof marketLine === 'number'
          ? Number((projectedLineValue - marketLine).toFixed(2))
          : undefined;
  const edgeVsConsensusPts =
    typeof displayPlay.edgeVsConsensusPts === 'number'
      ? displayPlay.edgeVsConsensusPts
      : undefined;
  const edgeVsBestAvailablePts =
    typeof displayPlay.edgeVsBestAvailablePts === 'number'
      ? displayPlay.edgeVsBestAvailablePts
      : undefined;
  const hasProjectionComparison =
    typeof edgeVsConsensusPts === 'number' ||
    typeof edgeVsBestAvailablePts === 'number';
  const isMoneylineMarket = marketType === 'MONEYLINE';
  const hasEdgeMathContext =
    typeof resolvedModelProb === 'number' &&
    typeof resolvedImpliedProb === 'number' &&
    hasMarketSpecificEdge &&
    primaryReasonCode !== 'EXACT_WAGER_MISMATCH';
  const hasSpreadContext =
    isSpreadLikeMarket &&
    (typeof projectedMargin === 'number' ||
      typeof edgePoints === 'number' ||
      typeof marketLine === 'number');
  const shouldRenderSpreadContext = hasSpreadContext;
  const hasTotalContext =
    isTotalLikeMarket &&
    (typeof projectedTotal === 'number' ||
      typeof projectedTeamTotal === 'number' ||
      typeof edgePoints === 'number' ||
      typeof marketLine === 'number');
  const hasOnePeriodTotalContext =
    typeof projectedTotal1p === 'number' ||
    typeof edgePoints1p === 'number' ||
    typeof onePModelCall === 'string';
  const hasMlContext =
    isMoneylineMarket &&
    (hasEdgeMathContext ||
      typeof livePrice === 'number' ||
      typeof mlBreakEvenPrice === 'number');
  const sharpVerdict = decisionV2?.sharp_price_status;
  const modelLean = decisionV2?.direction;
  const isCoinflip = Boolean(
    canRenderModelSummary && displayPlay.decision_data?.coinflip,
  );
  const isCoinflipHighEdge =
    isCoinflip && hasActionableEdge && effectiveEdgePct > 0.05;
  const isCoinflipLowEdge =
    isCoinflip && (!hasActionableEdge || effectiveEdgePct <= 0.05);
  const storageKey = `cheddar-card-show-drivers:${card.id}`;
  const showAllDrivers = useSyncExternalStore(
    subscribeDriverVisibility,
    () => readDriverVisibility(storageKey),
    () => false,
  );

  const toggleDrivers = () => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem(storageKey, String(!showAllDrivers));
    emitDriverVisibilityChange();
  };

  const gameTime = formatDate(card.startTime);
  const displayStatus =
    originalGame.display_status ??
    (originalGame.lifecycle_mode === 'active' ? 'ACTIVE' : 'SCHEDULED');
  const showActiveBadge = displayStatus === 'ACTIVE';
  const hasVisibleBetOdds = Boolean(
    displayPlay.bet &&
      Number.isFinite(
        typeof livePrice === 'number' ? livePrice : displayPlay.bet.odds_american,
      ),
  );
  const isProjectionOnlyCard =
    displayPlay.market_type === 'FIRST_PERIOD' ||
    displayPlay.market_type === 'INFO' ||
    displayPlay.market_type === 'PROP';
  const isActionableDecision =
    displayDecision === 'PLAY' || displayDecision === 'LEAN';
  const shouldDemoteForMissingOdds =
    isActionableDecision && !hasVisibleBetOdds && !isProjectionOnlyCard;
  const visibleDecision = shouldDemoteForMissingOdds ? 'PASS' : displayDecision;
  const visibleVerdict = getDisplayVerdict(visibleDecision);
  const visibleStatusLabel = visibleVerdict ? visibleVerdict.label : visibleDecision;
  const visibleBetText = shouldDemoteForMissingOdds ? 'NO PLAY' : displayBetText;
  const projectedValue = resolveProjectedValueForMarketContext({
    marketType,
    selectionSide: displaySelectionSide,
    projectedMargin,
    projectedTotal,
    projectedTeamTotal,
  });
  const projectedSentence =
    isSpreadLikeMarket || isTotalLikeMarket
      ? formatProjectedSentence(
          projectedValue,
          marketLine,
          primaryReasonCode,
          effectiveEdgePct,
          marketType,
          projectedMargin,
        )
      : null;
  const contextLine1 =
    projectedSentence ||
    (hasActionableEdge && primaryReasonCode !== 'EXACT_WAGER_MISMATCH'
      ? `Edge: ${(effectiveEdgePct * 100).toFixed(1)}% | Tier: ${
          decisionV2?.play_tier ??
          displayPlay.decision_data?.edge_tier ??
          displayPlay.valueStatus
        }`
      : isNoEdgeAtPrice
        ? `No edge at current price | Tier: ${
            decisionV2?.play_tier ??
            displayPlay.decision_data?.edge_tier ??
            displayPlay.valueStatus
          }`
        : 'No market-specific edge available');
  const baseDriverLine =
    primaryReasonCode && !INFORMATIONAL_CODES.has(primaryReasonCode)
      ? formatReasonCode(primaryReasonCode)
      : canRenderModelSummary
        ? (() => {
            const whyCode = displayPlay.whyCode;
            if (whyCode && INFORMATIONAL_CODES.has(whyCode)) {
              return displayPlay.whyText || null;
            }
            return displayPlay.whyText || (whyCode ? formatReasonCode(whyCode) : null);
          })()
        : 'Analysis unavailable (drivers missing).';
  const contextLine2 = baseDriverLine
    ? `Driver: ${baseDriverLine}`
    : activeRiskCodes.length > 0
      ? `Risk: ${formatReasonCode(activeRiskCodes[0])}`
      : null;
  const showMathDetails =
    canRenderModelSummary &&
    (shouldRenderSpreadContext ||
      hasTotalContext ||
      hasOnePeriodTotalContext ||
      hasMlContext ||
      hasEdgeMathContext);
  const hasDriverDetails = decisionV2
    ? decisionV2.driver_reasons.length > 0
    : fallbackDecision.topContributors.length > 0;
  const hasMissingInputDetails =
    (!decisionV2 &&
      (isBroken || isDegraded) &&
      (displayPlay.transform_meta?.missing_inputs?.length ?? 0) > 0) ||
    Boolean(decisionV2 && decisionV2.missing_data.missing_fields.length > 0);
  const showPassDetail = visibleDecision === 'PASS' && Boolean(decisionV2);
  const showAdvancedRisk =
    activeRiskCodes.length > 0 ||
    isCoinflipHighEdge ||
    isCoinflipLowEdge ||
    fallbackDecision.spreadCompare !== undefined;
  const hasDetails =
    showMathDetails ||
    hasDriverDetails ||
    hasMissingInputDetails ||
    showPassDetail ||
    showAdvancedRisk ||
    Boolean(displayOddsTimestamp) ||
    Boolean(updatedTime);

  return (
    <div
      key={card.id}
      className="border border-white/10 rounded-lg p-4 bg-surface/30 hover:bg-surface/50 transition"
    >
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h3 className="font-semibold text-lg">
              {card.awayTeam} @ {card.homeTeam}
            </h3>
            <span className="px-2 py-1 text-xs font-semibold bg-white/10 text-cloud/80 rounded border border-white/20">
              {card.sport}
            </span>
            {showActiveBadge && (
              <span className="px-2 py-1 text-xs font-semibold bg-blue-600/40 text-blue-200 rounded border border-blue-600/60">
                {displayStatus}
              </span>
            )}
          </div>
          <div className="text-sm text-cloud/70">
            <span>{gameTime}</span>
          </div>
          {originalGame.odds && (
            <p className="mt-1 text-xs text-cloud/55 font-mono">
              ML: {formatOddsLine(originalGame.odds.h2hHome)} /{' '}
              {formatOddsLine(originalGame.odds.h2hAway)}{' '}
              {typeof originalGame.odds.total === 'number'
                ? `| O/U ${originalGame.odds.total}`
                : ''}
            </p>
          )}
        </div>
      </div>

      <div className="border-t border-white/5 mt-3 pt-3 space-y-3">
        <div className="rounded-md border border-white/10 bg-white/5 p-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              {getMarketTypeBadge(
                displayPlay.bet?.market_type,
                displayPlay.market,
              )}
              <span
                className={`px-2 py-1 text-xs font-bold rounded border ${
                  visibleDecision === 'PLAY'
                    ? 'bg-green-700/50 text-green-200 border-green-600/60'
                    : visibleDecision === 'LEAN'
                      ? 'bg-yellow-700/50 text-yellow-200 border-yellow-600/60'
                      : 'bg-slate-700/50 text-slate-200 border-slate-600/60'
                }`}
              >
                {visibleStatusLabel}
              </span>
              {isDegraded && (
                <span className="px-2 py-0.5 text-xs font-semibold rounded border bg-amber-700/30 text-amber-200 border-amber-600/50">
                  Degraded
                </span>
              )}
              {isBroken && (
                <span className="px-2 py-0.5 text-xs font-semibold rounded border bg-red-700/30 text-red-200 border-red-600/50">
                  Data issue
                </span>
              )}
            </div>
          </div>
          <p className="mt-2 text-xl font-bold text-cloud">{visibleBetText}</p>
          {liveBook && visibleBetText !== 'NO PLAY' && (
            <p className="mt-0.5 text-xs text-cloud/45">
              via {formatBookName(liveBook)}
            </p>
          )}
          <p className="mt-1 text-xs text-cloud/65">{contextLine1}</p>
        </div>

        {contextLine2 && (
          <div className="rounded-md border border-white/10 bg-white/5 p-3">
            <p className="text-sm text-cloud/80">{contextLine2}</p>
          </div>
        )}

        {hasDetails && (
          <details className="rounded-md border border-white/10 bg-white/5 p-3">
            <summary className="cursor-pointer text-xs uppercase tracking-widest text-cloud/45 font-semibold select-none">
              Details
            </summary>
            <div className="mt-2 space-y-3">
              {showMathDetails && (
                <div className="space-y-1 text-xs font-mono text-cloud/65">
                  {shouldRenderSpreadContext && (
                    <div className="space-y-1">
                      <p>
                        Model spread (home):{' '}
                        <span className="text-cloud/90 font-bold">
                          {typeof projectedSpreadHome === 'number'
                            ? formatSignedDecimal(projectedSpreadHome)
                            : 'N/A'}
                        </span>{' '}
                        | Market line:{' '}
                        <span className="text-cloud/90 font-bold">
                          {typeof marketLine === 'number'
                            ? formatSignedDecimal(marketLine)
                            : 'N/A'}
                        </span>
                        {spreadConsensusConfidenceLabel && (
                          <span className="text-cloud/45 ml-1">
                            [{spreadConsensusConfidenceLabel} consensus]
                          </span>
                        )}
                        {bestSpreadBook && (
                          <span className="text-cloud/45 ml-1">
                            {usingConsensusSpreadLine
                              ? `best line ${formatBookName(bestSpreadBook)}`
                              : `(${formatBookName(bestSpreadBook)})`}
                          </span>
                        )}{' '}
                        {bestSpreadPriceBook && (
                          <span className="text-cloud/45 ml-1">
                            [price {formatBookName(bestSpreadPriceBook)}]
                          </span>
                        )}{' '}
                        {hasProjectionComparison ? (
                          <>
                            {' '}| Edge vs market:{' '}
                            <span className="text-cloud/90 font-bold">
                              {typeof edgeVsConsensusPts === 'number'
                                ? `${formatSignedDecimal(edgeVsConsensusPts)} pts`
                                : 'N/A'}
                            </span>
                            {' '}| Edge at best book:{' '}
                            <span className="text-cloud/90 font-bold">
                              {typeof edgeVsBestAvailablePts === 'number'
                                ? `${formatSignedDecimal(edgeVsBestAvailablePts)} pts`
                                : 'N/A'}
                            </span>
                            {bestSpreadBook && (
                              <span className="text-cloud/45 ml-1">
                                ({formatBookName(bestSpreadBook)})
                              </span>
                            )}
                          </>
                        ) : (
                          <>
                            {' '}| Delta:{' '}
                            <span className="text-cloud/90 font-bold">
                              {typeof edgePoints === 'number'
                                ? `${formatSignedDecimal(edgePoints)} pts`
                                : 'N/A'}
                            </span>
                          </>
                        )}
                      </p>
                      {spreadSoftLineFlag && (
                        <p className="text-amber-300">
                          Soft line at{' '}
                          {formatBookName(
                            originalGame.odds?.spreadOutlierBook ?? 'unknown',
                          )}
                          {typeof originalGame.odds?.spreadOutlierDelta === 'number'
                            ? ` (${formatSignedDecimal(originalGame.odds.spreadOutlierDelta)} vs consensus)`
                            : ''}
                        </p>
                      )}
                      {!spreadSoftLineFlag && spreadReviewFlag && (
                        <p className="text-cloud/45">Market disagreement</p>
                      )}
                    </div>
                  )}
                  {hasTotalContext && (
                    <div className="space-y-1">
                      <p>
                        Model total:{' '}
                        <span className="text-cloud/90 font-bold">
                          {typeof projectedTeamTotal === 'number'
                            ? projectedTeamTotal.toFixed(1)
                            : typeof projectedTotal === 'number'
                              ? projectedTotal.toFixed(1)
                              : 'N/A'}
                        </span>{' '}
                        | Market line:{' '}
                        <span className="text-cloud/90 font-bold">
                          {typeof marketLine === 'number'
                            ? marketLine.toFixed(1)
                            : 'N/A'}
                        </span>{' '}
                        {bestTotalBook && (
                          <span className="text-cloud/45 ml-1">
                            [line {formatBookName(bestTotalBook)}]
                          </span>
                        )}{' '}
                        {bestTotalPriceBook && (
                          <span className="text-cloud/45 ml-1">
                            [price {formatBookName(bestTotalPriceBook)}]
                          </span>
                        )}{' '}
                        {hasProjectionComparison ? (
                          <>
                            {' '}| Edge vs market:{' '}
                            <span className="text-cloud/90 font-bold">
                              {typeof edgeVsConsensusPts === 'number'
                                ? `${formatSignedDecimal(edgeVsConsensusPts)} pts`
                                : 'N/A'}
                            </span>
                            {' '}| Edge at best book:{' '}
                            <span className="text-cloud/90 font-bold">
                              {typeof edgeVsBestAvailablePts === 'number'
                                ? `${formatSignedDecimal(edgeVsBestAvailablePts)} pts`
                                : 'N/A'}
                            </span>
                            {bestTotalBook && (
                              <span className="text-cloud/45 ml-1">
                                ({formatBookName(bestTotalBook)})
                              </span>
                            )}
                          </>
                        ) : (
                          <>
                            {' '}| Delta:{' '}
                            <span className="text-cloud/90 font-bold">
                              {typeof edgePoints === 'number'
                                ? `${formatSignedDecimal(edgePoints)} pts`
                                : 'N/A'}
                            </span>
                          </>
                        )}
                      </p>
                      {totalSoftLineFlag && (
                        <p className="text-amber-300">
                          Soft line at{' '}
                          {formatBookName(
                            originalGame.odds?.totalOutlierBook ?? 'unknown',
                          )}
                          {typeof originalGame.odds?.totalOutlierDelta === 'number'
                            ? ` (${formatSignedDecimal(originalGame.odds.totalOutlierDelta)} vs consensus)`
                            : ''}
                        </p>
                      )}
                      {!totalSoftLineFlag && totalReviewFlag && (
                        <p className="text-cloud/45">Market disagreement</p>
                      )}
                    </div>
                  )}
                  {hasMlContext && (
                    <p>
                      Fair:{' '}
                      <span className="text-cloud/90 font-bold">
                        {typeof mlBreakEvenPrice === 'number'
                          ? `${mlBreakEvenPrice > 0 ? '+' : ''}${mlBreakEvenPrice}`
                          : 'N/A'}
                      </span>{' '}
                      vs{' '}
                      <span className="text-cloud/90 font-bold">
                        {typeof livePrice === 'number'
                          ? `${livePrice > 0 ? '+' : ''}${Math.trunc(livePrice)}`
                          : 'N/A'}
                      </span>
                    </p>
                  )}
                  {hasOnePeriodTotalContext && (
                    <div className="space-y-1">
                      <p>
                        1P projection:{' '}
                        <span className="text-cloud/90 font-bold">
                          {typeof projectedTotal1p === 'number'
                            ? projectedTotal1p.toFixed(2)
                            : 'N/A'}
                        </span>{' '}
                        | 1P call:{' '}
                        <span className="text-cloud/90 font-bold">
                          {onePModelCall ?? 'PASS'}
                        </span>
                      </p>
                      <p>
                        Goalie context:{' '}
                        <span className="text-cloud/90 font-bold">
                          {goalieContextNames.length > 0
                            ? goalieContextNames.join(' / ')
                            : goalieUncertain1p
                              ? 'Uncertain (PASS-capped)'
                              : 'Stable'}
                        </span>
                        {goalieContextStatuses.length > 0 && (
                          <>
                            {' '}
                            | Status:{' '}
                            <span className="text-cloud/90 font-bold">
                              {goalieContextStatuses.join(' / ')}
                            </span>
                          </>
                        )}
                      </p>
                    </div>
                  )}
                  {typeof projectedScoreHome === 'number' &&
                    typeof projectedScoreAway === 'number' && (
                      <p>
                        Projected score: {card.awayTeam} {projectedScoreAway.toFixed(1)} -{' '}
                        {card.homeTeam} {projectedScoreHome.toFixed(1)}
                      </p>
                    )}
                  {lineMoved && typeof bakedLine === 'number' && (
                    <p className="text-amber-300">
                      Line moved since model run (was {bakedLine.toFixed(1)})
                    </p>
                  )}
                  {isEdgeVerification && hasEdgeMathContext && (
                    <p className="text-amber-300">
                      Edge verification required on non-total market.
                    </p>
                  )}
                </div>
              )}

              {showPassDetail && (
                <div className="text-xs text-cloud/70 space-y-1">
                  <p>
                    Model direction:{' '}
                    <span className="text-cloud/90 font-semibold">
                      {modelLean ?? 'NONE'}
                    </span>
                  </p>
                  <p>
                    Pricing Status:{' '}
                    <span className="text-cloud/90 font-semibold">
                      {formatSharpPriceStatus(sharpVerdict)}
                    </span>
                  </p>
                  <p>
                    Reason:{' '}
                    <span className="text-cloud/90 font-semibold">
                      {formatReasonCode(primaryReasonCode)}
                    </span>
                  </p>
                </div>
              )}

              {hasDriverDetails && (
                <div className="space-y-2">
                  {decisionV2 ? (
                    decisionV2.driver_reasons.map((reason, index) => (
                      <div
                        key={`${card.id}-indicator-${index}`}
                        className="bg-white/5 rounded-md px-3 py-2"
                      >
                        <p className="text-xs text-cloud/55 leading-snug">{reason}</p>
                      </div>
                    ))
                  ) : (
                    fallbackDecision.topContributors.map(({ driver, polarity }) => (
                      <div
                        key={driverRowKey(driver)}
                        className="bg-white/5 rounded-md px-3 py-2"
                      >
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          {getPolarityBadge(polarity)}
                          {getTierBadge(driver.tier)}
                          {getDirectionBadge(driver.direction)}
                          <span className="text-xs font-mono text-cloud/60">
                            {formatConfidence(driver.confidence)}
                          </span>
                          <span className="text-xs font-mono text-cloud/60">
                            {formatContributorMarketLabel(
                              driver.market,
                              displayPlay.market,
                            )}
                          </span>
                          <span className="text-xs text-cloud/70 font-medium">
                            {driver.cardTitle}
                          </span>
                        </div>
                        <p className="text-xs text-cloud/50 leading-snug">{driver.note}</p>
                      </div>
                    ))
                  )}
                </div>
              )}

              {showAdvancedRisk && (
                <div className="space-y-2">
                  {activeRiskCodes.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {activeRiskCodes.map((code) => (
                        <span
                          key={code}
                          className="px-2 py-0.5 text-xs font-semibold rounded border bg-amber-700/30 text-amber-200 border-amber-600/50"
                        >
                          {formatReasonCode(code)}
                        </span>
                      ))}
                    </div>
                  )}
                  {isCoinflipHighEdge && (
                    <p className="text-xs text-blue-200/80">
                      Coinflip inefficiency: model fair probability diverges from current
                      market pricing.
                    </p>
                  )}
                  {isCoinflipLowEdge && (
                    <p className="text-xs text-cloud/55">
                      Near-even matchup with minimal edge; variance can flip outcomes.
                    </p>
                  )}
                  {fallbackDecision.spreadCompare && (
                    <p className="text-xs font-mono text-cloud/65">
                      Spread compare: proj{' '}
                      {fallbackDecision.spreadCompare.projectedSpread !== null
                        ? formatSignedDecimal(fallbackDecision.spreadCompare.projectedSpread)
                        : 'N/A'}{' '}
                      vs market{' '}
                      {fallbackDecision.spreadCompare.marketLine !== null
                        ? formatSignedDecimal(fallbackDecision.spreadCompare.marketLine)
                        : 'N/A'}
                    </p>
                  )}
                  {activeRiskCodes.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={toggleDrivers}
                        className="text-xs text-cloud/60 hover:text-cloud underline underline-offset-4"
                      >
                        {showAllDrivers ? 'Hide all drivers' : 'Show all drivers'}
                      </button>
                      {showAllDrivers && (
                        <div className="space-y-2">
                          {fallbackDecision.allDrivers.map((driver) => (
                            <div
                              key={`all-${driverRowKey(driver)}`}
                              className="bg-white/5 rounded-md px-3 py-2"
                            >
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                {getTierBadge(driver.tier)}
                                {getDirectionBadge(driver.direction)}
                                <span className="text-xs font-mono text-cloud/60">
                                  {formatMarketLabel(driver.market)}
                                </span>
                                <span className="text-xs font-mono text-cloud/60">
                                  {formatConfidence(driver.confidence)}
                                </span>
                                <span className="text-xs text-cloud/70 font-medium">
                                  {driver.cardTitle}
                                </span>
                              </div>
                              <p className="text-xs text-cloud/50 leading-snug">
                                {driver.note}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {hasMissingInputDetails && (
                <p className="text-xs text-amber-200/90">
                  Missing inputs:{' '}
                  {decisionV2
                    ? decisionV2.missing_data.missing_fields.join(', ')
                    : displayPlay.transform_meta?.missing_inputs.join(', ')}
                </p>
              )}

              <p className="text-xs text-cloud/45">
                Odds updated {displayOddsTimestamp} | Card updated {updatedTime}
              </p>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
