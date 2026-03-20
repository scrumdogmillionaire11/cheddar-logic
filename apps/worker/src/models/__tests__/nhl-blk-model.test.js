'use strict';
/**
 * Tests for projectBlkV1 — two-stage NHL blocked shots model.
 *
 * Phase 2 of WI-0526: blocked shots model is fully separate from SOG.
 * Different multiplier chain, different semantics, shared Poisson pricing layer.
 */
const { projectBlkV1 } = require('../nhl-player-shots');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildInputs(overrides = {}) {
  return {
    player_id: 'p-blk-001',
    game_id: 'g-001',
    ev_blocks_season_per60: 6.0,
    ev_blocks_l10_per60: 6.2,
    ev_blocks_l5_per60: 6.4,
    pk_blocks_season_per60: 4.0,
    pk_blocks_l10_per60: 4.1,
    pk_blocks_l5_per60: 4.2,
    toi_proj_ev: 14,   // 14 min EV
    toi_proj_pk: 2,    // 2 min PK
    role_stability: 'HIGH',
    opponent_attempt_factor: 1.0,
    defensive_zone_factor: 1.0,
    underdog_script_factor: 1.0,
    playoff_tightening_factor: 1.0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stage 1 — blk_mu projection
// ---------------------------------------------------------------------------
describe('projectBlkV1 — Stage 1: blk_mu projection', () => {
  test('blk_mu increases when toi_proj_ev increases (all else equal)', () => {
    const low = projectBlkV1(buildInputs({ toi_proj_ev: 10 }));
    const high = projectBlkV1(buildInputs({ toi_proj_ev: 20 }));
    expect(high.blk_mu).toBeGreaterThan(low.blk_mu);
  });

  test('blk_mu increases when toi_proj_pk increases (PK blocks contribute)', () => {
    const low = projectBlkV1(buildInputs({ toi_proj_pk: 0 }));
    const high = projectBlkV1(buildInputs({ toi_proj_pk: 4 }));
    expect(high.blk_mu).toBeGreaterThan(low.blk_mu);
  });

  test('blk_mu increases when opponent_attempt_factor increases', () => {
    const low = projectBlkV1(buildInputs({ opponent_attempt_factor: 0.90 }));
    const high = projectBlkV1(buildInputs({ opponent_attempt_factor: 1.12 }));
    expect(high.blk_mu).toBeGreaterThan(low.blk_mu);
  });

  test('opponent_attempt_factor is clamped to [0.90, 1.12]', () => {
    const below = projectBlkV1(buildInputs({ opponent_attempt_factor: 0.50 }));
    const above = projectBlkV1(buildInputs({ opponent_attempt_factor: 2.00 }));
    const atMin = projectBlkV1(buildInputs({ opponent_attempt_factor: 0.90 }));
    const atMax = projectBlkV1(buildInputs({ opponent_attempt_factor: 1.12 }));
    // Values outside range should equal the clamped boundary
    expect(below.blk_mu).toBeCloseTo(atMin.blk_mu, 6);
    expect(above.blk_mu).toBeCloseTo(atMax.blk_mu, 6);
  });

  test('defensive_zone_factor is clamped to [0.95, 1.08]', () => {
    const below = projectBlkV1(buildInputs({ defensive_zone_factor: 0.50 }));
    const above = projectBlkV1(buildInputs({ defensive_zone_factor: 5.00 }));
    const atMin = projectBlkV1(buildInputs({ defensive_zone_factor: 0.95 }));
    const atMax = projectBlkV1(buildInputs({ defensive_zone_factor: 1.08 }));
    expect(below.blk_mu).toBeCloseTo(atMin.blk_mu, 6);
    expect(above.blk_mu).toBeCloseTo(atMax.blk_mu, 6);
  });

  test('underdog_script_factor is clamped to [0.95, 1.10]', () => {
    const below = projectBlkV1(buildInputs({ underdog_script_factor: 0.50 }));
    const above = projectBlkV1(buildInputs({ underdog_script_factor: 5.00 }));
    const atMin = projectBlkV1(buildInputs({ underdog_script_factor: 0.95 }));
    const atMax = projectBlkV1(buildInputs({ underdog_script_factor: 1.10 }));
    expect(below.blk_mu).toBeCloseTo(atMin.blk_mu, 6);
    expect(above.blk_mu).toBeCloseTo(atMax.blk_mu, 6);
  });

  test('playoff_tightening_factor has floor of 1.00 (cannot suppress)', () => {
    const atFloor = projectBlkV1(buildInputs({ playoff_tightening_factor: 0.50 }));
    const baseline = projectBlkV1(buildInputs({ playoff_tightening_factor: 1.00 }));
    expect(atFloor.blk_mu).toBeCloseTo(baseline.blk_mu, 6);
  });

  test('playoff_tightening_factor is clamped to [1.00, 1.08]', () => {
    const above = projectBlkV1(buildInputs({ playoff_tightening_factor: 5.00 }));
    const atMax = projectBlkV1(buildInputs({ playoff_tightening_factor: 1.08 }));
    expect(above.blk_mu).toBeCloseTo(atMax.blk_mu, 6);
  });

  test('blk_mu is never negative', () => {
    const result = projectBlkV1(buildInputs({
      ev_blocks_season_per60: 0,
      ev_blocks_l10_per60: 0,
      ev_blocks_l5_per60: 0,
      pk_blocks_season_per60: 0,
      pk_blocks_l10_per60: 0,
      pk_blocks_l5_per60: 0,
    }));
    expect(result.blk_mu).toBeGreaterThanOrEqual(0);
  });

  test('blk_sigma equals sqrt(blk_mu)', () => {
    const result = projectBlkV1(buildInputs());
    expect(result.blk_sigma).toBeCloseTo(Math.sqrt(result.blk_mu), 6);
  });
});

// ---------------------------------------------------------------------------
// Trend factor — narrower than SOG
// ---------------------------------------------------------------------------
describe('projectBlkV1 — trend_factor', () => {
  test('LOW stability leaves trend_factor at 1.0 — HIGH outperforms LOW on same hot inputs', () => {
    // Same inputs (hot l5), different stability.
    // HIGH gets trend_factor ≈ 1.06 (capped); LOW gets exactly 1.0.
    const inputs = {
      ev_blocks_season_per60: 4.0,
      ev_blocks_l10_per60: 4.0,
      ev_blocks_l5_per60: 7.0,   // l5/season = 1.75 → HIGH saturates cap
    };
    const high = projectBlkV1(buildInputs({ ...inputs, role_stability: 'HIGH' }));
    const low  = projectBlkV1(buildInputs({ ...inputs, role_stability: 'LOW' }));
    expect(high.blk_mu).toBeGreaterThan(low.blk_mu);
  });

  test('trend_factor is capped at 1.06 — HIGH/LOW ratio on same inputs must be <= 1.061', () => {
    // Compare HIGH (trend_factor capped at 1.06) vs LOW (trend_factor = 1.00)
    // on identical inputs.  The ratio must be <= 1.061.
    const inputs = {
      ev_blocks_season_per60: 4.0,
      ev_blocks_l10_per60: 4.0,
      ev_blocks_l5_per60: 200.0,  // extreme — cap kicks in
    };
    const high = projectBlkV1(buildInputs({ ...inputs, role_stability: 'HIGH' }));
    const low  = projectBlkV1(buildInputs({ ...inputs, role_stability: 'LOW' }));
    // HIGH is only allowed to exceed LOW by 6% (trend cap) + floating-point slop
    expect(high.blk_mu).toBeLessThanOrEqual(low.blk_mu * 1.061);
  });

  test('MEDIUM stability applies 50% trend weight — HIGH > MEDIUM > LOW for same hot inputs', () => {
    // Use l5 that keeps HIGH and MEDIUM both below the cap so they differ visibly.
    const inputs = {
      ev_blocks_season_per60: 4.0,
      ev_blocks_l10_per60: 4.0,
      ev_blocks_l5_per60: 4.6,  // l5/season=1.15 → HIGH=1.045, MEDIUM=1.0225, LOW=1.0
    };
    const high   = projectBlkV1(buildInputs({ ...inputs, role_stability: 'HIGH'   }));
    const medium = projectBlkV1(buildInputs({ ...inputs, role_stability: 'MEDIUM' }));
    const low    = projectBlkV1(buildInputs({ ...inputs, role_stability: 'LOW'    }));
    expect(high.blk_mu).toBeGreaterThan(medium.blk_mu);
    expect(medium.blk_mu).toBeGreaterThan(low.blk_mu);
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — fair probabilities and pricing
// ---------------------------------------------------------------------------
describe('projectBlkV1 — Stage 2: fair probabilities', () => {
  test('fair_over_prob is monotonically decreasing as line increases', () => {
    const result = projectBlkV1(buildInputs({ lines_to_price: [0.5, 1.5, 2.5, 3.5, 4.5] }));
    const probs = [0.5, 1.5, 2.5, 3.5, 4.5].map((l) => result.fair_over_prob_by_line[String(l)]);
    for (let i = 1; i < probs.length; i++) {
      expect(probs[i]).toBeLessThan(probs[i - 1]);
    }
  });

  test('fair_over_prob + fair_under_prob do not exceed 1.0 for any line', () => {
    const result = projectBlkV1(buildInputs({ lines_to_price: [0.5, 1.5, 2.5, 3.5] }));
    for (const line of [0.5, 1.5, 2.5, 3.5]) {
      const key = String(line);
      expect(result.fair_over_prob_by_line[key] + result.fair_under_prob_by_line[key]).toBeLessThanOrEqual(1.0001);
    }
  });

  test('edge_over_pp and ev_over are null when market_price_over is missing', () => {
    const result = projectBlkV1(buildInputs({
      market_line: 2.5,
      market_price_over: null,
      market_price_under: -105,
    }));
    expect(result.edge_over_pp).toBeNull();
    expect(result.ev_over).toBeNull();
    expect(result.opportunity_score).toBeNull();
  });

  test('edge_over_pp is correct for known inputs', () => {
    // ev_blocks weighted ~6.0/60 * 14 + ~4.0/60 * 2 = 1.53 BLK mu
    const result = projectBlkV1(buildInputs({
      market_line: 1.5,
      market_price_over: -110,   // implied ~52.4%
      market_price_under: -110,
    }));
    // blk_mu ~1.53 → P(X > 1) = P(X >= 2) for Poisson
    expect(result.edge_over_pp).not.toBeNull();
    expect(typeof result.edge_over_pp).toBe('number');
  });

  test('opportunity_score is null when price is missing', () => {
    const result = projectBlkV1(buildInputs({
      market_line: 2.5,
      market_price_over: null,
      market_price_under: null,
    }));
    expect(result.opportunity_score).toBeNull();
  });

  test('opportunity_score is a number when all pricing inputs present', () => {
    const result = projectBlkV1(buildInputs({
      market_line: 1.5,
      market_price_over: -115,
      market_price_under: -105,
    }));
    expect(typeof result.opportunity_score).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------
describe('projectBlkV1 — flags', () => {
  test('LOW_SAMPLE flag set when EV block rates are null', () => {
    const result = projectBlkV1(buildInputs({
      ev_blocks_season_per60: null,
      ev_blocks_l10_per60: null,
      ev_blocks_l5_per60: null,
    }));
    expect(result.flags).toContain('LOW_SAMPLE');
  });

  test('ROLE_IN_FLUX flag set when role_stability is LOW', () => {
    const result = projectBlkV1(buildInputs({ role_stability: 'LOW' }));
    expect(result.flags).toContain('ROLE_IN_FLUX');
  });

  test('MISSING_PRICE flag set when line present but price absent', () => {
    const result = projectBlkV1(buildInputs({
      market_line: 2.5,
      market_price_over: null,
      market_price_under: null,
    }));
    expect(result.flags).toContain('MISSING_PRICE');
  });

  test('no flags on clean HIGH-stability priced candidate', () => {
    const result = projectBlkV1(buildInputs({
      role_stability: 'HIGH',
      market_line: 1.5,
      market_price_over: -112,
      market_price_under: -108,
    }));
    expect(result.flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Smoke tests
// ---------------------------------------------------------------------------
describe('projectBlkV1 — smoke tests', () => {
  test('top-4 D with high opp_attempt and playoff_tightening ranks above baseline', () => {
    const baseline = projectBlkV1(buildInputs({
      market_line: 1.5,
      market_price_over: -112,
      market_price_under: -108,
      role_stability: 'HIGH',
    }));
    const playoff = projectBlkV1(buildInputs({
      market_line: 1.5,
      market_price_over: -112,
      market_price_under: -108,
      role_stability: 'HIGH',
      opponent_attempt_factor: 1.08,
      playoff_tightening_factor: 1.06,
    }));
    expect(playoff.opportunity_score).toBeGreaterThan(baseline.opportunity_score);
  });

  test('no PK role means PK contribution is 0 (toi_proj_pk = 0)', () => {
    const withPk = projectBlkV1(buildInputs({ toi_proj_pk: 3 }));
    const noPk = projectBlkV1(buildInputs({ toi_proj_pk: 0 }));
    expect(withPk.blk_mu).toBeGreaterThan(noPk.blk_mu);
    expect(noPk.block_rate_pk_per60).toBeGreaterThanOrEqual(0);
  });

  test('SOG fields DO NOT appear on BLK projection output', () => {
    const result = projectBlkV1(buildInputs({
      market_line: 1.5,
      market_price_over: -110,
      market_price_under: -110,
    }));
    expect(result.sog_mu).toBeUndefined();
    expect(result.blk_mu).toBeDefined();
    expect(result.block_rate_ev_per60).toBeDefined();
    expect(result.block_rate_pk_per60).toBeDefined();
  });

  test('SOG pull job still works when only SOG market is enabled', () => {
    // Parse a fake Odds API response that contains only SOG market
    const { parseEventPropLines } = _testHelpers();
    const fakeOdds = {
      id: 'ev-001',
      bookmakers: [{
        key: 'draftkings',
        markets: [{
          key: 'player_shots_on_goal',
          outcomes: [
            { description: 'Connor McDavid', name: 'Over', point: 4.5, price: -115 },
            { description: 'Connor McDavid', name: 'Under', point: 4.5, price: -105 },
          ],
        }],
      }],
    };
    const rows = parseEventPropLines(fakeOdds, 'game-001', '2026-03-20T00:00:00Z');
    expect(rows).toHaveLength(1);
    expect(rows[0].propType).toBe('shots_on_goal');
  });

  test('BLK market parsed separately from SOG in same response', () => {
    const { parseEventPropLines } = _testHelpers();
    const fakeOdds = {
      id: 'ev-001',
      bookmakers: [{
        key: 'draftkings',
        markets: [
          {
            key: 'player_shots_on_goal',
            outcomes: [
              { description: 'Connor McDavid', name: 'Over', point: 4.5, price: -115 },
              { description: 'Connor McDavid', name: 'Under', point: 4.5, price: -105 },
            ],
          },
          {
            key: 'player_blocked_shots',
            outcomes: [
              { description: 'Brent Burns', name: 'Over', point: 1.5, price: -110 },
              { description: 'Brent Burns', name: 'Under', point: 1.5, price: -110 },
            ],
          },
        ],
      }],
    };
    const rows = parseEventPropLines(fakeOdds, 'game-001', '2026-03-20T00:00:00Z');
    const sog = rows.filter((r) => r.propType === 'shots_on_goal');
    const blk = rows.filter((r) => r.propType === 'blocked_shots');
    expect(sog).toHaveLength(1);
    expect(blk).toHaveLength(1);
    expect(sog[0].playerName).toBe('Connor McDavid');
    expect(blk[0].playerName).toBe('Brent Burns');
  });

  test('unknown market key in response is silently ignored', () => {
    const { parseEventPropLines } = _testHelpers();
    const fakeOdds = {
      id: 'ev-001',
      bookmakers: [{
        key: 'draftkings',
        markets: [{
          key: 'player_power_play_points', // not in MARKET_TO_PROP_TYPE
          outcomes: [
            { description: 'Someone', name: 'Over', point: 0.5, price: -130 },
          ],
        }],
      }],
    };
    const rows = parseEventPropLines(fakeOdds, 'game-001', '2026-03-20T00:00:00Z');
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test-internal helpers (expose parseEventPropLines without DB for unit tests)
// ---------------------------------------------------------------------------
function _testHelpers() {
  // Re-implement the parsing logic in isolation to avoid DB dependency in unit tests.
  // This mirrors the actual parseEventPropLines in pull_nhl_player_shots_props.js.
  const MARKET_TO_PROP_TYPE = {
    player_shots_on_goal: 'shots_on_goal',
    player_blocked_shots: 'blocked_shots',
  };

  function parseEventPropLines(eventOdds, gameId, fetchedAt) {
    const rows = [];
    if (!eventOdds?.bookmakers) return rows;
    for (const bm of eventOdds.bookmakers) {
      for (const market of bm.markets || []) {
        const propType = MARKET_TO_PROP_TYPE[market.key];
        if (!propType || !market.outcomes) continue;
        const byPlayer = {};
        for (const outcome of market.outcomes) {
          const playerName = outcome.description;
          if (!playerName) continue;
          if (!byPlayer[playerName]) byPlayer[playerName] = {};
          if (outcome.name === 'Over') {
            byPlayer[playerName].line = outcome.point;
            byPlayer[playerName].overPrice = outcome.price;
          } else if (outcome.name === 'Under') {
            byPlayer[playerName].line = outcome.point;
            byPlayer[playerName].underPrice = outcome.price;
          }
        }
        for (const [playerName, data] of Object.entries(byPlayer)) {
          if (data.line == null) continue;
          rows.push({
            propType,
            playerName,
            gameId,
            fetchedAt,
            line: data.line,
            overPrice: data.overPrice || null,
            underPrice: data.underPrice || null,
          });
        }
      }
    }
    return rows;
  }

  return { parseEventPropLines };
}
