export const PROJECTION_ONLY_LINE_SOURCES = [
  'projection_floor',
  'synthetic',
  'synthetic_fallback',
];

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
  if (!payload) return true;

  const basis = String(
    getPayloadString(payload, ['decision_basis_meta', 'decision_basis']) ||
      getPayloadString(payload, ['basis']) ||
      '',
  ).toUpperCase();
  if (basis === 'PROJECTION_ONLY') return false;

  const executionStatus = String(
    getPayloadString(payload, ['execution_status']) ||
      getPayloadString(payload, ['play', 'execution_status']) ||
      getPayloadString(payload, ['prop_display_state']) ||
      getPayloadString(payload, ['play', 'prop_display_state']) ||
      '',
  ).toUpperCase();
  if (executionStatus === 'PROJECTION_ONLY') return false;

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
  if (PROJECTION_ONLY_LINE_SOURCES.includes(lineSource)) return false;

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
  if (projectionSource === 'SYNTHETIC_FALLBACK') return false;

  return true;
}
