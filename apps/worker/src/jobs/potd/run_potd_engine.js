'use strict';

require('dotenv').config();

const { v4: uuidV4 } = require('uuid');
const { DateTime } = require('luxon');
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
  getDatabase,
  getLatestNhlModelOutput,
  getLatestMlbModelOutput,
  getLatestNbaModelOutput,
  insertCardPayload,
  upsertGame,
  createJob,
  buildDecisionOutcomeFromDecisionV2,
} = require('@cheddar-logic/data');
const { fetchOdds } = require('@cheddar-logic/odds');
const { SPORTS_CONFIG: ODDS_SPORTS_CONFIG } = require('@cheddar-logic/odds/src/config');
const {
  buildCandidates,
  confidenceMultiplier,
  confidenceThreshold,
  hasRequiredEdgeInputs,
  normalizeEdgeSource,
  resolveEdgeSourceContract,
  resolveNoiseFloor,
  scoreCandidate,
  selectBestPlay,
  selectTopPlays,
  kellySize,
} = require('./signal-engine');
const {
  resolveCanonicalDecision,
  CANONICAL_DECISION_SOURCE,
} = require('@cheddar-logic/models');
const { formatPotdDiscordMessage } = require('./format-discord');
const { sendDiscordMessages } = require('../post_discord_cards');

function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

function toUpperToken(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
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

function hasEdgeFormulaMismatch(candidate) {
  if (!hasRequiredEdgeInputs(candidate)) return true;
  const expected = candidate.modelWinProb - candidate.impliedProb;
  return !isFiniteNumber(expected) || Math.abs(expected - candidate.edgePct) > 1e-6;
}

function isModelBackedCandidate(candidate) {
  return Boolean(
    candidate &&
    candidate.edgeSourceTag === 'MODEL' &&
    hasRequiredEdgeInputs(candidate) &&
    !hasEdgeFormulaMismatch(candidate)
  );
}

function canonicalizeShadowSelection(candidate) {
  const explicit = String(candidate?.selection || '').toUpperCase();
  if (explicit === 'HOME' || explicit === 'AWAY' || explicit === 'OVER' || explicit === 'UNDER') {
    return explicit;
  }

  const marketType = String(candidate?.marketType || '').toUpperCase();
  const selectionLabel = String(candidate?.selectionLabel || '').toUpperCase();
  const homeTeam = normalizeShadowTeam(candidate?.home_team || candidate?.homeTeam);
  const awayTeam = normalizeShadowTeam(candidate?.away_team || candidate?.awayTeam);

  // Some providers emit team labels (not HOME/AWAY tokens) for SPREAD/MONEYLINE.
  // Infer canonical side from team names so near-miss rows still persist.
  if (marketType === 'SPREAD' || marketType === 'MONEYLINE') {
    if (explicit && homeTeam && explicit === homeTeam) return 'HOME';
    if (explicit && awayTeam && explicit === awayTeam) return 'AWAY';

    if (homeTeam && (selectionLabel.startsWith(homeTeam) || selectionLabel.includes(homeTeam))) {
      return 'HOME';
    }
    if (awayTeam && (selectionLabel.startsWith(awayTeam) || selectionLabel.includes(awayTeam))) {
      return 'AWAY';
    }
  }

  if (marketType === 'TOTAL') {
    if (selectionLabel.startsWith('OVER')) return 'OVER';
    if (selectionLabel.startsWith('UNDER')) return 'UNDER';
  }

  return null;
}

function normalizeShadowLine(line) {
  if (!isFiniteNumber(line)) return 'NA';
  return Number(line).toFixed(3);
}

function normalizeShadowTeam(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function resolveShadowGameRef(candidate) {
  const gameId = String(candidate?.gameId || candidate?.game_id || '').trim();
  if (gameId) return gameId;

  const teams = [
    normalizeShadowTeam(candidate?.home_team || candidate?.homeTeam),
    normalizeShadowTeam(candidate?.away_team || candidate?.awayTeam),
  ].filter(Boolean).sort();

  if (teams.length > 0) {
    // Include game date so teams playing twice in a series don't collide.
    const commenceTime = candidate?.commence_time;
    if (commenceTime) {
      const dt = DateTime.fromISO(commenceTime, { zone: 'utc' });
      if (dt.isValid) return `${dt.toISODate()}|${teams.join('__')}`;
    }
    return teams.join('__');
  }
  return 'UNKNOWN_GAME';
}

function normalizeShadowMarketLineContext(candidate) {
  const marketType = String(candidate?.marketType || candidate?.market_type || '').toUpperCase();
  const line = candidate?.line;
  if (marketType === 'MONEYLINE') return 'NA';
  if (!isFiniteNumber(line)) return 'NA';
  if (marketType === 'SPREAD') return Math.abs(Number(line)).toFixed(3);
  return Number(line).toFixed(3);
}

// Canonical market-type aliases: some odds providers emit H2H / TOTALS / HANDICAP
// instead of MONEYLINE / TOTAL / SPREAD. Normalize so suppression groups converge.
const POTD_MARKET_ALIASES = Object.freeze({ H2H: 'MONEYLINE', TOTALS: 'TOTAL', HANDICAP: 'SPREAD' });

function normalizePotdMarketKey(candidate) {
  const raw = String(candidate?.marketType || candidate?.market_type || '').toUpperCase();
  return POTD_MARKET_ALIASES[raw] || raw;
}

function buildShadowCandidateIdentity(candidate, canonicalSelection) {
  const sport = String(candidate?.sport || '').toUpperCase();
  const marketType = String(candidate?.marketType || '').toUpperCase();
  const gameId = String(candidate?.gameId || '').trim();
  const homeTeam = String(candidate?.home_team || '').trim();
  const awayTeam = String(candidate?.away_team || '').trim();
  const gameRef = gameId || `${homeTeam}__${awayTeam}`;
  return `${sport}|${gameRef}|${marketType}|${canonicalSelection}|${normalizeShadowLine(candidate?.line)}`;
}

function shadowCandidateIdentity(candidate) {
  const canonicalSelection = canonicalizeShadowSelection(candidate);
  if (!canonicalSelection) return null;
  return buildShadowCandidateIdentity(candidate, canonicalSelection);
}

// Suppression/dedupe group: sport + canonical game ref + normalized market type.
// Intentionally omits side and line so all variants of the same game+market
// (e.g. UNDER 219.5 and UNDER 220.5 for the same game) land in the same group.
function buildShadowMarketMatchGroup(candidate) {
  const sport = String(candidate?.sport || '').toUpperCase();
  const marketType = normalizePotdMarketKey(candidate);
  return [sport, resolveShadowGameRef(candidate), marketType].join('|');
}

// Build the full set of suppression group keys for a winner candidate.
// Includes a team+date derived group as a secondary key so near-miss candidates
// with a null game_id (but matching teams, date, and sport) are also suppressed.
function buildWinnerSuppressionGroups(winnerCandidate) {
  const groups = new Set();
  if (!winnerCandidate) return groups;

  groups.add(buildShadowMarketMatchGroup(winnerCandidate));

  // Secondary cross-match: derive team+date group from the winner so that
  // candidates with null game_id but identical teams/date/market are caught.
  const gameId = String(winnerCandidate?.gameId || winnerCandidate?.game_id || '').trim();
  if (!gameId) return groups; // winner itself has no game_id; primary group already team-based

  const sport = String(winnerCandidate?.sport || '').toUpperCase();
  const marketType = normalizePotdMarketKey(winnerCandidate);
  const teams = [
    normalizeShadowTeam(winnerCandidate?.home_team || winnerCandidate?.homeTeam),
    normalizeShadowTeam(winnerCandidate?.away_team || winnerCandidate?.awayTeam),
  ].filter(Boolean).sort();

  if (teams.length > 0) {
    const commenceTime = winnerCandidate?.commence_time;
    let teamRef = teams.join('__');
    if (commenceTime) {
      const dt = DateTime.fromISO(commenceTime, { zone: 'utc' });
      if (dt.isValid) teamRef = `${dt.toISODate()}|${teams.join('__')}`;
    }
    groups.add(`${sport}|${teamRef}|${marketType}`);
  }

  return groups;
}

function compareShadowCandidatesByEdgeScoreIdentity(left, right) {
  const leftEdge = isFiniteNumber(left?.edgePct) ? left.edgePct : Number.NEGATIVE_INFINITY;
  const rightEdge = isFiniteNumber(right?.edgePct) ? right.edgePct : Number.NEGATIVE_INFINITY;
  if (rightEdge !== leftEdge) return rightEdge - leftEdge;

  const leftScore = isFiniteNumber(left?.totalScore) ? left.totalScore : Number.NEGATIVE_INFINITY;
  const rightScore = isFiniteNumber(right?.totalScore) ? right.totalScore : Number.NEGATIVE_INFINITY;
  if (rightScore !== leftScore) return rightScore - leftScore;

  return String(shadowCandidateIdentity(left) || '').localeCompare(String(shadowCandidateIdentity(right) || ''));
}

function selectBestEdgeByShadowGroup(candidates) {
  const byGroup = new Map();
  for (const candidate of candidates || []) {
    const groupKey = buildShadowMarketMatchGroup(candidate);
    const current = byGroup.get(groupKey);
    if (!current || compareShadowCandidatesByEdgeScoreIdentity(current, candidate) > 0) {
      byGroup.set(groupKey, candidate);
    }
  }
  return Array.from(byGroup.values());
}

function selectNearMissShadowCandidates({ winnerStatus, candidatePool, winnerCandidate }) {
  if (!Array.isArray(candidatePool) || candidatePool.length === 0) return [];
  const winnerGroups =
    winnerStatus === 'FIRED' && winnerCandidate
      ? buildWinnerSuppressionGroups(winnerCandidate)
      : new Set();

  const eligibleRows = candidatePool.filter((candidate) =>
    winnerGroups.size === 0 || !winnerGroups.has(buildShadowMarketMatchGroup(candidate))
  );

  return selectBestEdgeByShadowGroup(eligibleRows)
    .sort(compareShadowCandidatesByEdgeScoreIdentity)
    .slice(0, POTD_MAX_NEAR_MISS_SHADOW_CANDIDATES);
}

function writeDailyStats(db, {
  playDate,
  potdFired,
  candidateCount,
  viableCount,
  topEdgePct,
  topScore,
  selectedEdgePct,
  selectedScore,
  stakePctOfBankroll,
}) {
  db.prepare(`
    INSERT INTO potd_daily_stats (
      play_date, potd_fired, candidate_count, viable_count,
      top_edge_pct, top_score, selected_edge_pct, selected_score,
      stake_pct_of_bankroll
    ) VALUES (
      @play_date, @potd_fired, @candidate_count, @viable_count,
      @top_edge_pct, @top_score, @selected_edge_pct, @selected_score,
      @stake_pct_of_bankroll
    )
    ON CONFLICT(play_date) DO UPDATE SET
      potd_fired            = excluded.potd_fired,
      candidate_count       = excluded.candidate_count,
      viable_count          = excluded.viable_count,
      top_edge_pct          = excluded.top_edge_pct,
      top_score             = excluded.top_score,
      selected_edge_pct     = excluded.selected_edge_pct,
      selected_score        = excluded.selected_score,
      stake_pct_of_bankroll = excluded.stake_pct_of_bankroll
  `).run({
    play_date: playDate,
    potd_fired: potdFired ? 1 : 0,
    candidate_count: candidateCount,
    viable_count: viableCount,
    top_edge_pct: topEdgePct ?? null,
    top_score: topScore ?? null,
    selected_edge_pct: selectedEdgePct ?? null,
    selected_score: selectedScore ?? null,
    stake_pct_of_bankroll: stakePctOfBankroll ?? null,
  });
}


/**
 * Resolve the POTD timing state based on current ET hour and whether an
 * official play has been published for today.
 */
function resolvePotdTimingState(nowEt, hasOfficialPlay = false) {
  const hour = Number(nowEt?.hour);
  if (!Number.isFinite(hour)) return POTD_TIMING_STATES.PENDING_WINDOW;
  if (hour < POTD_WINDOW_ET.OPENS_HOUR) return POTD_TIMING_STATES.PENDING_WINDOW;
  if (hour < POTD_WINDOW_ET.CLOSES_HOUR) {
    return hasOfficialPlay ? POTD_TIMING_STATES.OFFICIAL_PLAY : POTD_TIMING_STATES.PENDING_WINDOW;
  }
  // hour >= CLOSES_HOUR
  return hasOfficialPlay ? POTD_TIMING_STATES.OFFICIAL_PLAY : POTD_TIMING_STATES.NO_PICK_FINAL;
}

/**
 * Emit the POTD engine heartbeat log line on every return path.
 */
function emitPotdHeartbeat(runId, nowEt, candidatesCount, viableCount, timingState, playLabel = null) {
  const ts = nowEt ? nowEt.toUTC().toISO() : new Date().toISOString();
  const playPart = playLabel ? ` play:${playLabel}` : '';
  console.log(`[POTD] Engine run complete — ts:${ts} run:${runId} candidates:${candidatesCount} viable:${viableCount} status:${timingState}${playPart}`);
}

/**
 * Send a no-pick alert to the alert webhook.
 * Silent no-op when webhookUrl is falsy.
 */
async function sendPotdNopickAlert({ sendDiscordMessagesFn, webhookUrl, message }) {
  if (!webhookUrl) return;
  await sendDiscordMessagesFn({ webhookUrl, messages: [message] });
}

const POTD_NOPICK_ALERT_STATE_PREFIX = 'potd_nopick_alert';

function potdNopickAlertStateKey(playDate) {
  return `${POTD_NOPICK_ALERT_STATE_PREFIX}|${playDate}`;
}

function ensureRunStateTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_state (
      id TEXT PRIMARY KEY,
      current_run_id TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function hasSentPotdNopickAlert(db, playDate) {
  ensureRunStateTable(db);
  const stateKey = potdNopickAlertStateKey(playDate);
  const row = db
    .prepare(`SELECT current_run_id FROM run_state WHERE id = ? LIMIT 1`)
    .get(stateKey);
  return Boolean(row && row.current_run_id);
}

function claimPotdNopickAlertSend(db, playDate, runId) {
  ensureRunStateTable(db);
  const stateKey = potdNopickAlertStateKey(playDate);
  const result = db.prepare(`
    INSERT INTO run_state (id, current_run_id, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      current_run_id = excluded.current_run_id,
      updated_at = CURRENT_TIMESTAMP
    WHERE run_state.current_run_id IS NULL
  `).run(stateKey, runId);
  return result.changes === 1;
}

function releasePotdNopickAlertClaim(db, playDate, runId) {
  ensureRunStateTable(db);
  const stateKey = potdNopickAlertStateKey(playDate);
  db.prepare(`DELETE FROM run_state WHERE id = ? AND current_run_id = ?`).run(stateKey, runId);
}

function markPotdNopickAlertSent(db, playDate, runId) {
  ensureRunStateTable(db);
  const stateKey = potdNopickAlertStateKey(playDate);
  db.prepare(`
    INSERT INTO run_state (id, current_run_id, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      current_run_id = excluded.current_run_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(stateKey, runId);
}

async function sendPotdNopickAlertOncePerDay({
  db,
  playDate,
  runId,
  sendDiscordMessagesFn,
  webhookUrl,
  message,
}) {
  if (process.env.ENABLE_POTD_NOPICK_ALERTS === 'false') {
    console.log('[POTD] No-pick alerts disabled via ENABLE_POTD_NOPICK_ALERTS=false');
    return { sent: false, reason: 'disabled' };
  }
  if (!webhookUrl) return { sent: false, reason: 'missing_webhook' };
  if (!claimPotdNopickAlertSend(db, playDate, runId)) {
    console.log(`[POTD] No-pick alert already claimed for ${playDate} — suppressing duplicate`);
    return { sent: false, reason: 'already_sent' };
  }

  try {
    await sendPotdNopickAlert({ sendDiscordMessagesFn, webhookUrl, message });
    markPotdNopickAlertSent(db, playDate, runId);
    return { sent: true, reason: 'sent' };
  } catch (error) {
    // Release claim so a later retry can attempt delivery if Discord send fails.
    releasePotdNopickAlertClaim(db, playDate, runId);
    throw error;
  }
}

/**
 * Build the no-pick alert message text.
 */
function formatNopickNearMiss(candidate) {
  if (!candidate) return null;
  const edgeLabel = isFiniteNumber(candidate.edgePct) ? `${(candidate.edgePct * 100).toFixed(2)}%` : 'n/a';
  const scoreLabel = isFiniteNumber(candidate.totalScore) ? candidate.totalScore.toFixed(3) : 'n/a';
  return `${candidate.sport || 'UNK'} | ${candidate.selectionLabel || '—'} | Edge ${edgeLabel} | Score ${scoreLabel}`;
}

function formatNopickDateLabel(nowEt) {
  if (!nowEt) return 'today';

  if (typeof nowEt.toFormat === 'function') {
    try {
      return nowEt.toFormat('MMM dd');
    } catch (_) {
      // Fall through to ISO date formatting.
    }
  }

  if (typeof nowEt.toISODate === 'function') {
    const isoDate = nowEt.toISODate();
    if (typeof isoDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
      const asDate = new Date(`${isoDate}T00:00:00Z`);
      if (!Number.isNaN(asDate.getTime())) {
        return asDate.toLocaleDateString('en-US', {
          month: 'short',
          day: '2-digit',
          timeZone: 'UTC',
        });
      }
    }
  }

  return 'today';
}

function buildNopickAlertMessage({ alertCandidate, topByEdge, reason, candidatesCount, viableCount, nowEt, nearMissCandidates = [] }) {
  const candidate = alertCandidate || topByEdge;
  const dateLabel = formatNopickDateLabel(nowEt);
  const reasonLabel = POTD_NOPICK_REASONS[reason] || reason;
  const requiredEdge = candidate
    ? resolveNoiseFloor(candidate.sport, candidate.marketType, POTD_MIN_EDGE)
    : POTD_MIN_EDGE;
  const observedEdge = candidate && isFiniteNumber(candidate.edgePct)
    ? `${(candidate.edgePct * 100).toFixed(2)}%`
    : 'n/a';
  const candidateLabel = candidate
    ? `${candidate.sport} | ${candidate.selectionLabel || '—'} | Score: ${isFiniteNumber(candidate.totalScore) ? candidate.totalScore.toFixed(3) : 'n/a'}`
    : 'None available';
  const nearMissLines = Array.isArray(nearMissCandidates)
    ? nearMissCandidates
      .map(formatNopickNearMiss)
      .filter(Boolean)
      .slice(0, POTD_MAX_NEAR_MISS_SHADOW_CANDIDATES)
    : [];

  return [
    `⚠️ POTD — No Pick (${dateLabel})`,
    `Reason: ${reasonLabel}`,
    `Top candidate: ${candidateLabel}`,
    `Highest edge observed: ${observedEdge}`,
    `Required minimum edge: ${(requiredEdge * 100).toFixed(2)}%`,
    `Candidates scored: ${candidatesCount}`,
    `Viable: ${viableCount}`,
    `Near misses: ${nearMissLines.length ? nearMissLines.join(' || ') : 'None available'}`,
  ].join('\n');
}

function writeShadowCandidates(db, { playDate, capturedAt, minEdgePct, candidates }) {
  if (!Array.isArray(candidates) || candidates.length === 0) return;
  const retainedRows = selectBestEdgeByShadowGroup(candidates)
    .map((candidate) => {
      const canonicalSelection = canonicalizeShadowSelection(candidate);
      if (!canonicalSelection) return null;
      return {
        candidate,
        canonicalSelection,
        identityKey: buildShadowCandidateIdentity(candidate, canonicalSelection),
        groupKey: buildShadowMarketMatchGroup(candidate),
        shadowReason: candidate._shadowReason ?? null,
      };
    })
    .filter(Boolean);
  if (retainedRows.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO potd_shadow_candidates (
      play_date, captured_at, sport, market_type, selection_label,
      home_team, away_team, game_id, price, line,
      edge_pct, total_score, line_value, market_consensus,
      model_win_prob, implied_prob, projection_source, gap_to_min_edge,
      selection, game_time_utc, candidate_identity_key, shadow_reason
    ) VALUES (
      @play_date, @captured_at, @sport, @market_type, @selection_label,
      @home_team, @away_team, @game_id, @price, @line,
      @edge_pct, @total_score, @line_value, @market_consensus,
      @model_win_prob, @implied_prob, @projection_source, @gap_to_min_edge,
      @selection, @game_time_utc, @candidate_identity_key, @shadow_reason
    )
    ON CONFLICT(play_date, candidate_identity_key) DO UPDATE SET
      captured_at = excluded.captured_at,
      sport = excluded.sport,
      market_type = excluded.market_type,
      selection_label = excluded.selection_label,
      home_team = excluded.home_team,
      away_team = excluded.away_team,
      game_id = excluded.game_id,
      price = excluded.price,
      line = excluded.line,
      edge_pct = excluded.edge_pct,
      total_score = excluded.total_score,
      line_value = excluded.line_value,
      market_consensus = excluded.market_consensus,
      model_win_prob = excluded.model_win_prob,
      implied_prob = excluded.implied_prob,
      projection_source = excluded.projection_source,
      gap_to_min_edge = excluded.gap_to_min_edge,
      selection = excluded.selection,
      game_time_utc = excluded.game_time_utc,
      shadow_reason = excluded.shadow_reason
  `);
  const existingRowsStmt = db.prepare(`
    SELECT id, play_date, sport, market_type, home_team, away_team, game_id,
           line, candidate_identity_key
    FROM potd_shadow_candidates
    WHERE play_date = ?
  `);
  const clearResultFkStmt = db.prepare(`
    UPDATE potd_shadow_results
    SET shadow_candidate_id = NULL
    WHERE shadow_candidate_id = ?
  `);
  const deleteCandidateStmt = db.prepare(`
    DELETE FROM potd_shadow_candidates
    WHERE id = ?
  `);

  const transaction = db.transaction(() => {
    for (const row of retainedRows) {
      const c = row.candidate;
      stmt.run({
        play_date: playDate,
        captured_at: capturedAt,
        sport: c.sport ?? null,
        market_type: c.marketType ?? null,
        selection_label: c.selectionLabel ?? null,
        home_team: c.home_team ?? null,
        away_team: c.away_team ?? null,
        game_id: c.gameId ?? null,
        price: c.price ?? null,
        line: c.line ?? null,
        edge_pct: c.edgePct ?? null,
        total_score: c.totalScore ?? null,
        line_value: c.lineValue ?? null,
        market_consensus: c.marketConsensus ?? null,
        model_win_prob: c.modelWinProb ?? null,
        implied_prob: c.impliedProb ?? null,
        projection_source: c.scoreBreakdown && c.scoreBreakdown.projection_source ? c.scoreBreakdown.projection_source : null,
        gap_to_min_edge: c.edgePct != null ? c.edgePct - resolveNoiseFloor(c.sport, c.marketType, minEdgePct) : null,
        selection: row.canonicalSelection,
        game_time_utc: c.commence_time ?? null,
        candidate_identity_key: row.identityKey,
        shadow_reason: row.shadowReason,
      });
    }

    const retainedIdentityKeys = new Set(retainedRows.map((row) => row.identityKey));
    const retainedGroupKeys = new Set(retainedRows.map((row) => row.groupKey));
    const existingRows = existingRowsStmt.all(playDate);
    for (const existing of existingRows) {
      const groupKey = buildShadowMarketMatchGroup(existing);
      if (!retainedGroupKeys.has(groupKey) || retainedIdentityKeys.has(existing.candidate_identity_key)) {
        continue;
      }
      clearResultFkStmt.run(existing.id);
      deleteCandidateStmt.run(existing.id);
    }
  });

  transaction();
}
function writeNominees(db, { playDate, capturedAt, winnerStatus, nominees }) {
  db.prepare(`DELETE FROM potd_nominees WHERE play_date = ?`).run(playDate);
  if (!Array.isArray(nominees) || nominees.length === 0) return;
  const sanitizedNominees = nominees.filter((candidate) =>
    isModelBackedCandidate(candidate) &&
    isFiniteNumber(candidate.edgePct) &&
    candidate.edgePct > 0
  );
  if (sanitizedNominees.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO potd_nominees (
      play_date, nominee_rank, winner_status, sport, game_id,
      home_team, away_team, market_type, selection_label, line, price,
      edge_pct, total_score, confidence_label, model_win_prob,
      game_time_utc, source_type, created_at
    ) VALUES (
      @play_date, @nominee_rank, @winner_status, @sport, @game_id,
      @home_team, @away_team, @market_type, @selection_label, @line, @price,
      @edge_pct, @total_score, @confidence_label, @model_win_prob,
      @game_time_utc, @source_type, @created_at
    )
  `);
  sanitizedNominees.forEach((c, i) => {
    stmt.run({
      play_date: playDate,
      nominee_rank: i + 1,
      winner_status: winnerStatus,
      sport: c.sport ?? null,
      game_id: c.gameId ?? null,
      home_team: c.home_team ?? null,
      away_team: c.away_team ?? null,
      market_type: c.marketType ?? null,
      selection_label: c.selectionLabel ?? null,
      line: c.line ?? null,
      price: c.price ?? null,
      edge_pct: c.edgePct ?? null,
      total_score: c.totalScore ?? null,
      confidence_label: c.confidenceLabel ?? null,
      model_win_prob: c.modelWinProb ?? null,
      game_time_utc: c.commence_time ?? null,
      source_type: 'SPORT_WINNER',
      created_at: capturedAt,
    });
  });
}

const JOB_NAME = 'run_potd_engine';
const DEFAULT_TIMEZONE = 'America/New_York';

// Frozen timing-state tokens
const POTD_TIMING_STATES = Object.freeze({
  PENDING_WINDOW: 'PENDING_WINDOW',
  OFFICIAL_PLAY: 'OFFICIAL_PLAY',
  NO_PICK_FINAL: 'NO_PICK_FINAL',
});

// Publish window bounds in ET hours.
// CLOSES_HOUR=17 (5 PM ET) gives the engine breathing room past the scheduler's
// fallback deadline of 4:15 PM ET and prevents manual runs at 4:xx PM from
// being rejected by the window guard before any candidates are evaluated.
const POTD_WINDOW_ET = Object.freeze({ OPENS_HOUR: 12, CLOSES_HOUR: 17 });

// Human-readable reason strings for no-pick alerts
const POTD_NOPICK_REASONS = Object.freeze({
  below_noise_floor: 'No candidate cleared the per-sport noise floor',
  no_viable_candidates: 'No candidates scored above viability thresholds',
  model_health_stale: 'Model health snapshots are stale; gate decisions are reported as MODEL_HEALTH_STALE',
  confidence_below_high_gate: 'Best candidate confidence is below HIGH gate',
  zero_wager: 'Kelly sizing returned zero or non-finite wager',
  min_stake_rejected: 'Kelly stake fell below minimum stake percentage',
});

// Legacy numeric constants (kept for inline documentation; logic now uses POTD_WINDOW_ET)
const PUBLISH_WINDOW_START_HOUR = POTD_WINDOW_ET.OPENS_HOUR;
const PUBLISH_WINDOW_END_HOUR   = POTD_WINDOW_ET.CLOSES_HOUR;
const DEFAULT_BANKROLL = Number(process.env.POTD_STARTING_BANKROLL || 10);
const DEFAULT_KELLY_FRACTION = Number(process.env.POTD_KELLY_FRACTION || 0.25);
// Cap at 2 % of bankroll (was 20 % — much too loose for a featured single play).
const DEFAULT_MAX_WAGER_PCT = Number(process.env.POTD_MAX_WAGER_PCT || 0.02);
// Minimum model edge required to publish a POTD.  Plays below this threshold
// are skipped entirely rather than printed with couch-cushion wager amounts.
const POTD_MIN_EDGE = Number(process.env.POTD_MIN_EDGE || 0.02);  // 2.0 %
// If quarter-Kelly stake lands below this fraction of bankroll, reject the play
// (Kelly is screaming the edge is too thin — honour that signal).
const POTD_MIN_STAKE_PCT = Number(process.env.POTD_MIN_STAKE_PCT || 0.005); // 0.5 %
// Minimum totalScore (0–1 confidence/quality blend) required for POTD candidate viability.
// totalScore = (lineValue * 0.625) + (marketConsensus * 0.375), both [0,1] clamped.
const POTD_MIN_TOTAL_SCORE = Number(process.env.POTD_MIN_TOTAL_SCORE || 0.30);  // 0.30
// Maximum number of nominees (sport winners) to store and display per day.
// With 4 active sports the effective ceiling is 4.
const POTD_MAX_NOMINEES = Number(process.env.POTD_MAX_NOMINEES || 5);
const POTD_MAX_NEAR_MISS_SHADOW_CANDIDATES = 3;
const POTD_MODEL_HEALTH_MAX_AGE_MINUTES = Number(process.env.POTD_MODEL_HEALTH_MAX_AGE_MINUTES || 180);
const POTD_MONITORED_DECISION_STATUSES = new Set(['PLAY', 'LEAN', 'SLIGHT_EDGE']);
const SHADOW_REASONS = Object.freeze({
  NOT_SELECTED: 'NOT_SELECTED',
  NON_PLAY_DECISION_OUTCOME: 'NON_PLAY_DECISION_OUTCOME',
  BELOW_OFFICIAL_EDGE_FLOOR: 'BELOW_OFFICIAL_EDGE_FLOOR',
  BELOW_SCORE_GATE: 'BELOW_SCORE_GATE',
  NON_MODEL_SOURCE: 'NON_MODEL_SOURCE',
  EDGE_FORMULA_MISMATCH: 'EDGE_FORMULA_MISMATCH',
});
const POTD_EMPTY_SELECTION_REJECTION_CODES = new Set([
  'NO_QUALIFIED_PROPS',
  'SKIP_MARKET_NO_EDGE',
]);
// Set POTD_AUDIT_LOG_ENABLED=false to suppress per-candidate audit lines in production logs.
const POTD_AUDIT_LOG_ENABLED = process.env.POTD_AUDIT_LOG_ENABLED !== 'false';
/**
 * Load model health gates from the most recent snapshot per sport.
 * Returns a Set of uppercase sport keys (e.g. 'NBA', 'MLB', 'NHL') whose
 * MODEL-sourced candidates are blocked from POTD selection.
 * Blocked statuses: 'critical' only.
 * 'stale' means the health report job hasn't run recently — model quality is unknown, not
 * confirmed bad. Blocking stale sports would cause silent NO_PICK days whenever the monitoring
 * job misses a run, which is an operational failure masquerading as a signal failure.
 * 'degraded' candidates still compete — lower hit rates but not disqualified.
 * Safe-fails to empty Set if the table is missing or has no rows.
 */
function loadModelHealthState(db, opts = {}) {
  const blockedSports = new Set();
  const staleSports = new Set();
  const maxAgeMinutes = Number.isFinite(Number(opts.maxAgeMinutes))
    ? Number(opts.maxAgeMinutes)
    : POTD_MODEL_HEALTH_MAX_AGE_MINUTES;
  const nowUtc = opts.nowUtc && DateTime.isDateTime(opts.nowUtc)
    ? opts.nowUtc
    : DateTime.utc();
  const state = {
    blockedSports,
    staleSports,
    isStale: false,
    staleReasonCode: null,
    latestRunAt: null,
    snapshotAgeMinutes: null,
    maxAgeMinutes,
  };

  if (!db) {
    state.isStale = true;
    state.staleReasonCode = 'MODEL_HEALTH_STALE';
    return state;
  }

  try {
    const rows = db.prepare(`
      SELECT sport, status, run_at
      FROM model_health_snapshots
      WHERE (sport, run_at) IN (
        SELECT sport, MAX(run_at) FROM model_health_snapshots GROUP BY sport
      )
    `).all();

    if (!Array.isArray(rows) || rows.length === 0) {
      state.isStale = true;
      state.staleReasonCode = 'MODEL_HEALTH_STALE';
      return state;
    }

    let latestRunAtMs = null;
    for (const row of rows) {
      const sportKey = String(row.sport || '').toUpperCase();
      if (sportKey) staleSports.add(sportKey);

      const runAt = DateTime.fromISO(String(row.run_at || ''), { zone: 'utc' });
      if (runAt.isValid) {
        const ts = runAt.toMillis();
        latestRunAtMs = latestRunAtMs == null ? ts : Math.max(latestRunAtMs, ts);
      }

      if (row.status === 'critical') {
        blockedSports.add(sportKey);
      }
    }

    if (latestRunAtMs == null) {
      state.isStale = true;
      state.staleReasonCode = 'MODEL_HEALTH_STALE';
      blockedSports.clear();
      return state;
    }

    state.latestRunAt = DateTime.fromMillis(latestRunAtMs, { zone: 'utc' }).toISO();
    state.snapshotAgeMinutes = Math.max(0, Math.floor((nowUtc.toMillis() - latestRunAtMs) / 60_000));
    if (state.snapshotAgeMinutes > maxAgeMinutes) {
      state.isStale = true;
      state.staleReasonCode = 'MODEL_HEALTH_STALE';
      // Fail-open: stale health should not silently keep critical blocks forever.
      blockedSports.clear();
    }
  } catch (_) {
    // Table missing or query error — report stale and fail open.
    state.isStale = true;
    state.staleReasonCode = 'MODEL_HEALTH_STALE';
    blockedSports.clear();
  }

  return state;
}

function loadModelHealthGates(db, opts = {}) {
  return loadModelHealthState(db, opts).blockedSports;
}



/**
 * Pure function — builds a structured audit entry for a scored candidate.
 * No side effects; exported for direct unit testing.
 */
function buildCandidateAuditEntry(candidate, noiseFloor, minScore) {
  const edge = candidate.edgePct;
  const modelProb = candidate.modelWinProb;
  const impliedProb = candidate.impliedProb;
  const sourceTag = candidate.edgeSourceTag ?? null;
  const source = normalizeEdgeSource(sourceTag);
  const hasInputs = hasRequiredEdgeInputs(candidate);
  const edgeFormulaMismatch = hasEdgeFormulaMismatch(candidate);
  const totalScore = candidate.totalScore;
  const confidenceLabel = String(candidate.confidenceLabel || '').toUpperCase();
  const passesPositive = isFiniteNumber(edge) && edge > 0;
  const passesNoise = isFiniteNumber(edge) && edge > noiseFloor;
  const passesScore = isFiniteNumber(totalScore) && totalScore >= minScore;
  const passesConfidence = confidenceLabel !== 'LOW';
  const rejectionCodes = Array.isArray(candidate.rejectionDiagnostics)
    ? candidate.rejectionDiagnostics.map((entry) => entry?.code).filter(Boolean)
    : [];
  const hasModelSignalIncomplete = rejectionCodes.includes('MODEL_SIGNAL_INCOMPLETE');

  let rejectedReason = 'VIABLE';
  if (hasModelSignalIncomplete) {
    rejectedReason = 'MODEL_SIGNAL_INCOMPLETE';
  } else if (source !== 'MODEL') {
    rejectedReason = 'NON_MODEL_SOURCE';
  } else if (!hasInputs) {
    rejectedReason = 'MISSING_EDGE_INPUTS';
  } else if (edgeFormulaMismatch) {
    rejectedReason = 'EDGE_FORMULA_MISMATCH';
  } else if (!isFiniteNumber(edge)) {
    rejectedReason = 'NO_EDGE_COMPUTED';
  } else if (!passesPositive) {
    rejectedReason = 'NEGATIVE_EDGE';
  } else if (!passesNoise) {
    rejectedReason = 'BELOW_NOISE_FLOOR';
  } else if (!passesScore) {
    rejectedReason = 'BELOW_MIN_SCORE';
  } else if (!passesConfidence) {
    rejectedReason = 'BELOW_CONFIDENCE_LABEL';
  }

  return {
    potd_audit: true,
    sport: candidate.sport ?? null,
    marketType: candidate.marketType ?? null,
    selectionLabel: candidate.selectionLabel ?? null,
    price: candidate.price ?? null,
    gameId: candidate.gameId ?? null,
    modelProb: isFiniteNumber(modelProb) ? modelProb : null,
    impliedProb: isFiniteNumber(impliedProb) ? impliedProb : null,
    edgePct: isFiniteNumber(edge) ? edge : null,
    source,
    sourceTag,
    hasRequiredEdgeInputs: hasInputs,
    edgeFormulaMismatch,
    noiseFloor,
    passesNoise,
    totalScore: isFiniteNumber(totalScore) ? totalScore : null,
    minScore,
    passesScore,
    passesConfidence,
    edgeSourceTag: candidate.edgeSourceTag ?? null,
    edgeSourceMeta: candidate.edgeSourceMeta ?? null,
    confidenceLabel: candidate.confidenceLabel ?? null,
    rejectionDiagnostics: rejectionCodes,
    rejectedReason,
  };
}

function hasEmptySelectionRejectionCode(candidate) {
  const diagnostics = Array.isArray(candidate?.rejectionDiagnostics)
    ? candidate.rejectionDiagnostics
    : [];

  return diagnostics.some((entry) => {
    const code = String(entry?.code || '').trim().toUpperCase();
    return POTD_EMPTY_SELECTION_REJECTION_CODES.has(code);
  });
}

/**
 * Emit a structured audit log entry for a scored candidate.
 * Captures the noise floor used, whether it passed, score, and rejection reason.
 * Guarded by POTD_AUDIT_LOG_ENABLED env var.
 */
function auditLogCandidate(candidate, noiseFloor) {
  if (!POTD_AUDIT_LOG_ENABLED) return;
  const entry = buildCandidateAuditEntry(candidate, noiseFloor, POTD_MIN_TOTAL_SCORE);
  console.log(JSON.stringify(entry));

  // Contract mismatch check: edgeSourceTag must agree with EDGE_SOURCE_CONTRACT.
  const contractExpected = resolveEdgeSourceContract(candidate.sport, candidate.marketType);
  const tagActual = candidate.edgeSourceTag ?? null;
  if (contractExpected !== 'UNKNOWN' && tagActual !== null && tagActual !== contractExpected) {
    console.log(JSON.stringify({
      type: 'POTD_AUDIT_CONTRACT_MISMATCH',
      sport: candidate.sport ?? null,
      marketType: candidate.marketType ?? null,
      edgeSourceTag: tagActual,
      contractExpected,
      note: 'edgeSourceTag does not match EDGE_SOURCE_CONTRACT — scoring path bug suspected',
    }));
  }
}

const POTD_SPORT_ENV = {
  NHL: 'ENABLE_NHL_MODEL',
  NBA: 'ENABLE_NBA_MODEL',
  MLB: 'ENABLE_MLB_MODEL',
  NFL: 'ENABLE_NFL_MODEL',
};

function getActivePotdSports() {
  return Object.entries(POTD_SPORT_ENV)
    .filter(([sport, envKey]) => ODDS_SPORTS_CONFIG[sport] && ODDS_SPORTS_CONFIG[sport].active !== false && process.env[envKey] !== 'false')
    .map(([sport]) => sport);
}

function buildPotdIds(playDate) {
  return {
    playId: `potd-play-${playDate}`,
    cardId: `potd-card-${playDate}`,
    seedLedgerId: `potd-bankroll-initial-${playDate}`,
    playLedgerId: `potd-bankroll-play-${playDate}`,
  };
}

function getLatestBankrollRow(db) {
  return (
    db
      .prepare(
        `SELECT * FROM potd_bankroll
         ORDER BY datetime(created_at) DESC, id DESC
         LIMIT 1`,
      )
      .get() || null
  );
}

function ensureInitialBankroll(db, { playDate, nowIso, startingBankroll }) {
  const latest = getLatestBankrollRow(db);
  if (latest) {
    return {
      created: false,
      bankroll: Number(latest.amount_after),
    };
  }

  const ids = buildPotdIds(playDate);
  db.prepare(
    `INSERT INTO potd_bankroll (
      id, event_date, event_type, play_id, card_id,
      amount_before, amount_change, amount_after, notes, created_at
    ) VALUES (?, ?, 'initial', NULL, NULL, 0, ?, ?, ?, ?)`,
  ).run(
    ids.seedLedgerId,
    playDate,
    startingBankroll,
    startingBankroll,
    'Initial POTD bankroll seed',
    nowIso,
  );

  return {
    created: true,
    bankroll: startingBankroll,
  };
}

function buildSelectionObject(candidate) {
  if (candidate.marketType === 'TOTAL') {
    return { side: candidate.selection };
  }
  const team =
    candidate.selection === 'HOME'
      ? candidate.home_team
      : candidate.away_team;
  return {
    side: candidate.selection,
    team,
  };
}

function recommendedBetTypeFor(marketType) {
  if (marketType === 'TOTAL') return 'total';
  if (marketType === 'SPREAD') return 'spread';
  return 'moneyline';
}

function buildCardPayloadData(candidate, { nowIso, wagerAmount, bankrollAtPost, kellyFraction, confidenceMultiplier: confidenceMultiplierValue }) {
  const canonicalDecision = resolveCanonicalDecision(
    {
      decision_v2: {
        official_status: 'PLAY',
        primary_reason_code: 'POTD_CANDIDATE_SELECTED',
        source: CANONICAL_DECISION_SOURCE,
      },
    },
    {
      stage: 'publisher',
      fallbackToLegacy: false,
      strictSource: true,
      missingReasonCode: 'POTD_CANDIDATE_SELECTED',
    },
  );

  return {
    game_id: candidate.gameId,
    sport: candidate.sport,
    kind: 'PLAY',
    action: 'FIRE',
    status: 'FIRE',
    classification: 'BASE',
    decision_v2: {
      official_status: 'PLAY',
      primary_reason_code: 'POTD_CANDIDATE_SELECTED',
      source: CANONICAL_DECISION_SOURCE,
    },
    canonical_decision:
      canonicalDecision || {
        official_status: 'PLAY',
        is_actionable: true,
        tier: 'PLAY',
        reason_code: 'POTD_CANDIDATE_SELECTED',
        source: CANONICAL_DECISION_SOURCE,
        lifecycle: [
          {
            stage: 'publisher',
            status: 'CLEARED',
            reason_code: 'POTD_CANDIDATE_SELECTED',
          },
        ],
      },
    // Canonical play-state: POTD only fires for candidates that cleared the
    // positive-edge and confidence gates in gatherBestCandidate(). Stamp
    // final_play_state explicitly so all downstream surfaces (Discord, /wedge)
    // read the authoritative state rather than re-deriving it.
    final_play_state: 'OFFICIAL_PLAY',
    official_eligible: true,
    potd_eligible: true,
    prediction: candidate.selection,
    confidence: candidate.totalScore,
    confidence_pct: Math.round(candidate.totalScore * 100),
    confidence_label: candidate.confidenceLabel,
    recommended_bet_type: recommendedBetTypeFor(candidate.marketType),
    market_type: candidate.marketType,
    selection: buildSelectionObject(candidate),
    selection_label: candidate.selectionLabel,
    line: candidate.line,
    price: candidate.price,
    edge_pct: candidate.edgePct,
    total_score: candidate.totalScore,
    model_win_prob: candidate.modelWinProb,
    implied_prob: candidate.impliedProb,
    score_breakdown: candidate.scoreBreakdown,
    home_team: candidate.home_team,
    away_team: candidate.away_team,
    start_time_utc: candidate.commence_time,
    generated_at: nowIso,
    wager_amount: wagerAmount,
    bankroll_at_post: bankrollAtPost,
    kelly_fraction: kellyFraction,
    confidence_multiplier: confidenceMultiplierValue ?? null,
    odds_context: candidate.oddsContext,
    reasoning: candidate.reasoning ?? null,
  };
}

function buildPotdPlayRow(candidate, {
  playId,
  cardId,
  playDate,
  nowIso,
  wagerAmount,
  bankrollAtPost,
  kellyFraction,
  confidenceMultiplier: confidenceMultiplierValue,
}) {
  return {
    id: playId,
    play_date: playDate,
    game_id: candidate.gameId,
    card_id: cardId,
    sport: candidate.sport,
    home_team: candidate.home_team,
    away_team: candidate.away_team,
    market_type: candidate.marketType,
    selection: candidate.selection,
    selection_label: candidate.selectionLabel,
    line: candidate.line,
    price: candidate.price,
    confidence_label: candidate.confidenceLabel,
    total_score: candidate.totalScore,
    model_win_prob: candidate.modelWinProb,
    implied_prob: candidate.impliedProb,
    edge_pct: candidate.edgePct,
    score_breakdown: JSON.stringify(candidate.scoreBreakdown || {}),
    wager_amount: wagerAmount,
    bankroll_at_post: bankrollAtPost,
    kelly_fraction: kellyFraction,
    confidence_multiplier: confidenceMultiplierValue ?? null,
    game_time_utc: candidate.commence_time,
    posted_at: nowIso,
    reasoning: candidate.reasoning ?? null,
  };
}

function buildPotdCard(candidate, row, { cardId, nowIso }) {
  const payloadData = buildCardPayloadData(candidate, {
    nowIso,
    wagerAmount: row.wager_amount,
    bankrollAtPost: row.bankroll_at_post,
    kellyFraction: row.kelly_fraction,
    confidenceMultiplier: row.confidence_multiplier,
  });

  return {
    id: cardId,
    gameId: candidate.gameId,
    sport: candidate.sport,
    cardType: 'potd-call',
    cardTitle: `POTD: ${candidate.selectionLabel}`,
    createdAt: nowIso,
    expiresAt: null,
    payloadData,
    modelOutputIds: null,
  };
}

function normalizePotdSportKey(sport) {
  return String(sport || '')
    .toUpperCase()
    .replace('BASEBALL_', '')
    .replace('ICEHOCKEY_', '')
    .replace('BASKETBALL_', '')
    .replace('AMERICANFOOTBALL_', '');
}

function resolveModelContractPayloadCardType(sport, marketType) {
  if (resolveEdgeSourceContract(sport, marketType) !== 'MODEL') return null;

  const sportKey = normalizePotdSportKey(sport);
  const marketKey = toUpperToken(marketType);

  if (sportKey === 'MLB' && marketKey === 'MONEYLINE') return 'mlb-full-game';
  if (sportKey === 'NHL' && marketKey === 'MONEYLINE') return 'nhl-model-output';
  if (sportKey === 'NBA' && marketKey === 'TOTAL') return 'nba-totals-call';

  return null;
}

function buildDecisionOutcomeMetadataFromPayload(payload, row, fallbackMetadata = {}) {
  const selection = payload?.selection && typeof payload.selection === 'object'
    ? payload.selection
    : {};

  return {
    market: pickFirstString(
      selection.market,
      selection.market_type,
      payload?.market_type,
      payload?.recommended_bet_type,
      fallbackMetadata.market,
    ),
    side: pickFirstString(
      selection.side,
      selection.team,
      selection.player,
      payload?.prediction,
      payload?.selection_side,
      fallbackMetadata.side,
    ),
    line: pickFirstDefined(
      selection.line,
      payload?.line,
      payload?.total,
      payload?.market_line,
      fallbackMetadata.line,
    ),
    price: pickFirstDefined(
      selection.price,
      payload?.price,
      payload?.market_price_over,
      payload?.market_price_under,
      fallbackMetadata.price,
    ),
    line_verified: pickFirstDefined(
      payload?.line_verified,
      payload?.market_verified,
      fallbackMetadata.line_verified,
    ),
    data_fresh: pickFirstDefined(
      payload?.data_fresh,
      payload?.snapshot_fresh,
      fallbackMetadata.data_fresh,
    ),
    inputs_complete: pickFirstDefined(
      payload?.inputs_complete,
      payload?.projection_inputs_complete,
      fallbackMetadata.inputs_complete,
    ),
    model: pickFirstString(
      payload?.model,
      payload?.model_name,
      row?.card_type,
      fallbackMetadata.model,
    ),
    timestamp: pickFirstString(
      payload?.generated_at,
      payload?.created_at,
      row?.created_at,
      fallbackMetadata.timestamp,
    ),
  };
}

function readLatestModelPayloadRecord(db, gameId, cardType) {
  if (!db || !gameId || !cardType) {
    return { present: false, payload: null, row: null };
  }

  try {
    const row = db
      .prepare(
        `SELECT payload_data, card_type, created_at
         FROM card_payloads
         WHERE game_id = ? AND card_type = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(gameId, cardType);

    if (!row) {
      return { present: false, payload: null, row: null };
    }

    if (!row.payload_data) {
      return { present: true, payload: null, row };
    }

    const payload = JSON.parse(row.payload_data);
    return { present: true, payload, row };
  } catch (error) {
    console.warn(`[POTD] invalid model payload for ${gameId}/${cardType}: ${error.message}`);
    return { present: true, payload: null, row: null };
  }
}

function buildDecisionOutcomeFromPayloadRecord(modelPayloadRecord, fallbackMetadata = {}) {
  const payload = modelPayloadRecord?.payload;
  const row = modelPayloadRecord?.row;
  const decisionV2 = payload?.decision_v2;

  if (!decisionV2 || typeof decisionV2 !== 'object') {
    return null;
  }

  try {
    return buildDecisionOutcomeFromDecisionV2(
      decisionV2,
      buildDecisionOutcomeMetadataFromPayload(payload, row, fallbackMetadata),
    );
  } catch (error) {
    console.warn(
      `[POTD] invalid DecisionOutcome input for ${fallbackMetadata?.gameId || 'unknown'}/${row?.card_type || 'unknown'}: ${error.message}`,
    );
    return null;
  }
}

function shouldRejectNonPlayDecisionOutcomeCandidate(candidate, decisionOutcome) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (resolveEdgeSourceContract(candidate.sport, candidate.marketType) !== 'MODEL') return false;
  if (!resolveModelContractPayloadCardType(candidate.sport, candidate.marketType)) return true;
  const status = String(decisionOutcome?.status || '').toUpperCase();
  return !POTD_MONITORED_DECISION_STATUSES.has(status);
}

function isOfficialPlayDecisionOutcomeCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (resolveEdgeSourceContract(candidate.sport, candidate.marketType) !== 'MODEL') return true;
  const contractCardType = resolveModelContractPayloadCardType(candidate.sport, candidate.marketType);
  if (!contractCardType) return false;
  return String(candidate.decisionOutcomeStatus || '').toUpperCase() === 'PLAY';
}

async function gatherBestCandidate({
  fetchOddsFn,
  buildCandidatesFn,
  scoreCandidateFn,
  selectTopPlaysFn,
  playDate,
  db = null,
}) {
  const sports = getActivePotdSports();
  const scoredCandidates = [];
  const fetchErrors = [];

  for (const sport of sports) {
    const result = await fetchOddsFn({ sport, hoursAhead: 24 });
    if (Array.isArray(result?.errors) && result.errors.length > 0) {
      fetchErrors.push(...result.errors);
    }
    for (const game of result?.games || []) {
      const gameId = game?.gameId;
      const mlbModelPayload =
        sport === 'MLB' && gameId
          ? readLatestModelPayloadRecord(db, gameId, 'mlb-full-game')
          : { present: false, payload: null, row: null };
      const nhlModelPayload =
        sport === 'NHL' && gameId
          ? readLatestModelPayloadRecord(db, gameId, 'nhl-model-output')
          : { present: false, payload: null, row: null };
      const nbaModelPayload =
        sport === 'NBA' && gameId
          ? readLatestModelPayloadRecord(db, gameId, 'nba-totals-call')
          : { present: false, payload: null, row: null };

      const candidateGame =
        sport === 'MLB' && game?.gameId
          ? {
              ...game,
              mlbSnapshot: getLatestMlbModelOutput(game.gameId) || null,
              mlbModelPayloadPresent: mlbModelPayload.present,
            }
          : sport === 'NHL' && game?.gameId
          ? {
              ...game,
              nhlSnapshot: getLatestNhlModelOutput(game.gameId) || null,
              nhlModelPayloadPresent: nhlModelPayload.present,
            }
          : sport === 'NBA' && game?.gameId
          ? {
              ...game,
              nbaSnapshot: getLatestNbaModelOutput(game.gameId) || null,
              nbaModelPayloadPresent: nbaModelPayload.present,
            }
          : game;
      const candidates = buildCandidatesFn(candidateGame);
      for (const candidate of candidates) {
        const modelPayloadRecord =
          sport === 'MLB'
            ? mlbModelPayload
            : sport === 'NHL'
            ? nhlModelPayload
            : sport === 'NBA'
            ? nbaModelPayload
            : null;
        const gameDecisionOutcome = buildDecisionOutcomeFromPayloadRecord(modelPayloadRecord, {
          gameId: candidate?.gameId,
          market: candidate?.marketType,
          side: candidate?.selection,
          line: candidate?.line,
          price: candidate?.price,
          model: resolveModelContractPayloadCardType(candidate?.sport, candidate?.marketType),
        });

        if (shouldRejectNonPlayDecisionOutcomeCandidate(candidate, gameDecisionOutcome)) {
          if (POTD_AUDIT_LOG_ENABLED) {
            console.log(
              JSON.stringify({
                type: 'POTD_NON_PLAY_DECISION_OUTCOME_REJECTION',
                rejectionCode: 'NON_PLAY_DECISION_OUTCOME',
                sport: candidate?.sport ?? null,
                marketType: candidate?.marketType ?? null,
                gameId: candidate?.gameId ?? null,
                selectionLabel: candidate?.selectionLabel ?? null,
                status: gameDecisionOutcome?.status ?? 'MISSING',
                note: 'Candidate rejected during assembly before scoring because model-contract DecisionOutcome status is not PLAY',
              }),
            );
          }
          continue;
        }

        const scored = scoreCandidateFn(candidate);
        if (scored) {
          scoredCandidates.push({
            ...scored,
            decisionOutcomeStatus: String(gameDecisionOutcome?.status || '').toUpperCase() || null,
          });
        }
      }
    }
  }

  // POTD is date-scoped: only consider candidates whose game starts on the
  // same ET play_date as this run.
  const playDateScopedCandidates = scoredCandidates.filter((candidate) => {
    const startUtc = candidate?.commence_time;
    if (!startUtc || !playDate) return false;
    const startEt = DateTime.fromISO(startUtc, { zone: 'utc' }).setZone(DEFAULT_TIMEZONE);
    if (!startEt.isValid) return false;
    return startEt.toISODate() === playDate;
  });

  if (POTD_AUDIT_LOG_ENABLED && playDateScopedCandidates.length !== scoredCandidates.length) {
    console.log(
      JSON.stringify({
        type: 'POTD_PLAY_DATE_FILTER',
        playDate,
        dropped: scoredCandidates.length - playDateScopedCandidates.length,
        kept: playDateScopedCandidates.length,
      }),
    );
  }

  // Per-candidate audit log: emit noise-floor evaluation for every scored candidate.
  for (const c of playDateScopedCandidates) {
    auditLogCandidate(c, resolveNoiseFloor(c.sport, c.marketType, POTD_MIN_EDGE));
  }

  // Apply per-sport noise floors before ranking; pass minEdgePct: 0 so
  // selectTopPlaysFn does not re-apply a single global floor on top.
  const modelHealthState = loadModelHealthState(db);
  const modelHealthGates = modelHealthState.blockedSports;
  if (POTD_AUDIT_LOG_ENABLED && modelHealthState.isStale) {
    console.log(JSON.stringify({
      type: 'POTD_MODEL_HEALTH_STALE',
      reason_code: modelHealthState.staleReasonCode,
      maxAgeMinutes: modelHealthState.maxAgeMinutes,
      snapshotAgeMinutes: modelHealthState.snapshotAgeMinutes,
      latestRunAt: modelHealthState.latestRunAt,
      staleSports: Array.from(modelHealthState.staleSports),
      note: 'Model health snapshots are stale; critical gates are fail-open for this run',
    }));
  }
  if (POTD_AUDIT_LOG_ENABLED && modelHealthGates.size > 0) {
    console.log(JSON.stringify({
      type: 'POTD_MODEL_HEALTH_GATES_ACTIVE',
      blockedSports: Array.from(modelHealthGates),
      note: 'MODEL-sourced candidates from these sports are excluded from POTD selection',
    }));
  }
  function isSportModelGated(candidate) {
    if (modelHealthGates.size === 0 || candidate.edgeSourceTag !== 'MODEL') return false;
    const sportKey = String(candidate.sport || '')
      .toUpperCase()
      .replace('BASEBALL_', '')
      .replace('ICEHOCKEY_', '')
      .replace('BASKETBALL_', '')
      .replace('AMERICANFOOTBALL_', '');
    return modelHealthGates.has(sportKey);
  }
  const fireableSelectorPool = playDateScopedCandidates.filter(c => {
    if (!isModelBackedCandidate(c)) return false;
    if (!isOfficialPlayDecisionOutcomeCandidate(c)) {
      if (POTD_AUDIT_LOG_ENABLED) {
        console.log(JSON.stringify({
          type: 'POTD_OFFICIAL_PLAY_DECISION_OUTCOME_GATE',
          sport: c.sport,
          marketType: c.marketType,
          selectionLabel: c.selectionLabel,
          decisionOutcomeStatus: c.decisionOutcomeStatus || null,
          note: 'Candidate excluded from official POTD selection because DecisionOutcome status is not PLAY',
        }));
      }
      return false;
    }
    if (isSportModelGated(c)) {
      if (POTD_AUDIT_LOG_ENABLED) {
        console.log(JSON.stringify({
          type: 'POTD_MODEL_HEALTH_GATE',
          sport: c.sport,
          marketType: c.marketType,
          selectionLabel: c.selectionLabel,
          edgePct: c.edgePct,
          totalScore: c.totalScore,
          edgeSourceTag: c.edgeSourceTag,
          note: 'MODEL candidate blocked — sport health status is critical',
        }));
      }
      return false;
    }
    if (hasEmptySelectionRejectionCode(c)) {
      if (POTD_AUDIT_LOG_ENABLED) {
        console.log(JSON.stringify({
          type: 'POTD_EMPTY_SELECTION_REJECTION',
          sport: c.sport,
          marketType: c.marketType,
          selectionLabel: c.selectionLabel,
          edgePct: c.edgePct,
          totalScore: c.totalScore,
          rejectionDiagnostics: c.rejectionDiagnostics,
        }));
      }
      return false;
    }
    const noiseFloor = resolveNoiseFloor(c.sport, c.marketType, POTD_MIN_EDGE);
    return (
      isFiniteNumber(c.edgePct) &&
      c.edgePct > noiseFloor &&
      isFiniteNumber(c.totalScore) &&
      c.totalScore >= POTD_MIN_TOTAL_SCORE
    );
  });

  const bestEdgeSelectorPool = selectBestEdgeByShadowGroup(fireableSelectorPool);

  // Near-miss / shadow pool: wider than the official fireable pool.
  // Includes any model-backed today-scoped candidate with positive edge and a
  // finite score, regardless of whether it cleared the official noise floor or
  // score gate.  Official POTD selection is unaffected — it still uses
  // bestEdgeSelectorPool above.
  const fireableIdentities = new Set(
    fireableSelectorPool.map(c => shadowCandidateIdentity(c)).filter(Boolean),
  );
  const broadShadowEligiblePool = playDateScopedCandidates.filter(c =>
    !isSportModelGated(c) &&
    !hasEmptySelectionRejectionCode(c) &&
    isFiniteNumber(c.edgePct) &&
    c.edgePct > 0 &&
    isFiniteNumber(c.totalScore) &&
    Boolean(canonicalizeShadowSelection(c)),
  );
  const strictShadowEligiblePool = broadShadowEligiblePool.filter(c =>
    isModelBackedCandidate(c),
  );
  // If strict model-backed pool is empty, preserve near-miss visibility with
  // best available broad pool candidates (consensus/fallback or formula-mismatch).
  const shadowEligiblePool = strictShadowEligiblePool.length > 0
    ? strictShadowEligiblePool
    : broadShadowEligiblePool;

  // Fireable candidates take priority within each shadow group: a non-fireable
  // high-edge candidate from the same game/market must not displace a fireable
  // lower-edge candidate as the group representative.
  const fireableGroupKeys = new Set(
    fireableSelectorPool.map(c => buildShadowMarketMatchGroup(c)).filter(Boolean),
  );
  const nonFireableFillPool = shadowEligiblePool.filter(
    c => !fireableGroupKeys.has(buildShadowMarketMatchGroup(c)),
  );
  const shadowCandidatePool = [
    ...bestEdgeSelectorPool,
    ...selectBestEdgeByShadowGroup(nonFireableFillPool),
  ].map(c => {
    const noiseFloor = resolveNoiseFloor(c.sport, c.marketType, POTD_MIN_EDGE);
    const identity = shadowCandidateIdentity(c);
    let shadowReason;
    if (identity && fireableIdentities.has(identity)) {
      shadowReason = SHADOW_REASONS.NOT_SELECTED;
    } else if (c.decisionOutcomeStatus && c.decisionOutcomeStatus !== 'PLAY') {
      shadowReason = SHADOW_REASONS.NON_PLAY_DECISION_OUTCOME;
    } else if (c.edgeSourceTag !== 'MODEL') {
      shadowReason = SHADOW_REASONS.NON_MODEL_SOURCE;
    } else if (hasEdgeFormulaMismatch(c)) {
      shadowReason = SHADOW_REASONS.EDGE_FORMULA_MISMATCH;
    } else if (c.edgePct <= noiseFloor) {
      shadowReason = SHADOW_REASONS.BELOW_OFFICIAL_EDGE_FLOOR;
    } else {
      shadowReason = SHADOW_REASONS.BELOW_SCORE_GATE;
    }
    return { ...c, _shadowReason: shadowReason };
  });

  const fireableNominees = selectTopPlaysFn(bestEdgeSelectorPool, {
    minConfidence: POTD_MIN_TOTAL_SCORE,
    minEdgePct: 0,
    maxNominees: POTD_MAX_NOMINEES,
    requirePositiveEdge: true,
  });

  // diagnosticNominees are for no-pick diagnostics only and remain model-backed.
  const diagnosticNominees = selectTopPlaysFn(bestEdgeSelectorPool, {
    minConfidence: POTD_MIN_TOTAL_SCORE,
    minEdgePct: 0,
    maxNominees: POTD_MAX_NOMINEES,
    requirePositiveEdge: true,
  });
  // rankedNominees = only fireable (positive-edge, above threshold) candidates.
  // When fireableNominees is empty, rankedNominees is empty — POTD must return NO_PICK.
  const rankedNominees = fireableNominees;

  return {
    bestCandidate: fireableNominees[0] || null,
    rankedNominees,
    diagnosticNominees, // non-play diagnostics — labeled non-play, never nominated
    shadowCandidatePool,
    allScoredCandidates: playDateScopedCandidates,
    fetchErrors,
    activeSports: sports,
    modelHealthState,
    candidatesCount: playDateScopedCandidates.length,
    viableCount: fireableSelectorPool.length,
  };
}

async function runPotdEngine({
  jobKey = null,
  dryRun = false,
  force = false,
  schedule = null,
  fetchOddsFn = fetchOdds,
  buildCandidatesFn = buildCandidates,
  scoreCandidateFn = scoreCandidate,
  selectTopPlaysFn = selectTopPlays,
  kellySizeFn = kellySize,
  sendDiscordMessagesFn = sendDiscordMessages,
  nowFn = () => DateTime.now().setZone(DEFAULT_TIMEZONE),
} = {}) {
  const nowEt = nowFn();

  // Enforce publish window: 12:00 PM – 4:00 PM ET
  // Pass force=true to override (manual testing / backfill only)
  if (!force && (nowEt.hour < PUBLISH_WINDOW_START_HOUR || nowEt.hour >= PUBLISH_WINDOW_END_HOUR)) {
    const skippedRunId = `job-potd-${nowEt.toISODate()}-${uuidV4().slice(0, 8)}`;
    emitPotdHeartbeat(skippedRunId, nowEt, 0, 0, 'SKIPPED');
    return {
      success: true,
      skipped: true,
      reason: 'outside_publish_window',
      currentEt: nowEt.toFormat('HH:mm'),
      window: `${PUBLISH_WINDOW_START_HOUR}:00–${PUBLISH_WINDOW_END_HOUR}:00 ET`,
    };
  }

  const nowIso = nowEt.toUTC().toISO();
  const playDate = nowEt.toISODate();
  const { playId, cardId, playLedgerId } = buildPotdIds(playDate);
  const jobRunId = `job-potd-${playDate}-${uuidV4().slice(0, 8)}`;
  const webhookUrl = String(process.env.DISCORD_POTD_WEBHOOK_URL || '').trim();
  const alertWebhookUrl = String(process.env.DISCORD_ALERT_WEBHOOK_URL || '').trim();

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      emitPotdHeartbeat(jobRunId, nowEt, 0, 0, 'SKIPPED');
      return { success: true, skipped: true, jobKey };
    }

    if (dryRun) {
      emitPotdHeartbeat(jobRunId, nowEt, 0, 0, 'SKIPPED');
      return { success: true, dryRun: true, jobKey, schedule };
    }

    insertJobRun(JOB_NAME, jobRunId, jobKey);

    try {
      const db = getDatabase();
      const existingPlay = db
        .prepare(`SELECT * FROM potd_plays WHERE play_date = ? LIMIT 1`)
        .get(playDate);
      if (existingPlay) {
        markJobRunSuccess(jobRunId, { already_published: true, play_date: playDate });
        emitPotdHeartbeat(jobRunId, nowEt, 0, 0, POTD_TIMING_STATES.OFFICIAL_PLAY, existingPlay.selection_label || 'existing');
        return {
          success: true,
          jobRunId,
          alreadyPublished: true,
          playDate,
        };
      }

      const {
        bestCandidate,
        rankedNominees,
        diagnosticNominees,
        shadowCandidatePool,
        allScoredCandidates,
        fetchErrors,
        activeSports,
        modelHealthState,
        candidatesCount,
        viableCount,
      } = await gatherBestCandidate({
        fetchOddsFn,
        buildCandidatesFn,
        scoreCandidateFn,
        selectTopPlaysFn,
        playDate,
        db,
      });

      const bankrollState = ensureInitialBankroll(db, {
        playDate,
        nowIso,
        startingBankroll: DEFAULT_BANKROLL,
      });
      const bankrollAtPost = bankrollState.bankroll;

      if (!bestCandidate) {
        const noPickReason = modelHealthState?.isStale ? 'model_health_stale' : 'no_viable_candidates';
        const topByEdge = allScoredCandidates
          .filter(c => isModelBackedCandidate(c))
          .filter(c => typeof c.edgePct === 'number' && isFinite(c.edgePct) && typeof c.totalScore === 'number' && isFinite(c.totalScore))
          .sort((a, b) => b.edgePct - a.edgePct)[0] || null;
        const nearMissCandidates = selectNearMissShadowCandidates({
          winnerStatus: 'NO_PICK',
          candidatePool: shadowCandidatePool,
          winnerCandidate: null,
        });
        writeShadowCandidates(db, {
          playDate,
          capturedAt: nowIso,
          minEdgePct: POTD_MIN_EDGE,
          candidates: nearMissCandidates,
        });
        writeNominees(db, {
          playDate,
          capturedAt: nowIso,
          winnerStatus: 'NO_PICK',
          nominees: diagnosticNominees,
        });
        writeDailyStats(db, {
          playDate,
          potdFired: false,
          candidateCount: candidatesCount,
          viableCount,
          topEdgePct: topByEdge ? topByEdge.edgePct : null,
          topScore: topByEdge ? topByEdge.totalScore : null,
          selectedEdgePct: null,
          selectedScore: null,
          stakePctOfBankroll: null,
        });
        markJobRunSuccess(jobRunId, {
          no_play: true,
          reason: noPickReason,
          model_health_stale: Boolean(modelHealthState?.isStale),
          model_health_latest_run_at: modelHealthState?.latestRunAt ?? null,
          model_health_snapshot_age_minutes: modelHealthState?.snapshotAgeMinutes ?? null,
          play_date: playDate,
          active_sports: activeSports.join(','),
          fetch_errors: fetchErrors.length,
        });
        const timingStateNoPick = resolvePotdTimingState(nowEt, false);
        emitPotdHeartbeat(jobRunId, nowEt, candidatesCount, viableCount, timingStateNoPick);
        if (timingStateNoPick === POTD_TIMING_STATES.NO_PICK_FINAL) {
          const alertMsg = buildNopickAlertMessage({
            alertCandidate: topByEdge,
            topByEdge,
            reason: noPickReason,
            candidatesCount,
            viableCount,
            nowEt,
            nearMissCandidates,
          });
          await sendPotdNopickAlertOncePerDay({
            db,
            playDate,
            runId: jobRunId,
            sendDiscordMessagesFn,
            webhookUrl: alertWebhookUrl,
            message: alertMsg,
          });
        }
        return {
          success: true,
          jobRunId,
          noPlay: true,
          reason: noPickReason,
          playDate,
          fetchErrors,
        };
      }

      // Continuity guard (WI-0906): reject fragile-confidence picks even if a
      // caller injects a permissive selector. This keeps stake sizing aligned
      // with the documented HIGH/ELITE confidence policy for surfaced POTD plays.
      const minHighConfidenceScore = confidenceThreshold('HIGH');
      const bestScore = Number(bestCandidate.totalScore);
      const bestLabel = String(bestCandidate.confidenceLabel || '').toUpperCase();
      const lowConfidenceCandidate =
        !Number.isFinite(bestScore) ||
        bestScore < minHighConfidenceScore ||
        bestLabel === 'LOW';

      if (lowConfidenceCandidate) {
        const nearMissCandidates = selectNearMissShadowCandidates({
          winnerStatus: 'NO_PICK',
          candidatePool: shadowCandidatePool,
          winnerCandidate: null,
        });
        writeShadowCandidates(db, {
          playDate,
          capturedAt: nowIso,
          minEdgePct: POTD_MIN_EDGE,
          candidates: nearMissCandidates,
        });
        writeNominees(db, { playDate, capturedAt: nowIso, winnerStatus: 'NO_PICK', nominees: rankedNominees });
        writeDailyStats(db, {
          playDate,
          potdFired: false,
          candidateCount: candidatesCount,
          viableCount,
          topEdgePct: bestCandidate.edgePct ?? null,
          topScore: Number.isFinite(bestScore) ? bestScore : null,
          selectedEdgePct: null,
          selectedScore: null,
          stakePctOfBankroll: null,
        });
        markJobRunSuccess(jobRunId, {
          no_play: true,
          reason: 'confidence_below_high_gate',
          confidence_label: bestCandidate.confidenceLabel ?? null,
          total_score: Number.isFinite(bestScore) ? bestScore : null,
          min_total_score: minHighConfidenceScore,
          play_date: playDate,
        });
        const timingStateLowConf = resolvePotdTimingState(nowEt, false);
        emitPotdHeartbeat(jobRunId, nowEt, candidatesCount, viableCount, timingStateLowConf);
        if (timingStateLowConf === POTD_TIMING_STATES.NO_PICK_FINAL) {
          const alertMsg = buildNopickAlertMessage({
            alertCandidate: bestCandidate,
            topByEdge: bestCandidate,
            reason: 'confidence_below_high_gate',
            candidatesCount,
            viableCount,
            nowEt,
            nearMissCandidates,
          });
          await sendPotdNopickAlertOncePerDay({
            db,
            playDate,
            runId: jobRunId,
            sendDiscordMessagesFn,
            webhookUrl: alertWebhookUrl,
            message: alertMsg,
          });
        }
        return {
          success: true,
          jobRunId,
          noPlay: true,
          reason: 'confidence_below_high_gate',
          playDate,
        };
      }

      const rawWager = kellySizeFn({
        edgePct: bestCandidate.edgePct,
        impliedProb: bestCandidate.impliedProb,
        bankroll: bankrollAtPost,
        kellyFraction: DEFAULT_KELLY_FRACTION,
        maxWagerPct: DEFAULT_MAX_WAGER_PCT,
      });

      if (!Number.isFinite(rawWager) || rawWager <= 0) {
        const nearMissCandidates = selectNearMissShadowCandidates({
          winnerStatus: 'NO_PICK',
          candidatePool: shadowCandidatePool,
          winnerCandidate: null,
        });
        writeShadowCandidates(db, {
          playDate,
          capturedAt: nowIso,
          minEdgePct: POTD_MIN_EDGE,
          candidates: nearMissCandidates,
        });
        writeNominees(db, { playDate, capturedAt: nowIso, winnerStatus: 'NO_PICK', nominees: rankedNominees });
        writeDailyStats(db, {
          playDate,
          potdFired: false,
          candidateCount: candidatesCount,
          viableCount,
          topEdgePct: bestCandidate.edgePct ?? null,
          topScore: bestCandidate.totalScore ?? null,
          selectedEdgePct: null,
          selectedScore: null,
          stakePctOfBankroll: null,
        });
        markJobRunSuccess(jobRunId, {
          no_play: true,
          reason: 'zero_wager',
          play_date: playDate,
        });
        const timingStateZeroWager = resolvePotdTimingState(nowEt, false);
        emitPotdHeartbeat(jobRunId, nowEt, candidatesCount, viableCount, timingStateZeroWager);
        if (timingStateZeroWager === POTD_TIMING_STATES.NO_PICK_FINAL) {
          const alertMsg = buildNopickAlertMessage({
            alertCandidate: bestCandidate,
            topByEdge: bestCandidate,
            reason: 'zero_wager',
            candidatesCount,
            viableCount,
            nowEt,
            nearMissCandidates,
          });
          await sendPotdNopickAlertOncePerDay({
            db,
            playDate,
            runId: jobRunId,
            sendDiscordMessagesFn,
            webhookUrl: alertWebhookUrl,
            message: alertMsg,
          });
        }
        return {
          success: true,
          jobRunId,
          noPlay: true,
          reason: 'zero_wager',
          playDate,
        };
      }

      // Minimum-stake gate: if Kelly says bet less than 0.5 % of bankroll the
      // play is not worth featuring — reject rather than post dust.
      if (rawWager / bankrollAtPost < POTD_MIN_STAKE_PCT) {
        const nearMissCandidates = selectNearMissShadowCandidates({
          winnerStatus: 'NO_PICK',
          candidatePool: shadowCandidatePool,
          winnerCandidate: null,
        });
        writeShadowCandidates(db, {
          playDate,
          capturedAt: nowIso,
          minEdgePct: POTD_MIN_EDGE,
          candidates: nearMissCandidates,
        });
        writeNominees(db, { playDate, capturedAt: nowIso, winnerStatus: 'NO_PICK', nominees: rankedNominees });
        writeDailyStats(db, {
          playDate,
          potdFired: false,
          candidateCount: candidatesCount,
          viableCount,
          topEdgePct: bestCandidate.edgePct ?? null,
          topScore: bestCandidate.totalScore ?? null,
          selectedEdgePct: null,
          selectedScore: null,
          stakePctOfBankroll: null,
        });
        markJobRunSuccess(jobRunId, {
          no_play: true,
          reason: 'stake_below_minimum',
          edge_pct: bestCandidate.edgePct,
          raw_wager: rawWager,
          bankroll: bankrollAtPost,
          min_stake_pct: POTD_MIN_STAKE_PCT,
          play_date: playDate,
        });
        const timingStateStake = resolvePotdTimingState(nowEt, false);
        emitPotdHeartbeat(jobRunId, nowEt, candidatesCount, viableCount, timingStateStake);
        if (timingStateStake === POTD_TIMING_STATES.NO_PICK_FINAL) {
          const alertMsg = buildNopickAlertMessage({
            alertCandidate: bestCandidate,
            topByEdge: bestCandidate,
            reason: 'min_stake_rejected',
            candidatesCount,
            viableCount,
            nowEt,
            nearMissCandidates,
          });
          await sendPotdNopickAlertOncePerDay({
            db,
            playDate,
            runId: jobRunId,
            sendDiscordMessagesFn,
            webhookUrl: alertWebhookUrl,
            message: alertMsg,
          });
        }
        return {
          success: true,
          jobRunId,
          noPlay: true,
          reason: 'stake_below_minimum',
          playDate,
        };
      }

      // Apply confidence multiplier AFTER Kelly cap (cap lives inside kellySize),
      // then round to nearest $0.50 for clean UX.
      const adjustedWager = Math.round(rawWager * confidenceMultiplier(bestCandidate.confidenceLabel) * 100) / 100;
      const wagerAmount = Math.round(adjustedWager * 2) / 2;

      const playRow = buildPotdPlayRow(bestCandidate, {
        playId,
        cardId,
        playDate,
        nowIso,
        wagerAmount,
        bankrollAtPost,
        kellyFraction: DEFAULT_KELLY_FRACTION,
        confidenceMultiplier: confidenceMultiplier(bestCandidate.confidenceLabel),
      });

      const transaction = db.transaction(() => {
        upsertGame({
          id: `game-${String(bestCandidate.sport || '').toLowerCase()}-${bestCandidate.gameId}`,
          gameId: bestCandidate.gameId,
          sport: bestCandidate.sport,
          homeTeam: bestCandidate.home_team,
          awayTeam: bestCandidate.away_team,
          gameTimeUtc: bestCandidate.commence_time,
          status: 'scheduled',
        });

        db.prepare(
          `INSERT INTO potd_plays (
            id, play_date, game_id, card_id, sport, home_team, away_team,
            market_type, selection, selection_label, line, price, confidence_label,
            total_score, model_win_prob, implied_prob, edge_pct, score_breakdown,
            wager_amount, bankroll_at_post, kelly_fraction, confidence_multiplier,
            game_time_utc, posted_at, reasoning
          ) VALUES (
            @id, @play_date, @game_id, @card_id, @sport, @home_team, @away_team,
            @market_type, @selection, @selection_label, @line, @price, @confidence_label,
            @total_score, @model_win_prob, @implied_prob, @edge_pct, @score_breakdown,
            @wager_amount, @bankroll_at_post, @kelly_fraction, @confidence_multiplier,
            @game_time_utc, @posted_at, @reasoning
          )`,
        ).run(playRow);

        db.prepare(
          `INSERT INTO potd_bankroll (
            id, event_date, event_type, play_id, card_id,
            amount_before, amount_change, amount_after, notes, created_at
          ) VALUES (?, ?, 'play_posted', ?, ?, ?, 0, ?, ?, ?)`,
        ).run(
          playLedgerId,
          playDate,
          playId,
          cardId,
          bankrollAtPost,
          bankrollAtPost,
          `Posted ${bestCandidate.selectionLabel}`,
          nowIso,
        );

        insertCardPayload(buildPotdCard(bestCandidate, playRow, { cardId, nowIso }));
      });

      transaction();

      writeNominees(db, { playDate, capturedAt: nowIso, winnerStatus: 'FIRED', nominees: rankedNominees });
      writeShadowCandidates(db, {
        playDate,
        capturedAt: nowIso,
        minEdgePct: POTD_MIN_EDGE,
        candidates: selectNearMissShadowCandidates({
          winnerStatus: 'FIRED',
          candidatePool: shadowCandidatePool,
          winnerCandidate: bestCandidate,
        }),
      });

      writeDailyStats(db, {
        playDate,
        potdFired: true,
        candidateCount: candidatesCount,
        viableCount,
        topEdgePct: bestCandidate.edgePct,
        topScore: bestCandidate.totalScore,
        selectedEdgePct: bestCandidate.edgePct,
        selectedScore: bestCandidate.totalScore,
        stakePctOfBankroll: wagerAmount / bankrollAtPost,
      });

      let discordPosted = false;
      let discordError = null;
      // Suppress direct post when snapshot inclusion is active — the card will appear in
      // the snapshot feed instead, preventing duplicate Discord messages.
      const snapshotIncludeActive =
        process.env.DISCORD_INCLUDE_POTD_IN_SNAPSHOT === 'true' && Boolean(webhookUrl);
      if (webhookUrl && !snapshotIncludeActive) {
        try {
          await sendDiscordMessagesFn({
            webhookUrl,
            messages: [formatPotdDiscordMessage(playRow, rankedNominees.slice(1))],
          });
          discordPosted = true;
          db.prepare(
            `UPDATE potd_plays
             SET discord_posted = 1, discord_posted_at = ?
             WHERE id = ?`,
          ).run(nowIso, playId);
        } catch (error) {
          discordError = error.message;
          console.warn(`[POTD] Discord publish failed: ${error.message}`);
        }
      } else if (snapshotIncludeActive) {
        console.log(`[POTD] Direct Discord post suppressed — DISCORD_INCLUDE_POTD_IN_SNAPSHOT=true; play will appear in snapshot feed`);
      }

      markJobRunSuccess(jobRunId, {
        play_date: playDate,
        card_id: cardId,
        discord_posted: discordPosted,
      });

      emitPotdHeartbeat(jobRunId, nowEt, candidatesCount, viableCount, POTD_TIMING_STATES.OFFICIAL_PLAY, bestCandidate.selectionLabel || cardId);

      return {
        success: true,
        jobRunId,
        playDate,
        cardId,
        playId,
        wagerAmount,
        bankrollAtPost,
        discordPosted,
        discordError,
        fetchErrors,
      };
    } catch (error) {
      markJobRunFailure(jobRunId, error.message);
      throw error;
    }
  });
}

if (require.main === module) {
  // Pass --force to bypass the publish-window guard (e.g. manual backfills)
  const force = process.argv.includes('--force');
  createJob(JOB_NAME, async ({ dryRun }) => runPotdEngine({ dryRun, force }));
}

module.exports = {
  runPotdEngine,
  // WI-1039-B: timing state machine exports
  POTD_TIMING_STATES,
  POTD_WINDOW_ET,
  POTD_NOPICK_REASONS,
  resolvePotdTimingState,
  sendPotdNopickAlert,
  __private: {
    buildCardPayloadData,
    buildPotdPlayRow,
    buildPotdCard,
    getActivePotdSports,
    selectNearMissShadowCandidates,
    buildCandidateAuditEntry,
    loadModelHealthState,
    loadModelHealthGates,
    hasEmptySelectionRejectionCode,
  },
};
