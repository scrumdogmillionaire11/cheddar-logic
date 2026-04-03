/**
 * PropGameCard Component
 *
 * Displays a game with all player prop projections listed as rows
 * Designed for player props view - shows multiple plays per game
 */

import type { PropGameCard, PropPlayRow } from '@/lib/types/game-card';
import { useState } from 'react';

interface PropGameCardProps {
  card: PropGameCard;
}

const formatTime = (isoString: string) => {
  const date = new Date(isoString);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  }).format(date);
};

const formatOdds = (americanOdds: number) => {
  return americanOdds > 0 ? `+${americanOdds}` : String(americanOdds);
};

const formatBookName = (book: string | null | undefined): string => {
  if (!book) return '';
  const names: Record<string, string> = {
    betmgm: 'BetMGM',
    draftkings: 'DraftKings',
    fanduel: 'FanDuel',
    williamhill_us: 'Caesars',
    espnbet: 'ESPN Bet',
    fliff: 'Fliff',
    pinnacle: 'Pinnacle',
    fanatics: 'Fanatics',
    hardrockbet: 'Hard Rock',
  };
  return names[book] ?? book;
};

const formatNumber = (value: number | null | undefined, digits = 1) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toFixed(digits);
};

const formatPercent = (value: number | null | undefined, digits = 1) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
};

const formatSignedNumber = (value: number | null | undefined, digits = 1) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
};

const getPropUnits = (propType: string | null | undefined) => {
  const normalized = (propType || '').toLowerCase();
  if (normalized.includes('blocked shot')) {
    return { singular: 'block', plural: 'blocks' };
  }
  if (normalized.includes('strikeout')) {
    return { singular: 'strikeout', plural: 'strikeouts' };
  }
  if (normalized.includes('rebound')) {
    return { singular: 'rebound', plural: 'rebounds' };
  }
  if (normalized.includes('assist')) {
    return { singular: 'assist', plural: 'assists' };
  }
  if (normalized.includes('point')) {
    return { singular: 'point', plural: 'points' };
  }
  return { singular: 'shot', plural: 'shots' };
};

const getAverage = (values?: number[]) => {
  if (!values || values.length === 0) return null;
  const sum = values.reduce((acc, val) => acc + val, 0);
  return sum / values.length;
};

const getVerdictColor = (verdict: PropPlayRow['propVerdict']) => {
  switch (verdict) {
    case 'PLAY':
      return 'text-execute border-execute/40 bg-execute/10';
    case 'WATCH':
      return 'text-teal border-teal/40 bg-teal/10';
    case 'NO_PLAY':
      return 'text-amber-300 border-amber-400/30 bg-amber-400/10';
    case 'PROJECTION':
      return 'text-cloud/55 border-cloud/20 bg-cloud/5';
    default:
      return 'text-cloud/60 border-cloud/20 bg-cloud/5';
  }
};

const getVerdictBadge = (verdict: PropPlayRow['propVerdict']) => {
  const baseClass = 'px-2 py-1 text-xs font-semibold rounded border';
  const colorClass = getVerdictColor(verdict);
  return `${baseClass} ${colorClass}`;
};

const getVerdictLabel = (verdict: PropPlayRow['propVerdict']) => {
  if (verdict === 'NO_PLAY') return 'NO PLAY';
  return verdict ?? 'NO PLAY';
};

const formatReasonLabel = (value: string | null | undefined) => {
  if (!value) return null;
  return value
    .replace(/^PASS_/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const formatProjectionSource = (source: PropPlayRow['projectionSource']) => {
  switch (source) {
    case 'FULL_MODEL':
      return 'Full model';
    case 'DEGRADED_MODEL':
      return 'Degraded model';
    case 'SYNTHETIC_FALLBACK':
      return 'Synthetic fallback';
    default:
      return null;
  }
};

const getSourceBadgeClass = (source: PropPlayRow['projectionSource']) => {
  const baseClass =
    'rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]';
  if (source === 'FULL_MODEL') {
    return `${baseClass} border-emerald-400/30 bg-emerald-400/10 text-emerald-200`;
  }
  if (source === 'DEGRADED_MODEL') {
    return `${baseClass} border-amber-400/30 bg-amber-400/10 text-amber-200`;
  }
  if (source === 'SYNTHETIC_FALLBACK') {
    return `${baseClass} border-red-500/40 bg-red-500/10 text-red-300`;
  }
  return `${baseClass} border-white/10 bg-white/5 text-cloud/55`;
};

const getStatusCapBadgeClass = (statusCap: PropPlayRow['statusCap']) => {
  const baseClass =
    'rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]';
  if (statusCap === 'PLAY') {
    return `${baseClass} border-execute/30 bg-execute/10 text-execute`;
  }
  if (statusCap === 'LEAN') {
    return `${baseClass} border-teal/30 bg-teal/10 text-teal`;
  }
  return `${baseClass} border-cloud/15 bg-cloud/5 text-cloud/55`;
};

const isProjectionOnlyProp = (prop: PropPlayRow) =>
  prop.propVerdict === 'PROJECTION' ||
  prop.propDisplayState === 'PROJECTION_ONLY' ||
  prop.basis === 'PROJECTION_ONLY' ||
  prop.projectionSource === 'SYNTHETIC_FALLBACK';

const formatPlayabilityBand = (prop: PropPlayRow) => {
  const overLine = prop.playability?.over_playable_at_or_below;
  const underLine = prop.playability?.under_playable_at_or_above;
  if (!Number.isFinite(overLine) && !Number.isFinite(underLine)) return null;
  const overText = Number.isFinite(overLine)
    ? `Over playable at ${formatNumber(overLine, 1)} or lower`
    : null;
  const underText = Number.isFinite(underLine)
    ? `Under playable at ${formatNumber(underLine, 1)} or higher`
    : null;
  return [overText, underText].filter(Boolean).join(' · ');
};

const americanToImplied = (americanOdds: number) => {
  if (!Number.isFinite(americanOdds) || americanOdds === 0) return null;
  return americanOdds > 0
    ? 100 / (americanOdds + 100)
    : Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
};

const probabilityToAmerican = (probability: number) => {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    return null;
  }
  if (probability >= 0.5) {
    return Math.round(-((probability * 100) / (1 - probability)));
  }
  return Math.round(((1 - probability) * 100) / probability);
};

const getThresholdTarget = (lineValue: number | null | undefined) => {
  if (!Number.isFinite(lineValue)) return null;
  return Math.ceil(lineValue as number);
};

const getThresholdOutcomeText = ({
  leanSide,
  lineValue,
  propType,
}: {
  leanSide: 'OVER' | 'UNDER';
  lineValue: number | null | undefined;
  propType?: string | null;
}) => {
  const units = getPropUnits(propType);
  const target = getThresholdTarget(lineValue);
  if (!Number.isFinite(target)) {
    return leanSide === 'UNDER' ? 'under outcome' : 'over outcome';
  }
  const resolvedTarget = target as number;
  if (leanSide === 'UNDER') {
    return `${Math.max(resolvedTarget - 1, 0)} or fewer ${units.plural}`;
  }
  return `${resolvedTarget}+ ${resolvedTarget === 1 ? units.singular : units.plural}`;
};


const getHitRateLabel = ({
  leanSide,
  lineValue,
}: {
  leanSide: 'OVER' | 'UNDER';
  lineValue: number | null | undefined;
}) => {
  const target = getThresholdTarget(lineValue);
  if (!Number.isFinite(target)) {
    return leanSide === 'UNDER' ? 'under outcome' : 'over outcome';
  }
  const resolvedTarget = target as number;
  if (leanSide === 'UNDER') {
    return `${Math.max(resolvedTarget - 1, 0)} or fewer`;
  }
  return `${resolvedTarget}+`;
};

const getNoPlayLeanStrength = (thresholdGap: number | null | undefined) => {
  const absDelta = Math.abs(thresholdGap ?? 0);
  if (absDelta >= 0.75) return 'Strong';
  if (absDelta >= 0.3) return 'Weak';
  return null;
};

const getNoPlayLeanContext = (thresholdGap: number | null | undefined) => {
  const absDelta = Math.abs(thresholdGap ?? 0);
  if (absDelta >= 0.75) return 'Strong lean';
  if (absDelta >= 0.3) return 'Weak lean';
  if (absDelta < 0.1) return 'Even distribution — no lean';
  return 'No directional edge';
};

const buildHeroLine = ({
  verdict,
  leanSide,
  lineValue,
  displayPrice,
  thresholdGap,
  propType,
}: {
  verdict: NonNullable<PropPlayRow['propVerdict']>;
  leanSide: 'OVER' | 'UNDER';
  lineValue: number | null | undefined;
  displayPrice: number | null | undefined;
  thresholdGap: number | null | undefined;
  propType?: string | null;
}) => {
  const outcomeText = getThresholdOutcomeText({ leanSide, lineValue, propType });
  const oddsText =
    typeof displayPrice === 'number' ? ` (${formatOdds(displayPrice)})` : '';

  if (verdict === 'PLAY') {
    return `PLAY — ${outcomeText}${oddsText}`;
  }
  if (verdict === 'WATCH') {
    return `WATCH — ${outcomeText}${oddsText}`;
  }
  if (verdict === 'PROJECTION') {
    return 'PROJECTION ANCHOR';
  }

  const strength = getNoPlayLeanStrength(thresholdGap);
  const closeTag = strength ? ' (Close)' : '';
  return `NO PLAY${closeTag} — ${strength ? `${strength} Lean` : 'Lean'} ${outcomeText}${oddsText}`;
};

const getL5RelativeText = ({
  l5Mean,
  lineValue,
  trend,
  propType,
}: {
  l5Mean: number | null | undefined;
  lineValue: number | null | undefined;
  trend: PropPlayRow['l5Trend'];
  propType?: string | null;
}) => {
  if (l5Mean === null || l5Mean === undefined || Number.isNaN(l5Mean)) {
    return 'L5: unavailable';
  }
  const thresholdTarget = getThresholdTarget(lineValue);
  if (thresholdTarget === null) {
    return `L5: ${formatNumber(l5Mean)}`;
  }
  const delta = l5Mean - thresholdTarget;
  const thresholdText = getThresholdOutcomeText({
    leanSide: 'OVER',
    lineValue,
    propType,
  });
  const relation =
    delta >= 0.3
      ? `above ${thresholdText}`
      : delta <= -0.3
        ? `below ${thresholdText}`
        : `near ${thresholdText}`;
  const trendText = trend ? ` (${trend})` : '';
  return `L5: ${formatNumber(l5Mean)} -> ${relation}${trendText}`;
};

const getDeterministicExplanation = ({
  verdict,
  leanSide,
  lineValue,
  displayPrice,
  thresholdGap,
  probEdgePp,
  ev,
  flags,
  propWhy,
}: {
  verdict: NonNullable<PropPlayRow['propVerdict']>;
  leanSide: 'OVER' | 'UNDER';
  lineValue: number | null | undefined;
  displayPrice: number | null | undefined;
  thresholdGap: number | null | undefined;
  probEdgePp: number | null | undefined;
  ev: number | null | undefined;
  flags?: string[];
  propWhy?: string;
}) => {
  const uniqueFlags = Array.from(new Set(flags ?? []));
  const hasProjectionAnomaly = uniqueFlags.includes('PROJECTION_ANOMALY');
  const hasProjectionConflict = uniqueFlags.includes('PROJECTION_CONFLICT');
  const absDelta = Math.abs(thresholdGap ?? 0);
  const positiveEdge = typeof probEdgePp === 'number' && probEdgePp > 0;
  const negativeEv = typeof ev === 'number' && ev < 0;
  const priceBlocksPlay =
    typeof displayPrice === 'number' &&
    absDelta >= 0.5 &&
    ((typeof probEdgePp === 'number' && probEdgePp < 0.06) ||
      (typeof ev === 'number' && ev < 0.05));
  const priceRemovesValue =
    typeof displayPrice === 'number' &&
    absDelta >= 0.5 &&
    ((typeof probEdgePp === 'number' && probEdgePp <= 0) ||
      (typeof ev === 'number' && ev < 0));
  const outcomeText = getThresholdOutcomeText({ leanSide, lineValue });
  const priceText =
    typeof displayPrice === 'number' ? formatOdds(displayPrice) : null;

  if (verdict === 'PROJECTION') {
    return hasProjectionAnomaly
      ? 'Projection anomaly triggered, so this row stays model-only'
      : 'Projection only — no bettable market is available';
  }
  if (verdict === 'PLAY') {
    return (
      propWhy ??
      `Projection supports ${outcomeText}, and pricing clears the play threshold`
    );
  }
  if (hasProjectionConflict && propWhy) {
    return propWhy;
  }
  if (verdict === 'WATCH') {
    if (uniqueFlags.length > 0) {
      return `Projection supports ${outcomeText}, but flagged inputs cap this at WATCH`;
    }
    if (absDelta < 0.25) {
      return `Projection sits near the ${outcomeText} threshold — no edge`;
    }
    if (priceBlocksPlay && priceText) {
      return `Projection supports ${outcomeText}, but price (${priceText}) is too expensive`;
    }
    return `Projection supports ${outcomeText}, but price is not strong enough`;
  }
  if (absDelta < 0.25) {
    return `Projection sits near the ${outcomeText} threshold — no edge`;
  }
  if (priceRemovesValue && priceText) {
    return `Projection supports ${outcomeText}, but price (${priceText}) removes value`;
  }
  if (priceText && negativeEv) {
    return `Projection supports ${outcomeText}, but price (${priceText}) is too expensive`;
  }
  if (priceText && !positiveEdge) {
    return `Market is efficient for ${outcomeText} at ${priceText}`;
  }
  return absDelta >= 0.3
    ? `Projection leans ${outcomeText}, but the market is aligned`
    : `Projection sits near the ${outcomeText} threshold — no edge`;
};

const getWatchlistTrigger = ({
  verdict,
  leanSide,
  thresholdGap,
  fairProb,
  displayPrice,
  lineValue,
  flags,
}: {
  verdict: NonNullable<PropPlayRow['propVerdict']>;
  leanSide: 'OVER' | 'UNDER';
  thresholdGap: number | null | undefined;
  fairProb: number | null | undefined;
  displayPrice: number | null | undefined;
  lineValue: number | null | undefined;
  flags?: string[];
}) => {
  if (verdict !== 'NO_PLAY' && verdict !== 'WATCH') return null;
  if ((flags ?? []).includes('PROJECTION_CONFLICT')) return null;
  if (!Number.isFinite(thresholdGap)) return null;
  const resolvedThresholdGap = thresholdGap as number;
  if (Math.abs(resolvedThresholdGap) < 0.25) return null;
  const priceBlocked =
    Math.abs(resolvedThresholdGap) >= 0.5 &&
    Number.isFinite(fairProb) &&
    Number.isFinite(displayPrice);

  if (priceBlocked) {
    const resolvedFairProb = fairProb as number;
    const resolvedDisplayPrice = displayPrice as number;
    const targetProb = resolvedFairProb - 0.06;
    if (targetProb <= 0 || targetProb >= 1) return null;

    const targetPrice = probabilityToAmerican(targetProb);
    const currentImplied = americanToImplied(resolvedDisplayPrice);
    const targetImplied = targetPrice !== null ? americanToImplied(targetPrice) : null;
    if (
      targetPrice !== null &&
      targetImplied !== null &&
      currentImplied !== null &&
      targetImplied < currentImplied - 0.005
    ) {
      return verdict === 'WATCH'
        ? `Would be PLAY at ${formatOdds(targetPrice)} or better`
        : `Playable at ${formatOdds(targetPrice)} or better`;
    }
  }

  if (!Number.isFinite(lineValue) || Math.abs(resolvedThresholdGap) >= 0.5) {
    return null;
  }

  const currentTarget = getThresholdTarget(lineValue);
  if (!Number.isFinite(currentTarget)) return null;
  const resolvedCurrentTarget = currentTarget as number;
  const targetThreshold =
    leanSide === 'OVER' ? resolvedCurrentTarget - 1 : resolvedCurrentTarget + 1;
  if (targetThreshold < 1) return null;
  return leanSide === 'OVER'
    ? `Bet if the threshold drops to ${targetThreshold}+`
    : `Bet if the threshold rises to ${targetThreshold}+`;
};

const PITCHER_K_THRESHOLDS = [
  { key: 'p_5_plus', fairKey: 'k_5_plus', label: '5+', underLabel: '4 or fewer' },
  { key: 'p_6_plus', fairKey: 'k_6_plus', label: '6+', underLabel: '5 or fewer' },
  { key: 'p_7_plus', fairKey: 'k_7_plus', label: '7+', underLabel: '6 or fewer' },
] as const;

const CORE_MISSING_INPUTS: Record<string, string> = {
  opponent_contact_profile: 'opponent contact profile',
  starter_k_pct: 'starter K rate',
  starter_handedness: 'pitcher handedness',
  starter_role: 'starter role',
  season_starts: 'season starts',
};

const SECONDARY_MISSING_INPUTS: Record<string, string> = {
  starter_whiff_proxy: 'whiff rate (estimated)',
};

const computeNoEdgeZone = (playability: PropPlayRow['playability']) => {
  const overLine = playability?.over_playable_at_or_below;
  const underLine = playability?.under_playable_at_or_above;
  if (!Number.isFinite(overLine) || !Number.isFinite(underLine)) return null;
  return `${formatNumber(overLine as number, 1)}\u2013${formatNumber(underLine as number, 1)}`;
};

const getLeashDisplay = (flags: string[] | null | undefined) => {
  if (!flags || flags.length === 0) return null;
  const flagSet = new Set(flags);
  if (flagSet.has('IL_RETURN')) return 'IL return';
  if (flagSet.has('EXTENDED_REST')) return 'Extended rest';
  if (flagSet.has('SHORT_LEASH') || flagSet.has('SHORT_LEASH_HALTED')) return 'Short';
  if (flagSet.has('IP_PROXY')) return 'IP proxy (estimated from IP)';
  if (flagSet.has('SMALL_SAMPLE') || flagSet.has('THIN_SAMPLE_STARTS')) return 'Thin sample';
  return null;
};

const getPitcherKDiagnostics = (prop: PropPlayRow) => {
  const isFallback = prop.projectionSource === 'SYNTHETIC_FALLBACK';

  const coreMissing = (prop.missingInputs ?? [])
    .filter((k) => k in CORE_MISSING_INPUTS)
    .map((k) => CORE_MISSING_INPUTS[k]);

  const secondaryMissing = (prop.missingInputs ?? [])
    .filter((k) => k in SECONDARY_MISSING_INPUTS)
    .map((k) => SECONDARY_MISSING_INPUTS[k]);

  const coreMissingText =
    coreMissing.length > 0
      ? `Missing core input${coreMissing.length > 1 ? 's' : ''}: ${coreMissing.join(', ')}`
      : null;

  const secondaryText =
    secondaryMissing.length > 0
      ? `Secondary degradation: ${secondaryMissing.join(', ')}`
      : null;

  const qualityLabel = isFallback
    ? 'FALLBACK'
    : prop.projectionSource === 'DEGRADED_MODEL'
      ? 'DEGRADED'
      : 'FULL MODEL';

  const statusLine = isFallback
    ? 'PASS-only projection anchor'
    : prop.basis === 'PROJECTION_ONLY'
      ? 'Projection only \u2014 no odds market'
      : null;

  const reasonText =
    prop.passReason ||
    formatReasonLabel(prop.passReasonCode) ||
    (isFallback ? 'Synthetic fallback projection' : null) ||
    (prop.basis === 'PROJECTION_ONLY' ? 'Projection only \u2014 no odds market available' : null);

  const missingInputsText =
    prop.missingInputs && prop.missingInputs.length > 0
      ? `Missing inputs: ${prop.missingInputs.join(', ')}`
      : null;

  return {
    reasonText,
    missingInputsText,
    coreMissingText,
    secondaryText,
    qualityLabel,
    statusLine,
    isFallback,
  };
};

export default function PropGameCardComponent({ card }: PropGameCardProps) {
  const [isExpanded, setIsExpanded] = useState(card.propPlays.length <= 5);

  const displayPlays = isExpanded ? card.propPlays : card.propPlays.slice(0, 5);
  const hasMore = card.propPlays.length > 5;

  return (
    <article className="rounded-xl border border-white/10 bg-night shadow-lg overflow-hidden">
      {/* Game Header */}
      <div className="px-6 py-4 border-b border-slate-700/50 bg-surface/30">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <span className="px-2 py-1 text-xs font-bold uppercase tracking-wider bg-slate-700 text-slate-300 rounded">
              {card.sport}
            </span>
            <span className="text-sm font-semibold text-cloud/80">
              {formatTime(card.gameTimeUtc)}
            </span>
          </div>
        </div>

        <div className="text-lg font-bold text-sage-white">
          {card.awayTeam} @ {card.homeTeam}
        </div>

        {/* Optional odds context */}
        {(card.moneyline || card.total) && (
          <div className="mt-2 flex gap-4 text-xs text-cloud/60">
            {card.moneyline && (
              <span>
                ML: {card.homeTeam.split(' ').pop()}{' '}
                {formatOdds(card.moneyline.home)} /{' '}
                {card.awayTeam.split(' ').pop()}{' '}
                {formatOdds(card.moneyline.away)}
              </span>
            )}
            {card.total && <span>O/U {card.total.line}</span>}
          </div>
        )}
      </div>

      {/* Player Projections List */}
      <div className="px-6 py-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-cloud/60">
          Player Projections ({card.propPlays.length})
        </div>

        <div className="space-y-2">
          {displayPlays.map((prop, idx) => {
            const projectionValue = prop.kMean ?? prop.mu ?? prop.projection;
            const lineValue = prop.marketLine ?? prop.line ?? prop.suggestedLine;
            const verdict = prop.propVerdict ?? 'NO_PLAY';
            const projectionOnlyRow = isProjectionOnlyProp(prop);
            const projectionSourceLabel = formatProjectionSource(prop.projectionSource);
            const statusCapLabel = prop.statusCap ? `Cap ${prop.statusCap}` : null;
            const playabilityText = formatPlayabilityBand(prop);
            const {
              reasonText,
              missingInputsText,
              coreMissingText,
              secondaryText,
              qualityLabel,
              statusLine,
              isFallback,
            } = getPitcherKDiagnostics(prop);
            const noEdgeZoneText = computeNoEdgeZone(prop.playability);
            const leashDisplay = getLeashDisplay([...(prop.propFlags ?? []), ...(prop.reasonCodes ?? [])]);
            const isPitcherKCard = prop.propType === 'Strikeouts';
            const hasL5Data = prop.l5Mean !== null && prop.l5Mean !== undefined;
            const thresholdTarget = getThresholdTarget(lineValue);
            const thresholdGap =
              typeof projectionValue === 'number' && typeof thresholdTarget === 'number'
                ? projectionValue - thresholdTarget
                : null;
            const leanSide =
              prop.leanSide ??
              ((projectionValue ?? 0) >= (lineValue ?? 0) ? 'OVER' : 'UNDER');
            const thresholdOutcomeText = getThresholdOutcomeText({
              leanSide,
              lineValue,
              propType: prop.propType,
            });
            const underOutcomeText = getThresholdOutcomeText({
              leanSide: 'UNDER',
              lineValue,
              propType: prop.propType,
            });
            const overOutcomeText = getThresholdOutcomeText({
              leanSide: 'OVER',
              lineValue,
              propType: prop.propType,
            });
            const heroLine = buildHeroLine({
              verdict,
              leanSide,
              lineValue,
              displayPrice: prop.displayPrice,
              thresholdGap,
              propType: prop.propType,
            });
            const WARNING_FLAGS = ['SYNTHETIC_LINE', 'PROJECTION_ANOMALY'];
            const warningFlags = [...new Set([...(prop.propFlags ?? []), ...(prop.reasonCodes ?? [])])].filter((c) =>
              WARNING_FLAGS.includes(c),
            );
            const hasPitcherKLadder =
              prop.propType === 'Strikeouts' &&
              Boolean(
                prop.probabilityLadder?.p_5_plus != null ||
                  prop.probabilityLadder?.p_6_plus != null ||
                  prop.probabilityLadder?.p_7_plus != null,
              );
            const showEdgeBox =
              Number.isFinite(prop.fairProb) &&
              Number.isFinite(prop.impliedProb) &&
              Number.isFinite(prop.probEdgePp) &&
              Number.isFinite(prop.ev);
            const hasDetails =
              warningFlags.length > 0 ||
              (prop.l5Sog && prop.l5Sog.length > 0) ||
              (prop.l5Mean !== null && prop.l5Mean !== undefined) ||
              (prop.priceOver != null || prop.priceUnder != null) ||
              (prop.propFlags && prop.propFlags.length > 0) ||
              hasPitcherKLadder ||
              Boolean(playabilityText || reasonText || missingInputsText);
            const projectionLead =
              prop.propType === 'Strikeouts'
                ? (isFallback
                    ? `~${(Math.round(((prop.kMean ?? projectionValue ?? 0) as number) * 2) / 2).toFixed(1)} Ks`
                    : `${formatNumber(prop.kMean ?? projectionValue, 1)} Ks`)
                : `Projection: ${formatNumber(projectionValue)} ${getPropUnits(prop.propType).plural}`;
            const hitRateText =
              Number.isFinite(prop.fairProb)
                ? `Hit rate (${getHitRateLabel({ leanSide, lineValue })}): ${formatPercent(prop.fairProb)}`
                : null;
            const l5RelativeText = getL5RelativeText({
              l5Mean: prop.l5Mean,
              lineValue,
              trend: prop.l5Trend,
              propType: prop.propType,
            });
            const explanationLine = getDeterministicExplanation({
              verdict,
              leanSide,
              lineValue,
              displayPrice: prop.displayPrice,
              thresholdGap,
              probEdgePp: prop.probEdgePp,
              ev: prop.ev,
              flags: [...(prop.propFlags ?? []), ...(prop.reasonCodes ?? [])],
              propWhy: prop.propWhy,
            });
            const watchlistTrigger = getWatchlistTrigger({
              verdict,
              leanSide,
              thresholdGap,
              fairProb: prop.fairProb,
              displayPrice: prop.displayPrice,
              lineValue,
              flags: [...(prop.propFlags ?? []), ...(prop.reasonCodes ?? [])],
            });

            return (
              <div
                key={`${prop.playerId}-${prop.propType}-${idx}`}
                className={`rounded-lg border transition ${
                  projectionOnlyRow
                    ? 'border-dashed border-white/10 bg-surface/30 opacity-90 hover:border-white/20'
                    : verdict === 'PLAY'
                      ? 'border-execute/30 bg-surface/50 hover:border-execute/50'
                      : verdict === 'WATCH'
                        ? 'border-teal/25 bg-surface/50 hover:border-teal/45'
                        : verdict === 'NO_PLAY'
                          ? 'border-amber-400/20 bg-surface/50 hover:border-amber-400/35'
                          : 'border-white/10 bg-surface/50 hover:border-white/20'
                }`}
              >
                <div className="px-4 py-3 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-sage-white truncate">
                        {prop.playerName}
                      </div>
                      <div className="text-xs text-cloud/60">
                        {prop.propType}
                        {prop.teamAbbr ? ` · ${prop.teamAbbr}` : ''}
                      </div>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {projectionSourceLabel && (
                        <span className={getSourceBadgeClass(prop.projectionSource)}>
                          {projectionSourceLabel}
                        </span>
                      )}
                      {statusCapLabel && (
                        <span className={getStatusCapBadgeClass(prop.statusCap)}>
                          {statusCapLabel}
                        </span>
                      )}
                      <span className={getVerdictBadge(verdict)}>
                        {getVerdictLabel(verdict)}
                      </span>
                    </div>
                  </div>

                  <div className="rounded-md border border-white/10 bg-white/5 p-3">
                    <p className="text-sm font-semibold uppercase tracking-[0.12em] text-cloud/55">
                      {prop.playerName} — {prop.propType}
                    </p>
                    <p className="mt-1 text-lg font-bold text-cloud">
                      {heroLine}
                    </p>
                    <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-cloud/55">
                      {isPitcherKCard && projectionOnlyRow
                        ? 'Compare against posted K line'
                        : `Win condition: ${thresholdOutcomeText}`}
                    </p>
                    <p className="mt-2 text-xl font-bold text-sage-white">
                      {projectionLead}
                    </p>
                    {Number.isFinite(lineValue) && !isPitcherKCard && (
                      <p className="mt-1 text-sm font-semibold text-cloud/80">
                        Standard line: {formatNumber(lineValue, 1)}
                      </p>
                    )}
                    {hitRateText && !isPitcherKCard && (
                      <p className="mt-1 text-sm font-semibold text-cloud">
                        {hitRateText}
                      </p>
                    )}
                    {hasPitcherKLadder && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {PITCHER_K_THRESHOLDS.map((threshold) => {
                          const overProb =
                            prop.probabilityLadder?.[threshold.key] ?? null;
                          if (!Number.isFinite(overProb)) return null;
                          return (
                            <span
                              key={threshold.key}
                              className="rounded-full border border-white/10 bg-night/30 px-2 py-1 text-[11px] font-semibold text-cloud/80"
                            >
                              {`P(${threshold.label}) ${formatPercent(overProb)}`}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {(!isPitcherKCard || !projectionOnlyRow) && (
                      <p className="mt-2 text-sm text-cloud/72">{explanationLine}</p>
                    )}
                    {reasonText && !isPitcherKCard && (
                      <p className="mt-1 text-xs font-semibold text-cloud/60">
                        PASS reason: {reasonText}
                      </p>
                    )}
                    {missingInputsText && !isPitcherKCard && (
                      <p className="mt-1 text-xs text-cloud/55">
                        {missingInputsText}
                      </p>
                    )}
                    {watchlistTrigger && (
                      <p className="mt-1 text-xs font-semibold text-amber-200">
                        {watchlistTrigger}
                      </p>
                    )}
                  </div>

                  <div
                    className={`grid gap-2 ${
                      showEdgeBox || hasPitcherKLadder
                        ? 'md:grid-cols-3'
                        : 'md:grid-cols-2'
                    }`}
                  >
                    {showEdgeBox && (
                      <div className="rounded border border-white/10 bg-night/40 p-3">
                        <div className="text-[11px] uppercase tracking-[0.12em] text-cloud/45">
                          Edge
                        </div>
                        <div className="mt-2 space-y-1 text-sm text-cloud/80">
                          <p>Fair: {formatPercent(prop.fairProb)}</p>
                          <p>Implied: {formatPercent(prop.impliedProb)}</p>
                          <p>Edge: {formatPercent(prop.probEdgePp)}</p>
                          <p>EV: {formatSignedNumber(prop.ev, 2)}</p>
                        </div>
                      </div>
                    )}

                    {!showEdgeBox && hasPitcherKLadder && (
                      <div className="rounded border border-white/10 bg-night/40 p-3">
                        <div className="text-[11px] uppercase tracking-[0.12em] text-cloud/45">
                          K Ladder
                        </div>
                        <div className="mt-2 space-y-1 text-sm text-cloud/80">
                          {PITCHER_K_THRESHOLDS.map((threshold) => {
                            const overProb =
                              prop.probabilityLadder?.[threshold.key] ?? null;
                            if (!Number.isFinite(overProb)) return null;
                            const fairOver =
                              prop.fairPrices?.[threshold.fairKey]?.over ??
                              probabilityToAmerican(overProb as number);
                            const fairUnder =
                              prop.fairPrices?.[threshold.fairKey]?.under ??
                              probabilityToAmerican(1 - (overProb as number));
                            return (
                              <p key={threshold.key}>
                                {`P(${threshold.label}) ${formatPercent(overProb)} · Fair O ${fairOver != null ? formatOdds(fairOver) : '—'} / U ${fairUnder != null ? formatOdds(fairUnder) : '—'}`}
                              </p>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="rounded border border-white/10 bg-night/40 p-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-cloud/45">
                        Market
                      </div>
                      <div className="mt-2 space-y-1 text-sm text-cloud/80">
                        {Number.isFinite(lineValue) && (
                          <p>Standard line: {formatNumber(lineValue, 1)}</p>
                        )}
                        <p>Threshold: {overOutcomeText}</p>
                        {prop.priceOver != null && (
                          <p>{overOutcomeText} {formatOdds(prop.priceOver)}</p>
                        )}
                        {prop.priceUnder != null && (
                          <p>{underOutcomeText} {formatOdds(prop.priceUnder)}</p>
                        )}
                        {prop.priceOver == null && prop.priceUnder == null && (
                          <p>No live price</p>
                        )}
                        {prop.bookmaker && (
                          <p className="text-cloud/50">
                            Book: {formatBookName(prop.bookmaker)}
                          </p>
                        )}
                        {Number.isFinite(prop.playability?.over_playable_at_or_below) && (
                          <p className="text-cloud/80">
                            Over at {formatNumber(prop.playability?.over_playable_at_or_below, 1)} or lower
                          </p>
                        )}
                        {Number.isFinite(prop.playability?.under_playable_at_or_above) && (
                          <p className="text-cloud/80">
                            Under at {formatNumber(prop.playability?.under_playable_at_or_above, 1)} or higher
                          </p>
                        )}
                        {noEdgeZoneText && (
                          <p className="text-cloud/50">
                            No edge zone: {noEdgeZoneText}
                          </p>
                        )}
                        {leashDisplay && isPitcherKCard && (
                          <p className="text-cloud/50">
                            Leash: {leashDisplay}
                          </p>
                        )}
                      </div>
                    </div>

                    {isPitcherKCard ? (
                      <div className="rounded border border-white/10 bg-night/40 p-3">
                        <div className="text-[11px] uppercase tracking-[0.12em] text-cloud/45">
                          Model Quality
                        </div>
                        <div className="mt-2 space-y-1 text-sm">
                          <p className={`font-semibold ${isFallback ? 'text-red-300' : 'text-amber-200'}`}>
                            {qualityLabel}
                          </p>
                          {coreMissingText && (
                            <p className="text-xs text-red-300/80">{coreMissingText}</p>
                          )}
                          {secondaryText && (
                            <p className="text-xs text-amber-300/70">{secondaryText}</p>
                          )}
                          {statusLine && (
                            <p className="text-xs text-cloud/55">{statusLine}</p>
                          )}
                          {!hasL5Data && (
                            <p className="text-xs text-cloud/40">Recent form unavailable</p>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded border border-white/10 bg-night/40 p-3">
                        <div className="text-[11px] uppercase tracking-[0.12em] text-cloud/45">
                          L5 / Context
                        </div>
                        <div className="mt-2 space-y-1 text-sm text-cloud/80">
                          <p>{l5RelativeText}</p>
                          {thresholdGap !== null && verdict === 'NO_PLAY' && (
                            <p>{getNoPlayLeanContext(thresholdGap)}</p>
                          )}
                          {reasonText && <p>{reasonText}</p>}
                          {missingInputsText && <p>{missingInputsText}</p>}
                          {prop.propFlags && prop.propFlags.length > 0 && (
                            <p>Flags: {prop.propFlags.join(' | ')}</p>
                          )}
                          {projectionSourceLabel && (
                            <p>Source: {projectionSourceLabel}</p>
                          )}
                          {statusCapLabel && <p>{statusCapLabel}</p>}
                        </div>
                      </div>
                    )}
                  </div>

                  {hasDetails && (
                    <details className="rounded border border-white/10 bg-white/5 p-2.5">
                      <summary className="cursor-pointer text-[11px] uppercase tracking-widest text-cloud/45 font-semibold select-none">
                        Details
                      </summary>
                      <div className="mt-2 space-y-1.5 text-xs text-cloud/60">
                        {(prop.priceOver != null || prop.priceUnder != null) && (
                          <p>
                            Market odds: {overOutcomeText}{' '}
                            {prop.priceOver != null ? formatOdds(prop.priceOver) : '—'} / {underOutcomeText}{' '}
                            {prop.priceUnder != null ? formatOdds(prop.priceUnder) : '—'}
                          </p>
                        )}
                        {((prop.l5Sog && prop.l5Sog.length > 0) ||
                          (prop.l5Mean !== null && prop.l5Mean !== undefined)) && (
                          <p>
                            {`L5 ${getPropUnits(prop.propType).plural}`}: {(prop.l5Sog ?? []).join(', ') || formatNumber(getAverage(prop.l5Sog), 1)}
                          </p>
                        )}
                        {warningFlags.length > 0 && (
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {warningFlags.map((flag) => (
                              <span
                                key={flag}
                                className="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400"
                              >
                                {flag === 'SYNTHETIC_LINE'
                                  ? 'Synthetic line'
                                  : 'Projection anomaly'}
                              </span>
                            ))}
                          </div>
                        )}
                        {isPitcherKCard && (prop.propFlags ?? []).length > 0 && (
                          <div className="pt-1">
                            <p className="mb-0.5 text-cloud/40">Model flags</p>
                            <p className="break-all font-mono text-[10px] text-cloud/35">
                              {[...(prop.propFlags ?? []), ...(prop.reasonCodes ?? [])].filter(Boolean).join(' \u00b7 ')}
                            </p>
                          </div>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Expand/Collapse */}
        {hasMore && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="mt-3 w-full py-2 text-xs font-semibold text-cloud/60 hover:text-cloud transition border border-white/10 rounded hover:border-white/20"
          >
            {isExpanded ? 'Show Less' : `Show All (${card.propPlays.length})`}
          </button>
        )}

        {/* Odds Updated Footer */}
        {card.oddsUpdatedUtc && (
          <div className="mt-4 pt-3 border-t border-white/10 text-xs text-cloud/40">
            Odds updated {formatTime(card.oddsUpdatedUtc)}
          </div>
        )}
      </div>
    </article>
  );
}
