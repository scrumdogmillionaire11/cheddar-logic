import assert from 'node:assert';
import { createRequire } from 'node:module';

import { applyFilters, DEFAULT_GAME_FILTERS } from '../lib/game-card/filters';
import { buildResultsAggregation } from '../lib/results/transform-layer';
import { readRuntimeCanonicalDecision } from '../lib/runtime-decision-authority';

const require = createRequire(import.meta.url);

const originalInvalidFlag = process.env.ENABLE_INVALID_DECISION_ENFORCEMENT;

try {
  process.env.ENABLE_INVALID_DECISION_ENFORCEMENT = 'true';

  // 1) Missing decision_v2 resolves to INVALID and does not silently become PASS.
  const invalidDecision = readRuntimeCanonicalDecision({}, { stage: 'read_api' });
  assert.strictEqual(invalidDecision.officialStatus, 'INVALID');
  assert.strictEqual(invalidDecision.action, null);
  assert.strictEqual(invalidDecision.reasonCode, 'MISSING_DECISION_V2');

  // 2) Web card filter path does not render INVALID payloads in main FIRE/WATCH view.
  const mockCard = {
    id: 'card-invalid-1',
    sport: 'MLB',
    homeTeam: 'A',
    awayTeam: 'B',
    startTime: new Date().toISOString(),
    oddsUpdatedAt: new Date().toISOString(),
    drivers: [],
    tags: [],
    play: {
      market_type: 'MONEYLINE',
      decision_v2: null,
      selection: { side: 'HOME' },
      execution_status: 'EXECUTABLE',
    },
  };
  const rendered = applyFilters([mockCard] as never, DEFAULT_GAME_FILTERS, 'game');
  assert.strictEqual(rendered.length, 0, 'INVALID card must not render in main FIRE/WATCH surface');

  // 3) Results aggregation excludes INVALID and records diagnostics.
  const aggregation = buildResultsAggregation(
    [
      {
        id: 'ledger-invalid-1',
        sport: 'MLB',
        card_type: 'mlb-full-game',
        result: 'win',
        pnl_units: 1,
        clv_pct: 0,
        recommended_bet_type: 'moneyline',
        payload_data: JSON.stringify({ sport: 'MLB', play: { decision_v2: null } }),
      },
    ] as never,
    [],
  );
  assert.strictEqual(aggregation.summary.totalCards, 0, 'INVALID rows must be excluded from betting aggregation');
  assert.ok(
    (aggregation as { diagnostics?: { missingDecisionV2Count?: number } }).diagnostics?.missingDecisionV2Count === 1,
    'results diagnostics must count missing decision_v2 rows',
  );

  // 4) Discord classification suppresses INVALID cards.
  const { classifyDecisionBucket } = require('../../../apps/worker/src/jobs/post_discord_cards.js');
  const discordBucket = classifyDecisionBucket({
    payloadData: {
      decision_v2: null,
    },
  });
  assert.strictEqual(discordBucket, 'invalid', 'Discord must classify missing decision as invalid and suppress posting');

  // 5) Pipeline health fails on any missing/invalid occurrence.
  const dataModule = require('@cheddar-logic/data');
  const originalGetDatabase = dataModule.getDatabase;
  dataModule.getDatabase = () => ({
    prepare: (sql: string) => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('COUNT(*) AS total_cards')) {
        return {
          get: () => ({
            total_cards: 100,
            pass_cards: 20,
            missing_odds_cards: 0,
            degraded_cards: 0,
            missing_decision_v2_count: 1,
            invalid_decision_count: 0,
          }),
        };
      }
      if (normalized.includes('GROUP BY UPPER(COALESCE(json_extract(payload_data,')) {
        return { all: () => [{ sport: 'MLB', count: 1 }] };
      }
      if (normalized.includes('LIMIT 5')) {
        return { all: () => [{ game_id: 'g1', card_type: 'mlb-full-game', created_at: new Date().toISOString() }] };
      }
      if (normalized.includes('INSERT INTO pipeline_health')) {
        return { run: () => ({}) };
      }
      return { get: () => null, all: () => [], run: () => ({}) };
    },
  });

  const { checkCardOutputIntegrity } = require('../../../apps/worker/src/jobs/check_pipeline_health.js');
  const health = checkCardOutputIntegrity();
  assert.strictEqual(health.ok, false, 'pipeline health must fail on any missing/invalid decision occurrence');
  assert.ok(String(health.reason).includes('missing_decision_v2_count=1'));

  dataModule.getDatabase = originalGetDatabase;

  // 6) Kill-switch rollback path: enforcement OFF reverts to PASS.
  process.env.ENABLE_INVALID_DECISION_ENFORCEMENT = 'false';
  const rollbackDecision = readRuntimeCanonicalDecision({}, { stage: 'read_api' });
  assert.strictEqual(rollbackDecision.officialStatus, 'PASS');

  console.log('decision-invalid end-to-end simulation passed');
} finally {
  if (originalInvalidFlag === undefined) {
    delete process.env.ENABLE_INVALID_DECISION_ENFORCEMENT;
  } else {
    process.env.ENABLE_INVALID_DECISION_ENFORCEMENT = originalInvalidFlag;
  }
}
