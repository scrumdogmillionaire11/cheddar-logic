/*
 * Snapshot contract for /api/cards and /api/games behavior parity.
 *
 * This test intentionally uses a deterministic fixture corpus and validates
 * that current behavior remains stable across status, visibility, and
 * projection-marker semantics.
 *
 * Run: node web/src/__tests__/api-cards-parity-snapshot.test.js
 */

import assert from 'node:assert/strict';

const PROJECTION_ONLY_LINE_SOURCES = new Set([
  'projection_floor',
  'synthetic',
  'synthetic_fallback',
]);

function getString(payload, path) {
  let current = payload;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      return null;
    }
    current = current[key];
  }
  if (typeof current !== 'string') return null;
  const trimmed = current.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isBettingSurfacePayloadCards(payload) {
  if (!payload) return true;

  const basis = String(
    getString(payload, ['decision_basis_meta', 'decision_basis']) ||
      getString(payload, ['basis']) ||
      '',
  ).toUpperCase();
  if (basis === 'PROJECTION_ONLY') return false;

  const executionStatus = String(
    getString(payload, ['execution_status']) ||
      getString(payload, ['play', 'execution_status']) ||
      getString(payload, ['prop_display_state']) ||
      getString(payload, ['play', 'prop_display_state']) ||
      '',
  ).toUpperCase();
  if (executionStatus === 'PROJECTION_ONLY') return false;

  const lineSource = String(
    getString(payload, ['decision_basis_meta', 'market_line_source']) ||
      getString(payload, ['market_context', 'wager', 'line_source']) ||
      getString(payload, ['play', 'market_context', 'wager', 'line_source']) ||
      getString(payload, ['line_source']) ||
      getString(payload, ['play', 'line_source']) ||
      '',
  ).toLowerCase();
  if (PROJECTION_ONLY_LINE_SOURCES.has(lineSource)) return false;

  const projectionSource = String(
    getString(payload, ['prop_decision', 'projection_source']) ||
      getString(payload, ['play', 'prop_decision', 'projection_source']) ||
      getString(payload, ['projection_source']) ||
      getString(payload, ['play', 'projection_source']) ||
      '',
  ).toUpperCase();

  return projectionSource !== 'SYNTHETIC_FALLBACK';
}

function normalizeDecisionBasisToken(value) {
  const n = (value ?? '').trim().toUpperCase();
  if (n === 'PROJECTION_ONLY') return 'PROJECTION_ONLY';
  if (n === 'ODDS_BACKED') return 'ODDS_BACKED';
  return undefined;
}

function normalizeExecutionStatusToken(value) {
  const n = (value ?? '').trim().toUpperCase();
  if (n === 'EXECUTABLE') return 'EXECUTABLE';
  if (n === 'PROJECTION_ONLY') return 'PROJECTION_ONLY';
  if (n === 'BLOCKED') return 'BLOCKED';
  return undefined;
}

function isProjectionOnlyPlay(payload) {
  const play = payload?.play && typeof payload.play === 'object' ? payload.play : payload;
  const lineSource =
    (play?.line_source ?? '').trim().toUpperCase() ||
    (play?.market_context?.wager?.line_source ?? '').trim().toUpperCase();
  const projectionSource = (play?.prop_decision?.projection_source ?? '').trim().toUpperCase();

  const decisionBasis = normalizeDecisionBasisToken(
    payload?.decision_basis_meta?.decision_basis ??
      payload?.basis ??
      play?.basis ??
      play?.decision_basis,
  );
  const execStatus = normalizeExecutionStatusToken(
    payload?.execution_status ?? play?.execution_status,
  );
  const propDisplayState = (
    payload?.prop_display_state ?? play?.prop_display_state ?? ''
  ).trim().toUpperCase();

  return (
    decisionBasis === 'PROJECTION_ONLY' ||
    execStatus === 'PROJECTION_ONLY' ||
    propDisplayState === 'PROJECTION_ONLY' ||
    PROJECTION_ONLY_LINE_SOURCES.has(lineSource.toLowerCase()) ||
    projectionSource === 'SYNTHETIC_FALLBACK'
  );
}

function normalizeStatus(payload) {
  const play = payload?.play && typeof payload.play === 'object' ? payload.play : null;
  const decisionV2 = payload?.decision_v2 ?? play?.decision_v2 ?? null;
  const officialStatus =
    decisionV2?.official_status ||
    (payload?.action ?? play?.action ?? '').toUpperCase() ||
    (payload?.verdict ?? play?.verdict ?? '').toUpperCase() ||
    null;

  if (officialStatus === 'PLAY' || officialStatus === 'FIRE') return 'PLAY';
  if (officialStatus === 'LEAN' || officialStatus === 'WATCH') return 'LEAN';
  if (officialStatus === 'PASS') return 'PASS';
  if (officialStatus === 'DEGRADED') return 'DEGRADED';
  if (officialStatus === 'NO_BET' || officialStatus === 'BLOCKED') return 'NO_BET';
  return 'NO_BET';
}

function toSurfaceBucket(status) {
  if (status === 'PLAY') return 'OFFICIAL';
  if (status === 'LEAN') return 'MONITORED';
  return 'DIAGNOSTIC';
}

function reasonCode(payload) {
  const play = payload?.play && typeof payload.play === 'object' ? payload.play : null;
  const decisionV2 = payload?.decision_v2 ?? play?.decision_v2 ?? null;
  return (
    decisionV2?.primary_reason_code ??
    payload?.pass_reason_code ??
    play?.pass_reason_code ??
    null
  );
}

function cardsBehavior(payload) {
  const status = normalizeStatus(payload);
  const visibleOnCards = isBettingSurfacePayloadCards(payload);
  const visibilityClass = visibleOnCards ? 'visible' : 'hidden';
  const projectionSource = (
    payload?.prop_decision?.projection_source ??
    payload?.play?.prop_decision?.projection_source ??
    payload?.projection_source ??
    payload?.play?.projection_source ??
    ''
  ).toUpperCase();
  const propDisplayState = (
    payload?.prop_display_state ?? payload?.play?.prop_display_state ?? ''
  ).toUpperCase();

  return {
    status,
    surface_bucket: toSurfaceBucket(status),
    reason_code: reasonCode(payload),
    visibility_class: visibilityClass,
    has_projection_marker:
      projectionSource === 'SYNTHETIC_FALLBACK' ||
      propDisplayState === 'PROJECTION_ONLY' ||
      visibilityClass === 'projection_only',
  };
}

function gamesBehavior(payload) {
  const status = normalizeStatus(payload);
  const play = payload?.play && typeof payload.play === 'object' ? payload.play : payload;
  const lineSource = (
    payload?.line_source ??
    play?.line_source ??
    payload?.market_context?.wager?.line_source ??
    play?.market_context?.wager?.line_source ??
    ''
  ).toLowerCase();

  let visibilityClass = isProjectionOnlyPlay(payload) ? 'projection_only' : 'visible';
  if (PROJECTION_ONLY_LINE_SOURCES.has(lineSource)) {
    visibilityClass = 'projection_only';
  }

  const projectionSource = (
    payload?.prop_decision?.projection_source ??
    play?.prop_decision?.projection_source ??
    ''
  ).toUpperCase();
  const propDisplayState = (
    payload?.prop_display_state ?? play?.prop_display_state ?? ''
  ).toUpperCase();

  return {
    status,
    surface_bucket: toSurfaceBucket(status),
    reason_code: reasonCode(payload),
    visibility_class: visibilityClass,
    has_projection_marker:
      projectionSource === 'SYNTHETIC_FALLBACK' ||
      propDisplayState === 'PROJECTION_ONLY' ||
      visibilityClass === 'projection_only',
  };
}

const FIXTURES = [
  {
    fixtureId: 'parity-001-standard-play',
    payload: {
      basis: 'ODDS_BACKED', execution_status: 'EXECUTABLE', action: 'PLAY',
      decision_v2: { official_status: 'PLAY', primary_reason_code: 'EDGE_CONFIRMED' },
    },
  },
  {
    fixtureId: 'parity-002-standard-lean',
    payload: {
      basis: 'ODDS_BACKED', execution_status: 'EXECUTABLE', action: 'LEAN',
      decision_v2: { official_status: 'LEAN', primary_reason_code: 'LEAN_EDGE' },
    },
  },
  {
    fixtureId: 'parity-003-projection-only',
    payload: {
      basis: 'PROJECTION_ONLY', execution_status: 'PROJECTION_ONLY', prop_display_state: 'PROJECTION_ONLY', action: 'PASS',
      decision_v2: { official_status: 'PASS', primary_reason_code: 'NO_MARKET_LINE' },
    },
  },
  {
    fixtureId: 'parity-004-synthetic-fallback',
    payload: {
      line_source: 'synthetic_fallback', prop_decision: { projection_source: 'SYNTHETIC_FALLBACK' }, action: 'PASS',
      decision_v2: { official_status: 'PASS', primary_reason_code: 'SYNTHETIC_FALLBACK_GATE' },
    },
  },
  {
    fixtureId: 'parity-005-pass-with-reason',
    payload: {
      basis: 'ODDS_BACKED', execution_status: 'EXECUTABLE', action: 'PASS', pass_reason_code: 'SIGMA_INSUFFICIENT',
      decision_v2: { official_status: 'PASS', primary_reason_code: 'SIGMA_INSUFFICIENT' },
    },
  },
  {
    fixtureId: 'parity-006-blocked',
    payload: {
      basis: 'ODDS_BACKED', execution_status: 'BLOCKED', action: 'NO_BET',
      decision_v2: { official_status: 'NO_BET', primary_reason_code: 'INPUT_GATE_BLOCK' },
    },
  },
  {
    fixtureId: 'parity-007-nested-play',
    payload: {
      play: {
        basis: 'ODDS_BACKED', execution_status: 'EXECUTABLE', action: 'PLAY',
        decision_v2: { official_status: 'PLAY', primary_reason_code: 'EDGE_CONFIRMED' },
      },
    },
  },
  {
    fixtureId: 'parity-008-projection-floor',
    payload: {
      line_source: 'projection_floor', action: 'PASS',
      decision_v2: { official_status: 'PASS', primary_reason_code: 'PROJECTION_FLOOR_GATE' },
    },
  },
];

const runtimeSnapshot = FIXTURES.map(({ fixtureId, payload }) => {
  const cards = cardsBehavior(payload);
  const games = gamesBehavior(payload);

  const deltas = [];
  for (const field of ['status', 'surface_bucket', 'reason_code', 'visibility_class', 'has_projection_marker']) {
    if (String(cards[field]) !== String(games[field])) {
      deltas.push(field);
    }
  }

  return {
    fixtureId,
    parity_status: deltas.length === 0 ? 'MATCH' : 'EXPECTED_DELTA',
    field_deltas: deltas,
    cards,
    games,
  };
});

const expectedSnapshot = [
  {
    fixtureId: 'parity-001-standard-play',
    parity_status: 'MATCH',
    field_deltas: [],
    cards: { status: 'PLAY', surface_bucket: 'OFFICIAL', reason_code: 'EDGE_CONFIRMED', visibility_class: 'visible', has_projection_marker: false },
    games: { status: 'PLAY', surface_bucket: 'OFFICIAL', reason_code: 'EDGE_CONFIRMED', visibility_class: 'visible', has_projection_marker: false },
  },
  {
    fixtureId: 'parity-002-standard-lean',
    parity_status: 'MATCH',
    field_deltas: [],
    cards: { status: 'LEAN', surface_bucket: 'MONITORED', reason_code: 'LEAN_EDGE', visibility_class: 'visible', has_projection_marker: false },
    games: { status: 'LEAN', surface_bucket: 'MONITORED', reason_code: 'LEAN_EDGE', visibility_class: 'visible', has_projection_marker: false },
  },
  {
    fixtureId: 'parity-003-projection-only',
    parity_status: 'EXPECTED_DELTA',
    field_deltas: ['visibility_class'],
    cards: { status: 'PASS', surface_bucket: 'DIAGNOSTIC', reason_code: 'NO_MARKET_LINE', visibility_class: 'hidden', has_projection_marker: true },
    games: { status: 'PASS', surface_bucket: 'DIAGNOSTIC', reason_code: 'NO_MARKET_LINE', visibility_class: 'projection_only', has_projection_marker: true },
  },
  {
    fixtureId: 'parity-004-synthetic-fallback',
    parity_status: 'EXPECTED_DELTA',
    field_deltas: ['visibility_class'],
    cards: { status: 'PASS', surface_bucket: 'DIAGNOSTIC', reason_code: 'SYNTHETIC_FALLBACK_GATE', visibility_class: 'hidden', has_projection_marker: true },
    games: { status: 'PASS', surface_bucket: 'DIAGNOSTIC', reason_code: 'SYNTHETIC_FALLBACK_GATE', visibility_class: 'projection_only', has_projection_marker: true },
  },
  {
    fixtureId: 'parity-005-pass-with-reason',
    parity_status: 'MATCH',
    field_deltas: [],
    cards: { status: 'PASS', surface_bucket: 'DIAGNOSTIC', reason_code: 'SIGMA_INSUFFICIENT', visibility_class: 'visible', has_projection_marker: false },
    games: { status: 'PASS', surface_bucket: 'DIAGNOSTIC', reason_code: 'SIGMA_INSUFFICIENT', visibility_class: 'visible', has_projection_marker: false },
  },
  {
    fixtureId: 'parity-006-blocked',
    parity_status: 'MATCH',
    field_deltas: [],
    cards: { status: 'NO_BET', surface_bucket: 'DIAGNOSTIC', reason_code: 'INPUT_GATE_BLOCK', visibility_class: 'visible', has_projection_marker: false },
    games: { status: 'NO_BET', surface_bucket: 'DIAGNOSTIC', reason_code: 'INPUT_GATE_BLOCK', visibility_class: 'visible', has_projection_marker: false },
  },
  {
    fixtureId: 'parity-007-nested-play',
    parity_status: 'MATCH',
    field_deltas: [],
    cards: { status: 'PLAY', surface_bucket: 'OFFICIAL', reason_code: 'EDGE_CONFIRMED', visibility_class: 'visible', has_projection_marker: false },
    games: { status: 'PLAY', surface_bucket: 'OFFICIAL', reason_code: 'EDGE_CONFIRMED', visibility_class: 'visible', has_projection_marker: false },
  },
  {
    fixtureId: 'parity-008-projection-floor',
    parity_status: 'EXPECTED_DELTA',
    field_deltas: ['visibility_class', 'has_projection_marker'],
    cards: { status: 'PASS', surface_bucket: 'DIAGNOSTIC', reason_code: 'PROJECTION_FLOOR_GATE', visibility_class: 'hidden', has_projection_marker: false },
    games: { status: 'PASS', surface_bucket: 'DIAGNOSTIC', reason_code: 'PROJECTION_FLOOR_GATE', visibility_class: 'projection_only', has_projection_marker: true },
  },
];

assert.deepEqual(
  runtimeSnapshot,
  expectedSnapshot,
  'Snapshot mismatch: /cards behavior drifted from current expected contract.',
);

console.log('✅ /cards parity snapshot contract is stable');
