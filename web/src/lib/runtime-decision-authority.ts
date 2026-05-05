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

import type { CanonicalDecisionResult } from '@cheddar-logic/models/decision-authority';
import * as _decisionAuthority from '@cheddar-logic/models/decision-authority';

const resolveCanonicalDecision = (
  _decisionAuthority as unknown as {
    resolveCanonicalDecision: (
      payload: object | null,
      options?: {
        stage?: string;
        fallbackToLegacy?: boolean;
        strictSource?: boolean;
        missingReasonCode?: string;
      },
    ) => CanonicalDecisionResult | null;
  }
).resolveCanonicalDecision;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CanonicalLifecycleEntry = {
  stage: string;
  status: string;
  reason_code: string;
};

type RuntimeCanonicalDecisionValid = {
  officialStatus: 'PLAY' | 'LEAN' | 'PASS';
  action: 'FIRE' | 'HOLD' | 'PASS';
  classification: 'BASE' | 'LEAN' | 'PASS';
  status: 'FIRE' | 'WATCH' | 'PASS';
  isActionable: boolean;
  reasonCode: string;
  missingCanonicalDecision: boolean;
  lifecycle: CanonicalLifecycleEntry[];
};

type RuntimeCanonicalDecisionInvalid = {
  officialStatus: 'INVALID';
  action: null;
  classification: null;
  status: null;
  isActionable: false;
  reasonCode: string;
  missingCanonicalDecision: true;
  lifecycle: CanonicalLifecycleEntry[];
};

export type RuntimeCanonicalDecision =
  | RuntimeCanonicalDecisionValid
  | RuntimeCanonicalDecisionInvalid;

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

const MISSING_CANONICAL_DECISION_REASON = 'MISSING_DECISION_V2';

const MISSING_CANONICAL_LIFECYCLE: CanonicalLifecycleEntry[] = [
  {
    stage: 'read_api',
    status: 'INVALID',
    reason_code: MISSING_CANONICAL_DECISION_REASON,
  },
];

// ---------------------------------------------------------------------------
// Internal helpers (mapping only — no decision semantics)
// ---------------------------------------------------------------------------

function canonicalStatusToOfficialStatus(
  raw: string,
): 'PLAY' | 'LEAN' | 'PASS' | 'INVALID' {
  const s = raw.toUpperCase();
  if (s === 'PLAY') return 'PLAY';
  if (s === 'SLIGHT_EDGE') return 'LEAN';
  if (s === 'INVALID') return 'INVALID';
  return 'PASS';
}

function actionFromOfficialStatus(
  officialStatus: 'PLAY' | 'LEAN' | 'PASS' | 'INVALID',
): 'FIRE' | 'HOLD' | 'PASS' | null {
  if (officialStatus === 'PLAY') return 'FIRE';
  if (officialStatus === 'LEAN') return 'HOLD';
  if (officialStatus === 'PASS') return 'PASS';
  return null;
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
  const hasCanonicalInput = Boolean(
    payload?.decision_v2 && typeof payload.decision_v2 === 'object',
  ) || Boolean(
    payload?.canonical_decision && typeof payload.canonical_decision === 'object',
  );

  if (!hasCanonicalInput) {
    if (strictTestMode) {
      throw new Error('Canonical decision missing');
    }

    return {
      officialStatus: 'INVALID',
      action: null,
      classification: null,
      status: null,
      isActionable: false,
      reasonCode: MISSING_CANONICAL_DECISION_REASON,
      missingCanonicalDecision: true,
      lifecycle: MISSING_CANONICAL_LIFECYCLE,
    };
  }

  const canonical = resolveCanonicalDecision(payload ?? null, {
    stage: options.stage ?? 'read_api',
    // Legacy fallback is permanently disabled on web read paths.
    // The feature flag controls strictness (throw vs INVALID), not inference.
    fallbackToLegacy: false,
    strictSource: true,
    missingReasonCode: MISSING_CANONICAL_DECISION_REASON,
  });

  if (!canonical) {
    if (strictTestMode) {
      throw new Error('Canonical decision missing');
    }

    return {
      officialStatus: 'INVALID',
      action: null,
      classification: null,
      status: null,
      isActionable: false,
      reasonCode: MISSING_CANONICAL_DECISION_REASON,
      missingCanonicalDecision: true,
      lifecycle: MISSING_CANONICAL_LIFECYCLE,
    };
  }

  const officialStatus = canonicalStatusToOfficialStatus(canonical.official_status);
  const action = actionFromOfficialStatus(officialStatus);

  if (officialStatus === 'INVALID' || action === null) {
    if (strictTestMode) {
      throw new Error('Canonical decision missing');
    }

    return {
      officialStatus: 'INVALID',
      action: null,
      classification: null,
      status: null,
      isActionable: false,
      reasonCode: String(canonical.reason_code || MISSING_CANONICAL_DECISION_REASON),
      missingCanonicalDecision: true,
      lifecycle: Array.isArray(canonical.lifecycle) ? canonical.lifecycle : MISSING_CANONICAL_LIFECYCLE,
    };
  }

  return {
    officialStatus,
    action,
    classification: action === 'FIRE' ? 'BASE' : action === 'HOLD' ? 'LEAN' : 'PASS',
    status: action === 'HOLD' ? 'WATCH' : action === 'FIRE' ? 'FIRE' : 'PASS',
    isActionable: Boolean(canonical.is_actionable),
    reasonCode: String(canonical.reason_code || MISSING_CANONICAL_DECISION_REASON),
    missingCanonicalDecision: false,
    lifecycle: Array.isArray(canonical.lifecycle) ? canonical.lifecycle : [],
  };
}
