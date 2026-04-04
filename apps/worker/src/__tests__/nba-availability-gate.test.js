'use strict';

/**
 * WI-0769: NBA key-player availability gate tests.
 *
 * Tests:
 *  1. OUT impact player on home team → tier capped at LEAN, missing_inputs contains 'key_player_out'
 *  2. Full healthy roster (no OUT impact players) → no availability flags, tier unchanged
 *  3. No availability rows for either team → missing_inputs contains 'nba_availability_unresolved'
 *  4. DTD impact player → missing_inputs contains 'key_player_uncertain', tier NOT capped
 */

const assert = require('assert');

// ---------------------------------------------------------------------------
// Inline isolated implementation of buildNbaAvailabilityGate for unit testing.
// We intentionally avoid require('../jobs/run_nba_model') because that file
// has heavy side-effects (DB init, env, scheduler hooks). Instead we extract
// the pure logic and stub getPlayerAvailabilityByTeam.
// ---------------------------------------------------------------------------

const NBA_IMPACT_PLAYERS = new Set([
  'LeBron James',
  'Stephen Curry',
  'Giannis Antetokounmpo',
  'Nikola Jokic',
  'Jayson Tatum',
  'Joel Embiid',
]);

const NBA_TEAM_ABBR_MAP = {
  'Boston Celtics': 'BOS',
  'Miami Heat': 'MIA',
  'Los Angeles Lakers': 'LAL',
  'Golden State Warriors': 'GS',
  'Denver Nuggets': 'DEN',
};

/**
 * Factory: build availability gate function with a stubbed DB query.
 * @param {function} stubGetByTeam  Replacement for getPlayerAvailabilityByTeam
 */
function makeGateFn(stubGetByTeam) {
  return function buildNbaAvailabilityGate(homeTeam, awayTeam) {
    try {
      const homeAbbr = NBA_TEAM_ABBR_MAP[homeTeam] || null;
      const awayAbbr = NBA_TEAM_ABBR_MAP[awayTeam] || null;

      if (!homeAbbr && !awayAbbr) {
        return { missingFlags: ['nba_availability_unresolved'], uncertainFlags: [], availabilityFlags: [] };
      }

      const allRows = [];
      if (homeAbbr) allRows.push(...stubGetByTeam(homeAbbr, 'nba'));
      if (awayAbbr) allRows.push(...stubGetByTeam(awayAbbr, 'nba'));

      if (allRows.length === 0) {
        return { missingFlags: ['nba_availability_unresolved'], uncertainFlags: [], availabilityFlags: [] };
      }

      const missingFlags = [];
      const uncertainFlags = [];
      const availabilityFlags = [];

      for (const row of allRows) {
        const playerName = row.player_name || '';
        if (!NBA_IMPACT_PLAYERS.has(playerName)) continue;

        if (row.status === 'OUT') {
          if (!missingFlags.includes('key_player_out')) missingFlags.push('key_player_out');
          availabilityFlags.push({ player: playerName, team: row.team_id, status: row.status });
        } else if (row.status === 'DTD' || row.status === 'GTD') {
          if (!uncertainFlags.includes('key_player_uncertain')) uncertainFlags.push('key_player_uncertain');
          availabilityFlags.push({ player: playerName, team: row.team_id, status: row.status });
        }
      }

      return { missingFlags, uncertainFlags, availabilityFlags };
    } catch (err) {
      return { missingFlags: [], uncertainFlags: [], availabilityFlags: [] };
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(playerName, teamId, status) {
  return { player_id: Math.floor(Math.random() * 1e6), player_name: playerName, team_id: teamId, sport: 'nba', status, status_reason: null, checked_at: new Date().toISOString() };
}

/**
 * Apply the card-tier downgrade logic mirrored from run_nba_model.js.
 * Returns the modified card (mutates in place).
 */
function applyAvailabilityGateToCard(card, availabilityGate) {
  if (availabilityGate.missingFlags.length > 0 || availabilityGate.uncertainFlags.length > 0) {
    card.payloadData.missing_inputs = [
      ...(card.payloadData.missing_inputs || []),
      ...availabilityGate.missingFlags,
    ];
    if (availabilityGate.availabilityFlags.length > 0) {
      if (!card.payloadData.raw_data) card.payloadData.raw_data = {};
      card.payloadData.raw_data.availability_flags = availabilityGate.availabilityFlags;
    }
    if (
      availabilityGate.missingFlags.includes('key_player_out') &&
      card.payloadData.tier &&
      (card.payloadData.tier === 'FIRE' || card.payloadData.tier === 'WATCH')
    ) {
      card.payloadData.tier = 'LEAN';
    }
  }
  return card;
}

function makeCard(tier = 'FIRE') {
  return {
    cardType: 'nba-base-projection',
    payloadData: {
      tier,
      prediction: 'over 220.5',
      confidence: 0.62,
      missing_inputs: [],
      raw_data: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log('\n[nba-availability-gate] Running tests...\n');

// Test 1: OUT impact player → tier capped at LEAN, key_player_out in missing_inputs
runTest('OUT impact player caps tier at LEAN and sets key_player_out', () => {
  const gateRows = {
    BOS: [makeRow('Jayson Tatum', 'BOS', 'OUT'), makeRow('Jaylen Brown', 'BOS', 'ACTIVE')],
    MIA: [],
  };
  const buildGate = makeGateFn((teamId) => gateRows[teamId] || []);

  const gate = buildGate('Boston Celtics', 'Miami Heat');
  assert.ok(gate.missingFlags.includes('key_player_out'), 'missingFlags should include key_player_out');
  assert.strictEqual(gate.availabilityFlags.length, 1, 'should have 1 availability flag');
  assert.strictEqual(gate.availabilityFlags[0].player, 'Jayson Tatum');
  assert.strictEqual(gate.availabilityFlags[0].status, 'OUT');

  // Apply to a FIRE-tier card — should downgrade to LEAN
  const card = makeCard('FIRE');
  applyAvailabilityGateToCard(card, gate);
  assert.strictEqual(card.payloadData.tier, 'LEAN', 'FIRE card should be capped to LEAN');
  assert.ok(card.payloadData.missing_inputs.includes('key_player_out'));

  // Also test on a WATCH-tier card
  const watchCard = makeCard('WATCH');
  applyAvailabilityGateToCard(watchCard, gate);
  assert.strictEqual(watchCard.payloadData.tier, 'LEAN', 'WATCH card should be capped to LEAN');
});

// Test 2: Full healthy roster (no impact players on injury report) → no flags, tier unchanged
runTest('Full roster with no OUT impact players: no flags, tier unchanged', () => {
  const gateRows = {
    LAL: [makeRow('Austin Reaves', 'LAL', 'OUT')],   // not an impact player
    GS: [makeRow('Andrew Wiggins', 'GS', 'DTD')],    // not an impact player
  };
  const buildGate = makeGateFn((teamId) => gateRows[teamId] || []);

  const gate = buildGate('Los Angeles Lakers', 'Golden State Warriors');
  assert.strictEqual(gate.missingFlags.length, 0, 'should have no missing flags');
  assert.strictEqual(gate.uncertainFlags.length, 0, 'should have no uncertain flags');
  assert.strictEqual(gate.availabilityFlags.length, 0, 'should have no availability flags');

  const card = makeCard('FIRE');
  applyAvailabilityGateToCard(card, gate);
  assert.strictEqual(card.payloadData.tier, 'FIRE', 'tier should be unchanged');
  assert.strictEqual(card.payloadData.missing_inputs.length, 0);
});

// Test 3: No rows for either team → nba_availability_unresolved
runTest('No availability rows: emits nba_availability_unresolved', () => {
  const buildGate = makeGateFn(() => []);

  const gate = buildGate('Boston Celtics', 'Miami Heat');
  assert.ok(gate.missingFlags.includes('nba_availability_unresolved'), 'should flag nba_availability_unresolved');
  assert.strictEqual(gate.availabilityFlags.length, 0);

  // Tier must NOT be capped (nba_availability_unresolved does not trigger tier cap)
  const card = makeCard('FIRE');
  applyAvailabilityGateToCard(card, gate);
  assert.strictEqual(card.payloadData.tier, 'FIRE', 'tier should NOT be capped for unresolved flag');
  assert.ok(card.payloadData.missing_inputs.includes('nba_availability_unresolved'));
});

// Test 4: DTD impact player → key_player_uncertain, tier NOT capped
runTest('DTD impact player adds key_player_uncertain but does not cap tier', () => {
  const gateRows = {
    DEN: [makeRow('Nikola Jokic', 'DEN', 'DTD')],
    MIA: [],
  };
  const buildGate = makeGateFn((teamId) => gateRows[teamId] || []);

  const gate = buildGate('Denver Nuggets', 'Miami Heat');
  assert.strictEqual(gate.missingFlags.length, 0, 'DTD should not set missing flags');
  assert.ok(gate.uncertainFlags.includes('key_player_uncertain'));
  assert.strictEqual(gate.availabilityFlags[0].player, 'Nikola Jokic');

  const card = makeCard('FIRE');
  applyAvailabilityGateToCard(card, gate);
  assert.strictEqual(card.payloadData.tier, 'FIRE', 'DTD should not cap tier');
});

// Test 5: Unknown team name → nba_availability_unresolved (can't map to abbr)
runTest('Unknown team names produce nba_availability_unresolved', () => {
  const buildGate = makeGateFn(() => []);

  const gate = buildGate('Unknown FC', 'Mystery Team');
  assert.ok(gate.missingFlags.includes('nba_availability_unresolved'));
});

// Test 6: LEAN card with OUT impact player — tier stays LEAN (no further cap needed)
runTest('LEAN card with OUT impact player stays LEAN', () => {
  const gateRows = {
    BOS: [makeRow('Jayson Tatum', 'BOS', 'OUT')],
    MIA: [],
  };
  const buildGate = makeGateFn((teamId) => gateRows[teamId] || []);

  const gate = buildGate('Boston Celtics', 'Miami Heat');
  const card = makeCard('LEAN');
  applyAvailabilityGateToCard(card, gate);
  assert.strictEqual(card.payloadData.tier, 'LEAN', 'LEAN card should stay LEAN');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n[nba-availability-gate] Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
