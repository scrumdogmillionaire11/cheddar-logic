import assert from 'node:assert';
import { createRequire } from 'node:module';
import cheddarData from '@cheddar-logic/data';
import { hasActionableProjectionCall } from '../app/api/results/projection-metrics';

const require = createRequire(import.meta.url);

const sharedCorpus = require('@cheddar-logic/data/fixtures/decision-outcome-parity-shared-corpus.json') as Array<unknown>;
const expected = require('./fixtures/results-decision-outcome-parity.expected.json') as {
  corpusSize: number;
  tierCounts: { PLAY: number; LEAN: number; PASS: number };
  actionableCounts: { true: number; false: number };
  fixtures: Array<{ id: string; tier: 'PLAY' | 'LEAN' | 'PASS'; actionable: boolean }>;
};

function buildPayload(decision: unknown) {
  return {
    play: {
      decision_v2: decision,
    },
  } as Record<string, unknown>;
}

const buildDecisionOutcomeFromDecisionV2 = (
  cheddarData as {
    buildDecisionOutcomeFromDecisionV2: (decisionV2: unknown) => {
      status: 'PLAY' | 'SLIGHT_EDGE' | 'PASS';
    };
  }
).buildDecisionOutcomeFromDecisionV2;

function resolveTierFromOutcomeStatus(
  status: 'PLAY' | 'SLIGHT_EDGE' | 'PASS',
): 'PLAY' | 'LEAN' | 'PASS' {
  if (status === 'PLAY') return 'PLAY';
  if (status === 'SLIGHT_EDGE') return 'LEAN';
  return 'PASS';
}

assert.strictEqual(sharedCorpus.length, expected.corpusSize, 'shared corpus size drifted from expected baseline');

const tierCounts = { PLAY: 0, LEAN: 0, PASS: 0 };
const actionableCounts = { true: 0, false: 0 };

for (let index = 0; index < expected.fixtures.length; index += 1) {
  const fixture = expected.fixtures[index];
  const decisionV2 = sharedCorpus[index];
  const payload = buildPayload(decisionV2);

  const outcome = buildDecisionOutcomeFromDecisionV2(decisionV2);
  const tier = resolveTierFromOutcomeStatus(outcome.status);
  const actionable = hasActionableProjectionCall(payload);

  tierCounts[tier] += 1;
  actionableCounts[String(actionable) as 'true' | 'false'] += 1;

  assert.strictEqual(tier, fixture.tier, `${fixture.id}: results tier parity mismatch`);
  assert.strictEqual(
    actionable,
    fixture.actionable,
    `${fixture.id}: results actionable parity mismatch`,
  );
}

assert.deepStrictEqual(tierCounts, expected.tierCounts);
assert.deepStrictEqual(actionableCounts, expected.actionableCounts);
console.log(`results-decision-outcome parity passed (${expected.corpusSize} fixtures)`);
