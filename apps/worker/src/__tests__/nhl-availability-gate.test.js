'use strict';

/**
 * WI-0789: Jest tests for buildNhlAvailabilityGate (NHL key-player availability gate).
 *
 * Tests:
 *  1. INJURED key player on home team → tier capped at LEAN, missing_inputs contains 'key_player_out'
 *  2. Full healthy roster → no availability flags, tier unchanged
 *  3. No availability rows for either team → missing_inputs contains 'nhl_availability_unresolved'
 *  4. DTD key player → missing_inputs contains 'key_player_uncertain', tier NOT capped
 *  5. Non-impact player INJURED → no tier cap, no flags
 *  6. getPlayerAvailabilityByTeam throws → gate skipped gracefully, model continues
 *
 * Isolated pattern: inlines the gate logic with stubbed DB to avoid heavy side-effects.
 */

const assert = require('assert');

// ---------------------------------------------------------------------------
// Inline isolated implementation of buildNhlAvailabilityGate for unit testing.
// We intentionally avoid require('../jobs/run_nhl_model') because that file
// has heavy side-effects (DB init, env, scheduler hooks). Instead we extract
// the pure logic and stub getPlayerAvailabilityByTeam.
// ---------------------------------------------------------------------------

const NHL_IMPACT_PLAYERS = new Set([
  'Connor McDavid',
  'Leon Draisaitl',
  'Nathan MacKinnon',
  'Cale Makar',
  'David Pastrnak',
  'Auston Matthews',
  'Mitch Marner',
  'Connor Hellebuyck',
  'Igor Shesterkin',
  'Andrei Vasilevskiy',
]);

const NHL_TEAM_ABBR_MAP = {
  'Edmonton Oilers': 'EDM',
  'Toronto Maple Leafs': 'TOR',
  'Boston Bruins': 'BOS',
  'Colorado Avalanche': 'COL',
  'Winnipeg Jets': 'WPG',
  'New York Rangers': 'NYR',
  'Tampa Bay Lightning': 'TBL',
};

/**
 * Factory: build availability gate function with a stubbed DB query.
 * @param {function} stubGetByTeam  Replacement for getPlayerAvailabilityByTeam
 */
function makeGateFn(stubGetByTeam) {
  return function buildNhlAvailabilityGate(homeTeam, awayTeam) {
    const EMPTY = { missingFlags: [], uncertainFlags: [], availabilityFlags: [] };
    try {
      const homeAbbr = NHL_TEAM_ABBR_MAP[homeTeam] || null;
      const awayAbbr = NHL_TEAM_ABBR_MAP[awayTeam] || null;

      if (!homeAbbr && !awayAbbr) return EMPTY;

      const allRows = [];
      if (homeAbbr) allRows.push(...stubGetByTeam(homeAbbr, 'NHL'));
      if (awayAbbr) allRows.push(...stubGetByTeam(awayAbbr, 'NHL'));

      if (allRows.length === 0) {
        return { ...EMPTY, missingFlags: ['nhl_availability_unresolved'] };
      }

      const missingFlags = [];
      const uncertainFlags = [];
      const availabilityFlags = [];

      for (const row of allRows) {
        const playerName = row.player_name || '';
        if (!NHL_IMPACT_PLAYERS.has(playerName)) continue;

        if (row.status === 'INJURED' || row.status === 'OUT') {
          if (!missingFlags.includes('key_player_out')) missingFlags.push('key_player_out');
          availabilityFlags.push({ player: playerName, team: row.team_id, status: row.status });
        } else if (row.status === 'DTD' || row.status === 'GTD') {
          if (!uncertainFlags.includes('key_player_uncertain')) uncertainFlags.push('key_player_uncertain');
          availabilityFlags.push({ player: playerName, team: row.team_id, status: row.status });
        }
      }

      return { missingFlags, uncertainFlags, availabilityFlags };
    } catch (err) {
      return EMPTY;
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(playerName, teamId, status) {
  return {
    player_id: Math.floor(Math.random() * 1e6),
    player_name: playerName,
    team_id: teamId,
    sport: 'NHL',
    status,
    status_reason: null,
    checked_at: new Date().toISOString(),
  };
}

function makeCard(tier = 'FIRE') {
  return {
    cardType: 'nhl-base-projection',
    payloadData: {
      tier,
      prediction: 'over 5.5',
      confidence: 0.58,
      missing_inputs: [],
      raw_data: {},
    },
  };
}

/**
 * Apply the card-tier downgrade logic mirrored from run_nhl_model.js.
 * Returns the modified card (mutates in place).
 */
function applyAvailabilityGateToCard(card, availabilityGate) {
  if (availabilityGate.missingFlags.length > 0 || availabilityGate.uncertainFlags.length > 0) {
    card.payloadData.missing_inputs = [
      ...(card.payloadData.missing_inputs || []),
      ...availabilityGate.missingFlags,
    ];
    if (availabilityGate.uncertainFlags.length > 0) {
      card.payloadData.missing_inputs = [
        ...card.payloadData.missing_inputs,
        ...availabilityGate.uncertainFlags,
      ];
    }
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('nhl-availability-gate', () => {

  // Test 1: INJURED key player on home team → tier capped at LEAN, key_player_out
  test('INJURED key player on home team caps tier at LEAN and sets key_player_out', () => {
    const gateRows = {
      EDM: [makeRow('Connor McDavid', 'EDM', 'INJURED'), makeRow('Jesse Puljujarvi', 'EDM', 'ACTIVE')],
      TOR: [],
    };
    const buildGate = makeGateFn((teamId) => gateRows[teamId] || []);

    const gate = buildGate('Edmonton Oilers', 'Toronto Maple Leafs');
    assert.ok(gate.missingFlags.includes('key_player_out'), 'missingFlags should include key_player_out');
    assert.strictEqual(gate.availabilityFlags.length, 1, 'should have 1 availability flag');
    assert.strictEqual(gate.availabilityFlags[0].player, 'Connor McDavid');
    assert.strictEqual(gate.availabilityFlags[0].status, 'INJURED');

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

  // Test 2: Full healthy roster → no flags, tier unchanged
  test('Full healthy roster produces no flags and leaves tier unchanged', () => {
    const gateRows = {
      EDM: [makeRow('Connor McDavid', 'EDM', 'ACTIVE'), makeRow('Leon Draisaitl', 'EDM', 'ACTIVE')],
      TOR: [makeRow('Auston Matthews', 'TOR', 'ACTIVE')],
    };
    const buildGate = makeGateFn((teamId) => gateRows[teamId] || []);

    const gate = buildGate('Edmonton Oilers', 'Toronto Maple Leafs');
    assert.strictEqual(gate.missingFlags.length, 0, 'should have no missing flags');
    assert.strictEqual(gate.uncertainFlags.length, 0, 'should have no uncertain flags');
    assert.strictEqual(gate.availabilityFlags.length, 0, 'should have no availability flags');

    const card = makeCard('FIRE');
    applyAvailabilityGateToCard(card, gate);
    assert.strictEqual(card.payloadData.tier, 'FIRE', 'tier should be unchanged');
    assert.strictEqual(card.payloadData.missing_inputs.length, 0);
  });

  // Test 3: No availability rows for either team → nhl_availability_unresolved
  test('No availability rows for either team emits nhl_availability_unresolved', () => {
    const buildGate = makeGateFn(() => []);

    const gate = buildGate('Edmonton Oilers', 'Toronto Maple Leafs');
    assert.ok(
      gate.missingFlags.includes('nhl_availability_unresolved'),
      'should emit nhl_availability_unresolved when no rows found',
    );

    // Apply to card — nhl_availability_unresolved lands in missing_inputs but does NOT cap tier
    const card = makeCard('FIRE');
    applyAvailabilityGateToCard(card, gate);
    assert.ok(card.payloadData.missing_inputs.includes('nhl_availability_unresolved'));
    // Tier is NOT capped — unresolved is informational, not a block
    assert.strictEqual(card.payloadData.tier, 'FIRE', 'tier should be unchanged when availability unresolved');
  });

  // Test 4: DTD key player → key_player_uncertain, tier NOT capped
  test('DTD key player adds key_player_uncertain but does not cap tier', () => {
    const gateRows = {
      WPG: [makeRow('Connor Hellebuyck', 'WPG', 'DTD')],
      BOS: [],
    };
    const buildGate = makeGateFn((teamId) => gateRows[teamId] || []);

    const gate = buildGate('Winnipeg Jets', 'Boston Bruins');
    assert.strictEqual(gate.missingFlags.length, 0, 'DTD should not set key_player_out');
    assert.ok(gate.uncertainFlags.includes('key_player_uncertain'));
    assert.strictEqual(gate.availabilityFlags[0].player, 'Connor Hellebuyck');

    const card = makeCard('FIRE');
    applyAvailabilityGateToCard(card, gate);
    assert.strictEqual(card.payloadData.tier, 'FIRE', 'DTD should not cap tier');
    assert.ok(card.payloadData.missing_inputs.includes('key_player_uncertain'));
  });

  // Test 5: Non-impact player INJURED → no tier cap, no flags
  test('Non-impact player INJURED produces no flags and no tier cap', () => {
    const gateRows = {
      EDM: [makeRow('Zach Hyman', 'EDM', 'INJURED')],   // not in NHL_IMPACT_PLAYERS
      TOR: [makeRow('Jake McCabe', 'TOR', 'DTD')],       // not in NHL_IMPACT_PLAYERS
    };
    const buildGate = makeGateFn((teamId) => gateRows[teamId] || []);

    const gate = buildGate('Edmonton Oilers', 'Toronto Maple Leafs');
    assert.strictEqual(gate.missingFlags.length, 0, 'non-impact INJURED should not set flags');
    assert.strictEqual(gate.uncertainFlags.length, 0, 'non-impact DTD should not set uncertain flags');
    assert.strictEqual(gate.availabilityFlags.length, 0, 'non-impact players should not appear in availabilityFlags');

    const card = makeCard('FIRE');
    applyAvailabilityGateToCard(card, gate);
    assert.strictEqual(card.payloadData.tier, 'FIRE', 'tier should be unchanged for non-impact injured');
    assert.strictEqual(card.payloadData.missing_inputs.length, 0);
  });

  // Test 6: getPlayerAvailabilityByTeam throws → gate skipped gracefully
  test('getPlayerAvailabilityByTeam throwing causes gate to fail-open (no crash)', () => {
    const buildGate = makeGateFn(() => {
      throw new Error('DB connection failed');
    });

    // Must not throw
    let gate;
    assert.doesNotThrow(() => {
      gate = buildGate('Edmonton Oilers', 'Toronto Maple Leafs');
    }, 'gate should never throw even when DB throws');

    assert.strictEqual(gate.missingFlags.length, 0, 'fail-open: no missing flags on DB error');
    assert.strictEqual(gate.uncertainFlags.length, 0, 'fail-open: no uncertain flags on DB error');
    assert.strictEqual(gate.availabilityFlags.length, 0, 'fail-open: no availability flags on DB error');

    // Card tier must not be affected
    const card = makeCard('FIRE');
    applyAvailabilityGateToCard(card, gate);
    assert.strictEqual(card.payloadData.tier, 'FIRE', 'tier should be unchanged when gate fails-open');
  });

}); // end describe('nhl-availability-gate')
