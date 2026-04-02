const fs = require('fs');
const path = require('path');

const FIXTURES_ROOT = path.join(__dirname, 'fixtures');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
    : `${normalizedFixtureId}.json`;

  return path.join(getFixtureDirectory(sport, options), fixtureFileName);
}

function parseFixtureFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read fixture file ${filePath}: ${error.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in fixture file ${filePath}: ${error.message}`);
  }
}

function validateFixtureSchema(fixture, options = {}) {
  const label = options.filePath || 'fixture';

  if (!isPlainObject(fixture)) {
    throw new Error(`${label} must be a JSON object`);
  }

  const fixtureId = asNonEmptyString(fixture.fixture_id);
  if (!fixtureId) {
    throw new Error(`${label} is missing required string field "fixture_id"`);
  }

  const sport = normalizeSport(fixture.sport);
  if (!sport) {
    throw new Error(`${label} is missing required string field "sport"`);
  }

  const inputContract = asNonEmptyString(fixture.input_contract);
  if (!inputContract) {
    throw new Error(`${label} is missing required string field "input_contract"`);
  }

  if (!isPlainObject(fixture.input)) {
    throw new Error(`${label} is missing required object field "input"`);
  }

  if (!isPlainObject(fixture.expected)) {
    throw new Error(`${label} is missing required object field "expected"`);
  }

  const gameId = asNonEmptyString(fixture.input.game_id);
  if (!gameId) {
    throw new Error(`${label} is missing required string field "input.game_id"`);
  }

  if (
    fixture.expected.input_hash !== undefined &&
    fixture.expected.input_hash !== null &&
    typeof fixture.expected.input_hash !== 'string'
  ) {
    throw new Error(`${label} field "expected.input_hash" must be a string when present`);
  }

  if (
    fixture.expected.final_cards !== undefined &&
    !Array.isArray(fixture.expected.final_cards)
  ) {
    throw new Error(`${label} field "expected.final_cards" must be an array when present`);
  }

  if (
    fixture.expected.stage_categories !== undefined &&
    !isPlainObject(fixture.expected.stage_categories)
  ) {
    throw new Error(
      `${label} field "expected.stage_categories" must be an object when present`,
    );
  }

  if (
    fixture.expected.reason_codes_must_not_include !== undefined &&
    !Array.isArray(fixture.expected.reason_codes_must_not_include)
  ) {
    throw new Error(
      `${label} field "expected.reason_codes_must_not_include" must be an array when present`,
    );
  }

  return {
    ...fixture,
    fixture_id: fixtureId,
    sport,
    input_contract: inputContract,
  };
}

function loadFixtureFromPath(filePath) {
  return validateFixtureSchema(parseFixtureFile(filePath), { filePath });
}

function loadFixture(sport, fixtureId, options = {}) {
  return loadFixtureFromPath(resolveFixturePath(sport, fixtureId, options));
}

function loadFixturesForSport(sport, options = {}) {
  const directory = getFixtureDirectory(sport, options);

  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Failed to read fixture directory ${directory}: ${error.message}`);
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
    .map((fileName) => loadFixtureFromPath(path.join(directory, fileName)));
}

function isFixturePathCandidate(value) {
  if (!asNonEmptyString(value)) return false;
  return (
    value.endsWith('.json') ||
    value.includes(path.sep) ||
    value.startsWith(`.${path.sep}`) ||
    value.startsWith('..')
  );
}

module.exports = {
  FIXTURES_ROOT,
  getFixtureDirectory,
  isFixturePathCandidate,
  loadFixture,
  loadFixtureFromPath,
  loadFixturesForSport,
  normalizeSport,
  resolveFixturePath,
  validateFixtureSchema,
};
