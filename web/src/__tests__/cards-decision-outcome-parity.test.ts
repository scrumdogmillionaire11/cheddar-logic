import assert from 'node:assert';
import { createRequire } from 'node:module';
import cheddarData from '@cheddar-logic/data';

import { resolvePlayDisplayDecision } from '../lib/game-card/decision';

const require = createRequire(import.meta.url);

const sharedCorpus = require('@cheddar-logic/data/fixtures/decision-outcome-parity-shared-corpus.json') as Array<unknown>;
const expected = require('./fixtures/cards-decision-outcome-parity.expected.json') as {
  corpusSize: number;
  counts: { FIRE: number; HOLD: number; PASS: number };
  fixtures: Array<{ id: string; action: 'FIRE' | 'HOLD' | 'PASS' }>;
};

const buildDecisionOutcomeFromDecisionV2 = (
  cheddarData as {
    buildDecisionOutcomeFromDecisionV2: (decisionV2: unknown) => {
      status: 'PLAY' | 'SLIGHT_EDGE' | 'PASS';
      reasons?: { blockers?: string[] };
    };
  }
).buildDecisionOutcomeFromDecisionV2;

assert.strictEqual(sharedCorpus.length, expected.corpusSize, 'shared corpus size drifted from expected baseline');

const actualCounts = { FIRE: 0, HOLD: 0, PASS: 0 };

for (let index = 0; index < expected.fixtures.length; index += 1) {
  const fixture = expected.fixtures[index];
  const decision = sharedCorpus[index];

  const decisionOutcome = buildDecisionOutcomeFromDecisionV2(decision);

  const display = resolvePlayDisplayDecision({
    decision_v2: decision as never,
    decision_outcome: decisionOutcome,
  });

  actualCounts[display.action] += 1;

  assert.strictEqual(
    display.action,
    fixture.action,
    `${fixture.id}: cards action parity mismatch`,
  );
}

assert.deepStrictEqual(actualCounts, expected.counts, 'cards status/count parity mismatch');
console.log(`cards-decision-outcome parity passed (${expected.corpusSize} fixtures)`);
