'use strict';

const { buildModelOutput } = require('../model-output');

describe('buildModelOutput', () => {
  test('builds canonical fields and preserves extra fields', () => {
    const result = buildModelOutput({
      market: 'NBA_TOTAL',
      model_status: 'MODEL_OK',
      fairProb: 0.58,
      fairLine: 224.5,
      confidence: 0.72,
      featuresUsed: { paceAdjustment: 1.2 },
      missingOptional: ['restDaysHome'],
      missingCritical: [],
      diagnostics: { source: 'unit-test' },
      projectedTotal: 224.5,
      legacy_status: 'UNCHANGED',
    });

    expect(result).toMatchObject({
      market: 'NBA_TOTAL',
      model_status: 'MODEL_OK',
      fairProb: 0.58,
      fairLine: 224.5,
      confidence: 0.72,
      featuresUsed: { paceAdjustment: 1.2 },
      missingOptional: ['restDaysHome'],
      missingCritical: [],
      projectedTotal: 224.5,
      legacy_status: 'UNCHANGED',
    });
    expect(result.diagnostics).toMatchObject({
      leakageSafe: true,
      version: '1.0.0',
      source: 'unit-test',
    });
  });

  test('defaults optional fields when omitted', () => {
    const result = buildModelOutput({
      market: 'NHL_TOTAL',
    });

    expect(result).toMatchObject({
      market: 'NHL_TOTAL',
      model_status: 'MODEL_OK',
      fairProb: null,
      fairLine: null,
      confidence: 0,
      featuresUsed: {},
      missingOptional: [],
      missingCritical: [],
    });
    expect(result.diagnostics).toMatchObject({
      leakageSafe: true,
      version: '1.0.0',
    });
  });
});
