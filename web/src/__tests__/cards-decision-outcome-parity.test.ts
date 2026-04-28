import assert from 'node:assert';
import cheddarData from '@cheddar-logic/data';

import { resolvePlayDisplayDecision } from '../lib/game-card/decision';

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
    blocking_reason_codes: ['BLOCK_INJURY_RISK'],
  };
}

function expectedActionFromOfficialStatus(status: OfficialStatus): 'FIRE' | 'HOLD' | 'PASS' {
  if (status === 'PLAY') return 'FIRE';
  if (status === 'LEAN') return 'HOLD';
  return 'PASS';
}

const fixtures = Array.from({ length: 60 }, (_, idx) => ({
  id: `fixture-${idx + 1}`,
  decision: buildFixtureDecision(idx),
}));

const expectedCounts = { FIRE: 0, HOLD: 0, PASS: 0 };
const actualCounts = { FIRE: 0, HOLD: 0, PASS: 0 };

for (const fixture of fixtures) {
  const expectedAction = expectedActionFromOfficialStatus(fixture.decision.official_status);
  expectedCounts[expectedAction] += 1;

  const decisionOutcome = buildDecisionOutcomeFromDecisionV2(fixture.decision);

  const display = resolvePlayDisplayDecision({
    decision_v2: fixture.decision as never,
    decision_outcome: decisionOutcome,
  });

  actualCounts[display.action] += 1;

  assert.strictEqual(
    display.action,
    expectedAction,
    `${fixture.id}: cards action parity mismatch`,
  );

  if (fixture.decision.official_status === 'PASS') {
    assert.ok(
      Array.isArray(decisionOutcome.reasons?.blockers) &&
        (decisionOutcome.reasons?.blockers?.length || 0) > 0,
      `${fixture.id}: PASS outcomes must keep blocker reasons`,
    );
  }
}

assert.deepStrictEqual(actualCounts, expectedCounts, 'cards status/count parity mismatch');
console.log('cards-decision-outcome parity passed (60 fixtures)');
