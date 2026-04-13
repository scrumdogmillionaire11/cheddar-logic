/**
 * WI-0902: Endpoint Behavioral Parity Fixtures for Cards and Games
 *
 * Purpose: Prevent silent behavioral drift between /api/cards and /api/games
 * by asserting reason-level explainability on every difference, not just
 * boolean equality.
 *
 * Run: node web/src/__tests__/api-endpoint-parity-fixtures.test.js
 *
 * This file applies the same normalization logic used by both endpoint paths
 * to a shared fixture corpus and produces deterministic diff objects.
 *
 * Architecture:
 *   - Cards path: reads payloadData as-is, calls isBettingSurfacePayload()
 *     to determine visibility; returns status from payloadData fields directly
 *   - Games path: transforms payloadData via normalizeDecisionBasisToken(),
 *     normalizeExecutionStatusToken(), isProjectionOnlyPlayPayload(); produces
 *     a Play object with normalized behavioral fields
 *   - Parity diff: compares status, reason_code, visibility_class,
 *     has_projection_marker derived from each path
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

// ---------------------------------------------------------------------------
// Source contract verification
// ---------------------------------------------------------------------------

const cardsRouteSource = fs.readFileSync(
  path.join(REPO_ROOT, 'web/src/app/api/cards/route.ts'),
  'utf8',
);

const gamesRouteHandlerSource = fs.readFileSync(
  path.join(REPO_ROOT, 'web/src/lib/games/route-handler.ts'),
  'utf8',
);

// Verify both paths use the same PROJECTION_ONLY detection logic
assert(
  cardsRouteSource.includes("basis === 'PROJECTION_ONLY'") ||
    cardsRouteSource.includes("'PROJECTION_ONLY'"),
  'Expected cards route to detect PROJECTION_ONLY status',
);

assert(
  gamesRouteHandlerSource.includes("'PROJECTION_ONLY'"),
  'Expected games route-handler to detect PROJECTION_ONLY status',
);

assert(
  gamesRouteHandlerSource.includes('execution_status: normalizedExecutionStatus'),
  'Expected games route-handler to emit normalized execution_status',
);

assert(
  gamesRouteHandlerSource.includes('basis: normalizedDecisionBasis'),
  'Expected games route-handler to emit normalized decision basis',
);

assert(
  gamesRouteHandlerSource.includes('prop_display_state: normalizedPropDisplayState'),
  'Expected games route-handler to emit normalized prop_display_state',
);

// ---------------------------------------------------------------------------
// Shared normalization helpers (mirror of both endpoint paths)
// ---------------------------------------------------------------------------

const PROJECTION_ONLY_LINE_SOURCES = new Set([
  'projection_floor',
  'synthetic',
  'synthetic_fallback',
]);

/**
 * Mirror of cards route isBettingSurfacePayload()
 * Returns false for projection-only payloads, true otherwise.
 */
function isBettingSurfacePayloadCards(payload) {
  if (!payload) return true;

  const getStr = (obj, ...keys) => {
    let cur = obj;
    for (const key of keys) {
      if (!cur || typeof cur !== 'object' || !(key in cur)) return null;
      cur = cur[key];
    }
    if (typeof cur !== 'string') return null;
    const n = cur.trim();
    return n.length > 0 ? n : null;
  };

  const basis = String(
    getStr(payload, 'decision_basis_meta', 'decision_basis') ||
      getStr(payload, 'basis') ||
      '',
  ).toUpperCase();
  if (basis === 'PROJECTION_ONLY') return false;

  const executionStatus = String(
    getStr(payload, 'execution_status') ||
      getStr(payload, 'play', 'execution_status') ||
      getStr(payload, 'prop_display_state') ||
      getStr(payload, 'play', 'prop_display_state') ||
      '',
  ).toUpperCase();
  if (executionStatus === 'PROJECTION_ONLY') return false;

  const lineSource = String(
    getStr(payload, 'decision_basis_meta', 'market_line_source') ||
      getStr(payload, 'market_context', 'wager', 'line_source') ||
      getStr(payload, 'play', 'market_context', 'wager', 'line_source') ||
      getStr(payload, 'line_source') ||
      getStr(payload, 'play', 'line_source') ||
      '',
  ).toLowerCase();
  if (PROJECTION_ONLY_LINE_SOURCES.has(lineSource)) return false;

  const projectionSource = String(
    getStr(payload, 'prop_decision', 'projection_source') ||
      getStr(payload, 'play', 'prop_decision', 'projection_source') ||
      getStr(payload, 'projection_source') ||
      getStr(payload, 'play', 'projection_source') ||
      '',
  ).toUpperCase();
  if (projectionSource === 'SYNTHETIC_FALLBACK') return false;

  return true;
}

/**
 * Mirror of games route-handler normalizeDecisionBasisToken()
 */
function normalizeDecisionBasisToken(value) {
  const n = (value ?? '').trim().toUpperCase();
  if (n === 'PROJECTION_ONLY') return 'PROJECTION_ONLY';
  if (n === 'ODDS_BACKED') return 'ODDS_BACKED';
  return undefined;
}

/**
 * Mirror of games route-handler normalizeExecutionStatusToken()
 */
function normalizeExecutionStatusToken(value) {
  const n = (value ?? '').trim().toUpperCase();
  if (n === 'EXECUTABLE') return 'EXECUTABLE';
  if (n === 'PROJECTION_ONLY') return 'PROJECTION_ONLY';
  if (n === 'BLOCKED') return 'BLOCKED';
  return undefined;
}

/**
 * Mirror of games route-handler isProjectionOnlyPlayPayload()
 * Returns true when a play payload should be treated as projection-only.
 */
function isProjectionOnlyPlay(payload) {
  const play = (payload && typeof payload.play === 'object' && payload.play)
    ? payload.play
    : payload;

  const lineSource =
    (play?.line_source ?? '').trim().toUpperCase() ||
    (play?.market_context?.wager?.line_source ?? '').trim().toUpperCase();

  const projectionSource =
    (play?.prop_decision?.projection_source ?? '').trim().toUpperCase();

  const decisionBasis = normalizeDecisionBasisToken(
    payload?.decision_basis_meta?.decision_basis ??
      payload?.basis ??
      play?.basis ??
      play?.decision_basis,
  );
  const execStatus = normalizeExecutionStatusToken(
    payload?.execution_status ??
      play?.execution_status,
  );
  const propDisplayState = (
    payload?.prop_display_state ??
      play?.prop_display_state ??
      ''
  ).trim().toUpperCase();

  return (
    decisionBasis === 'PROJECTION_ONLY' ||
    execStatus === 'PROJECTION_ONLY' ||
    propDisplayState === 'PROJECTION_ONLY' ||
    PROJECTION_ONLY_LINE_SOURCES.has(lineSource.toLowerCase()) ||
    projectionSource === 'SYNTHETIC_FALLBACK'
  );
}

// ---------------------------------------------------------------------------
// Behavioral field extractors for each path
// ---------------------------------------------------------------------------

/**
 * Extract behavioral fields from the cards path perspective.
 * The cards route returns raw payloadData — we derive the behavioral summary
 * using the same helpers cards route uses.
 */
function extractCardsPathBehavior(payload) {
  const isSurface = isBettingSurfacePayloadCards(payload);

  const play = (payload && typeof payload.play === 'object' && payload.play)
    ? payload.play
    : null;

  // Status: read from decision_v2.official_status, then action, then payload status
  const decisionV2 = payload?.decision_v2 ?? play?.decision_v2 ?? null;
  const officialStatus =
    (decisionV2?.official_status) ||
    ((payload?.action ?? play?.action ?? '')).toUpperCase() ||
    ((payload?.verdict ?? play?.verdict ?? '')).toUpperCase() ||
    null;

  // Normalize to the parity vocabulary
  let status = 'NO_BET';
  if (officialStatus === 'PLAY' || officialStatus === 'FIRE') status = 'PLAY';
  else if (officialStatus === 'LEAN' || officialStatus === 'WATCH') status = 'LEAN';
  else if (officialStatus === 'PASS') status = 'PASS';
  else if (officialStatus === 'NO_BET' || officialStatus === 'BLOCKED') status = 'NO_BET';
  else if (officialStatus === 'DEGRADED') status = 'DEGRADED';

  // reason_code: primary_reason_code from decision_v2, or pass_reason_code
  const reasonCode =
    decisionV2?.primary_reason_code ??
    payload?.pass_reason_code ??
    play?.pass_reason_code ??
    null;

  // visibility_class
  let visibilityClass = 'visible';
  if (!isSurface) visibilityClass = 'hidden';
  else if (isProjectionOnlyPlay(payload)) visibilityClass = 'projection_only';

  // has_projection_marker
  const projectionSource = (
    payload?.prop_decision?.projection_source ??
      play?.prop_decision?.projection_source ??
      payload?.projection_source ??
      play?.projection_source ??
      ''
  ).toUpperCase();
  const propDisplayState = (
    payload?.prop_display_state ??
      play?.prop_display_state ??
      ''
  ).toUpperCase();
  const hasProjectionMarker =
    projectionSource === 'SYNTHETIC_FALLBACK' ||
    propDisplayState === 'PROJECTION_ONLY' ||
    visibilityClass === 'projection_only';

  return {
    status,
    reason_code: reasonCode ?? null,
    visibility_class: visibilityClass,
    has_projection_marker: hasProjectionMarker,
  };
}

/**
 * Extract behavioral fields from the games path perspective.
 * The games route normalizes payloads — we apply the same normalization.
 */
function extractGamesPathBehavior(payload) {
  const play = (payload && typeof payload.play === 'object' && payload.play)
    ? payload.play
    : null;

  const firstString = (...vals) => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    }
    return null;
  };

  const normalizedBasis = normalizeDecisionBasisToken(
    firstString(
      payload?.basis,
      payload?.decision_basis,
      payload?.decision_basis_meta?.decision_basis,
      play?.basis,
      play?.decision_basis,
    ),
  );
  const normalizedExecStatus = normalizeExecutionStatusToken(
    firstString(
      payload?.execution_status,
      play?.execution_status,
    ),
  );
  const normalizedPropDisplayState = (
    payload?.prop_display_state ?? play?.prop_display_state ?? ''
  ).trim().toUpperCase() || undefined;

  // Compute official status same as games route
  const decisionV2 = payload?.decision_v2 ?? play?.decision_v2 ?? null;
  const officialStatus =
    (decisionV2?.official_status) ||
    ((payload?.action ?? play?.action ?? '')).toUpperCase() ||
    ((payload?.verdict ?? play?.verdict ?? '')).toUpperCase() ||
    null;

  let status = 'NO_BET';
  if (officialStatus === 'PLAY' || officialStatus === 'FIRE') status = 'PLAY';
  else if (officialStatus === 'LEAN' || officialStatus === 'WATCH') status = 'LEAN';
  else if (officialStatus === 'PASS') status = 'PASS';
  else if (officialStatus === 'NO_BET' || officialStatus === 'BLOCKED') status = 'NO_BET';
  else if (officialStatus === 'DEGRADED') status = 'DEGRADED';

  const reasonCode =
    decisionV2?.primary_reason_code ??
    payload?.pass_reason_code ??
    play?.pass_reason_code ??
    null;

  // isProjectionOnly from games path
  const isProjectionOnly =
    normalizedBasis === 'PROJECTION_ONLY' ||
    normalizedExecStatus === 'PROJECTION_ONLY' ||
    normalizedPropDisplayState === 'PROJECTION_ONLY' ||
    isProjectionOnlyPlay(payload);

  let visibilityClass = 'visible';
  if (isProjectionOnly) visibilityClass = 'projection_only';

  const lineSource = (
    payload?.line_source ??
      play?.line_source ??
      payload?.market_context?.wager?.line_source ??
      play?.market_context?.wager?.line_source ??
      ''
  ).toLowerCase();
  const isLineSourceProjectionFloor = PROJECTION_ONLY_LINE_SOURCES.has(lineSource);
  if (isLineSourceProjectionFloor) visibilityClass = 'projection_only';

  const projectionSource = (
    payload?.prop_decision?.projection_source ??
      play?.prop_decision?.projection_source ??
      ''
  ).toUpperCase();
  const hasProjectionMarker =
    projectionSource === 'SYNTHETIC_FALLBACK' ||
    normalizedPropDisplayState === 'PROJECTION_ONLY' ||
    visibilityClass === 'projection_only';

  return {
    status,
    reason_code: reasonCode ?? null,
    visibility_class: visibilityClass,
    has_projection_marker: hasProjectionMarker,
  };
}

// ---------------------------------------------------------------------------
// Parity diff computation
// ---------------------------------------------------------------------------

const COMPARABLE_FIELDS = ['status', 'reason_code', 'visibility_class', 'has_projection_marker'];

/**
 * Compute a parity diff object from two behavioral field snapshots.
 * @param {string} gameId
 * @param {string} fixtureId
 * @param {object} cardsFields
 * @param {object} gamesFields
 * @param {'MATCH'|'EXPECTED_DELTA'|'UNEXPECTED_DELTA'} expectedParityStatus
 * @param {string[]} expectedFieldDeltas - field names expected to differ
 * @returns {object} parity diff
 */
function computeParityDiff(
  gameId,
  fixtureId,
  cardsFields,
  gamesFields,
  expectedParityStatus,
  expectedFieldDeltas = [],
) {
  const fieldDeltas = COMPARABLE_FIELDS.filter(
    (field) => String(cardsFields[field]) !== String(gamesFields[field]),
  );

  let actualParityStatus;
  if (fieldDeltas.length === 0) {
    actualParityStatus = 'MATCH';
  } else {
    // Check if actual deltas match expected deltas exactly
    const actualSet = new Set(fieldDeltas);
    const expectedSet = new Set(expectedFieldDeltas);
    const setsMatch =
      actualSet.size === expectedSet.size &&
      [...actualSet].every((f) => expectedSet.has(f));
    actualParityStatus = setsMatch ? 'EXPECTED_DELTA' : 'UNEXPECTED_DELTA';
  }

  const reasonParts = [];
  for (const field of fieldDeltas) {
    reasonParts.push(
      `${field}: cards="${cardsFields[field]}" vs games="${gamesFields[field]}"`,
    );
  }
  const reasonExplanation =
    reasonParts.length > 0
      ? `Field delta(s) between cards and games endpoints: ${reasonParts.join('; ')}`
      : '';

  return {
    gameId,
    fixtureId,
    cards: { ...cardsFields },
    games: { ...gamesFields },
    field_deltas: fieldDeltas,
    reason_explanation: reasonExplanation,
    parity_status: actualParityStatus,
    _expected_parity_status: expectedParityStatus,
  };
}

// ---------------------------------------------------------------------------
// Fixture corpus
// ---------------------------------------------------------------------------

/**
 * Fixture table.
 *
 * Each entry:
 *   fixtureId      - stable fixture identifier
 *   gameId         - synthetic deterministic game id
 *   scenario       - human-readable description
 *   payload        - minimal normalized card payload that drives both paths
 *   expectedParity - expected parity status and field deltas
 */
const FIXTURE_TABLE = [
  // ── Fixture 1: Standard PLAY with real odds ───────────────────────────────
  {
    fixtureId: 'parity-001-standard-play',
    gameId: 'game-parity-001',
    scenario: 'Standard PLAY decision with real odds and ODDS_BACKED basis',
    payload: {
      basis: 'ODDS_BACKED',
      execution_status: 'EXECUTABLE',
      action: 'PLAY',
      decision_v2: {
        official_status: 'PLAY',
        primary_reason_code: 'EDGE_CONFIRMED',
        pipeline_version: 'v2',
        decided_at: '2026-04-12T12:00:00Z',
      },
    },
    expectedParity: {
      status: 'PLAY',
      reasonCode: 'EDGE_CONFIRMED',
      visibilityClass: 'visible',
      hasProjectionMarker: false,
      expectedParityStatus: 'MATCH',
      expectedFieldDeltas: [],
    },
  },

  // ── Fixture 2: LEAN with market odds ──────────────────────────────────────
  {
    fixtureId: 'parity-002-standard-lean',
    gameId: 'game-parity-002',
    scenario: 'Standard LEAN decision with ODDS_BACKED basis',
    payload: {
      basis: 'ODDS_BACKED',
      execution_status: 'EXECUTABLE',
      action: 'LEAN',
      decision_v2: {
        official_status: 'LEAN',
        primary_reason_code: 'LEAN_EDGE',
        pipeline_version: 'v2',
        decided_at: '2026-04-12T12:00:00Z',
      },
    },
    expectedParity: {
      status: 'LEAN',
      reasonCode: 'LEAN_EDGE',
      visibilityClass: 'visible',
      hasProjectionMarker: false,
      expectedParityStatus: 'MATCH',
      expectedFieldDeltas: [],
    },
  },

  // ── Fixture 3: Projection-only row ───────────────────────────────────────
  //
  // NOTE: This is an EXPECTED_DELTA fixture. The cards path marks projection-only
  // rows as "hidden" because isBettingSurfacePayload() returns false and the card
  // is filtered out before returning. The games path marks them "projection_only"
  // because it includes them in the response with explicit classification. This is
  // an inherent architectural difference: cards=exclude, games=include+classify.
  {
    fixtureId: 'parity-003-projection-only',
    gameId: 'game-parity-003',
    scenario: 'Projection-only row: cards excludes (hidden), games includes with projection_only classification',
    payload: {
      basis: 'PROJECTION_ONLY',
      execution_status: 'PROJECTION_ONLY',
      prop_display_state: 'PROJECTION_ONLY',
      action: 'PASS',
      decision_v2: {
        official_status: 'PASS',
        primary_reason_code: 'NO_MARKET_LINE',
        pipeline_version: 'v2',
        decided_at: '2026-04-12T12:00:00Z',
      },
    },
    expectedParity: {
      status: 'PASS',
      reasonCode: 'NO_MARKET_LINE',
      // Cards path: "hidden" because isBettingSurfacePayload returns false (card excluded)
      // Games path: "projection_only" because games route classifies and includes the row
      visibilityClass: 'projection_only',
      hasProjectionMarker: true,
      expectedParityStatus: 'EXPECTED_DELTA',
      expectedFieldDeltas: ['visibility_class'],
    },
  },

  // ── Fixture 4: Synthetic fallback row ────────────────────────────────────
  //
  // NOTE: Same architectural pattern as Fixture 3 — cards excludes via
  // isBettingSurfacePayload (returns "hidden"), games classifies as
  // "projection_only". EXPECTED_DELTA on visibility_class.
  {
    fixtureId: 'parity-004-synthetic-fallback',
    gameId: 'game-parity-004',
    scenario: 'Synthetic fallback: cards excludes (hidden), games includes with projection_only classification',
    payload: {
      line_source: 'synthetic_fallback',
      prop_decision: {
        projection_source: 'SYNTHETIC_FALLBACK',
        verdict: 'PASS',
      },
      action: 'PASS',
      decision_v2: {
        official_status: 'PASS',
        primary_reason_code: 'SYNTHETIC_FALLBACK_GATE',
        pipeline_version: 'v2',
        decided_at: '2026-04-12T12:00:00Z',
      },
    },
    expectedParity: {
      status: 'PASS',
      reasonCode: 'SYNTHETIC_FALLBACK_GATE',
      // Cards path: "hidden" because isBettingSurfacePayload returns false
      // Games path: "projection_only" because games route classifies and includes
      visibilityClass: 'projection_only',
      hasProjectionMarker: true,
      expectedParityStatus: 'EXPECTED_DELTA',
      expectedFieldDeltas: ['visibility_class'],
    },
  },

  // ── Fixture 5: PASS with reason code ─────────────────────────────────────
  {
    fixtureId: 'parity-005-pass-with-reason',
    gameId: 'game-parity-005',
    scenario: 'PASS decision with explicit pass reason code',
    payload: {
      basis: 'ODDS_BACKED',
      execution_status: 'EXECUTABLE',
      action: 'PASS',
      pass_reason_code: 'SIGMA_INSUFFICIENT',
      decision_v2: {
        official_status: 'PASS',
        primary_reason_code: 'SIGMA_INSUFFICIENT',
        pipeline_version: 'v2',
        decided_at: '2026-04-12T12:00:00Z',
      },
    },
    expectedParity: {
      status: 'PASS',
      reasonCode: 'SIGMA_INSUFFICIENT',
      visibilityClass: 'visible',
      hasProjectionMarker: false,
      expectedParityStatus: 'MATCH',
      expectedFieldDeltas: [],
    },
  },

  // ── Fixture 6: BLOCKED / NO_BET ──────────────────────────────────────────
  {
    fixtureId: 'parity-006-blocked',
    gameId: 'game-parity-006',
    scenario: 'Blocked card (BLOCKED execution status)',
    payload: {
      basis: 'ODDS_BACKED',
      execution_status: 'BLOCKED',
      action: 'NO_BET',
      decision_v2: {
        official_status: 'NO_BET',
        primary_reason_code: 'INPUT_GATE_BLOCK',
        pipeline_version: 'v2',
        decided_at: '2026-04-12T12:00:00Z',
      },
    },
    expectedParity: {
      status: 'NO_BET',
      reasonCode: 'INPUT_GATE_BLOCK',
      visibilityClass: 'visible',
      hasProjectionMarker: false,
      expectedParityStatus: 'MATCH',
      expectedFieldDeltas: [],
    },
  },

  // ── Fixture 7: Nested play structure ─────────────────────────────────────
  {
    fixtureId: 'parity-007-nested-play',
    gameId: 'game-parity-007',
    scenario: 'PLAY via nested play sub-object (common card payload shape)',
    payload: {
      play: {
        basis: 'ODDS_BACKED',
        execution_status: 'EXECUTABLE',
        action: 'PLAY',
        decision_v2: {
          official_status: 'PLAY',
          primary_reason_code: 'EDGE_CONFIRMED',
          pipeline_version: 'v2',
          decided_at: '2026-04-12T12:00:00Z',
        },
      },
    },
    expectedParity: {
      status: 'PLAY',
      reasonCode: 'EDGE_CONFIRMED',
      visibilityClass: 'visible',
      hasProjectionMarker: false,
      expectedParityStatus: 'MATCH',
      expectedFieldDeltas: [],
    },
  },

  // ── Fixture 8: Projection floor line source ────────────────────────────────
  //
  // NOTE: Cards path filters out projection_floor rows via isBettingSurfacePayload
  // returning false (visibility_class="hidden", has_projection_marker=false in the
  // filter-layer helper which doesn't assign projection markers to excluded rows).
  // Games path classifies the same payload as "projection_only" with a projection
  // marker. EXPECTED_DELTA on visibility_class and has_projection_marker.
  // This documents the structural difference: cards=exclude before returning,
  // games=include+classify.
  {
    fixtureId: 'parity-008-projection-floor',
    gameId: 'game-parity-008',
    scenario: 'Projection floor: cards excludes (hidden, no marker), games includes with projection_only+marker',
    payload: {
      line_source: 'projection_floor',
      action: 'PASS',
      decision_v2: {
        official_status: 'PASS',
        primary_reason_code: 'PROJECTION_FLOOR_GATE',
        pipeline_version: 'v2',
        decided_at: '2026-04-12T12:00:00Z',
      },
    },
    expectedParity: {
      status: 'PASS',
      reasonCode: 'PROJECTION_FLOOR_GATE',
      // Cards path: "hidden", has_projection_marker=false (filtered out before marker assigned)
      // Games path: "projection_only", has_projection_marker=true
      visibilityClass: 'projection_only',
      hasProjectionMarker: true,
      expectedParityStatus: 'EXPECTED_DELTA',
      expectedFieldDeltas: ['visibility_class', 'has_projection_marker'],
    },
  },
];

// ---------------------------------------------------------------------------
// Task 1: Validate fixture corpus structure
// ---------------------------------------------------------------------------

console.log('── Task 1: Fixture corpus structural validation ──\n');

for (const fixture of FIXTURE_TABLE) {
  assert(typeof fixture.fixtureId === 'string' && fixture.fixtureId.length > 0,
    `fixtureId must be a non-empty string in fixture`);
  assert(typeof fixture.gameId === 'string' && fixture.gameId.length > 0,
    `gameId must be a non-empty string in fixture ${fixture.fixtureId}`);
  assert(fixture.payload && typeof fixture.payload === 'object',
    `payload must be an object in fixture ${fixture.fixtureId}`);
  assert(fixture.expectedParity && typeof fixture.expectedParity === 'object',
    `expectedParity must be an object in fixture ${fixture.fixtureId}`);
  assert(typeof fixture.expectedParity.status === 'string',
    `expectedParity.status must be a string in fixture ${fixture.fixtureId}`);
  assert(typeof fixture.expectedParity.visibilityClass === 'string',
    `expectedParity.visibilityClass must be a string in fixture ${fixture.fixtureId}`);
  assert(typeof fixture.expectedParity.hasProjectionMarker === 'boolean',
    `expectedParity.hasProjectionMarker must be a boolean in fixture ${fixture.fixtureId}`);

  // Verify both paths are invocable per fixture
  const cardsFields = extractCardsPathBehavior(fixture.payload);
  const gamesFields = extractGamesPathBehavior(fixture.payload);

  assert(cardsFields && typeof cardsFields === 'object',
    `cards path must return an object for fixture ${fixture.fixtureId}`);
  assert(gamesFields && typeof gamesFields === 'object',
    `games path must return an object for fixture ${fixture.fixtureId}`);

  // Verify output has required fields
  for (const field of ['status', 'reason_code', 'visibility_class', 'has_projection_marker']) {
    assert(field in cardsFields,
      `cards path output must include ${field} for fixture ${fixture.fixtureId}`);
    assert(field in gamesFields,
      `games path output must include ${field} for fixture ${fixture.fixtureId}`);
  }

  console.log(`  ✓ ${fixture.fixtureId}: both paths invocable without error`);
}

console.log(`\n✓ ${FIXTURE_TABLE.length} fixtures validated structurally\n`);

// ---------------------------------------------------------------------------
// Task 3: Parity diff assertions
// ---------------------------------------------------------------------------

console.log('── Task 3: Parity diff assertions ──\n');

const paritySummary = [];
const failures = [];

for (const fixture of FIXTURE_TABLE) {
  const cardsFields = extractCardsPathBehavior(fixture.payload);
  const gamesFields = extractGamesPathBehavior(fixture.payload);

  const diff = computeParityDiff(
    fixture.gameId,
    fixture.fixtureId,
    cardsFields,
    gamesFields,
    fixture.expectedParity.expectedParityStatus,
    fixture.expectedParity.expectedFieldDeltas ?? [],
  );

  paritySummary.push(diff);

  if (diff.parity_status === 'UNEXPECTED_DELTA') {
    failures.push(diff);
    console.log(`  ✗ UNEXPECTED_DELTA in ${fixture.fixtureId}`);
    console.log('    Diff:', JSON.stringify(diff, null, 4));
  } else if (diff.parity_status === 'MATCH') {
    // Verify expected fields match
    assert.equal(
      cardsFields.status,
      fixture.expectedParity.status,
      `Expected cards status "${fixture.expectedParity.status}" in fixture ${fixture.fixtureId}, got "${cardsFields.status}"`,
    );
    assert.equal(
      gamesFields.status,
      fixture.expectedParity.status,
      `Expected games status "${fixture.expectedParity.status}" in fixture ${fixture.fixtureId}, got "${gamesFields.status}"`,
    );
    assert.equal(
      cardsFields.visibility_class,
      fixture.expectedParity.visibilityClass,
      `Expected cards visibility_class "${fixture.expectedParity.visibilityClass}" in fixture ${fixture.fixtureId}, got "${cardsFields.visibility_class}"`,
    );
    assert.equal(
      cardsFields.has_projection_marker,
      fixture.expectedParity.hasProjectionMarker,
      `Expected cards has_projection_marker ${fixture.expectedParity.hasProjectionMarker} in fixture ${fixture.fixtureId}, got ${cardsFields.has_projection_marker}`,
    );
    assert.equal(diff.field_deltas.length, 0,
      `Expected no field deltas in MATCH fixture ${fixture.fixtureId}, got: ${JSON.stringify(diff.field_deltas)}`);
    console.log(`  ✓ ${fixture.fixtureId}: MATCH — status=${cardsFields.status}, visibility=${cardsFields.visibility_class}`);
  } else if (diff.parity_status === 'EXPECTED_DELTA') {
    assert(diff.field_deltas.length > 0,
      `EXPECTED_DELTA fixture ${fixture.fixtureId} must have at least one field delta`);
    assert(diff.reason_explanation.length > 0,
      `EXPECTED_DELTA fixture ${fixture.fixtureId} must have a non-empty reason_explanation`);
    // Verify reason_explanation references at least one field name
    const mentionsField = diff.field_deltas.some(f => diff.reason_explanation.includes(f));
    assert(mentionsField,
      `EXPECTED_DELTA reason_explanation must reference a field name in fixture ${fixture.fixtureId}`);
    console.log(`  ✓ ${fixture.fixtureId}: EXPECTED_DELTA — deltas=${JSON.stringify(diff.field_deltas)}, reason="${diff.reason_explanation}"`);
  }
}

console.log('');

if (failures.length > 0) {
  console.error(`❌ ${failures.length} UNEXPECTED_DELTA failure(s) detected — behavioral drift between cards and games endpoints:`);
  for (const f of failures) {
    console.error(JSON.stringify(f, null, 2));
  }
  process.exit(1);
}

console.log(`✓ Parity diff suite: ${FIXTURE_TABLE.length} fixtures passed`);
console.log(`  MATCH: ${paritySummary.filter(d => d.parity_status === 'MATCH').length}`);
console.log(`  EXPECTED_DELTA: ${paritySummary.filter(d => d.parity_status === 'EXPECTED_DELTA').length}`);
console.log(`  UNEXPECTED_DELTA: ${paritySummary.filter(d => d.parity_status === 'UNEXPECTED_DELTA').length}`);
console.log('');
console.log('✅ WI-0902 API endpoint parity fixtures test passed');
