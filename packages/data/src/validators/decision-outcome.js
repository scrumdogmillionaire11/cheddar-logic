function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateReasons(reasons, errors) {
  if (reasons === undefined) return;
  if (!isObject(reasons)) {
    errors.push('reasons must be an object when provided');
    return;
  }

  ['pass', 'blockers', 'warnings'].forEach((key) => {
    const value = reasons[key];
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
      errors.push(`reasons.${key} must be an array of non-empty strings when provided`);
    }
  });
}

function validateDecisionOutcome(candidate) {
  const errors = [];
  const outcome = candidate;

  if (!isObject(outcome)) {
    return { valid: false, errors: ['DecisionOutcome must be an object'] };
  }

  const allowedStatuses = new Set(['PLAY', 'SLIGHT_EDGE', 'PASS']);
  if (!allowedStatuses.has(outcome.status)) {
    errors.push('status must be one of: PLAY, SLIGHT_EDGE, PASS');
  }

  if (!isObject(outcome.selection)) {
    errors.push('selection must be an object');
  } else {
    if (!isNonEmptyString(outcome.selection.market)) {
      errors.push('selection.market must be a non-empty string');
    }
    if (!isNonEmptyString(outcome.selection.side)) {
      errors.push('selection.side must be a non-empty string');
    }
    if (
      Object.prototype.hasOwnProperty.call(outcome.selection, 'line') &&
      outcome.selection.line !== null &&
      !isFiniteNumber(outcome.selection.line)
    ) {
      errors.push('selection.line must be a finite number or null');
    }
    if (
      Object.prototype.hasOwnProperty.call(outcome.selection, 'price') &&
      outcome.selection.price !== null &&
      !isFiniteNumber(outcome.selection.price)
    ) {
      errors.push('selection.price must be a finite number or null');
    }
  }

  if (outcome.edge !== null && !isFiniteNumber(outcome.edge)) {
    errors.push('edge must be a finite number or null');
  }

  if (outcome.confidence !== null && !isFiniteNumber(outcome.confidence)) {
    errors.push('confidence must be a finite number or null');
  }

  validateReasons(outcome.reasons, errors);

  if (!isObject(outcome.verification)) {
    errors.push('verification must be an object');
  } else {
    ['line_verified', 'data_fresh', 'inputs_complete'].forEach((key) => {
      if (typeof outcome.verification[key] !== 'boolean') {
        errors.push(`verification.${key} must be a boolean`);
      }
    });
  }

  if (!isObject(outcome.source)) {
    errors.push('source must be an object');
  } else {
    if (!isNonEmptyString(outcome.source.model)) {
      errors.push('source.model must be a non-empty string');
    }
    if (!isNonEmptyString(outcome.source.timestamp)) {
      errors.push('source.timestamp must be a non-empty string');
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

module.exports = {
  validateDecisionOutcome,
};
