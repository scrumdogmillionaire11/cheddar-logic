'use strict';

// Tests for applyNbaTotalQuarantine() — quick-79 / WI-0588
// This file tests the pure demotion function (unit) and
// end-to-end integration via buildDecisionV2.

// ---------------------------------------------------------------------------
// Minimal payload factory for buildDecisionV2 integration tests
// ---------------------------------------------------------------------------

const RECENT_CAPTURED_AT = new Date(Date.now() - 60_000).toISOString(); // 1 min ago

/**
 * Build a minimal valid payload that will resolve to the given officialStatus
 * when the quarantine flag is OFF.
 *
 * model_prob / price combinations:
 *   - For NBA:TOTAL, play_edge_min = 0.062, lean_edge_min = 0.031
 *   - price -110 → implied_prob ≈ 0.5238
 *   - model_prob 0.59 → edge ≈ 0.066  → PLAY tier (>= play_edge_min, support >= 0.58)
 *   - model_prob 0.558 → edge ≈ 0.034 → LEAN tier (>= lean_edge_min, support >= 0.47)
 *   - model_prob 0.52  → edge ≈ -0.004 → PASS tier
 */
function buildPayload({ sport, market_type, model_prob, support_score, tier = 'play' }) {
  // price -110 gives implied_prob ≈ 0.5238
  const price = -110;
  const line = 220.5;
  const side = market_type === 'SPREAD' || market_type === 'MONEYLINE' ? 'OVER' : 'OVER';
  // Spread/ML need HOME/AWAY, TOTAL needs OVER/UNDER
  const selectionSide =
    market_type === 'SPREAD' || market_type === 'MONEYLINE' ? 'HOME' : 'OVER';

  return {
    kind: 'PLAY',
    sport,
    market_type,
    model_prob,
    price,
    line,
    selection: { side: selectionSide },
    driver: {
      score: support_score,
      inputs: {
        pace_tier: 'FAST',
        event_env: 'NEUTRAL',
        event_direction_tag: 'OVER',
        vol_env: 'LOW',
        total_bias: 'NONE',
      },
    },
    drivers_active: ['pace_model'],
    odds_context: {
      captured_at: RECENT_CAPTURED_AT,
      total_over: { line, price },
    },
  };
}

// ---------------------------------------------------------------------------
// Unit tests — pure applyNbaTotalQuarantine()
// ---------------------------------------------------------------------------

describe('applyNbaTotalQuarantine (unit)', () => {
  let applyNbaTotalQuarantine;

  beforeEach(() => {
    // Explicitly enable quarantine so unit tests for demotion behaviour work
    // regardless of the module default (which is OFF so POTD candidates flow).
    process.env.QUARANTINE_NBA_TOTAL = '1';
    jest.resetModules();
    const patch = require('../decision-pipeline-v2-edge-config');
    applyNbaTotalQuarantine = patch.applyNbaTotalQuarantine;
  });

  afterEach(() => {
    delete process.env.QUARANTINE_NBA_TOTAL;
  });

  it('returns unchanged when sport is not NBA', () => {
    const input = { sport: 'NHL', marketType: 'TOTAL', officialStatus: 'PLAY', priceReasonCodes: [] };
    const result = applyNbaTotalQuarantine(input);
    expect(result.officialStatus).toBe('PLAY');
    expect(result.priceReasonCodes).not.toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });

  it('returns unchanged when marketType is not TOTAL', () => {
    const input = { sport: 'NBA', marketType: 'SPREAD', officialStatus: 'PLAY', priceReasonCodes: [] };
    const result = applyNbaTotalQuarantine(input);
    expect(result.officialStatus).toBe('PLAY');
    expect(result.priceReasonCodes).not.toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });

  it('returns unchanged when officialStatus is PASS', () => {
    const input = { sport: 'NBA', marketType: 'TOTAL', officialStatus: 'PASS', priceReasonCodes: [] };
    const result = applyNbaTotalQuarantine(input);
    expect(result.officialStatus).toBe('PASS');
    expect(result.priceReasonCodes).not.toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });

  it('demotes PLAY to LEAN for NBA TOTAL', () => {
    const input = { sport: 'NBA', marketType: 'TOTAL', officialStatus: 'PLAY', priceReasonCodes: ['SOME_REASON'] };
    const result = applyNbaTotalQuarantine(input);
    expect(result.officialStatus).toBe('LEAN');
    expect(result.priceReasonCodes).toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
    expect(result.priceReasonCodes).toContain('SOME_REASON');
  });

  it('demotes LEAN to PASS for NBA TOTAL', () => {
    const input = { sport: 'NBA', marketType: 'TOTAL', officialStatus: 'LEAN', priceReasonCodes: [] };
    const result = applyNbaTotalQuarantine(input);
    expect(result.officialStatus).toBe('PASS');
    expect(result.priceReasonCodes).toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });

  it('does not duplicate NBA_TOTAL_QUARANTINE_DEMOTE if already present', () => {
    const input = {
      sport: 'NBA',
      marketType: 'TOTAL',
      officialStatus: 'PLAY',
      priceReasonCodes: ['NBA_TOTAL_QUARANTINE_DEMOTE'],
    };
    const result = applyNbaTotalQuarantine(input);
    const count = result.priceReasonCodes.filter(c => c === 'NBA_TOTAL_QUARANTINE_DEMOTE').length;
    expect(count).toBe(1);
  });

  it('is case-insensitive for sport and marketType', () => {
    const input = { sport: 'nba', marketType: 'total', officialStatus: 'PLAY', priceReasonCodes: [] };
    const result = applyNbaTotalQuarantine(input);
    expect(result.officialStatus).toBe('LEAN');
  });

  it('returns unchanged when QUARANTINE_NBA_TOTAL flag is off', () => {
    jest.resetModules();
    process.env.QUARANTINE_NBA_TOTAL = '0';
    const patch = require('../decision-pipeline-v2-edge-config');
    const fn = patch.applyNbaTotalQuarantine;
    const input = { sport: 'NBA', marketType: 'TOTAL', officialStatus: 'PLAY', priceReasonCodes: [] };
    const result = fn(input);
    expect(result.officialStatus).toBe('PLAY');
    expect(result.priceReasonCodes).not.toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — buildDecisionV2 end-to-end
// ---------------------------------------------------------------------------

describe('NBA TOTAL quarantine — buildDecisionV2 integration', () => {
  let buildDecisionV2;

  beforeAll(() => {
    // Explicitly enable quarantine for this integration suite. Do NOT rely on
    // the default — the default is false (quarantine off) so that NBA TOTAL
    // cards can be POTD candidates. Tests for quarantine-active behavior must
    // set the flag explicitly.
    process.env.QUARANTINE_NBA_TOTAL = '1';
    jest.resetModules();
    buildDecisionV2 = require('../decision-pipeline-v2').buildDecisionV2;
  });

  afterAll(() => {
    delete process.env.QUARANTINE_NBA_TOTAL;
  });

  it('NBA TOTAL PLAY-tier payload resolves to official_status=LEAN (quarantine demotes)', () => {
    const payload = buildPayload({
      sport: 'NBA',
      market_type: 'TOTAL',
      model_prob: 0.59,    // edge ≈ 0.066 > 0.062 play_edge_min
      support_score: 0.65, // > 0.58 play support threshold
    });
    const result = buildDecisionV2(payload);
    expect(result).not.toBeNull();
    expect(result.official_status).toBe('LEAN');
    expect(result.price_reason_codes).toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });

  it('NBA TOTAL LEAN-tier payload resolves to official_status=PASS (quarantine demotes)', () => {
    const payload = buildPayload({
      sport: 'NBA',
      market_type: 'TOTAL',
      model_prob: 0.558,   // edge ≈ 0.034 > 0.031 lean_edge_min, < 0.062 play_edge_min
      support_score: 0.50, // > 0.47 lean support threshold, < 0.58 play threshold
    });
    const result = buildDecisionV2(payload);
    expect(result).not.toBeNull();
    expect(result.official_status).toBe('PASS');
    expect(result.price_reason_codes).toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });

  it('NHL TOTAL PLAY-tier payload is unaffected (official_status=PLAY)', () => {
    // NHL:TOTAL play_edge_min=0.05, play support=0.52
    const payload = buildPayload({
      sport: 'NHL',
      market_type: 'TOTAL',
      model_prob: 0.58,    // edge ≈ 0.056 > 0.05
      support_score: 0.58, // > 0.52
    });
    const result = buildDecisionV2(payload);
    expect(result).not.toBeNull();
    expect(result.official_status).toBe('PLAY');
    expect(result.price_reason_codes).not.toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });

  it('NBA SPREAD PLAY-tier payload is unaffected (official_status=PLAY)', () => {
    // NBA:SPREAD play_edge_min=0.07, play support=0.68
    const payload = buildPayload({
      sport: 'NBA',
      market_type: 'SPREAD',
      model_prob: 0.60,    // edge ≈ 0.076 > 0.07
      support_score: 0.72, // > 0.68
    });
    const result = buildDecisionV2(payload);
    expect(result).not.toBeNull();
    expect(result.official_status).toBe('PLAY');
    expect(result.price_reason_codes).not.toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
  });

  it('NBA TOTAL PLAY-tier resolves to PLAY when QUARANTINE_NBA_TOTAL=0', () => {
    jest.resetModules();
    process.env.QUARANTINE_NBA_TOTAL = '0';
    const buildDecisionV2Off = require('../decision-pipeline-v2').buildDecisionV2;
    const payload = buildPayload({
      sport: 'NBA',
      market_type: 'TOTAL',
      model_prob: 0.59,
      support_score: 0.65,
    });
    const result = buildDecisionV2Off(payload);
    expect(result).not.toBeNull();
    expect(result.official_status).toBe('PLAY');
    expect(result.price_reason_codes).not.toContain('NBA_TOTAL_QUARANTINE_DEMOTE');
    delete process.env.QUARANTINE_NBA_TOTAL;
  });
});
