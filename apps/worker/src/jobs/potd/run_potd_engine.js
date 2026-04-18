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
  getLatestOdds,
  getLatestNhlModelOutput,
  insertCardPayload,
  upsertGame,
  createJob,
} = require('@cheddar-logic/data');
const { fetchOdds } = require('@cheddar-logic/odds');
const { SPORTS_CONFIG: ODDS_SPORTS_CONFIG } = require('@cheddar-logic/odds/src/config');
const {
  buildCandidates,
  confidenceMultiplier,
  confidenceThreshold,
  resolveNoiseFloor,
  scoreCandidate,
  selectBestPlay,
  selectTopPlays,
  kellySize,
} = require('./signal-engine');
const { formatPotdDiscordMessage } = require('./format-discord');
const { sendDiscordMessages } = require('../post_discord_cards');

function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

function canonicalizeShadowSelection(candidate) {
  const explicit = String(candidate?.selection || '').toUpperCase();
  if (explicit === 'HOME' || explicit === 'AWAY' || explicit === 'OVER' || explicit === 'UNDER') {
    return explicit;
  }

  const marketType = String(candidate?.marketType || '').toUpperCase();
  const selectionLabel = String(candidate?.selectionLabel || '').toUpperCase();

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

function buildShadowCandidateIdentity(candidate, canonicalSelection) {
  const sport = String(candidate?.sport || '').toUpperCase();
  const marketType = String(candidate?.marketType || '').toUpperCase();
  const gameId = String(candidate?.gameId || '').trim();
  const homeTeam = String(candidate?.home_team || '').trim();
  const awayTeam = String(candidate?.away_team || '').trim();
  const gameRef = gameId || `${homeTeam}__${awayTeam}`;
  return `${sport}|${gameRef}|${marketType}|${canonicalSelection}|${normalizeShadowLine(candidate?.line)}`;
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


function writeShadowCandidates(db, { playDate, capturedAt, minEdgePct, candidates }) {
  if (!Array.isArray(candidates) || candidates.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO potd_shadow_candidates (
      play_date, captured_at, sport, market_type, selection_label,
      home_team, away_team, game_id, price, line,
      edge_pct, total_score, line_value, market_consensus,
      model_win_prob, implied_prob, projection_source, gap_to_min_edge,
      selection, game_time_utc, candidate_identity_key
    ) VALUES (
      @play_date, @captured_at, @sport, @market_type, @selection_label,
      @home_team, @away_team, @game_id, @price, @line,
      @edge_pct, @total_score, @line_value, @market_consensus,
      @model_win_prob, @implied_prob, @projection_source, @gap_to_min_edge,
      @selection, @game_time_utc, @candidate_identity_key
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
      game_time_utc = excluded.game_time_utc
  `);
  for (const c of candidates) {
    const canonicalSelection = canonicalizeShadowSelection(c);
    if (!canonicalSelection) continue;
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
      selection: canonicalSelection,
      game_time_utc: c.commence_time ?? null,
      candidate_identity_key: buildShadowCandidateIdentity(c, canonicalSelection),
    });
  }
}
function writeNominees(db, { playDate, capturedAt, winnerStatus, nominees }) {
  db.prepare(`DELETE FROM potd_nominees WHERE play_date = ?`).run(playDate);
  if (!Array.isArray(nominees) || nominees.length === 0) return;
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
  nominees.forEach((c, i) => {
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
// Publish window: 12:00 PM – 4:00 PM ET (scheduler enforces this too, but guard here
// prevents accidental posts when the job is invoked manually outside the window)
const PUBLISH_WINDOW_START_HOUR = 12; // noon ET (inclusive)
const PUBLISH_WINDOW_END_HOUR = 16;   // 4 PM ET (exclusive)
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
// Set POTD_AUDIT_LOG_ENABLED=false to suppress per-candidate audit lines in production logs.
const POTD_AUDIT_LOG_ENABLED = process.env.POTD_AUDIT_LOG_ENABLED !== 'false';

/**
 * Emit a structured audit log entry for a scored candidate.
 * Captures the noise floor used, whether it passed, score, and rejection reason.
 * Guarded by POTD_AUDIT_LOG_ENABLED env var.
 */
function auditLogCandidate(candidate, noiseFloor) {
  if (!POTD_AUDIT_LOG_ENABLED) return;
  const edge = candidate.edgePct;
  const passesNoise = isFiniteNumber(edge) && edge > noiseFloor;
  const passesScore = isFiniteNumber(candidate.totalScore) && candidate.totalScore >= POTD_MIN_TOTAL_SCORE;
  let rejectedReason = null;
  if (!isFiniteNumber(edge)) {
    rejectedReason = 'NO_EDGE_COMPUTED';
  } else if (!passesNoise) {
    rejectedReason = `BELOW_NOISE_FLOOR:${noiseFloor}`;
  } else if (!passesScore) {
    rejectedReason = `BELOW_MIN_SCORE:${POTD_MIN_TOTAL_SCORE}`;
  }
  console.log(
    JSON.stringify({
      type: 'POTD_AUDIT',
      sport: candidate.sport ?? null,
      marketType: candidate.marketType ?? null,
      selectionLabel: candidate.selectionLabel ?? null,
      price: candidate.price ?? null,
      edgePct: isFiniteNumber(edge) ? edge : null,
      noiseFloor,
      passesNoise,
      totalScore: isFiniteNumber(candidate.totalScore) ? candidate.totalScore : null,
      passesScore,
      edgeSourceTag: candidate.edgeSourceTag ?? null,
      edgeSourceMeta: candidate.edgeSourceMeta ?? null,
      confidenceLabel: candidate.confidenceLabel ?? null,
      rejectedReason,
    }),
  );
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
  return {
    game_id: candidate.gameId,
    sport: candidate.sport,
    kind: 'PLAY',
    action: 'FIRE',
    status: 'FIRE',
    classification: 'BASE',
    decision_v2: { official_status: 'PLAY' },
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

async function gatherBestCandidate({
  fetchOddsFn,
  buildCandidatesFn,
  scoreCandidateFn,
  selectTopPlaysFn,
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
      const candidateGame =
        sport === 'MLB' && game?.gameId
          ? {
              ...game,
              oddsSnapshot: getLatestOdds(game.gameId) || null,
            }
          : sport === 'NHL' && game?.gameId
          ? {
              ...game,
              nhlSnapshot: getLatestNhlModelOutput(game.gameId) || null,
            }
          : game;
      const candidates = buildCandidatesFn(candidateGame);
      for (const candidate of candidates) {
        const scored = scoreCandidateFn(candidate);
        if (scored) scoredCandidates.push(scored);
      }
    }
  }

  // Per-candidate audit log: emit noise-floor evaluation for every scored candidate.
  for (const c of scoredCandidates) {
    auditLogCandidate(c, resolveNoiseFloor(c.sport, c.marketType, POTD_MIN_EDGE));
  }

  const viableCandidates = scoredCandidates.filter(c => {
    const noiseFloor = resolveNoiseFloor(c.sport, c.marketType, POTD_MIN_EDGE);
    return (
      isFiniteNumber(c.edgePct) &&
      c.edgePct > noiseFloor &&
      isFiniteNumber(c.totalScore) &&
      c.totalScore >= POTD_MIN_TOTAL_SCORE
    );
  });

  // Apply per-sport noise floors before ranking; pass minEdgePct: 0 so
  // selectTopPlaysFn does not re-apply a single global floor on top.
  const noisePassed = scoredCandidates.filter(c => {
    const noiseFloor = resolveNoiseFloor(c.sport, c.marketType, POTD_MIN_EDGE);
    return isFiniteNumber(c.edgePct) && c.edgePct > noiseFloor;
  });
  const fireableNominees = selectTopPlaysFn(noisePassed, {
    minConfidence: POTD_MIN_TOTAL_SCORE,
    minEdgePct: 0,
    maxNominees: POTD_MAX_NOMINEES,
    requirePositiveEdge: true,
  });
  // diagnosticNominees are for no-pick diagnostics only — they include
  // sub-threshold and negative-edge candidates and must never select a POTD.
  const diagnosticNominees = selectTopPlaysFn(scoredCandidates, {
    minConfidence: POTD_MIN_TOTAL_SCORE,
    maxNominees: POTD_MAX_NOMINEES,
    requirePositiveEdge: false,
  });
  // rankedNominees = only fireable (positive-edge, above threshold) candidates.
  // When fireableNominees is empty, rankedNominees is empty — POTD must return NO_PICK.
  const rankedNominees = fireableNominees;

  return {
    bestCandidate: fireableNominees[0] || null,
    rankedNominees,
    diagnosticNominees, // non-play diagnostics — labeled non-play, never nominated
    allScoredCandidates: scoredCandidates,
    fetchErrors,
    activeSports: sports,
    candidatesCount: scoredCandidates.length,
    viableCount: viableCandidates.length,
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

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      return { success: true, skipped: true, jobKey };
    }

    if (dryRun) {
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
        allScoredCandidates,
        fetchErrors,
        activeSports,
        candidatesCount,
        viableCount,
      } = await gatherBestCandidate({
        fetchOddsFn,
        buildCandidatesFn,
        scoreCandidateFn,
        selectTopPlaysFn,
      });

      const bankrollState = ensureInitialBankroll(db, {
        playDate,
        nowIso,
        startingBankroll: DEFAULT_BANKROLL,
      });
      const bankrollAtPost = bankrollState.bankroll;

      if (!bestCandidate) {
        const topByEdge = allScoredCandidates
          .filter(c => typeof c.edgePct === 'number' && isFinite(c.edgePct) && typeof c.totalScore === 'number' && isFinite(c.totalScore))
          .sort((a, b) => b.edgePct - a.edgePct)[0] || null;
        writeShadowCandidates(db, { playDate, capturedAt: nowIso, minEdgePct: POTD_MIN_EDGE, candidates: allScoredCandidates });
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
          play_date: playDate,
          active_sports: activeSports.join(','),
          fetch_errors: fetchErrors.length,
        });
        return {
          success: true,
          jobRunId,
          noPlay: true,
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
        writeShadowCandidates(db, { playDate, capturedAt: nowIso, minEdgePct: POTD_MIN_EDGE, candidates: allScoredCandidates });
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
        writeShadowCandidates(db, { playDate, capturedAt: nowIso, minEdgePct: POTD_MIN_EDGE, candidates: allScoredCandidates });
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
        writeShadowCandidates(db, { playDate, capturedAt: nowIso, minEdgePct: POTD_MIN_EDGE, candidates: allScoredCandidates });
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
      writeShadowCandidates(db, { playDate, capturedAt: nowIso, minEdgePct: POTD_MIN_EDGE, candidates: allScoredCandidates });

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
      if (webhookUrl) {
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
      }

      markJobRunSuccess(jobRunId, {
        play_date: playDate,
        card_id: cardId,
        discord_posted: discordPosted,
      });

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
  __private: {
    buildCardPayloadData,
    buildPotdPlayRow,
    buildPotdCard,
    getActivePotdSports,
  },
};
