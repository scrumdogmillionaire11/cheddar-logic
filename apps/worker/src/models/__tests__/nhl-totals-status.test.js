const { classifyNhlTotalsStatus, computeNhl1pForecast } = require('../nhl-totals-status');

describe('classifyNhlTotalsStatus', () => {
  const baseInput = {
    side: 'OVER',
    modelTotal: 7.6,
    marketTotal: 5.5,
    integrityOk: true,
    goaliesConfirmedHome: true,
    goaliesConfirmedAway: true,
    majorInjuryUncertainty: false,
    accelerantScore: 0.25,
    hasRequiredInputs: true,
  };

  test('+2.1 at 5.5 over => PLAY', () => {
    const result = classifyNhlTotalsStatus(baseInput);
    expect(result.status).toBe('PLAY');
  });

  test('-1.5 at 6.5 under => PLAY', () => {
    const result = classifyNhlTotalsStatus({
      ...baseInput,
      side: 'UNDER',
      modelTotal: 5.0,
      marketTotal: 6.5,
    });
    expect(result.status).toBe('PLAY');
  });

  test('+0.7 at 6.5 over with accelerant 0.10 => PASS', () => {
    const result = classifyNhlTotalsStatus({
      ...baseInput,
      side: 'OVER',
      modelTotal: 7.2,
      marketTotal: 6.5,
      accelerantScore: 0.1,
    });
    expect(result.status).toBe('PASS');
  });

  test('+0.7 at 6.5 over with accelerant 0.25 => SLIGHT EDGE', () => {
    const result = classifyNhlTotalsStatus({
      ...baseInput,
      side: 'OVER',
      modelTotal: 7.2,
      marketTotal: 6.5,
      accelerantScore: 0.25,
    });
    expect(result.status).toBe('SLIGHT EDGE');
  });

  test('+0.5 at 5.5 over => SLIGHT EDGE', () => {
    const result = classifyNhlTotalsStatus({
      ...baseInput,
      modelTotal: 6.0,
      marketTotal: 5.5,
    });
    expect(result.status).toBe('SLIGHT EDGE');
  });

  test('+0.4 at 5.5 over => PASS', () => {
    const result = classifyNhlTotalsStatus({
      ...baseInput,
      modelTotal: 5.9,
      marketTotal: 5.5,
    });
    expect(result.status).toBe('PASS');
  });

  test('integrityOk=false => PASS', () => {
    const result = classifyNhlTotalsStatus({ ...baseInput, integrityOk: false });
    expect(result.status).toBe('PASS');
    expect(result.reasonCodes).toContain('PASS_INTEGRITY_BLOCK');
  });

  test('unconfirmed goalies cap PLAY to SLIGHT EDGE', () => {
    const result = classifyNhlTotalsStatus({
      ...baseInput,
      goaliesConfirmedHome: false,
      goaliesConfirmedAway: true,
    });
    expect(result.status).toBe('SLIGHT EDGE');
    expect(result.reasonCodes).toContain(
      'DOWNGRADE_PLAY_TO_SLIGHT_EDGE_GOALIE_UNCERTAINTY',
    );
  });

  test('under 5.5 downgrades one tier', () => {
    const result = classifyNhlTotalsStatus({
      ...baseInput,
      side: 'UNDER',
      modelTotal: 4.0,
      marketTotal: 5.5,
    });
    expect(result.status).toBe('SLIGHT EDGE');
    expect(result.reasonCodes).toContain('DOWNGRADE_PLAY_TO_SLIGHT_EDGE_UNDER_5_5');
  });

  test('abs(delta) >= 1.0 cannot be SLIGHT EDGE without explicit downgrade reason', () => {
    const result = classifyNhlTotalsStatus({
      ...baseInput,
      side: 'OVER',
      modelTotal: 7.0,
      marketTotal: 6.0,
    });

    if (result.status === 'SLIGHT EDGE') {
      expect(result.reasonCodes).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^DOWNGRADE_PLAY_TO_SLIGHT_EDGE_/),
        ]),
      );
    } else {
      expect(result.status).toBe('PLAY');
    }
  });
});

describe('computeNhl1pForecast', () => {
  test('valid inputs return correct delta, absDelta, forecastValid=true', () => {
    const result = computeNhl1pForecast({ modelTotal: 6.5, marketTotal: 5.5 });
    expect(result.delta).toBeCloseTo(1.0);
    expect(result.absDelta).toBeCloseTo(1.0);
    expect(result.forecastValid).toBe(true);
    expect(result.modelTotal).toBeCloseTo(6.5);
    expect(result.marketTotal).toBeCloseTo(5.5);
  });

  test('hasRequiredInputs=false returns forecastValid=false', () => {
    const result = computeNhl1pForecast({ modelTotal: 5.0, marketTotal: 5.5, hasRequiredInputs: false });
    expect(result.forecastValid).toBe(false);
  });

  test('NaN modelTotal returns forecastValid=false, NaN delta and absDelta', () => {
    const result = computeNhl1pForecast({ modelTotal: NaN, marketTotal: 5.5 });
    expect(result.forecastValid).toBe(false);
    expect(Number.isFinite(result.delta)).toBe(false);
    expect(Number.isFinite(result.absDelta)).toBe(false);
  });
});

describe('classifyNhlTotalsStatus — independent thresholds', () => {
  test('OVER: tightened play threshold promotes absDelta=0.8 to PLAY (default would be SLIGHT EDGE)', () => {
    const result = classifyNhlTotalsStatus({
      side: 'OVER',
      modelTotal: 6.3,
      marketTotal: 5.5,
      integrityOk: true,
      goaliesConfirmedHome: true,
      goaliesConfirmedAway: true,
      majorInjuryUncertainty: false,
      thresholds: {
        over:  { play: 0.7, slightEdge: 0.4 },
        under: { play: 1.0, slightEdge: 0.5 },
      },
    });
    expect(result.status).toBe('PLAY');
  });

  test('UNDER: raised play threshold demotes absDelta=1.0 from PLAY to SLIGHT EDGE', () => {
    const result = classifyNhlTotalsStatus({
      side: 'UNDER',
      modelTotal: 4.0,
      marketTotal: 5.0,
      integrityOk: true,
      goaliesConfirmedHome: true,
      goaliesConfirmedAway: true,
      majorInjuryUncertainty: false,
      thresholds: {
        over:  { play: 1.0, slightEdge: 0.5 },
        under: { play: 1.5, slightEdge: 0.5 },
      },
    });
    expect(result.status).toBe('SLIGHT EDGE');
  });
});
