import type { GameCard } from '@/lib/types';

export type PassHeaderBucket =
  | 'odds-blocked'
  | 'data-error'
  | 'projection-only';

export type SportDiagnosticBucket =
  | 'missingMapping'
  | 'driverLoadFailed'
  | 'noOdds'
  | 'noProjection'
  | 'projectionOnly';

export type SportDiagnosticCounts = Record<SportDiagnosticBucket, number>;

export const DIAGNOSTIC_BUCKET_ORDER: readonly SportDiagnosticBucket[] = [
  'noOdds',
  'missingMapping',
  'driverLoadFailed',
  'projectionOnly',
  'noProjection',
];

export const DIAGNOSTIC_BUCKET_LABELS: Record<SportDiagnosticBucket, string> = {
  missingMapping: 'Missing mapping',
  driverLoadFailed: 'Driver load failed',
  noOdds: 'No odds',
  noProjection: 'No projection',
  projectionOnly: 'Projection only',
};

const DATA_ERROR_PASS_CODES = new Set([
  'PASS_DATA_ERROR',
  'PASS_MISSING_KIND',
  'PASS_MISSING_SELECTION',
  'PASS_MISSING_MARKET_TYPE',
  'PASS_MISSING_LINE',
  'PASS_NO_MARKET_PRICE',
  'PASS_TOTAL_INSUFFICIENT_DATA',
  'PASS_MISSING_DRIVER_INPUTS',
  'PASS_NO_ACTIONABLE_PLAY',
]);

function getReasonCodes(card: GameCard): string[] {
  return card.play?.reason_codes ?? [];
}

function getMissingInputs(card: GameCard): string[] {
  return card.play?.transform_meta?.missing_inputs ?? [];
}

export function classifyPassHeaderBucket(card: GameCard): PassHeaderBucket | null {
  const play = card.play;
  if (!play) return null;

  const reasonCodes = getReasonCodes(card);
  const priceReasonCodes: string[] =
    (play.decision_v2 as { price_reason_codes?: string[] } | undefined)
      ?.price_reason_codes ?? [];

  if (
    play.execution_status === 'PROJECTION_ONLY' ||
    reasonCodes.includes('PROJECTION_ONLY_EXCLUSION')
  ) {
    return 'projection-only';
  }

  if (
    play.execution_status === 'BLOCKED' ||
    priceReasonCodes.includes('PROXY_EDGE_BLOCKED') ||
    priceReasonCodes.includes('PROXY_EDGE_CAPPED') ||
    reasonCodes.some((code) => code.startsWith('PASS_EXECUTION_GATE_'))
  ) {
    return 'odds-blocked';
  }

  if (
    play.transform_meta?.quality === 'BROKEN' ||
    reasonCodes.some((code) => DATA_ERROR_PASS_CODES.has(code))
  ) {
    return 'data-error';
  }

  if (reasonCodes.length > 0) return 'odds-blocked';

  return null;
}

export function classifySportDiagnosticBucket(card: GameCard): SportDiagnosticBucket {
  const codes = getReasonCodes(card);
  const missingInputs = getMissingInputs(card);

  if (codes.includes('MISSING_DATA_NO_ODDS') || missingInputs.includes('odds_timestamp')) {
    return 'noOdds';
  }

  if (
    codes.includes('MISSING_DATA_TEAM_MAPPING') ||
    codes.includes('MISSING_DATA_NO_PLAYS') ||
    codes.includes('PASS_MISSING_MARKET_TYPE')
  ) {
    return 'missingMapping';
  }

  if (codes.includes('MISSING_DATA_DRIVERS') || codes.includes('PASS_DATA_ERROR')) {
    return 'driverLoadFailed';
  }

  if (
    codes.includes('PROJECTION_ONLY_EXCLUSION') ||
    card.play?.pass_reason_code === 'PROJECTION_ONLY'
  ) {
    return 'projectionOnly';
  }

  if (codes.includes('MISSING_DATA_PROJECTION_INPUTS')) {
    return 'noProjection';
  }

  return 'noProjection';
}

export function countBlockedDiagnostics(buckets: SportDiagnosticCounts): number {
  return DIAGNOSTIC_BUCKET_ORDER.reduce((sum, bucket) => sum + buckets[bucket], 0);
}
