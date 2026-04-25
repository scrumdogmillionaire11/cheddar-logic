export const PROJECTION_ONLY_LINE_SOURCES = [
  'projection_floor',
  'synthetic',
  'synthetic_fallback',
];

export type BettingSurfacePayloadDropReason =
  | 'PROJECTION_ONLY_BASIS'
  | 'PROJECTION_ONLY_EXECUTION_STATUS'
  | 'PROJECTION_ONLY_LINE_SOURCE'
  | 'SYNTHETIC_FALLBACK_PROJECTION_SOURCE';

export function safeJsonParse(payload: string | null) {
  if (!payload) return { data: null, error: true };
  try {
    return { data: JSON.parse(payload), error: false };
  } catch {
    return { data: null, error: true };
  }
}

export function normalizePayloadMeta(payload: Record<string, unknown> | null) {
  if (!payload || typeof payload !== 'object') return payload;
  return payload;
}

export function getPayloadString(
  payload: Record<string, unknown> | null,
  path: string[],
): string | null {
  let current: unknown = payload;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current !== 'string') return null;
  const normalized = current.trim();
  return normalized.length > 0 ? normalized : null;
}

export function isBettingSurfacePayload(
  payload: Record<string, unknown> | null,
): boolean {
  return getBettingSurfacePayloadDropReason(payload) === null;
}

export function getBettingSurfacePayloadDropReason(
  payload: Record<string, unknown> | null,
): BettingSurfacePayloadDropReason | null {
  // Missing or unparsable payloads stay visible; callers mark parse status
  // separately instead of hiding historical cards with malformed JSON.
  if (!payload) return null;

  const basis = String(
    getPayloadString(payload, ['decision_basis_meta', 'decision_basis']) ||
      getPayloadString(payload, ['basis']) ||
      '',
  ).toUpperCase();
  if (basis === 'PROJECTION_ONLY') return 'PROJECTION_ONLY_BASIS';

  const executionStatus = String(
    getPayloadString(payload, ['execution_status']) ||
      getPayloadString(payload, ['play', 'execution_status']) ||
      getPayloadString(payload, ['prop_display_state']) ||
      getPayloadString(payload, ['play', 'prop_display_state']) ||
      '',
  ).toUpperCase();
  if (executionStatus === 'PROJECTION_ONLY') {
    return 'PROJECTION_ONLY_EXECUTION_STATUS';
  }

  const lineSource = String(
    getPayloadString(payload, [
      'decision_basis_meta',
      'market_line_source',
    ]) ||
      getPayloadString(payload, ['market_context', 'wager', 'line_source']) ||
      getPayloadString(payload, [
        'play',
        'market_context',
        'wager',
        'line_source',
      ]) ||
      getPayloadString(payload, ['line_source']) ||
      getPayloadString(payload, ['play', 'line_source']) ||
      '',
  ).toLowerCase();
  if (PROJECTION_ONLY_LINE_SOURCES.includes(lineSource)) {
    return 'PROJECTION_ONLY_LINE_SOURCE';
  }

  const projectionSource = String(
    getPayloadString(payload, ['prop_decision', 'projection_source']) ||
      getPayloadString(payload, [
        'play',
        'prop_decision',
        'projection_source',
      ]) ||
      getPayloadString(payload, ['projection_source']) ||
      getPayloadString(payload, ['play', 'projection_source']) ||
      '',
  ).toUpperCase();
  if (projectionSource === 'SYNTHETIC_FALLBACK') {
    return 'SYNTHETIC_FALLBACK_PROJECTION_SOURCE';
  }

  return null;
}

export interface ShadowCompareTelemetry {
  legacy_count: number;
  simplified_count: number;
  delta: number;
  by_card_type: Array<{
    card_type: string;
    legacy_count: number;
    simplified_count: number;
    delta: number;
  }>;
}

export function buildShadowCompareTelemetry(
  legacyCardTypes: string[],
  simplifiedCardTypes: string[],
): ShadowCompareTelemetry {
  const legacyCounts = new Map<string, number>();
  for (const ct of legacyCardTypes) {
    legacyCounts.set(ct, (legacyCounts.get(ct) ?? 0) + 1);
  }
  const simplifiedCounts = new Map<string, number>();
  for (const ct of simplifiedCardTypes) {
    simplifiedCounts.set(ct, (simplifiedCounts.get(ct) ?? 0) + 1);
  }
  const allTypes = new Set([...legacyCounts.keys(), ...simplifiedCounts.keys()]);
  const by_card_type = Array.from(allTypes)
    .map((ct) => {
      const lc = legacyCounts.get(ct) ?? 0;
      const sc = simplifiedCounts.get(ct) ?? 0;
      return { card_type: ct, legacy_count: lc, simplified_count: sc, delta: sc - lc };
    })
    .sort((a, b) => a.card_type.localeCompare(b.card_type));
  return {
    legacy_count: legacyCardTypes.length,
    simplified_count: simplifiedCardTypes.length,
    delta: simplifiedCardTypes.length - legacyCardTypes.length,
    by_card_type,
  };
}
