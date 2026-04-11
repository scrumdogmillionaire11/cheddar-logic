'use strict';

function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

function buildModelOutput({
  market,
  model_status = 'MODEL_OK',
  fairProb = null,
  fairLine = null,
  confidence = 0,
  featuresUsed = {},
  missingOptional = [],
  missingCritical = [],
  leakageSafe = true,
  version = '1.0.0',
  diagnostics = {},
  ...rest
}) {
  return {
    ...rest,
    market,
    model_status,
    fairProb,
    fairLine,
    confidence,
    featuresUsed:
      featuresUsed && typeof featuresUsed === 'object' ? featuresUsed : {},
    missingOptional: normalizeList(missingOptional),
    missingCritical: normalizeList(missingCritical),
    diagnostics: {
      ...diagnostics,
      leakageSafe,
      version,
    },
  };
}

module.exports = { buildModelOutput };
