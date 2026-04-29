import assert from 'node:assert';
import { createRequire } from 'node:module';
import cheddarData from '@cheddar-logic/data';

import { resolveLiveOfficialStatus } from '../lib/games/route-handler';

const require = createRequire(import.meta.url);

const sharedCorpus = require('@cheddar-logic/data/fixtures/decision-outcome-parity-shared-corpus.json') as Array<unknown>;
const expected = require('./fixtures/games-decision-outcome-parity.expected.json') as {
  corpusSize: number;
  counts: { PLAY: number; LEAN: number; PASS: number };
  fixtures: Array<{ id: string; status: 'PLAY' | 'LEAN' | 'PASS' }>;
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

const actualCounts = { PLAY: 0, LEAN: 0, PASS: 0 };

for (let index = 0; index < expected.fixtures.length; index += 1) {
  const fixture = expected.fixtures[index];
  const decision = sharedCorpus[index];

  const decisionOutcome = buildDecisionOutcomeFromDecisionV2(decision);
  const observed = resolveLiveOfficialStatus({
    decision_v2: decision as never,
    decision_outcome: decisionOutcome,
  } as never);

  actualCounts[observed] += 1;
  assert.strictEqual(observed, fixture.status, `${fixture.id}: games status parity mismatch`);
}

assert.deepStrictEqual(actualCounts, expected.counts, 'games status/count parity mismatch');
console.log(`games-decision-outcome parity passed (${expected.corpusSize} fixtures)`);

// This script imports a heavy route module that can keep active handles open.
// Exit explicitly after assertions/logging so CI does not hang.
process.exit(0);
