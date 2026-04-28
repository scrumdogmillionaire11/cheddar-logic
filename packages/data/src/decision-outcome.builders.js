const reasonCodes = require('./reason-codes');
const { validateDecisionOutcome } = require('./validators/decision-outcome');

const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

function toUpperToken(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function pickFirstString() {
  for (let i = 0; i < arguments.length; i += 1) {
    const candidate = arguments[i];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return '';
}

function pickFirstDefined() {
  for (let i = 0; i < arguments.length; i += 1) {
    if (arguments[i] !== undefined && arguments[i] !== null) {
      return arguments[i];
    }
  }
  return undefined;
}

function normalizeDecisionOutcomeStatus(status) {
  const normalized = toUpperToken(status);
  if (normalized === 'PLAY') return 'PLAY';
  if (normalized === 'SLIGHT_EDGE' || normalized === 'SLIGHT-EDGE' || normalized === 'LEAN') {
    return 'SLIGHT_EDGE';
  }
  return 'PASS';
}

function toReasonCodeList() {
  const values = [];
  for (let i = 0; i < arguments.length; i += 1) {
    const source = arguments[i];
    if (typeof source === 'string') {
      const code = toUpperToken(source);
      if (code) values.push(code);
      continue;
    }
    if (!Array.isArray(source)) continue;
    for (let j = 0; j < source.length; j += 1) {
      const code = toUpperToken(source[j]);
      if (!code) continue;
      values.push(code);
    }
  }
  return values;
}

function mapReasonsToOutcome(decisionV2) {
  const source = decisionV2 && typeof decisionV2 === 'object' ? decisionV2 : {};
  const rawCodes = toReasonCodeList(
    source.primary_reason_code,
    source.reason_codes,
    source.blocking_reason_codes,
    source.watchdog_reason_codes,
    source.price_reason_codes,
  );

  const seen = new Set();
  const pass = [];
  const blockers = [];
  const warnings = [];

  rawCodes.forEach((code) => {
    if (seen.has(code)) return;
    seen.add(code);

    if (
      reasonCodes.DATA_BLOCKER_CODES.has(code) ||
      reasonCodes.GATE_REASON_CODES.has(code) ||
      code.startsWith('BLOCK_')
    ) {
      blockers.push(code);
      return;
    }

    if (code.startsWith('PASS_')) {
      pass.push(code);
      return;
    }

    warnings.push(code);
  });

  const mapped = {};
  if (pass.length > 0) mapped.pass = pass;
  if (blockers.length > 0) mapped.blockers = blockers;
  if (warnings.length > 0) mapped.warnings = warnings;
  return mapped;
}

function buildSelection(decisionV2, metadata) {
  const selectionSource =
    decisionV2 && decisionV2.selection && typeof decisionV2.selection === 'object'
      ? decisionV2.selection
      : {};

  const market = pickFirstString(
    selectionSource.market,
    selectionSource.market_type,
    decisionV2.market,
    decisionV2.market_type,
    metadata.market,
  );

  const side = pickFirstString(
    selectionSource.side,
    decisionV2.prediction,
    decisionV2.selection_side,
    metadata.side,
  );

  const line = toFiniteNumberOrNull(
    pickFirstDefined(selectionSource.line, decisionV2.line, decisionV2.best_line, metadata.line),
  );
  const price = toFiniteNumberOrNull(
    pickFirstDefined(selectionSource.price, decisionV2.price, decisionV2.best_price, metadata.price),
  );

  const selection = {
    market: market || 'UNKNOWN',
    side: side || 'UNKNOWN',
  };

  if (line !== null) selection.line = line;
  if (price !== null) selection.price = price;

  return selection;
}

function buildDecisionOutcomeFromDecisionV2(decisionV2, metadata) {
  const sourceDecision = decisionV2 && typeof decisionV2 === 'object' ? decisionV2 : {};
  const sourceMetadata = metadata && typeof metadata === 'object' ? metadata : {};

  const output = {
    status: normalizeDecisionOutcomeStatus(sourceDecision.official_status || sourceDecision.status),
    selection: buildSelection(sourceDecision, sourceMetadata),
    edge: toFiniteNumberOrNull(
      pickFirstDefined(sourceDecision.edge, sourceDecision.edge_pct, sourceDecision.edge_over_pp),
    ),
    confidence: toFiniteNumberOrNull(
      pickFirstDefined(sourceDecision.confidence, sourceDecision.confidence_score),
    ),
    reasons: mapReasonsToOutcome(sourceDecision),
    verification: {
      line_verified: Boolean(
        pickFirstDefined(
          sourceDecision.line_verified,
          sourceDecision.market_verified,
          sourceMetadata.line_verified,
        ),
      ),
      data_fresh: Boolean(
        pickFirstDefined(
          sourceDecision.data_fresh,
          sourceDecision.snapshot_fresh,
          sourceMetadata.data_fresh,
        ),
      ),
      inputs_complete: Boolean(
        pickFirstDefined(
          sourceDecision.inputs_complete,
          sourceDecision.projection_inputs_complete,
          sourceMetadata.inputs_complete,
        ),
      ),
    },
    source: {
      model:
        pickFirstString(
          sourceMetadata.model,
          sourceDecision.model,
          sourceDecision.model_name,
          sourceMetadata.model_name,
        ) || 'unknown',
      timestamp:
        pickFirstString(
          sourceMetadata.timestamp,
          sourceDecision.timestamp,
          sourceDecision.generated_at,
          sourceMetadata.generated_at,
        ) || FALLBACK_TIMESTAMP,
    },
  };

  const validation = validateDecisionOutcome(output);
  if (!validation.valid) {
    throw new TypeError(`Invalid DecisionOutcome: ${(validation.errors || []).join('; ')}`);
  }

  return output;
}

module.exports = {
  buildDecisionOutcomeFromDecisionV2,
  mapReasonsToOutcome,
  normalizeDecisionOutcomeStatus,
};
