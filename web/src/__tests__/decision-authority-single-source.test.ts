import assert from 'node:assert';

import { resolvePlayDisplayDecision } from '../lib/game-card/decision';
import { resolveLiveOfficialStatus } from '../lib/games/route-handler';
import { readRuntimeCanonicalDecision } from '../lib/runtime-decision-authority';

// resolveDecisionTier delegates to readRuntimeCanonicalDecision; test via the authority directly
function resolveDecisionTier(payload: Record<string, unknown> | null): 'PLAY' | 'LEAN' | 'PASS_OR_OTHER' {
  const d = readRuntimeCanonicalDecision(payload, { stage: 'read_api' });
  if (d.officialStatus === 'PLAY') return 'PLAY';
  if (d.officialStatus === 'LEAN') return 'LEAN';
  return 'PASS_OR_OTHER';
}

function withCanonicalOnlyEnv(fn: () => void): void {
  const prevEnforce = process.env.ENFORCE_CANONICAL_DECISION_ONLY;
  const prevStrict = process.env.ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST;
  process.env.ENFORCE_CANONICAL_DECISION_ONLY = 'true';
  process.env.ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST = 'false';
  try {
    fn();
  } finally {
    process.env.ENFORCE_CANONICAL_DECISION_ONLY = prevEnforce;
    process.env.ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST = prevStrict;
  }
}

withCanonicalOnlyEnv(() => {
  const canonicalPayload = {
    decision_v2: {
      official_status: 'PASS',
      canonical_envelope_v2: {
        official_status: 'PASS',
      },
    },
  };

  const cards = resolvePlayDisplayDecision(canonicalPayload as never);
  const games = resolveLiveOfficialStatus(canonicalPayload as never);
  const results = resolveDecisionTier(canonicalPayload as Record<string, unknown>);

  assert.strictEqual(cards.action, 'PASS');
  assert.strictEqual(games, 'PASS');
  assert.strictEqual(results, 'PASS_OR_OTHER');
});

withCanonicalOnlyEnv(() => {
  const missingCanonicalWithLegacy = {
    action: 'FIRE',
    classification: 'BASE',
    status: 'PLAY',
    play: {
      action: 'FIRE',
      status: 'PLAY',
    },
  };

  const cards = resolvePlayDisplayDecision(missingCanonicalWithLegacy as never);
  const games = resolveLiveOfficialStatus(missingCanonicalWithLegacy as never);
  const results = resolveDecisionTier(
    missingCanonicalWithLegacy as Record<string, unknown>,
  );

  assert.strictEqual(cards.action, 'PASS');
  assert.strictEqual(games, 'PASS');
  assert.strictEqual(results, 'PASS_OR_OTHER');
});

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
