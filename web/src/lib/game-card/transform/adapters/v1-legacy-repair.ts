/**
 * Versioned adapter boundary for v1 legacy payload shapes.
 *
 * V1 PAYLOAD SHAPE DEFINITION
 * Payloads written by the worker before the `decision_v2` canonical envelope was stabilized.
 * Identifying characteristics:
 *   - May have `decision_v2.official_status` directly on the decision object
 *     (not wrapped in `canonical_envelope_v2`)
 *   - May have `execution_gate.drop_reason` for dropped cards
 *   - Selection side may live at `decision_v2.selection_side`,
 *     `decision_v2.canonical_envelope_v2.selection_side`, or top-level `payload.prediction`
 *   - Market context lives at `payload.market_context.wager`, with line/price at
 *     `payload.line`/`payload.juice` or inside `wager.called_line`/`wager.called_price`
 *   - Snapshot timestamp may live at `payload.snapshot_at`, `payload.captured_at`,
 *     or `payload.created_at`
 *
 * All direct access to the v1 field topology is confined to this file. Callers receive
 * typed, semantic results and are shielded from the raw shape.
 */

import {
  firstString,
  firstNumber,
  normalizeSelectionSide,
} from '../../../games/normalizers';

// Re-export legacy-repair helpers so transform/index.ts has a single boundary import.
export {
  normalizeCardType,
  getSportCardTypeContract,
  isPlayItem,
  isEvidenceItem,
  isWelcomeHomePlay,
  getSourcePlayAction,
  resolveSourceModelProb,
} from '../legacy-repair';

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

/** Minimal row shape needed by getMlbFallbackSnapshotEpoch. */
export interface V1CardRowTimestamp {
  created_at: string;
}

// ---------------------------------------------------------------------------
// V1 payload probe helpers (previously in route-handler.ts)
// ---------------------------------------------------------------------------

/**
 * Resolves the official play status from a v1 payload.
 *
 * Probe order:
 *   1. `decision_v2.canonical_envelope_v2.official_status` (canonical envelope path)
 *   2. `decision_v2.official_status` (pre-envelope path, v1 legacy)
 */
export function resolveMlbFallbackOfficialStatus(
  payload: Record<string, unknown>,
): 'PLAY' | 'LEAN' | 'PASS' | null {
  const decisionV2 = toRecord(payload.decision_v2);
  const canonicalEnvelope = toRecord(decisionV2?.canonical_envelope_v2);
  const envelopeStatus = firstString(canonicalEnvelope?.official_status);
  if (envelopeStatus === 'PLAY' || envelopeStatus === 'LEAN' || envelopeStatus === 'PASS') {
    return envelopeStatus;
  }
  const official = firstString(decisionV2?.official_status);
  if (official === 'PLAY' || official === 'LEAN' || official === 'PASS') return official;
  return null;
}

/**
 * Returns true when the v1 payload has an execution-gate drop reason.
 * Dropped cards must not surface as actionable plays.
 */
export function hasMlbFallbackDropReason(payload: Record<string, unknown>): boolean {
  const executionGate = toRecord(payload.execution_gate);
  return Boolean(executionGate?.drop_reason);
}

/**
 * Returns true when the v1 payload contains an actionable (non-NONE) selection side.
 *
 * Probe order across four v1 field paths:
 *   1. `decision_v2.canonical_envelope_v2.selection_side`
 *   2. `decision_v2.selection_side`
 *   3. `selection.side`
 *   4. `prediction` (top-level)
 */
export function hasMlbFallbackActionableSelection(
  payload: Record<string, unknown>,
): boolean {
  const decisionV2 = toRecord(payload.decision_v2);
  const canonicalEnvelope = toRecord(decisionV2?.canonical_envelope_v2);
  const selectionObj = toRecord(payload.selection);
  const side = normalizeSelectionSide(
    firstString(
      canonicalEnvelope?.selection_side,
      decisionV2?.selection_side,
      selectionObj?.side,
      payload.prediction,
    ),
  );
  return Boolean(side && side !== 'NONE');
}

/**
 * Returns true when the v1 payload contains sufficient market context (line + price) for
 * the given card type.
 *
 * `mlb-full-game`: requires total line + price.
 * `mlb-full-game-ml`: requires home + away moneyline prices.
 */
export function hasMlbFallbackMarketContext(
  payload: Record<string, unknown>,
  cardType: string,
): boolean {
  const marketContext = toRecord(payload.market_context);
  const wager = toRecord(marketContext?.wager);
  const oddsContext = toRecord(payload.odds_context);
  if (cardType === 'mlb-full-game') {
    const line = firstNumber(
      payload.line,
      payload.total_line,
      wager?.called_line,
      oddsContext?.total,
    );
    const price = firstNumber(payload.price, payload.juice, wager?.called_price);
    return Number.isFinite(line) && Number.isFinite(price);
  }
  if (cardType === 'mlb-full-game-ml') {
    const homePrice = firstNumber(
      payload.ml_home,
      payload.h2h_home,
      oddsContext?.h2h_home,
      oddsContext?.ml_home,
    );
    const awayPrice = firstNumber(
      payload.ml_away,
      payload.h2h_away,
      oddsContext?.h2h_away,
      oddsContext?.ml_away,
    );
    return Number.isFinite(homePrice) && Number.isFinite(awayPrice);
  }
  return false;
}

/**
 * Resolves a Unix epoch ms from the v1 payload snapshot timestamp.
 *
 * Probe order:
 *   1. `payload.snapshot_at`
 *   2. `payload.captured_at`
 *   3. `payload.created_at`
 *   4. `row.created_at` (DB row timestamp, last fallback)
 *
 * Returns `NaN` if no parseable timestamp is found.
 */
export function getMlbFallbackSnapshotEpoch(
  row: V1CardRowTimestamp,
  payload: Record<string, unknown>,
): number {
  const snapshotCandidate = firstString(
    payload.snapshot_at,
    payload.captured_at,
    payload.created_at,
    row.created_at,
  );
  if (!snapshotCandidate) return Number.NaN;
  const parsed = Date.parse(snapshotCandidate);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
