'use strict';

const STARTER_STATES = ['CONFIRMED', 'EXPECTED', 'UNKNOWN', 'CONFLICTING'];
const STARTER_SOURCES = [
  'USER_INPUT',
  'SCRAPER_NAME_MATCH',
  'SEASON_TABLE_INFERENCE',
  'MERGED',
  'NHL_API_CONFIRMED',
  'NHL_API_PROBABLE',
];
const GOALIE_TIERS = ['ELITE', 'STRONG', 'AVERAGE', 'WEAK', 'UNKNOWN'];
const TIER_CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW', 'NONE'];
const ADJUSTMENT_TRUST_LEVELS = ['FULL', 'DEGRADED', 'NEUTRALIZED', 'BLOCKED'];
const TEAM_SIDES = ['home', 'away'];
const USER_STARTER_STATUSES = ['CONFIRMED', 'EXPECTED', 'UNKNOWN'];
const SCRAPER_SOURCE_TYPES = ['SCRAPER_NAME_MATCH', 'SEASON_TABLE_INFERENCE'];
const DEFAULT_STALE_WINDOW_MS = 6 * 60 * 60 * 1000;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isEnumValue(value, allowed) {
  return typeof value === 'string' && allowed.includes(value);
}

function normalizeNameForCompare(value) {
  if (!isNonEmptyString(value)) return '';
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveGoalieTierFromGsax(gsax) {
  if (!Number.isFinite(gsax)) return 'UNKNOWN';
  if (gsax > 10) return 'ELITE';
  if (gsax >= 5) return 'STRONG';
  if (gsax >= -5) return 'AVERAGE';
  return 'WEAK';
}

function normalizeUserStatus(value) {
  const token = String(value || '')
    .trim()
    .toUpperCase();
  if (!token) return null;
  if (token === 'CONFIRMED' || token === 'STARTING' || token === 'OFFICIAL') {
    return 'CONFIRMED';
  }
  if (token === 'EXPECTED' || token === 'PROJECTED' || token === 'LIKELY') {
    return 'EXPECTED';
  }
  if (token === 'UNKNOWN' || token === 'UNCONFIRMED' || token === 'TBD') {
    return 'UNKNOWN';
  }
  return null;
}

function normalizeScraperStatus(value) {
  return normalizeUserStatus(value);
}

function isValidIsoTimestamp(value) {
  if (!isNonEmptyString(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function normalizeScraperInput(scraperInput = {}) {
  const goalieName = isNonEmptyString(scraperInput.goalie_name)
    ? scraperInput.goalie_name.trim()
    : null;
  const gsax = toFiniteNumber(scraperInput.gsax);
  const savePct = toFiniteNumber(scraperInput.save_pct);
  const sourceType = isEnumValue(scraperInput.source_type, SCRAPER_SOURCE_TYPES)
    ? scraperInput.source_type
    : goalieName
      ? 'SCRAPER_NAME_MATCH'
      : 'SEASON_TABLE_INFERENCE';
  const status = normalizeScraperStatus(scraperInput.status);

  return {
    goalie_name: goalieName,
    gsax,
    save_pct: savePct,
    source_type: sourceType,
    status,
  };
}

function evaluateUserInput(userInput, options = {}) {
  if (userInput === null || userInput === undefined) {
    return {
      usable: false,
      malformed: false,
      stale: false,
      goalie_name: null,
      status: null,
      supplied_at: null,
    };
  }

  if (!userInput || typeof userInput !== 'object') {
    return {
      usable: false,
      malformed: true,
      stale: false,
      goalie_name: null,
      status: null,
      supplied_at: null,
    };
  }

  const goalieName = isNonEmptyString(userInput.goalie_name)
    ? userInput.goalie_name.trim()
    : null;
  const status = normalizeUserStatus(userInput.status);
  const suppliedAt = isNonEmptyString(userInput.supplied_at)
    ? userInput.supplied_at.trim()
    : null;
  const malformed =
    !goalieName ||
    !isEnumValue(status, USER_STARTER_STATUSES) ||
    !isValidIsoTimestamp(suppliedAt);

  if (malformed) {
    return {
      usable: false,
      malformed: true,
      stale: false,
      goalie_name: goalieName,
      status,
      supplied_at: suppliedAt,
    };
  }

  const staleWindowMs = Number.isFinite(options.staleWindowMs)
    ? Number(options.staleWindowMs)
    : DEFAULT_STALE_WINDOW_MS;
  const gameTimeMs = Number.isFinite(Date.parse(options.gameTimeUtc || ''))
    ? Date.parse(options.gameTimeUtc)
    : null;
  const suppliedAtMs = Date.parse(suppliedAt);
  const stale =
    Number.isFinite(gameTimeMs) &&
    Number.isFinite(suppliedAtMs) &&
    suppliedAtMs < gameTimeMs - staleWindowMs;

  return {
    usable: !stale,
    malformed: false,
    stale,
    goalie_name: goalieName,
    status,
    supplied_at: suppliedAt,
  };
}

function deriveAdjustmentTrust(starterState, tierConfidence) {
  if (starterState === 'CONFLICTING') return 'BLOCKED';
  if (starterState === 'UNKNOWN') return 'NEUTRALIZED';
  if (starterState === 'EXPECTED') return 'DEGRADED';
  if (starterState === 'CONFIRMED') {
    return tierConfidence === 'HIGH' || tierConfidence === 'MEDIUM'
      ? 'FULL'
      : 'DEGRADED';
  }
  throw new Error(`Invalid starter_state "${starterState}"`);
}

function inferDefaultStarterSource(starterState, goalieName) {
  if (starterState === 'UNKNOWN' || !goalieName) {
    return 'SEASON_TABLE_INFERENCE';
  }
  return 'MERGED';
}

function inferDefaultTierConfidence(starterState, goalieName, goalieTier) {
  if (
    starterState === 'UNKNOWN' ||
    starterState === 'CONFLICTING' ||
    !goalieName ||
    goalieTier === 'UNKNOWN'
  ) {
    return 'NONE';
  }
  return starterState === 'CONFIRMED' ? 'HIGH' : 'MEDIUM';
}

/**
 * @typedef {Object} CanonicalGoalieState
 * @property {string} game_id
 * @property {'home'|'away'} team_side
 * @property {'CONFIRMED'|'EXPECTED'|'UNKNOWN'|'CONFLICTING'} starter_state
 * @property {'USER_INPUT'|'SCRAPER_NAME_MATCH'|'SEASON_TABLE_INFERENCE'|'MERGED'} starter_source
 * @property {string|null} goalie_name
 * @property {'ELITE'|'STRONG'|'AVERAGE'|'WEAK'|'UNKNOWN'} goalie_tier
 * @property {'HIGH'|'MEDIUM'|'LOW'|'NONE'} tier_confidence
 * @property {'FULL'|'DEGRADED'|'NEUTRALIZED'|'BLOCKED'} adjustment_trust
 * @property {string[]} evidence_flags
 */

/**
 * Returns `{ valid, errors }` without mutating input.
 *
 * @param {object} state
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateCanonicalGoalieState(state) {
  const errors = [];
  if (!state || typeof state !== 'object') {
    return { valid: false, errors: ['State must be an object'] };
  }

  if (!isNonEmptyString(state.game_id)) {
    errors.push('game_id is required and must be a non-empty string');
  }

  if (!isEnumValue(state.team_side, TEAM_SIDES)) {
    errors.push(`team_side must be one of: ${TEAM_SIDES.join(', ')}`);
  }

  if (!isEnumValue(state.starter_state, STARTER_STATES)) {
    errors.push(`starter_state must be one of: ${STARTER_STATES.join(', ')}`);
  }

  if (!isEnumValue(state.starter_source, STARTER_SOURCES)) {
    errors.push(`starter_source must be one of: ${STARTER_SOURCES.join(', ')}`);
  }

  if (!(state.goalie_name === null || isNonEmptyString(state.goalie_name))) {
    errors.push('goalie_name must be null or a non-empty string');
  }

  if (!isEnumValue(state.goalie_tier, GOALIE_TIERS)) {
    errors.push(`goalie_tier must be one of: ${GOALIE_TIERS.join(', ')}`);
  }

  if (!isEnumValue(state.tier_confidence, TIER_CONFIDENCE_LEVELS)) {
    errors.push(
      `tier_confidence must be one of: ${TIER_CONFIDENCE_LEVELS.join(', ')}`,
    );
  }

  if (!isEnumValue(state.adjustment_trust, ADJUSTMENT_TRUST_LEVELS)) {
    errors.push(
      `adjustment_trust must be one of: ${ADJUSTMENT_TRUST_LEVELS.join(', ')}`,
    );
  }

  if (!Array.isArray(state.evidence_flags)) {
    errors.push('evidence_flags must be an array');
  } else if (state.evidence_flags.some((flag) => !isNonEmptyString(flag))) {
    errors.push('evidence_flags entries must be non-empty strings');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Build a canonical goalie state with defaults and validation.
 * `adjustment_trust` is always derived from `starter_state` + `tier_confidence`.
 *
 * @param {Partial<CanonicalGoalieState>} fields
 * @returns {CanonicalGoalieState}
 */
function makeCanonicalGoalieState(fields = {}) {
  if (!fields || typeof fields !== 'object') {
    throw new Error('makeCanonicalGoalieState requires an object');
  }

  const gameId = fields.game_id;
  const teamSide = fields.team_side;

  if (!isNonEmptyString(gameId)) {
    throw new Error('makeCanonicalGoalieState: game_id is required');
  }
  if (!isEnumValue(teamSide, TEAM_SIDES)) {
    throw new Error(
      `makeCanonicalGoalieState: team_side must be one of ${TEAM_SIDES.join(', ')}`,
    );
  }

  const starterState = isEnumValue(fields.starter_state, STARTER_STATES)
    ? fields.starter_state
    : 'UNKNOWN';
  const goalieName = isNonEmptyString(fields.goalie_name)
    ? fields.goalie_name.trim()
    : null;
  const goalieTier = isEnumValue(fields.goalie_tier, GOALIE_TIERS)
    ? fields.goalie_tier
    : 'UNKNOWN';
  const tierConfidence = isEnumValue(
    fields.tier_confidence,
    TIER_CONFIDENCE_LEVELS,
  )
    ? fields.tier_confidence
    : inferDefaultTierConfidence(starterState, goalieName, goalieTier);
  const starterSource = isEnumValue(fields.starter_source, STARTER_SOURCES)
    ? fields.starter_source
    : inferDefaultStarterSource(starterState, goalieName);
  const evidenceFlags = Array.isArray(fields.evidence_flags)
    ? fields.evidence_flags.filter((flag) => isNonEmptyString(flag))
    : [];
  const adjustmentTrust = deriveAdjustmentTrust(starterState, tierConfidence);

  const state = {
    game_id: gameId.trim(),
    team_side: teamSide,
    starter_state: starterState,
    starter_source: starterSource,
    goalie_name: goalieName,
    goalie_tier: goalieTier,
    tier_confidence: tierConfidence,
    adjustment_trust: adjustmentTrust,
    evidence_flags: evidenceFlags,
  };

  const validation = validateCanonicalGoalieState(state);
  if (!validation.valid) {
    throw new Error(
      `makeCanonicalGoalieState: ${validation.errors.join('; ')}`,
    );
  }

  return state;
}

/**
 * Query nhl_goalie_starters for a confirmed or probable goalie row.
 * Returns null if db is absent, table does not exist, or no row found.
 *
 * @param {object|null|undefined} db - better-sqlite3 Database instance
 * @param {string|number} gameId
 * @param {string} teamId - team abbreviation (e.g. 'TOR')
 * @returns {{ goalie_id: string|null, goalie_name: string|null, confirmed: number }|null}
 */
function lookupApiGoalieRow(db, gameId, teamId) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    return db.prepare(
      'SELECT goalie_id, goalie_name, confirmed FROM nhl_goalie_starters WHERE game_id = ? AND team_id = ?',
    ).get(String(gameId), String(teamId)) || null;
  } catch (_e) {
    return null; // table may not exist in test envs without migration
  }
}

/**
 * Resolve scraper and optional user inputs into one canonical goalie state.
 *
 * @param {object} scraperInput
 * @param {object|null} userInput
 * @param {string} gameId
 * @param {'home'|'away'} teamSide
 * @param {{ gameTimeUtc?: string|null, staleWindowMs?: number, db?: object, teamId?: string }} options
 * @returns {CanonicalGoalieState}
 */
function resolveGoalieState(
  scraperInput,
  userInput,
  gameId,
  teamSide,
  options = {},
) {
  const scraper = normalizeScraperInput(scraperInput);
  const evidenceFlags = [];

  // ── NHL API lookup (highest priority source) ──────────────────────────────
  const apiRow = lookupApiGoalieRow(options.db, gameId, options.teamId);
  if (apiRow) {
    const goalieTier = deriveGoalieTierFromGsax(scraper.gsax);

    if (apiRow.confirmed) {
      evidenceFlags.push('NHL_API_CONFIRMED');
      const state = makeCanonicalGoalieState({
        game_id: gameId,
        team_side: teamSide,
        starter_state: 'CONFIRMED',
        starter_source: 'NHL_API_CONFIRMED',
        goalie_name: apiRow.goalie_name || null,
        goalie_tier: goalieTier,
        tier_confidence: 'HIGH',
        evidence_flags: evidenceFlags,
      });
      return state;
    } else {
      evidenceFlags.push('NHL_API_PROBABLE');
      const state = makeCanonicalGoalieState({
        game_id: gameId,
        team_side: teamSide,
        starter_state: 'EXPECTED',
        starter_source: 'NHL_API_PROBABLE',
        goalie_name: apiRow.goalie_name || null,
        goalie_tier: goalieTier,
        tier_confidence: 'MEDIUM',
        evidence_flags: evidenceFlags,
      });
      return state;
    }
  }

  // ── Existing user/scraper resolution chain ────────────────────────────────
  const user = evaluateUserInput(userInput, options);

  if (user.malformed) evidenceFlags.push('MALFORMED_USER_INPUT');
  if (user.stale) evidenceFlags.push('STALE_USER_INPUT');

  let starterState = 'UNKNOWN';
  let starterSource = 'SEASON_TABLE_INFERENCE';
  let goalieName = null;

  if (user.usable) {
    starterState = user.status;
    starterSource = 'USER_INPUT';
    goalieName = user.goalie_name;

    if (
      isNonEmptyString(scraper.goalie_name) &&
      normalizeNameForCompare(scraper.goalie_name) !==
        normalizeNameForCompare(user.goalie_name)
    ) {
      starterState = 'CONFLICTING';
      evidenceFlags.push('CONFLICTING_SOURCE_EVIDENCE');
    }
  } else if (isNonEmptyString(scraper.goalie_name)) {
    starterState = scraper.status === 'CONFIRMED' ? 'CONFIRMED' : 'EXPECTED';
    starterSource = 'SCRAPER_NAME_MATCH';
    goalieName = scraper.goalie_name;
  } else {
    evidenceFlags.push('SEASON_TABLE_INFERENCE_ONLY');
  }

  const goalieTier = deriveGoalieTierFromGsax(scraper.gsax);
  let tierConfidence = 'NONE';

  if (goalieName) {
    if (goalieTier === 'UNKNOWN') {
      tierConfidence = 'LOW';
    } else if (starterState === 'CONFIRMED') {
      tierConfidence = 'HIGH';
    } else if (starterState === 'EXPECTED') {
      tierConfidence = 'MEDIUM';
    } else {
      tierConfidence = 'LOW';
    }
  } else if (goalieTier !== 'UNKNOWN') {
    tierConfidence = 'LOW';
  }

  const state = makeCanonicalGoalieState({
    game_id: gameId,
    team_side: teamSide,
    starter_state: starterState,
    starter_source: starterSource,
    goalie_name: goalieName,
    goalie_tier: goalieTier,
    tier_confidence: tierConfidence,
    evidence_flags: evidenceFlags,
  });

  // ── Unresolved downgrade: no source could identify the goalie ─────────────
  if (starterState === 'UNKNOWN' && !goalieName) {
    state.missing_inputs = ['goalie_unresolved'];
  }

  return state;
}

module.exports = {
  STARTER_STATES,
  STARTER_SOURCES,
  GOALIE_TIERS,
  TIER_CONFIDENCE_LEVELS,
  ADJUSTMENT_TRUST_LEVELS,
  TEAM_SIDES,
  DEFAULT_STALE_WINDOW_MS,
  deriveAdjustmentTrust,
  validateCanonicalGoalieState,
  makeCanonicalGoalieState,
  lookupApiGoalieRow,
  resolveGoalieState,
};
