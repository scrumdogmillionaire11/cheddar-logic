'use strict';

const { __private } = require('../potd/run_potd_engine');

describe('POTD empty-selection rejection diagnostics', () => {
  const { hasEmptySelectionRejectionCode } = __private;

  test('treats NO_QUALIFIED_PROPS as empty-selection', () => {
    const candidate = {
      rejectionDiagnostics: [{ code: 'NO_QUALIFIED_PROPS' }],
    };

    expect(hasEmptySelectionRejectionCode(candidate)).toBe(true);
  });

  test('treats SKIP_MARKET_NO_EDGE as empty-selection', () => {
    const candidate = {
      rejectionDiagnostics: [{ code: 'skip_market_no_edge' }],
    };

    expect(hasEmptySelectionRejectionCode(candidate)).toBe(true);
  });

  test('does not treat unrelated diagnostics as empty-selection', () => {
    const candidate = {
      rejectionDiagnostics: [{ code: 'MODEL_SIGNAL_INCOMPLETE' }],
    };

    expect(hasEmptySelectionRejectionCode(candidate)).toBe(false);
  });
});
