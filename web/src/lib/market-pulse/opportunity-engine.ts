import { createHash } from 'node:crypto';
import type {
  DisplayTier,
  FreshnessStatus,
  LineGap,
  MarketPulseOpportunity,
  OddsGap,
  OddsSnapshot,
  OpportunityKind,
  OpportunitySide,
  ProjectionStatus,
  SignalKind,
  SuppressionReason,
  MarketType,
} from '@/lib/types/market-pulse';

type RawTier = 'TRIGGER' | 'WATCH';

type ParsedSpreadEntry = {
  book: string;
  home: number | null;
  away: number | null;
  price_home: number | null;
  price_away: number | null;
};

type ParsedTotalEntry = {
  book: string;
  line: number | null;
  over: number | null;
  under: number | null;
};

type ParsedH2hEntry = {
  book: string;
  home: number | null;
  away: number | null;
};

type ParsedMarkets = {
  spreads: ParsedSpreadEntry[];
  totals: ParsedTotalEntry[];
  h2h: ParsedH2hEntry[];
};

type Candidate = {
  gameId: string;
  sport: string;
  homeTeam: string | null;
  awayTeam: string | null;
  marketType: MarketType;
  displayMarket: string;
  line: number | null;
  side: OpportunitySide;
  signalKinds: SignalKind[];
  bestBook: string;
  bestPrice: number | null;
  referenceBook: string;
  referencePrice: number | null;
  marketGapPct: number | null;
  lineDelta: number | null;
  capturedAt: string;
  sourceTier: RawTier;
  suppressionReason: SuppressionReason;
};

type AggregatedOpportunity = Candidate & {
  highestTier: RawTier;
  mergedSignals: number;
};

type MlbModelOutput = {
  modelWinProbHome: number;
  side: 'HOME' | 'AWAY';
};

type NbaModelOutput = {
  totalProjection: number;
};

type NhlModelSignal = {
  market_type?: string | null;
  selection_side?: string | null;
  model_prob?: number | null;
  fair_price?: number | null;
};

type NhlModelOutput = {
  model_signal?: NhlModelSignal | null;
};

export type ProjectionReaders = {
  getLatestMlbModelOutput?: (gameId: string) => MlbModelOutput | null;
  getLatestNbaModelOutput?: (gameId: string) => NbaModelOutput | null;
  getLatestNhlModelOutput?: (gameId: string) => NhlModelOutput | null;
};

export interface OpportunityEngineResult {
  opportunities: MarketPulseOpportunity[];
  counters: {
    droppedDuplicate: number;
    droppedStale: number;
    droppedUnsupported: number;
    droppedConflict: number;
    freshCount: number;
    staleVerifyRequiredCount: number;
    expiredCount: number;
    projectionAlignedWatchCount: number;
    marketOnlyCount: number;
  };
}

const VERIFY_BEFORE_BET_LABEL = 'Verify before betting — odds may be stale';

function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normalizeSpreadEntries(raw: unknown): ParsedSpreadEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const book =
        typeof record.book === 'string' && record.book.trim() !== ''
          ? record.book
          : null;
      if (!book) return null;
      return {
        book,
        home: toFiniteNumberOrNull(record.home),
        away: toFiniteNumberOrNull(record.away),
        price_home: toFiniteNumberOrNull(record.price_home),
        price_away: toFiniteNumberOrNull(record.price_away),
      };
    })
    .filter((entry): entry is ParsedSpreadEntry => entry !== null);
}

function normalizeTotalEntries(raw: unknown): ParsedTotalEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const book =
        typeof record.book === 'string' && record.book.trim() !== ''
          ? record.book
          : null;
      if (!book) return null;
      return {
        book,
        line: toFiniteNumberOrNull(record.line),
        over: toFiniteNumberOrNull(record.over),
        under: toFiniteNumberOrNull(record.under),
      };
    })
    .filter((entry): entry is ParsedTotalEntry => entry !== null);
}

function normalizeH2hEntries(raw: unknown): ParsedH2hEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const book =
        typeof record.book === 'string' && record.book.trim() !== ''
          ? record.book
          : null;
      if (!book) return null;
      return {
        book,
        home: toFiniteNumberOrNull(record.home),
        away: toFiniteNumberOrNull(record.away),
      };
    })
    .filter((entry): entry is ParsedH2hEntry => entry !== null);
}

function parseSnapshotMarkets(snapshot: OddsSnapshot): ParsedMarkets {
  const parsed = parseJson(snapshot.raw_data ?? '{}');
  const markets =
    parsed.markets && typeof parsed.markets === 'object'
      ? (parsed.markets as Record<string, unknown>)
      : parsed;

  return {
    spreads: normalizeSpreadEntries(markets.spreads),
    totals: normalizeTotalEntries(markets.totals),
    h2h: normalizeH2hEntries(markets.h2h),
  };
}

function buildSnapshotIndex(
  snapshots: OddsSnapshot[],
): Map<string, ParsedMarkets> {
  const index = new Map<string, ParsedMarkets>();
  for (const snapshot of snapshots) {
    index.set(snapshot.game_id, parseSnapshotMarkets(snapshot));
  }
  return index;
}

function getDisplayMarket(marketType: MarketType): string {
  if (marketType === 'MONEYLINE') return 'Moneyline';
  if (marketType === 'SPREAD') return 'Spread';
  return 'Total';
}

function normalizeSide(
  side: 'home' | 'away' | 'over' | 'under',
): OpportunitySide {
  if (side === 'home') return 'HOME';
  if (side === 'away') return 'AWAY';
  if (side === 'over') return 'OVER';
  return 'UNDER';
}

function normalizeLine(line: number | null): string {
  if (!Number.isFinite(line)) return 'ml';
  return Number(line).toFixed(1);
}

function buildClusterKey(candidate: Candidate): string {
  return [
    candidate.gameId,
    candidate.marketType,
    normalizeLine(candidate.line),
    candidate.side,
  ].join('|');
}

function probabilityToAmerican(probability: number): number | null {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    return null;
  }
  if (probability >= 0.5) {
    return Math.round((-100 * probability) / (1 - probability));
  }
  return Math.round((100 * (1 - probability)) / probability);
}

function inferFreshnessStatus(
  capturedAt: string,
  nowMs: number,
): { freshnessStatus: FreshnessStatus; minutesAgo: number } {
  const capturedMs = new Date(capturedAt).getTime();
  if (!Number.isFinite(capturedMs)) {
    return {
      freshnessStatus: 'EXPIRED',
      minutesAgo: Number.POSITIVE_INFINITY,
    };
  }

  const minutesAgo = Math.max(0, Math.floor((nowMs - capturedMs) / 60_000));
  if (minutesAgo <= 15) {
    return { freshnessStatus: 'FRESH', minutesAgo };
  }
  if (minutesAgo <= 60) {
    return { freshnessStatus: 'STALE_VERIFY_REQUIRED', minutesAgo };
  }
  return { freshnessStatus: 'EXPIRED', minutesAgo };
}

function deriveOpportunityId(input: {
  gameId: string;
  marketType: MarketType;
  line: number | null;
  side: OpportunitySide;
  bestBook: string;
  capturedAt: string;
}): string {
  const payload = [
    input.gameId,
    input.marketType,
    normalizeLine(input.line),
    input.side,
    input.bestBook,
    input.capturedAt,
  ].join('|');
  return createHash('sha1').update(payload).digest('hex');
}

function chooseClosestByValue<T extends { book: string }>(
  entries: T[],
  sourceBook: string,
  targetValue: number | null,
  readValue: (entry: T) => number | null,
): T | null {
  if (!Number.isFinite(targetValue)) return null;
  const safeTargetValue = Number(targetValue);

  let best: T | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const entry of entries) {
    if (entry.book === sourceBook) continue;
    const value = readValue(entry);
    if (!Number.isFinite(value)) continue;
    const delta = Math.abs(Number(value) - safeTargetValue);
    if (delta < bestDelta) {
      best = entry;
      bestDelta = delta;
    }
  }

  return best;
}

function inferMarketGapPct(
  bestPrice: number | null,
  referencePrice: number | null,
): number | null {
  if (!Number.isFinite(bestPrice) || !Number.isFinite(referencePrice)) {
    return null;
  }

  const best =
    bestPrice! < 0
      ? Math.abs(bestPrice!) / (Math.abs(bestPrice!) + 100)
      : 100 / (bestPrice! + 100);
  const reference =
    referencePrice! < 0
      ? Math.abs(referencePrice!) / (Math.abs(referencePrice!) + 100)
      : 100 / (referencePrice! + 100);

  return Math.abs(best - reference);
}

function buildLineCandidate(
  gap: LineGap,
  snapshotMarkets: ParsedMarkets | undefined,
): Candidate {
  const marketType: MarketType = gap.market === 'spread' ? 'SPREAD' : 'TOTAL';
  const side = normalizeSide(gap.direction);

  if (marketType === 'SPREAD') {
    const sourceEntry =
      snapshotMarkets?.spreads.find((entry) => entry.book === gap.outlierBook) ??
      null;
    const lineField = side === 'HOME' ? 'home' : 'away';
    const priceField = side === 'HOME' ? 'price_home' : 'price_away';
    const referenceEntry = chooseClosestByValue(
      snapshotMarkets?.spreads ?? [],
      gap.outlierBook,
      gap.consensusLine,
      (entry) => entry[lineField],
    );
    const bestPrice =
      sourceEntry !== null ? sourceEntry[priceField] : null;
    const referencePrice =
      referenceEntry !== null ? referenceEntry[priceField] : null;

    return {
      gameId: gap.gameId,
      sport: gap.sport,
      homeTeam: gap.homeTeam,
      awayTeam: gap.awayTeam,
      marketType,
      displayMarket: getDisplayMarket(marketType),
      line: gap.outlierLine,
      side,
      signalKinds: ['LINE'],
      bestBook: gap.outlierBook,
      bestPrice,
      referenceBook: referenceEntry?.book ?? 'Consensus',
      referencePrice,
      marketGapPct: inferMarketGapPct(bestPrice, referencePrice),
      lineDelta: gap.delta,
      capturedAt: gap.capturedAt,
      sourceTier: gap.tier,
      suppressionReason: null,
    };
  }

  const sourceEntry =
    snapshotMarkets?.totals.find((entry) => entry.book === gap.outlierBook) ??
    null;
  const priceField = side === 'OVER' ? 'over' : 'under';
  const referenceEntry = chooseClosestByValue(
    snapshotMarkets?.totals ?? [],
    gap.outlierBook,
    gap.consensusLine,
    (entry) => entry.line,
  );
  const bestPrice = sourceEntry !== null ? sourceEntry[priceField] : null;
  const referencePrice = referenceEntry !== null ? referenceEntry[priceField] : null;

  return {
    gameId: gap.gameId,
    sport: gap.sport,
    homeTeam: gap.homeTeam,
    awayTeam: gap.awayTeam,
    marketType,
    displayMarket: getDisplayMarket(marketType),
    line: gap.outlierLine,
    side,
    signalKinds: ['LINE'],
    bestBook: gap.outlierBook,
    bestPrice,
    referenceBook: referenceEntry?.book ?? 'Consensus',
    referencePrice,
    marketGapPct: inferMarketGapPct(bestPrice, referencePrice),
    lineDelta: gap.delta,
    capturedAt: gap.capturedAt,
    sourceTier: gap.tier,
    suppressionReason: null,
  };
}

function buildOddsCandidate(gap: OddsGap): Candidate {
  const marketType: MarketType =
    gap.market === 'moneyline'
      ? 'MONEYLINE'
      : gap.market === 'spread'
        ? 'SPREAD'
        : 'TOTAL';

  return {
    gameId: gap.gameId,
    sport: gap.sport,
    homeTeam: gap.homeTeam,
    awayTeam: gap.awayTeam,
    marketType,
    displayMarket: getDisplayMarket(marketType),
    line: gap.line,
    side: normalizeSide(gap.side),
    signalKinds: ['PRICE'],
    bestBook: gap.bestBook,
    bestPrice: gap.bestPrice,
    referenceBook: gap.worstBook,
    referencePrice: gap.worstPrice,
    marketGapPct: gap.impliedEdgePct,
    lineDelta: null,
    capturedAt: gap.capturedAt,
    sourceTier: gap.tier,
    suppressionReason: null,
  };
}

function mergeCandidate(
  current: AggregatedOpportunity,
  next: Candidate,
): AggregatedOpportunity {
  const signalKinds = Array.from(
    new Set<SignalKind>([...current.signalKinds, ...next.signalKinds]),
  ).sort();

  const pricePreferred = next.signalKinds.includes('PRICE');
  const bestBook = pricePreferred ? next.bestBook : current.bestBook;
  const bestPrice = pricePreferred ? next.bestPrice : current.bestPrice;
  const referenceBook = pricePreferred ? next.referenceBook : current.referenceBook;
  const referencePrice =
    pricePreferred ? next.referencePrice : current.referencePrice;

  return {
    ...current,
    bestBook,
    bestPrice,
    referenceBook,
    referencePrice,
    marketGapPct:
      next.marketGapPct !== null ? next.marketGapPct : current.marketGapPct,
    lineDelta: next.lineDelta !== null ? next.lineDelta : current.lineDelta,
    signalKinds,
    highestTier:
      current.highestTier === 'TRIGGER' || next.sourceTier === 'TRIGGER'
        ? 'TRIGGER'
        : 'WATCH',
    mergedSignals: current.mergedSignals + 1,
    suppressionReason: 'MERGED_COMPOSITE_SIGNAL',
  };
}

function resolveProjectionOverlay(
  opportunity: AggregatedOpportunity,
  readers: ProjectionReaders,
): {
  projectionStatus: ProjectionStatus;
  projectionValue?: number;
  fairPrice?: number;
} {
  if (opportunity.sport === 'MLB' && opportunity.marketType === 'MONEYLINE') {
    const projection = readers.getLatestMlbModelOutput?.(opportunity.gameId) ?? null;
    if (!projection) return { projectionStatus: 'UNAVAILABLE' };

    const homeProbability = projection.modelWinProbHome;
    if (!Number.isFinite(homeProbability)) {
      return { projectionStatus: 'UNAVAILABLE' };
    }

    const sideProbability =
      opportunity.side === 'HOME' ? homeProbability : 1 - homeProbability;
    const projectionStatus =
      projection.side === opportunity.side ? 'CONFIRMED' : 'MISMATCHED';

    return {
      projectionStatus,
      projectionValue: sideProbability,
      fairPrice: probabilityToAmerican(sideProbability) ?? undefined,
    };
  }

  if (opportunity.sport === 'NBA' && opportunity.marketType === 'TOTAL') {
    const projection = readers.getLatestNbaModelOutput?.(opportunity.gameId) ?? null;
    if (!projection || !Number.isFinite(projection.totalProjection)) {
      return { projectionStatus: 'UNAVAILABLE' };
    }

    if (!Number.isFinite(opportunity.line)) {
      return { projectionStatus: 'UNAVAILABLE' };
    }

    if (projection.totalProjection === opportunity.line) {
      return {
        projectionStatus: 'UNAVAILABLE',
        projectionValue: projection.totalProjection,
      };
    }

    const projectionSide: OpportunitySide =
      projection.totalProjection > (opportunity.line as number) ? 'OVER' : 'UNDER';

    return {
      projectionStatus:
        projectionSide === opportunity.side ? 'CONFIRMED' : 'MISMATCHED',
      projectionValue: projection.totalProjection,
    };
  }

  if (opportunity.sport === 'NHL' && opportunity.marketType === 'MONEYLINE') {
    const projection = readers.getLatestNhlModelOutput?.(opportunity.gameId) ?? null;
    const signal = projection?.model_signal ?? null;
    if (!signal) return { projectionStatus: 'UNAVAILABLE' };

    const marketType = String(signal.market_type ?? '').trim().toUpperCase();
    const selectionSide = String(signal.selection_side ?? '').trim().toUpperCase();
    const fairPrice = toFiniteNumberOrNull(signal.fair_price);
    const modelProb = toFiniteNumberOrNull(signal.model_prob);

    if (marketType !== 'MONEYLINE') {
      return { projectionStatus: 'UNAVAILABLE' };
    }
    if (selectionSide !== 'HOME' && selectionSide !== 'AWAY') {
      return { projectionStatus: 'UNAVAILABLE' };
    }
    if (!Number.isFinite(fairPrice) && !Number.isFinite(modelProb)) {
      return { projectionStatus: 'UNAVAILABLE' };
    }

    let sideProbability: number | undefined;
    let sideFairPrice: number | undefined;

    if (Number.isFinite(modelProb)) {
      const selectedProbability = modelProb as number;
      sideProbability =
        selectionSide === opportunity.side
          ? selectedProbability
          : 1 - selectedProbability;
      sideFairPrice = probabilityToAmerican(sideProbability) ?? undefined;
    }

    if (selectionSide === opportunity.side && Number.isFinite(fairPrice)) {
      sideFairPrice = fairPrice as number;
    }

    return {
      projectionStatus:
        selectionSide === opportunity.side ? 'CONFIRMED' : 'MISMATCHED',
      projectionValue: sideProbability,
      fairPrice: sideFairPrice,
    };
  }

  return { projectionStatus: 'UNSUPPORTED_SPORT' };
}

function deriveOpportunityKind(
  projectionStatus: ProjectionStatus,
): OpportunityKind {
  if (projectionStatus === 'CONFIRMED') return 'PROJECTION_CONFIRMED';
  if (projectionStatus === 'MISMATCHED') return 'CONFLICTING';
  if (projectionStatus === 'UNSUPPORTED_SPORT') return 'UNSUPPORTED';
  return 'MARKET_ONLY';
}

function deriveDisplayTier(options: {
  freshnessStatus: FreshnessStatus;
  opportunityKind: OpportunityKind;
  highestTier: RawTier;
}): DisplayTier {
  if (options.freshnessStatus === 'EXPIRED') return 'EXPIRED';
  if (options.opportunityKind === 'UNSUPPORTED') return 'MARKET_ONLY';
  if (options.opportunityKind === 'MARKET_ONLY') return 'MARKET_ONLY';
  if (options.opportunityKind === 'CONFLICTING') return 'WATCH';
  if (options.freshnessStatus === 'STALE_VERIFY_REQUIRED') return 'WATCH';
  return options.highestTier === 'TRIGGER' ? 'SCOUT' : 'WATCH';
}

export function buildMarketPulseView(input: {
  snapshots: OddsSnapshot[];
  lineGaps: LineGap[];
  oddsGaps: OddsGap[];
  readers?: ProjectionReaders;
  nowMs?: number;
}): OpportunityEngineResult {
  const nowMs = input.nowMs ?? Date.now();
  const readers = input.readers ?? {};
  const snapshotIndex = buildSnapshotIndex(input.snapshots);

  const mergedByCluster = new Map<string, AggregatedOpportunity>();
  let droppedDuplicate = 0;

  for (const gap of input.lineGaps) {
    const candidate = buildLineCandidate(gap, snapshotIndex.get(gap.gameId));
    const clusterKey = buildClusterKey(candidate);
    const current = mergedByCluster.get(clusterKey);
    if (!current) {
      mergedByCluster.set(clusterKey, {
        ...candidate,
        highestTier: candidate.sourceTier,
        mergedSignals: 1,
      });
      continue;
    }

    mergedByCluster.set(clusterKey, mergeCandidate(current, candidate));
    droppedDuplicate += 1;
  }

  for (const gap of input.oddsGaps) {
    const candidate = buildOddsCandidate(gap);
    const clusterKey = buildClusterKey(candidate);
    const current = mergedByCluster.get(clusterKey);
    if (!current) {
      mergedByCluster.set(clusterKey, {
        ...candidate,
        highestTier: candidate.sourceTier,
        mergedSignals: 1,
      });
      continue;
    }

    mergedByCluster.set(clusterKey, mergeCandidate(current, candidate));
    droppedDuplicate += 1;
  }

  let droppedStale = 0;
  let droppedUnsupported = 0;
  let droppedConflict = 0;
  let freshCount = 0;
  let staleVerifyRequiredCount = 0;
  let expiredCount = 0;
  let projectionAlignedWatchCount = 0;
  let marketOnlyCount = 0;

  const opportunities = Array.from(mergedByCluster.values())
    .map((candidate) => {
      const freshness = inferFreshnessStatus(candidate.capturedAt, nowMs);
      const projection = resolveProjectionOverlay(candidate, readers);
      const opportunityKind = deriveOpportunityKind(projection.projectionStatus);
      const displayTier = deriveDisplayTier({
        freshnessStatus: freshness.freshnessStatus,
        opportunityKind,
        highestTier: candidate.highestTier,
      });
      const verifyBeforeBetLabel =
        freshness.freshnessStatus === 'FRESH' ? null : VERIFY_BEFORE_BET_LABEL;

      if (freshness.freshnessStatus === 'FRESH') freshCount += 1;
      if (freshness.freshnessStatus === 'STALE_VERIFY_REQUIRED') {
        staleVerifyRequiredCount += 1;
      }
      if (freshness.freshnessStatus === 'EXPIRED') expiredCount += 1;
      if (opportunityKind === 'MARKET_ONLY') marketOnlyCount += 1;
      if (opportunityKind === 'UNSUPPORTED') droppedUnsupported += 1;
      if (opportunityKind === 'CONFLICTING') droppedConflict += 1;
      if (displayTier === 'WATCH' && projection.projectionStatus === 'CONFIRMED') {
        projectionAlignedWatchCount += 1;
      }

      if (!Number.isFinite(freshness.minutesAgo)) {
        droppedStale += 1;
      }

      return {
        opportunityId: deriveOpportunityId({
          gameId: candidate.gameId,
          marketType: candidate.marketType,
          line: candidate.line,
          side: candidate.side,
          bestBook: candidate.bestBook,
          capturedAt: candidate.capturedAt,
        }),
        gameId: candidate.gameId,
        sport: candidate.sport,
        homeTeam: candidate.homeTeam,
        awayTeam: candidate.awayTeam,
        marketType: candidate.marketType,
        displayMarket: candidate.displayMarket,
        line: candidate.line,
        side: candidate.side,
        signalKinds: candidate.signalKinds,
        bestBook: candidate.bestBook,
        bestPrice: candidate.bestPrice,
        referenceBook: candidate.referenceBook,
        referencePrice: candidate.referencePrice,
        marketGapPct: candidate.marketGapPct,
        lineDelta: candidate.lineDelta,
        capturedAt: candidate.capturedAt,
        minutesAgo: Number.isFinite(freshness.minutesAgo)
          ? freshness.minutesAgo
          : Number.MAX_SAFE_INTEGER,
        freshnessStatus: freshness.freshnessStatus,
        projectionStatus: projection.projectionStatus,
        ...(projection.projectionValue !== undefined && {
          projectionValue: projection.projectionValue,
        }),
        ...(projection.fairPrice !== undefined && {
          fairPrice: projection.fairPrice,
        }),
        opportunityKind,
        displayTier,
        verifyBeforeBetLabel,
        suppressionReason: candidate.mergedSignals > 1 ? candidate.suppressionReason : null,
      } satisfies MarketPulseOpportunity;
    })
    .sort((left, right) => {
      const tierRank: Record<DisplayTier, number> = {
        SCOUT: 0,
        WATCH: 1,
        MARKET_ONLY: 2,
        EXPIRED: 3,
      };

      const leftRank = tierRank[left.displayTier];
      const rightRank = tierRank[right.displayTier];
      if (leftRank !== rightRank) return leftRank - rightRank;

      const leftGap = left.marketGapPct ?? left.lineDelta ?? 0;
      const rightGap = right.marketGapPct ?? right.lineDelta ?? 0;
      return rightGap - leftGap;
    });

  return {
    opportunities,
    counters: {
      droppedDuplicate,
      droppedStale,
      droppedUnsupported,
      droppedConflict,
      freshCount,
      staleVerifyRequiredCount,
      expiredCount,
      projectionAlignedWatchCount,
      marketOnlyCount,
    },
  };
}
