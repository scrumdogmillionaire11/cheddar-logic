import assert from 'node:assert';
import cheddarData from '@cheddar-logic/data';

import { resolveLiveOfficialStatus } from '../lib/games/route-handler';

type OfficialStatus = 'PLAY' | 'LEAN' | 'PASS';

const buildDecisionOutcomeFromDecisionV2 = (
  cheddarData as {
    buildDecisionOutcomeFromDecisionV2: (decisionV2: unknown) => {
      status: 'PLAY' | 'SLIGHT_EDGE' | 'PASS';
      reasons?: { blockers?: string[] };
    };
  }
).buildDecisionOutcomeFromDecisionV2;

function buildFixtureDecision(index: number): { official_status: OfficialStatus; primary_reason_code?: string; blocking_reason_codes?: string[] } {
  if (index % 3 === 0) return { official_status: 'PLAY' };
  if (index % 3 === 1) return { official_status: 'LEAN', primary_reason_code: 'EDGE_FOUND' };
  return {
    official_status: 'PASS',
    primary_reason_code: 'PASS_NO_EDGE',
    blocking_reason_codes: ['BLOCK_MARKET_STALE'],
  };
}

const fixtures = Array.from({ length: 60 }, (_, idx) => ({
  id: `fixture-${idx + 1}`,
  decision: buildFixtureDecision(idx),
}));

const expectedCounts = { PLAY: 0, LEAN: 0, PASS: 0 };
const actualCounts = { PLAY: 0, LEAN: 0, PASS: 0 };

for (const fixture of fixtures) {
  const expected = fixture.decision.official_status;
  expectedCounts[expected] += 1;

  const decisionOutcome = buildDecisionOutcomeFromDecisionV2(fixture.decision);
  const observed = resolveLiveOfficialStatus({
    decision_v2: fixture.decision as never,
    decision_outcome: decisionOutcome,
  } as never);

  actualCounts[observed] += 1;
  assert.strictEqual(observed, expected, `${fixture.id}: games status parity mismatch`);
}

assert.deepStrictEqual(actualCounts, expectedCounts, 'games status/count parity mismatch');
console.log('games-decision-outcome parity passed (60 fixtures)');
