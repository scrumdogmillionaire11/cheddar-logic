import assert from 'node:assert';
import cheddarData from '@cheddar-logic/data';
import { hasActionableProjectionCall } from '../app/api/results/projection-metrics';

type OfficialStatus = 'PLAY' | 'LEAN' | 'PASS';

function buildPayload(status: OfficialStatus) {
  return {
    play: {
      decision_v2: {
        official_status: status,
        selection: { market: 'NHL_1P_TOTAL', side: status === 'PASS' ? 'UNKNOWN' : 'OVER' },
        blocking_reason_codes: status === 'PASS' ? ['BLOCK_INPUTS_MISSING'] : [],
      },
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

const fixtures = Array.from({ length: 60 }, (_, idx) => {
  const status: OfficialStatus = idx % 3 === 0 ? 'PLAY' : idx % 3 === 1 ? 'LEAN' : 'PASS';
  return {
    id: `fixture-${idx + 1}`,
    payload: buildPayload(status),
    expectedTier: status === 'PLAY' ? 'PLAY' : status === 'LEAN' ? 'LEAN' : 'PASS',
    expectedActionable: status !== 'PASS',
  };
});

const tierCounts = { PLAY: 0, LEAN: 0, PASS: 0 };
const actionableCounts = { true: 0, false: 0 };

for (const fixture of fixtures) {
  const decisionV2 =
    fixture.payload.play &&
    typeof fixture.payload.play === 'object' &&
    (fixture.payload.play as Record<string, unknown>).decision_v2;
  const outcome = buildDecisionOutcomeFromDecisionV2(decisionV2);
  const tier = resolveTierFromOutcomeStatus(outcome.status);
  const actionable = hasActionableProjectionCall(fixture.payload);

  tierCounts[tier] += 1;
  actionableCounts[String(actionable) as 'true' | 'false'] += 1;

  assert.strictEqual(tier, fixture.expectedTier, `${fixture.id}: results tier parity mismatch`);
  assert.strictEqual(
    actionable,
    fixture.expectedActionable,
    `${fixture.id}: results actionable parity mismatch`,
  );
}

assert.deepStrictEqual(tierCounts, { PLAY: 20, LEAN: 20, PASS: 20 });
assert.deepStrictEqual(actionableCounts, { true: 40, false: 20 });
console.log('results-decision-outcome parity passed (60 fixtures)');
