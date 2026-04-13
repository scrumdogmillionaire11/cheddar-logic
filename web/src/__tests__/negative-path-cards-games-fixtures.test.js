/*
 * Shared negative-path fixture matrix for cards + games behavior checks.
 * Run: node --import tsx/esm web/src/__tests__/negative-path-cards-games-fixtures.test.js
 */

import assert from 'node:assert/strict';
import { transformToGameCard } from '../lib/game-card/transform/index.ts';
import { applyFilters, DEFAULT_GAME_FILTERS } from '../lib/game-card/filters.ts';
import { selectAuthoritativeTruePlay } from '../lib/games/route-handler.ts';

function buildPlay(overrides = {}) {
  return {
    source_card_id: overrides.source_card_id ?? 'fixture-play',
    cardType: 'mlb-total-call',
    cardTitle: 'Model total',
    prediction: 'OVER',
    confidence: 0.72,
    tier: 'BEST',
    reasoning: 'Fixture play',
    evPassed: true,
    driverKey: `driver-${overrides.source_card_id ?? 'fixture-play'}`,
    edge: 0.05,
    model_prob: 0.56,
    market_type: 'TOTAL',
    selection: { side: 'OVER', team: 'Roadrunners' },
    kind: 'PLAY',
    line: 8.5,
    price: -110,
    status: 'FIRE',
    classification: 'BASE',
    action: 'FIRE',
    reason_codes: ['EDGE_CLEAR'],
    decision_v2: {
      official_status: 'PLAY',
      support_score: 0.65,
      edge_pct: 0.05,
      edge_delta_pct: 0.05,
      primary_reason_code: 'EDGE_CLEAR',
      watchdog_status: 'OK',
      watchdog_reason_codes: [],
      price_reason_codes: [],
      missing_data: { missing_fields: [] },
      consistency: { total_bias: 'OK' },
      pricing_trace: { line_source: 'odds_snapshot', price_source: 'odds_snapshot' },
    },
    created_at: '2026-04-11T14:00:00.000Z',
    ...overrides,
  };
}

function buildGame(id, play) {
  return {
    id,
    gameId: id,
    sport: 'MLB',
    homeTeam: 'Home Team',
    awayTeam: 'Away Team',
    gameTimeUtc: '2026-04-11T19:00:00.000Z',
    status: 'scheduled',
    createdAt: '2026-04-11T14:00:00.000Z',
    odds: {
      h2hHome: -120,
      h2hAway: 105,
      total: 8.5,
      spreadHome: null,
      spreadAway: null,
      spreadPriceHome: null,
      spreadPriceAway: null,
      totalPriceOver: -110,
      totalPriceUnder: -110,
      capturedAt: '2026-04-11T14:05:00.000Z',
    },
    plays: [play],
    true_play: play,
  };
}

function effectiveStatus(cardPlay) {
  const official = cardPlay?.decision_v2?.official_status;
  if (official === 'PLAY') return 'PLAY';
  if (official === 'LEAN') return 'WATCH';
  if (official === 'PASS') return 'PASS';
  if (cardPlay?.action === 'FIRE') return 'PLAY';
  if (cardPlay?.action === 'HOLD') return 'WATCH';
  return 'PASS';
}

console.log('🧪 Negative-path cards/games fixture matrix');

const fixtures = [
  {
    fixtureId: 'odds-present-no-play',
    play: buildPlay({
      source_card_id: 'pass-no-edge',
      status: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      reason_codes: ['PASS_NO_EDGE'],
      decision_v2: {
        official_status: 'PASS',
        support_score: 0.3,
        edge_pct: 0.0,
        edge_delta_pct: 0.0,
        primary_reason_code: 'PASS_NO_EDGE',
      },
    }),
    expected: {
      status: 'PASS',
      visibleDefault: false,
      gamesTruePlay: false,
      reason: 'PASS_NO_EDGE',
    },
  },
  {
    fixtureId: 'selected-then-downgraded',
    play: buildPlay({
      source_card_id: 'downgraded-gate',
      status: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      reason_codes: ['PASS_EXECUTION_GATE_BLOCKED'],
      pass_reason_code: 'PASS_EXECUTION_GATE_BLOCKED',
      execution_status: 'BLOCKED',
      execution_gate: {
        drop_reason: {
          drop_reason_code: 'STALE_SNAPSHOT_GATE',
          drop_reason_layer: 'worker_gate',
        },
        blocked_by: ['STALE_SNAPSHOT:901s'],
      },
      decision_v2: {
        official_status: 'PASS',
        support_score: 0.44,
        edge_pct: 0.07,
        edge_delta_pct: 0.07,
        primary_reason_code: 'PASS_EXECUTION_GATE_BLOCKED',
      },
    }),
    expected: {
      status: 'PASS',
      visibleDefault: false,
      gamesTruePlay: false,
      reason: 'PASS_EXECUTION_GATE_BLOCKED',
    },
  },
  {
    fixtureId: 'play-control',
    play: buildPlay({
      source_card_id: 'play-control',
      status: 'FIRE',
      action: 'FIRE',
      classification: 'BASE',
      reason_codes: ['EDGE_CLEAR'],
      decision_v2: {
        official_status: 'PLAY',
        support_score: 0.71,
        edge_pct: 0.06,
        edge_delta_pct: 0.06,
        primary_reason_code: 'EDGE_CLEAR',
      },
    }),
    expected: {
      status: 'PLAY',
      visibleDefault: true,
      gamesTruePlay: true,
      reason: 'EDGE_CLEAR',
    },
  },
];

for (const fixture of fixtures) {
  const game = buildGame(`game-${fixture.fixtureId}`, fixture.play);
  const card = transformToGameCard(game);
  const visible = applyFilters([card], DEFAULT_GAME_FILTERS, 'game').length > 0;
  const truePlay = selectAuthoritativeTruePlay([fixture.play]);

  assert.equal(
    effectiveStatus(card.play),
    fixture.expected.status,
    `${fixture.fixtureId}: cards status should match expected negative-path outcome`,
  );

  assert.equal(
    visible,
    fixture.expected.visibleDefault,
    `${fixture.fixtureId}: default game filters visibility mismatch`,
  );

  assert.equal(
    Boolean(truePlay),
    fixture.expected.gamesTruePlay,
    `${fixture.fixtureId}: games true_play selection mismatch`,
  );

  const reasonCodes = Array.isArray(card.play?.reason_codes) ? card.play.reason_codes : [];
  assert.ok(
    reasonCodes.includes(fixture.expected.reason),
    `${fixture.fixtureId}: expected reason code ${fixture.expected.reason}`,
  );
}

console.log('✅ Negative-path cards/games fixture matrix passed');
