'use strict';

const fs = require('fs');
const path = require('path');

const FIXTURES_ROOT = path.join(__dirname, 'fixtures');
const DEFAULT_BASELINE_NOTE_EXPIRY_RUNS = 3;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

const VALID_CARD_MODES = ['ODDS_BACKED', 'PROJECTION_ONLY', 'MIXED'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asPositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeSport(sport) {
  const normalized = asNonEmptyString(sport);
  return normalized ? normalized.toUpperCase() : null;
}

function getFixtureDirectory(sport, options = {}) {
  const normalizedSport = normalizeSport(sport);
  if (!normalizedSport) {
    throw new Error('Fixture sport is required');
  }

  const fixturesRoot = options.fixturesRoot || FIXTURES_ROOT;
  return path.join(fixturesRoot, normalizedSport.toLowerCase());
}

function resolveFixturePath(sport, fixtureId, options = {}) {
  const normalizedFixtureId = asNonEmptyString(fixtureId);
  if (!normalizedFixtureId) {
    throw new Error('Fixture id is required');
  }

  const fixtureFileName = normalizedFixtureId.endsWith('.json')
    ? normalizedFixtureId
    : normalizedFixtureId + '.json';

  return path.join(getFixtureDirectory(sport, options), fixtureFileName);
}

function parseFixtureFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error('Failed to read fixture file ' + filePath + ': ' + error.message);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error('Invalid JSON in fixture file ' + filePath + ': ' + error.message);
  }
}

function hasPriceInput(input) {
  return (
    input.total_price_over != null ||
    input.total_price_under != null ||
    input.h2h_home != null ||
    input.h2h_away != null ||
    input.spread_price_home != null ||
    input.spread_price_away != null ||
    input.price != null ||
    input.line != null
  );
}

function validateSubCard(subCard, index, label) {
  const subLabel = label + ' sub_cards[' + index + ']';
  if (!isPlainObject(subCard)) {
    throw new Error(subLabel + ' must be a JSON object');
  }
  const scCardFamily = asNonEmptyString(subCard.card_family);
  if (!scCardFamily) {
    throw new Error(subLabel + ' is missing required string field "card_family"');
  }
  const scCardMode = asNonEmptyString(subCard.card_mode);
  if (!scCardMode) {
    throw new Error(subLabel + ' is missing required string field "card_mode"');
  }
  if (!['ODDS_BACKED', 'PROJECTION_ONLY'].includes(scCardMode)) {
    throw new Error(subLabel + ' field "card_mode" must be ODDS_BACKED or PROJECTION_ONLY');
  }
  if (!isPlainObject(subCard.match_key)) {
    throw new Error(subLabel + ' is missing required object field "match_key"');
  }
  if (!asNonEmptyString(subCard.match_key.game_id)) {
    throw new Error(subLabel + ' is missing required string field "match_key.game_id"');
  }
  if (!isPlainObject(subCard.input)) {
    throw new Error(subLabel + ' is missing required object field "input"');
  }
  if (!isPlainObject(subCard.expected)) {
    throw new Error(subLabel + ' is missing required object field "expected"');
  }
  if (scCardMode === 'ODDS_BACKED' && !hasPriceInput(subCard.input)) {
    throw new Error(subLabel + ' has card_mode=ODDS_BACKED but input contains no price fields');
  }
}

function normalizeBaselineChangeNote(note, options = {}) {
  const label = options.label || 'fixture';
  if (note === undefined) return undefined;
  if (!isPlainObject(note)) {
    throw new Error(label + ' field "_baseline_change_note" must be an object when present');
  }

  const changedBy = asNonEmptyString(note.changed_by);
  if (!changedBy) {
    throw new Error(label + ' field "_baseline_change_note.changed_by" is required');
  }

  const reason = asNonEmptyString(note.reason);
  if (!reason) {
    throw new Error(label + ' field "_baseline_change_note.reason" is required');
  }

  const approvedAt = asNonEmptyString(note.approved_at);
  if (!approvedAt) {
    throw new Error(label + ' field "_baseline_change_note.approved_at" is required');
  }

  const approvedAtMs = Date.parse(approvedAt);
  if (!Number.isFinite(approvedAtMs)) {
    throw new Error(label + ' field "_baseline_change_note.approved_at" must be a valid date');
  }

  const expiresAfterRuns =
    note.expires_after_runs === undefined
      ? DEFAULT_BASELINE_NOTE_EXPIRY_RUNS
      : asPositiveInteger(note.expires_after_runs);
  if (!expiresAfterRuns) {
    throw new Error(
      label +
        ' field "_baseline_change_note.expires_after_runs" must be a positive integer when present',
    );
  }

  const normalized = {
    changed_by: changedBy,
    reason: reason,
    approved_at: new Date(approvedAtMs).toISOString(),
    expires_after_runs: expiresAfterRuns,
  };

  const expectedDownstreamEffect = asNonEmptyString(note.expected_downstream_effect);
  if (expectedDownstreamEffect) {
    normalized.expected_downstream_effect = expectedDownstreamEffect;
  }

  return normalized;
}

function evaluateBaselineChangeNote(note, options = {}) {
  if (!note || typeof note !== 'object') {
    return {
      approved_at_ms: null,
      cycles_elapsed: 0,
      expired: false,
      expires_after_runs: null,
      present: false,
    };
  }

  const runAtValue = options.runAt || new Date().toISOString();
  const runAtMs = Date.parse(runAtValue);
  if (!Number.isFinite(runAtMs)) {
    throw new Error('Invalid runAt for baseline change note evaluation');
  }

  const approvedAtMs = Date.parse(note.approved_at);
  const deltaMs = Math.max(0, runAtMs - approvedAtMs);
  const cyclesElapsed = Math.floor(deltaMs / MS_PER_WEEK);
  const expiresAfterRuns = asPositiveInteger(note.expires_after_runs) || DEFAULT_BASELINE_NOTE_EXPIRY_RUNS;

  return {
    approved_at_ms: approvedAtMs,
    cycles_elapsed: cyclesElapsed,
    expired: cyclesElapsed >= expiresAfterRuns,
    expires_after_runs: expiresAfterRuns,
    present: true,
  };
}

function validateFixtureSchema(fixture, options) {
  options = options || {};
  const label = options.filePath || 'fixture';

  if (!isPlainObject(fixture)) {
    throw new Error(label + ' must be a JSON object');
  }

  const fixtureId = asNonEmptyString(fixture.fixture_id);
  if (!fixtureId) {
    throw new Error(label + ' is missing required string field "fixture_id"');
  }

  const sport = normalizeSport(fixture.sport);
  if (!sport) {
    throw new Error(label + ' is missing required string field "sport"');
  }

  const inputContract = asNonEmptyString(fixture.input_contract);
  if (!inputContract) {
    throw new Error(label + ' is missing required string field "input_contract"');
  }

  // card_family — required, non-empty string
  const cardFamily = asNonEmptyString(fixture.card_family);
  if (!cardFamily) {
    throw new Error(label + ' is missing required string field "card_family"');
  }

  // card_mode — required, must be a known value
  const cardMode = asNonEmptyString(fixture.card_mode);
  if (!cardMode) {
    throw new Error(label + ' is missing required string field "card_mode"');
  }
  if (!VALID_CARD_MODES.includes(cardMode)) {
    throw new Error(
      label + ' field "card_mode" must be one of: ' + VALID_CARD_MODES.join(', '),
    );
  }

  // match_key — required object with game_id
  if (!isPlainObject(fixture.match_key)) {
    throw new Error(label + ' is missing required object field "match_key"');
  }
  if (!asNonEmptyString(fixture.match_key.game_id)) {
    throw new Error(label + ' is missing required string field "match_key.game_id"');
  }

  if (!isPlainObject(fixture.input)) {
    throw new Error(label + ' is missing required object field "input"');
  }

  // MIXED (multi-card) validation
  if (cardMode === 'MIXED') {
    if (!Array.isArray(fixture.sub_cards) || fixture.sub_cards.length < 2) {
      throw new Error(
        label + ' has card_mode=MIXED but is missing "sub_cards" array with at least 2 entries',
      );
    }
    fixture.sub_cards.forEach(function (sc, i) {
      validateSubCard(sc, i, label);
    });
    const marketTypes = fixture.sub_cards.map(function (sc) {
      return asNonEmptyString((sc.match_key || {}).market_type);
    });
    const uniqueMarketTypes = new Set(marketTypes);
    if (uniqueMarketTypes.size !== fixture.sub_cards.length || marketTypes.includes(null)) {
      throw new Error(
        label + ' sub_cards must each have a distinct non-empty "match_key.market_type"',
      );
    }
    if (!isPlainObject(fixture.expected)) {
      throw new Error(label + ' is missing required object field "expected"');
    }
  } else {
    // Single-card validation
    if (!isPlainObject(fixture.expected)) {
      throw new Error(label + ' is missing required object field "expected"');
    }

    const gameId = asNonEmptyString(fixture.input.game_id);
    if (!gameId) {
      throw new Error(label + ' is missing required string field "input.game_id"');
    }

    // ODDS_BACKED fixtures must include at least one price field
    if (cardMode === 'ODDS_BACKED' && !hasPriceInput(fixture.input)) {
      throw new Error(
        label + ' has card_mode=ODDS_BACKED but input contains no price fields' +
          ' (total_price_over/under, h2h_home/away, spread_price_home/away, price, line)',
      );
    }

    // MLB guard: only PROJECTION_ONLY allowed in current scope
    if (sport === 'MLB' && cardMode !== 'PROJECTION_ONLY') {
      throw new Error(
        label + ' has sport=MLB and card_mode=' + cardMode +
          '; MLB fixtures must be PROJECTION_ONLY in current audit scope',
      );
    }

    if (
      fixture.expected.input_hash !== undefined &&
      fixture.expected.input_hash !== null &&
      typeof fixture.expected.input_hash !== 'string'
    ) {
      throw new Error(label + ' field "expected.input_hash" must be a string when present');
    }

    if (
      fixture.expected.final_cards !== undefined &&
      !Array.isArray(fixture.expected.final_cards)
    ) {
      throw new Error(label + ' field "expected.final_cards" must be an array when present');
    }

    if (
      fixture.expected.stage_categories !== undefined &&
      !isPlainObject(fixture.expected.stage_categories)
    ) {
      throw new Error(
        label + ' field "expected.stage_categories" must be an object when present',
      );
    }

    if (
      fixture.expected.reason_codes_must_not_include !== undefined &&
      !Array.isArray(fixture.expected.reason_codes_must_not_include)
    ) {
      throw new Error(
        label + ' field "expected.reason_codes_must_not_include" must be an array when present',
      );
    }
  }

  // baseline_reviewed / input_hash cross-check
  if (
    fixture.baseline_reviewed === true &&
    isPlainObject(fixture.expected) &&
    fixture.expected.input_hash === 'RECOMPUTE_ON_FIRST_RUN'
  ) {
    throw new Error(
      label + ' has "baseline_reviewed: true" but "expected.input_hash" is still' +
        ' "RECOMPUTE_ON_FIRST_RUN" — replace the hash before marking baseline reviewed',
    );
  }

  const baselineChangeNote = normalizeBaselineChangeNote(fixture._baseline_change_note, {
    label,
  });

  return Object.assign({}, fixture, {
    _baseline_change_note: baselineChangeNote,
    fixture_id: fixtureId,
    fixture_file_path: options.filePath ? path.resolve(options.filePath) : null,
    sport: sport,
    card_family: cardFamily,
    card_mode: cardMode,
    input_contract: inputContract,
  });
}

function loadFixtureFromPath(filePath) {
  return validateFixtureSchema(parseFixtureFile(filePath), { filePath: filePath });
}

function loadFixture(sport, fixtureId, options) {
  return loadFixtureFromPath(resolveFixturePath(sport, fixtureId, options));
}

function loadFixturesForSport(sport, options) {
  options = options || {};
  const directory = getFixtureDirectory(sport, options);

  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error('Failed to read fixture directory ' + directory + ': ' + error.message);
  }

  return entries
    .filter(function (entry) {
      return entry.isFile() && entry.name.endsWith('.json');
    })
    .map(function (entry) {
      return entry.name;
    })
    .sort()
    .map(function (fileName) {
      return loadFixtureFromPath(path.join(directory, fileName));
    });
}

function isFixturePathCandidate(value) {
  if (!asNonEmptyString(value)) return false;
  return (
    value.endsWith('.json') ||
    value.includes(path.sep) ||
    value.startsWith('.' + path.sep) ||
    value.startsWith('..')
  );
}

module.exports = {
  FIXTURES_ROOT: FIXTURES_ROOT,
  DEFAULT_BASELINE_NOTE_EXPIRY_RUNS: DEFAULT_BASELINE_NOTE_EXPIRY_RUNS,
  evaluateBaselineChangeNote: evaluateBaselineChangeNote,
  getFixtureDirectory: getFixtureDirectory,
  isFixturePathCandidate: isFixturePathCandidate,
  loadFixture: loadFixture,
  loadFixtureFromPath: loadFixtureFromPath,
  loadFixturesForSport: loadFixturesForSport,
  normalizeBaselineChangeNote: normalizeBaselineChangeNote,
  normalizeSport: normalizeSport,
  resolveFixturePath: resolveFixturePath,
  validateFixtureSchema: validateFixtureSchema,
};
