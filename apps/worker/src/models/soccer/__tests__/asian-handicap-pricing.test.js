const {
  removeVigTwoWay,
  priceAsianHandicap,
} = require('../asian-handicap-pricing');

describe('asian handicap pricing', () => {
  test('removeVigTwoWay normalizes implied probabilities to ~1', () => {
    const result = removeVigTwoWay(-110, -110);

    expect(result.success).toBe(true);
    expect(result.normalized_prob_a).toBeGreaterThan(0);
    expect(result.normalized_prob_b).toBeGreaterThan(0);
    expect(result.normalized_prob_a + result.normalized_prob_b).toBeCloseTo(1, 6);
  });

  test('prices whole-line AH and returns win/push/loss probabilities', () => {
    const result = priceAsianHandicap({
      lambda_home: 1.45,
      lambda_away: 1.05,
      line: -0.5,
      side: 'HOME',
      offered_price: -108,
      opposite_price: -112,
    });

    expect(result.success).toBe(true);
    expect(result.line_type).toBe('HALF');
    expect(result.probabilities.P_win).toBeGreaterThan(0);
    expect(result.probabilities.P_loss).toBeGreaterThan(0);
    expect(result.probabilities.P_push).toBeCloseTo(0, 6);
    expect(result.probabilities.P_win + result.probabilities.P_push + result.probabilities.P_loss).toBeCloseTo(1, 6);
  });

  test('quarter-line pricing exposes split outcome probabilities', () => {
    const result = priceAsianHandicap({
      lambda_home: 1.55,
      lambda_away: 1.1,
      line: -0.75,
      side: 'HOME',
      offered_price: 102,
      opposite_price: -122,
    });

    expect(result.success).toBe(true);
    expect(result.line_type).toBe('QUARTER');
    expect(result.probabilities.P_full_win).toBeGreaterThan(0);
    expect(result.probabilities.P_half_win).toBeGreaterThanOrEqual(0);
    expect(result.probabilities.P_half_loss).toBeGreaterThanOrEqual(0);
    expect(result.probabilities.P_full_loss).toBeGreaterThan(0);
    expect(result.probabilities.P_win + result.probabilities.P_push + result.probabilities.P_loss).toBeCloseTo(1, 6);
  });

  test('small price perturbation keeps EV sign stable for same side/line', () => {
    const baseline = priceAsianHandicap({
      lambda_home: 1.5,
      lambda_away: 1.0,
      line: -0.25,
      side: 'HOME',
      offered_price: -110,
      opposite_price: -110,
    });

    const perturbed = priceAsianHandicap({
      lambda_home: 1.5,
      lambda_away: 1.0,
      line: -0.25,
      side: 'HOME',
      offered_price: -108,
      opposite_price: -112,
    });

    expect(baseline.success).toBe(true);
    expect(perturbed.success).toBe(true);

    const baselineSign = Math.sign(baseline.expected_value);
    const perturbedSign = Math.sign(perturbed.expected_value);
    expect(perturbedSign).toBe(baselineSign);
  });

  test('rejects malformed line values', () => {
    const result = priceAsianHandicap({
      lambda_home: 1.5,
      lambda_away: 1.0,
      line: 0.3,
      side: 'HOME',
      offered_price: -110,
      opposite_price: -110,
    });

    expect(result.success).toBe(false);
    expect(result.reason_code).toBe('INVALID_HANDICAP_LINE');
  });
});
