/**
 * Single web-side decision read adapter.
 *
 * Imports the pure `resolveCanonicalDecision` function from the shared
 * `@cheddar-logic/models/decision-authority` sub-path.  That file has zero
 * server-only dependencies (no better-sqlite3, no fs) so it is safe to use
 * in both server and client bundles.
 *
 * IMPORTANT: This module must NEVER inline decision logic.  All semantics
 * live exclusively in packages/models/src/decision-authority.js.
 */

import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const { resolveCanonicalDecision } = _require('@cheddar-logic/models/decision-authority') as {
  resolveCanonicalDecision: (
    payload: object | null,
    options?: {
      stage?: string;
      fallbackToLegacy?: boolean;
      strictSource?: boolean;
      missingReasonCode?: string;
    },
  ) => {
    official_status: string;
    is_actionable: boolean;
    reason_code: string;
    lifecycle: Array<{ stage: string; status: string; reason_code: string }>;
  } | null;
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CanonicalLifecycleEntry = {
  stage: string;
  status: string;
  reason_code: string;
};

export type RuntimeCanonicalDecision = {
  officialStatus: 'PLAY' | 'LEAN' | 'PASS';
  action: 'FIRE' | 'HOLD' | 'PASS';
  classification: 'BASE' | 'LEAN' | 'PASS';
  status: 'FIRE' | 'WATCH' | 'PASS';
  isActionable: boolean;
  reasonCode: string;
  missingCanonicalDecision: boolean;
  lifecycle: CanonicalLifecycleEntry[];
};

export type LifecycleModeForFallback = 'pregame' | 'active';

type CanonicalDecisionPayload = {
  decision_v2?: Record<string, unknown> | null;
  canonical_decision?: Record<string, unknown> | null;
  action?: unknown;
  classification?: unknown;
  status?: unknown;
  pass_reason_code?: unknown;
};

type ReadRuntimeDecisionOptions = {
  stage?: 'parser' | 'model' | 'publisher' | 'watchdog' | 'read_api';
};

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const MISSING_CANONICAL_DECISION_REASON = 'MISSING_CANONICAL_DECISION';

const MISSING_CANONICAL_LIFECYCLE: CanonicalLifecycleEntry[] = [
  {
    stage: 'read_api',
    status: 'PASS',
    reason_code: MISSING_CANONICAL_DECISION_REASON,
  },
];

// ---------------------------------------------------------------------------
// Internal helpers (mapping only — no decision semantics)
// ---------------------------------------------------------------------------

function canonicalStatusToOfficialStatus(
  raw: string,
): 'PLAY' | 'LEAN' | 'PASS' {
  const s = raw.toUpperCase();
  if (s === 'PLAY') return 'PLAY';
  if (s === 'SLIGHT_EDGE') return 'LEAN';
  return 'PASS';
}

function actionFromOfficialStatus(
  officialStatus: 'PLAY' | 'LEAN' | 'PASS',
): 'FIRE' | 'HOLD' | 'PASS' {
  if (officialStatus === 'PLAY') return 'FIRE';
  if (officialStatus === 'LEAN') return 'HOLD';
  return 'PASS';
}

function classificationFromAction(
  action: 'FIRE' | 'HOLD' | 'PASS',
): 'BASE' | 'LEAN' | 'PASS' {
  if (action === 'FIRE') return 'BASE';
  if (action === 'HOLD') return 'LEAN';
  return 'PASS';
}

function statusFromAction(
  action: 'FIRE' | 'HOLD' | 'PASS',
): 'FIRE' | 'WATCH' | 'PASS' {
  if (action === 'HOLD') return 'WATCH';
  if (action === 'FIRE') return 'FIRE';
  return 'PASS';
}

// ---------------------------------------------------------------------------
// Feature flag helpers
// ---------------------------------------------------------------------------

export function isCanonicalDecisionOnlyEnforced(): boolean {
  return process.env.ENFORCE_CANONICAL_DECISION_ONLY === 'true';
}

export function isCanonicalDecisionStrictTestModeEnabled(): boolean {
  return process.env.ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST === 'true';
}

// ---------------------------------------------------------------------------
// Active-mode run-scope gate (exported for tests)
// ---------------------------------------------------------------------------

/** Active mode is fail-closed: never widen from scoped runs to global history. */
export function shouldApplyGlobalRunFallback(
  lifecycleMode: LifecycleModeForFallback | string,
): boolean {
  return lifecycleMode !== 'active';
}

// ---------------------------------------------------------------------------
// Core read adapter
// ---------------------------------------------------------------------------

/**
 * Read the canonical decision from a card/play payload.
 *
 * - NEVER falls back to legacy action/classification/status fields.
 * - Feature flag controls only whether a missing canonical decision throws
 *   (strict test mode) — it does NOT restore legacy inference.
 * - Always returns full lifecycle so callers can surface failure traces.
 */
export function readRuntimeCanonicalDecision(
  payload: CanonicalDecisionPayload | null | undefined,
  options: ReadRuntimeDecisionOptions = {},
): RuntimeCanonicalDecision {
  const strictTestMode = isCanonicalDecisionStrictTestModeEnabled();

  const canonical = resolveCanonicalDecision(payload ?? null, {
    stage: options.stage ?? 'read_api',
    // Legacy fallback is permanently disabled on web read paths.
    // The feature flag controls strictness (throw vs silent PASS), not inference.
    fallbackToLegacy: false,
    strictSource: true,
    missingReasonCode: MISSING_CANONICAL_DECISION_REASON,
  });

  if (!canonical) {
    if (strictTestMode) {
      throw new Error('Canonical decision missing');
    }

    return {
      officialStatus: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      status: 'PASS',
      isActionable: false,
      reasonCode: MISSING_CANONICAL_DECISION_REASON,
      missingCanonicalDecision: true,
      lifecycle: MISSING_CANONICAL_LIFECYCLE,
    };
  }

  const officialStatus = canonicalStatusToOfficialStatus(canonical.official_status);
  const action = actionFromOfficialStatus(officialStatus);

  return {
    officialStatus,
    action,
    classification: classificationFromAction(action),
    status: statusFromAction(action),
    isActionable: Boolean(canonical.is_actionable),
    reasonCode: String(canonical.reason_code || MISSING_CANONICAL_DECISION_REASON),
    missingCanonicalDecision: false,
    lifecycle: Array.isArray(canonical.lifecycle) ? canonical.lifecycle : [],
  };
}
