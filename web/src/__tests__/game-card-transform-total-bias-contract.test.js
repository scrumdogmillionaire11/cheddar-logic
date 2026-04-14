/*
 * Behavioral totals consistency gating contract for transform output.
 * Run: npm --prefix web run test:transform:total-bias
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const webRoot = path.resolve(repoRoot, 'web');

console.log('Behavior total_bias transform contract tests');

const behaviorScript = String.raw`
import assert from 'node:assert/strict';
import { transformToGameCard } from './src/lib/game-card/transform/index.ts';

function makeTotalsGame(totalBias, action = 'FIRE') {
  return {
    id: 'totals-' + totalBias + '-' + action,
    gameId: 'totals-' + totalBias + '-' + action,
    sport: 'NHL',
    homeTeam: 'Home Team',
    awayTeam: 'Away Team',
    gameTimeUtc: '2026-04-14T23:00:00Z',
    status: 'scheduled',
    createdAt: '2026-04-13T20:00:00Z',
    projection_inputs_complete: true,
    projection_missing_inputs: [],
    source_mapping_ok: true,
    source_mapping_failures: [],
    ingest_failure_reason_code: null,
    ingest_failure_reason_detail: null,
    odds: {
      h2hHome: -120,
      h2hAway: 110,
      total: 5.5,
      spreadHome: null,
      spreadAway: null,
      spreadPriceHome: null,
      spreadPriceAway: null,
      totalPriceOver: -110,
      totalPriceUnder: -110,
      capturedAt: '2026-04-13T20:05:00Z',
    },
    consistency: { total_bias: totalBias },
    true_play: null,
    plays: [
      {
        source_card_id: 'card-total',
        cardType: 'nhl-totals-call',
        cardTitle: 'NHL Totals Call',
        prediction: 'OVER',
        confidence: 0.66,
        tier: 'BEST',
        reasoning: 'Totals play for consistency gate contract.',
        evPassed: true,
        driverKey: 'nhl-totals-call',
        kind: 'PLAY',
        market_type: 'TOTAL',
        selection: { side: 'OVER' },
        line: 5.5,
        price: -110,
        action,
        status: action === 'FIRE' ? 'FIRE' : action === 'HOLD' ? 'WATCH' : 'PASS',
        classification: action === 'PASS' ? 'PASS' : 'BASE',
        model_prob: 0.57,
        reason_codes: [],
      },
    ],
  };
}

const blocked = transformToGameCard(makeTotalsGame('INSUFFICIENT_DATA', 'FIRE')).play;
assert.equal(blocked?.decision, 'WATCH');
assert.equal(blocked?.betAction, 'NO_PLAY');
assert.ok(blocked?.reason_codes?.includes('PASS_TOTAL_INSUFFICIENT_DATA'));
assert.ok(blocked?.tags?.includes('CONSISTENCY_BLOCK_TOTALS'));

const unknown = transformToGameCard(makeTotalsGame('UNKNOWN', 'FIRE')).play;
assert.equal(unknown?.decision, 'FIRE');
assert.ok(!unknown?.reason_codes?.includes('PASS_TOTAL_INSUFFICIENT_DATA'));

const ok = transformToGameCard(makeTotalsGame('OK', 'HOLD')).play;
assert.equal(ok?.decision, 'WATCH');
assert.ok(!ok?.tags?.includes('CONSISTENCY_BLOCK_TOTALS'));
`;

execFileSync(process.execPath, ['--import', 'tsx/esm', '--eval', behaviorScript], {
  cwd: webRoot,
  stdio: 'inherit',
});

console.log('Behavior total_bias transform contract tests passed');
