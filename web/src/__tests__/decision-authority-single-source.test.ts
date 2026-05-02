import assert from 'node:assert';

import { resolvePlayDisplayDecision } from '../lib/game-card/decision';
import {
  isNativeTotalBiasActionable,
  resolveLiveOfficialStatus,
} from '../lib/games/route-handler';
import { readRuntimeCanonicalDecision } from '../lib/runtime-decision-authority';

// resolveDecisionTier now returns canonical status directly
function resolveDecisionTier(payload: Record<string, unknown> | null): 'PLAY' | 'LEAN' | 'PASS' | 'INVALID' {
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
// Invalid enforcement ON: legacy-only payload (no decision_v2) → INVALID/null
// ---------------------------------------------------------------------------
withEnv({ ENABLE_INVALID_DECISION_ENFORCEMENT: 'true', ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST: 'false' }, () => {
  const legacyOnlyPayload = { action: 'FIRE', classification: 'BASE', status: 'PLAY' };

  assert.strictEqual(resolvePlayDisplayDecision(legacyOnlyPayload as never).action, null, 'cards must be null/hidden on legacy-only payload when INVALID enforcement is ON');
  assert.strictEqual(resolveLiveOfficialStatus(legacyOnlyPayload as never), 'INVALID', 'games must resolve INVALID on legacy-only payload when INVALID enforcement is ON');
  assert.strictEqual(resolveDecisionTier(legacyOnlyPayload as Record<string, unknown>), 'INVALID', 'results must resolve INVALID on legacy-only payload when INVALID enforcement is ON');
});

// ---------------------------------------------------------------------------
// Kill switch OFF: legacy-only payload still fails closed without decision_v2
// ---------------------------------------------------------------------------
withEnv({ ENABLE_INVALID_DECISION_ENFORCEMENT: 'false', ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST: 'false' }, () => {
  const legacyOnlyPayload = { action: 'FIRE', classification: 'BASE', status: 'PLAY' };

  assert.strictEqual(resolvePlayDisplayDecision(legacyOnlyPayload as never).action, null, 'cards must remain null/hidden on legacy-only payload when kill switch is OFF');
  assert.strictEqual(resolveLiveOfficialStatus(legacyOnlyPayload as never), 'INVALID', 'games must remain INVALID on legacy-only payload when kill switch is OFF');
  assert.strictEqual(resolveDecisionTier(legacyOnlyPayload as Record<string, unknown>), 'INVALID', 'results must remain INVALID on legacy-only payload when kill switch is OFF');
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
// MLB full-game legacy (no decision_v2) is also invalid under canonical-only rules
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
    null,
    'MLB full-game legacy rows must not infer HOLD without decision_v2',
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
    null,
    'MLB full-game legacy rows must not infer FIRE without decision_v2',
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
    null,
    'MLB full-game legacy rows must not infer PASS without decision_v2',
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
// Non-MLB legacy rows without decision_v2 are invalid
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
    null,
    'non-MLB rows without decision_v2 must resolve as INVALID (no action)',
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
  assert.strictEqual(result.officialStatus, 'INVALID', 'missing canonical decision must resolve to INVALID');
  assert.strictEqual(result.action, null, 'missing canonical decision must not produce a betting action');
  assert.ok(Array.isArray(result.lifecycle) && result.lifecycle.length > 0, 'must emit failure lifecycle entry when canonical missing');
  assert.strictEqual(result.lifecycle[0].stage, 'read_api', 'failure lifecycle entry stage must be read_api');
  assert.strictEqual(result.lifecycle[0].reason_code, 'MISSING_DECISION_V2', 'failure lifecycle entry must have MISSING_DECISION_V2 reason');
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
