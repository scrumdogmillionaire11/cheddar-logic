import assert from 'node:assert';

import { resolvePlayDisplayDecision } from '../lib/game-card/decision';
import {
  isNativeTotalBiasActionable,
  resolveLiveOfficialStatus,
} from '../lib/games/route-handler';
import { readRuntimeCanonicalDecision } from '../lib/runtime-decision-authority';

// resolveDecisionTier now returns canonical status directly
function resolveDecisionTier(payload: Record<string, unknown> | null): 'PLAY' | 'LEAN' | 'PASS' {
  return readRuntimeCanonicalDecision(payload, { stage: 'read_api' }).officialStatus;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Flag ON: canonical PASS payload → all surfaces return PASS
// ---------------------------------------------------------------------------
withEnv({ ENFORCE_CANONICAL_DECISION_ONLY: 'true', ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST: 'false' }, () => {
  const canonicalPayload = {
    decision_v2: {
      official_status: 'PASS',
      canonical_envelope_v2: { official_status: 'PASS' },
    },
  };

  assert.strictEqual(resolvePlayDisplayDecision(canonicalPayload as never).action, 'PASS');
  assert.strictEqual(resolveLiveOfficialStatus(canonicalPayload as never), 'PASS');
  assert.strictEqual(resolveDecisionTier(canonicalPayload as Record<string, unknown>), 'PASS');
});

// ---------------------------------------------------------------------------
// Flag ON: legacy-only payload (no decision_v2) → all surfaces return PASS
// ---------------------------------------------------------------------------
withEnv({ ENFORCE_CANONICAL_DECISION_ONLY: 'true', ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST: 'false' }, () => {
  const legacyOnlyPayload = { action: 'FIRE', classification: 'BASE', status: 'PLAY' };

  assert.strictEqual(resolvePlayDisplayDecision(legacyOnlyPayload as never).action, 'PASS', 'cards must be PASS on legacy-only, flag ON');
  assert.strictEqual(resolveLiveOfficialStatus(legacyOnlyPayload as never), 'PASS', 'games must be PASS on legacy-only, flag ON');
  assert.strictEqual(resolveDecisionTier(legacyOnlyPayload as Record<string, unknown>), 'PASS', 'results must be PASS on legacy-only, flag ON');
});

// ---------------------------------------------------------------------------
// Flag OFF: legacy-only payload still returns PASS (no inference ever)
// ---------------------------------------------------------------------------
withEnv({ ENFORCE_CANONICAL_DECISION_ONLY: 'false', ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST: 'false' }, () => {
  const legacyOnlyPayload = { action: 'FIRE', classification: 'BASE', status: 'PLAY' };

  assert.strictEqual(resolvePlayDisplayDecision(legacyOnlyPayload as never).action, 'PASS', 'cards must still be PASS on legacy-only, flag OFF');
  assert.strictEqual(resolveLiveOfficialStatus(legacyOnlyPayload as never), 'PASS', 'games must still be PASS on legacy-only, flag OFF');
  assert.strictEqual(resolveDecisionTier(legacyOnlyPayload as Record<string, unknown>), 'PASS', 'results must still be PASS on legacy-only, flag OFF');
});

// ---------------------------------------------------------------------------
// Flag OFF: canonical PLAY payload → PLAY (flag off does not break canonical reads)
// ---------------------------------------------------------------------------
withEnv({ ENFORCE_CANONICAL_DECISION_ONLY: 'false', ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST: 'false' }, () => {
  const canonicalPlay = { decision_v2: { official_status: 'PLAY' } };

  const result = readRuntimeCanonicalDecision(canonicalPlay as never);
  assert.strictEqual(result.officialStatus, 'PLAY', 'canonical PLAY must resolve to PLAY regardless of flag state');
  assert.strictEqual(result.isActionable, true, 'canonical PLAY must be actionable');
});

// ---------------------------------------------------------------------------
// MLB full-game legacy (no decision_v2) preserves native PLAY/SLIGHT EDGE/PASS
// ---------------------------------------------------------------------------
{
  const mlbLegacyLeanPayload = {
    cardType: 'mlb-full-game',
    market_type: 'TOTAL',
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    final_market_decision: { surfaced_status: 'SLIGHT EDGE' },
  };
  assert.strictEqual(
    resolvePlayDisplayDecision(mlbLegacyLeanPayload as never).action,
    'HOLD',
    'MLB full-game legacy SLIGHT EDGE must remain HOLD/LEAN',
  );

  const mlbLegacyPlayPayload = {
    cardType: 'mlb-full-game',
    market_type: 'TOTAL',
    action: 'FIRE',
    classification: 'BASE',
    status: 'FIRE',
  };
  assert.strictEqual(
    resolvePlayDisplayDecision(mlbLegacyPlayPayload as never).action,
    'FIRE',
    'MLB full-game legacy PLAY must remain FIRE',
  );

  const mlbLegacyPassPayload = {
    cardType: 'mlb-full-game',
    market_type: 'TOTAL',
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
  };
  assert.strictEqual(
    resolvePlayDisplayDecision(mlbLegacyPassPayload as never).action,
    'PASS',
    'MLB full-game legacy PASS must remain PASS',
  );
}

// ---------------------------------------------------------------------------
// Modern MLB decision_v2 remains authoritative over native legacy fields
// ---------------------------------------------------------------------------
{
  const modernMlbPayload = {
    cardType: 'mlb-full-game',
    market_type: 'TOTAL',
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    decision_v2: {
      official_status: 'PLAY',
      canonical_envelope_v2: { official_status: 'PLAY' },
    },
  };
  assert.strictEqual(
    resolvePlayDisplayDecision(modernMlbPayload as never).action,
    'FIRE',
    'decision_v2 must override native legacy PASS fields for modern MLB rows',
  );
}

// ---------------------------------------------------------------------------
// Non-MLB legacy rows without decision_v2 remain fail-closed PASS
// ---------------------------------------------------------------------------
{
  const nonMlbLegacyPayload = {
    cardType: 'nhl-moneyline-call',
    market_type: 'MONEYLINE',
    action: 'FIRE',
    classification: 'BASE',
    status: 'FIRE',
  };
  assert.strictEqual(
    resolvePlayDisplayDecision(nonMlbLegacyPayload as never).action,
    'PASS',
    'non-MLB rows must not bypass canonical fail-closed behavior',
  );
}

// ---------------------------------------------------------------------------
// Native total bias eligibility remains true for actionable MLB legacy totals
// ---------------------------------------------------------------------------
{
  assert.strictEqual(
    isNativeTotalBiasActionable({
      market_type: 'TOTAL',
      status: 'WATCH',
      line: 8.5,
      edge_pct: 0.06,
      edge: 0.06,
    }),
    true,
    'native actionable total rows must continue to set total_bias eligibility true',
  );
}

// ---------------------------------------------------------------------------
// Lifecycle: present on canonical result
// ---------------------------------------------------------------------------
withEnv({ ENFORCE_CANONICAL_DECISION_ONLY: 'false' }, () => {
  const payloadWithLifecycle = {
    decision_v2: {
      official_status: 'PLAY',
      lifecycle: [{ stage: 'publisher', status: 'CLEARED', reason_code: 'OK' }],
    },
  };

  const result = readRuntimeCanonicalDecision(payloadWithLifecycle as never);
  assert.ok(Array.isArray(result.lifecycle), 'lifecycle must be an array');
  assert.ok(result.lifecycle.length > 0, 'lifecycle must be non-empty when present in payload');
  assert.strictEqual(result.lifecycle[0].stage, 'publisher', 'lifecycle stage must be preserved');
  assert.strictEqual(result.lifecycle[0].status, 'CLEARED', 'lifecycle status must be preserved');
});

// ---------------------------------------------------------------------------
// Lifecycle: missing canonical decision emits explicit failure lifecycle entry
// ---------------------------------------------------------------------------
withEnv({ ENFORCE_CANONICAL_DECISION_ONLY: 'false', ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST: 'false' }, () => {
  const result = readRuntimeCanonicalDecision(null);
  assert.ok(result.missingCanonicalDecision, 'missingCanonicalDecision must be true');
  assert.ok(Array.isArray(result.lifecycle) && result.lifecycle.length > 0, 'must emit failure lifecycle entry when canonical missing');
  assert.strictEqual(result.lifecycle[0].stage, 'read_api', 'failure lifecycle entry stage must be read_api');
  assert.strictEqual(result.lifecycle[0].reason_code, 'MISSING_CANONICAL_DECISION', 'failure lifecycle entry must have MISSING_CANONICAL_DECISION reason');
});

// ---------------------------------------------------------------------------
// Strict test mode: throws on missing canonical decision
// ---------------------------------------------------------------------------
{
  const prevEnforce = process.env.ENFORCE_CANONICAL_DECISION_ONLY;
  const prevStrict = process.env.ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST;
  process.env.ENFORCE_CANONICAL_DECISION_ONLY = 'true';
  process.env.ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST = 'true';
  try {
    assert.throws(
      () => readRuntimeCanonicalDecision(null, { stage: 'read_api' }),
      /Canonical decision missing/,
    );
  } finally {
    process.env.ENFORCE_CANONICAL_DECISION_ONLY = prevEnforce;
    process.env.ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST = prevStrict;
  }
}

console.log('Decision authority single-source runtime behavior tests passed');
