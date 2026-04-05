/**
 * NHL Player Shots Model Runner Job
 *
 * Reads player shot logs from DB, runs nhl-player-shots model,
 * and generates PROP card payloads for shots on goal markets.
 *
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  setCurrentRunId,
  insertCardPayload,
  validateCardPayload,
  withDb,
  getPlayerPropLine,
} = require('@cheddar-logic/data');
const {
  calcMu,
  calcMu1p,
  classifyEdge,
  calcFairLine,
  calcFairLine1p,
  projectSogV2,
  projectBlkV1,
} = require('../models/nhl-player-shots');
const { fetchMoneyPuckSnapshot } = require('../moneypuck');
const { applyNhlDecisionBasisMeta } = require('../utils/nhl-shots-patch');

const JOB_NAME = 'run-nhl-player-shots-model';

// WI-0578: Conservative league-average PP shot rate (shots/60) used as fallback
// when NST PP rate data is missing (PP_RATE_MISSING) but the player has non-zero ppToi.
// Prevents pp_component silently collapsing to 0 for top PP players.
// Value ~3.0 is ~25th-percentile among PP-eligible players (conservative, not inflated).
const PP_RATE_LEAGUE_AVG_PER60 = 3.0;
const EVENT_PRICING_DISABLED = true;

/**
 * WI-0529: Compute three-state display decision for prop cards.
 * PROJECTION_ONLY: anomaly flagged or no odds price (no actionable signal).
 * PLAY:           clean projection + positive opportunity score.
 * WATCH:          clean projection + zero or negative opportunity score.
 */
function computePropDisplayState(v2AnomalyDetected, v2OpportunityScore) {
  if (v2AnomalyDetected || v2OpportunityScore == null) return 'PROJECTION_ONLY';
  if (v2OpportunityScore > 0) return 'PLAY';
  return 'WATCH';
}

function computePropDisplayStateFromVerdict(verdict) {
  if (verdict === 'PLAY') return 'PLAY';
  if (verdict === 'WATCH') return 'WATCH';
  return 'PROJECTION_ONLY';
}

function americanToImplied(americanOdds) {
  if (!Number.isFinite(americanOdds) || americanOdds === 0) return null;
  if (americanOdds > 0) {
    return 100 / (americanOdds + 100);
  }
  return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
}

const PROP_PROJECTION_FLAGS = new Set([
  'PROJECTION_ANOMALY',
  'SYNTHETIC_LINE',
  'MISSING_PRICE',
]);

const PROP_WARNING_FLAGS = new Set([
  'LOW_SAMPLE',
  'ROLE_IN_FLUX',
  'PP_RATE_MISSING',
  'PP_SMALL_SAMPLE',
  'PP_MATCHUP_MISSING',
  'PP_CONTRIBUTION_CAPPED',
]);
const PROP_PROJECTION_CONFLICT_FLAG = 'PROJECTION_CONFLICT';

function roundMetric(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatSignedPercent(probabilityEdge) {
  if (!Number.isFinite(probabilityEdge)) return '0.0%';
  const percent = probabilityEdge * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

function formatSignedEv(ev) {
  if (!Number.isFinite(ev)) return '0.00';
  return `${ev >= 0 ? '+' : ''}${ev.toFixed(2)}`;
}

function computePropTrendLabel(l5Mean, projection) {
  if (!Number.isFinite(l5Mean) || !Number.isFinite(projection)) return null;
  const delta = projection - l5Mean;
  if (delta >= 0.3) return 'uptrend';
  if (delta <= -0.3) return 'downtrend';
  return 'stable';
}

function getThresholdTarget(line) {
  if (!Number.isFinite(line)) return null;
  return Math.ceil(line);
}

function resolveProjectedLeanSide({
  projection,
  marketLine,
}) {
  if (Number.isFinite(projection) && Number.isFinite(marketLine)) {
    return projection >= getThresholdTarget(marketLine) ? 'OVER' : 'UNDER';
  }

  return null;
}

function formatThresholdOutcome(leanSide, marketLine) {
  const target = getThresholdTarget(marketLine);
  if (!Number.isFinite(target)) {
    return leanSide === 'UNDER' ? 'under outcome' : 'over outcome';
  }
  if (leanSide === 'UNDER') {
    return `${Math.max(target - 1, 0)} or fewer shots`;
  }
  return `${target}+ shots`;
}

function deriveLegacyActionFromVerdict(verdict) {
  if (verdict === 'PLAY') {
    return {
      action: 'FIRE',
      status: 'FIRE',
      classification: 'BASE',
      officialStatus: 'PLAY',
    };
  }
  if (verdict === 'WATCH') {
    return {
      action: 'HOLD',
      status: 'WATCH',
      classification: 'LEAN',
      officialStatus: 'LEAN',
    };
  }
  return {
    action: 'PASS',
    status: 'PASS',
    classification: 'PASS',
    officialStatus: 'PASS',
  };
}

function buildCanonicalPropDecision({
  projection,
  marketLine,
  marketPriceOver,
  marketPriceUnder,
  fairOverProb,
  fairUnderProb,
  impliedOverProb,
  impliedUnderProb,
  edgeOverPp,
  edgeUnderPp,
  evOver,
  evUnder,
  opportunityScore,
  confidence,
  roleStability,
  l5Mean,
  flags,
  usingRealLine,
}) {
  const normalizedFlags = Array.from(
    new Set((Array.isArray(flags) ? flags : []).map((flag) => String(flag))),
  );
  const projectionFlag = normalizedFlags.find((flag) =>
    PROP_PROJECTION_FLAGS.has(flag),
  );
  const warningFlags = normalizedFlags.filter((flag) =>
    PROP_WARNING_FLAGS.has(flag),
  );

  const overCandidate = {
    lean_side: 'OVER',
    display_price: Number.isFinite(marketPriceOver) ? marketPriceOver : null,
    fair_prob: Number.isFinite(fairOverProb) ? fairOverProb : null,
    implied_prob: Number.isFinite(impliedOverProb) ? impliedOverProb : null,
    prob_edge_pp: Number.isFinite(edgeOverPp) ? edgeOverPp : null,
    ev: Number.isFinite(evOver) ? evOver : null,
    line_delta:
      Number.isFinite(projection) && Number.isFinite(marketLine)
        ? projection - marketLine
        : null,
  };
  const underCandidate = {
    lean_side: 'UNDER',
    display_price: Number.isFinite(marketPriceUnder) ? marketPriceUnder : null,
    fair_prob: Number.isFinite(fairUnderProb) ? fairUnderProb : null,
    implied_prob: Number.isFinite(impliedUnderProb) ? impliedUnderProb : null,
    prob_edge_pp: Number.isFinite(edgeUnderPp) ? edgeUnderPp : null,
    ev: Number.isFinite(evUnder) ? evUnder : null,
    line_delta:
      Number.isFinite(projection) && Number.isFinite(marketLine)
        ? marketLine - projection
        : null,
  };

  const betterPricedCandidate =
    (overCandidate.prob_edge_pp ?? Number.NEGATIVE_INFINITY) >=
    (underCandidate.prob_edge_pp ?? Number.NEGATIVE_INFINITY)
      ? overCandidate
      : underCandidate;

  const fallbackLeanSide =
    Number.isFinite(projection) && Number.isFinite(marketLine)
      ? projection >= marketLine
        ? 'OVER'
        : 'UNDER'
      : null;
  const fallbackCandidate =
    fallbackLeanSide === 'UNDER' ? underCandidate : overCandidate;
  const projectedCandidate =
    fallbackLeanSide === 'UNDER' ? underCandidate : overCandidate;

  const usePricedLean =
    Number.isFinite(betterPricedCandidate.prob_edge_pp) &&
    betterPricedCandidate.prob_edge_pp >= 0.02;
  const pricedSelected = usePricedLean ? betterPricedCandidate : fallbackCandidate;

  const hasRealMarket =
    usingRealLine &&
    Number.isFinite(marketLine) &&
    Number.isFinite(marketPriceOver) &&
    Number.isFinite(marketPriceUnder);

  const projectionBlocked =
    !hasRealMarket || Boolean(projectionFlag);
  const projectedLeanSide = resolveProjectedLeanSide({
    projection,
    marketLine,
  });
  const projectionConflict =
    !projectionBlocked &&
    projectedLeanSide !== null &&
    pricedSelected.lean_side !== projectedLeanSide;
  const selected = projectionConflict ? projectedCandidate : pricedSelected;
  const selectedFlags = projectionConflict
    ? Array.from(new Set([...normalizedFlags, PROP_PROJECTION_CONFLICT_FLAG]))
    : normalizedFlags;
  const lineDeltaAbs = Math.abs(selected.line_delta ?? 0);
  const probEdge = selected.prob_edge_pp;
  const ev = selected.ev;
  let verdict = 'NO_PLAY';

  if (projectionBlocked) {
    verdict = 'PROJECTION';
  } else if (
    Number.isFinite(probEdge) &&
    probEdge >= 0.06 &&
    Number.isFinite(ev) &&
    ev >= 0.05 &&
    lineDeltaAbs >= 0.5 &&
    roleStability !== 'LOW' &&
    Number.isFinite(confidence) &&
    confidence >= 0.6 &&
    warningFlags.length === 0
  ) {
    verdict = 'PLAY';
  } else if (
    Number.isFinite(probEdge) &&
    probEdge >= 0.02 &&
    Number.isFinite(ev) &&
    ev >= -0.01 &&
    (lineDeltaAbs >= 0.25 ||
      (Number.isFinite(opportunityScore) && opportunityScore > 0) ||
      (Number.isFinite(ev) && ev >= 0 && probEdge > 0))
  ) {
    verdict = 'WATCH';
  }

  let why = 'Market already efficient at current price';
  const selectedOutcome = formatThresholdOutcome(selected.lean_side, marketLine);
  if (verdict === 'PROJECTION') {
    why =
      projectionFlag === 'PROJECTION_ANOMALY'
        ? 'Projection anomaly — do not price'
        : 'Projection only — no bettable market';
  } else if (projectionConflict) {
    const blockedOutcome = formatThresholdOutcome(pricedSelected.lean_side, marketLine);
    why = `Projection supports ${selectedOutcome}, so ${blockedOutcome} is ignored as a projection conflict`;
  } else if (verdict === 'PLAY') {
    why = `Projection supports ${selectedOutcome}, and pricing clears the play threshold`;
  } else if (verdict === 'WATCH') {
    why =
      warningFlags.length > 0
        ? `Projection supports ${selectedOutcome}, but flagged data keeps this at WATCH`
        : `Projection supports ${selectedOutcome}, but price is not strong enough`;
  }

  return {
    verdict,
    lean_side: selected.lean_side,
    line: Number.isFinite(marketLine) ? marketLine : null,
    display_price: selected.display_price,
    projection: Number.isFinite(projection) ? projection : null,
    line_delta: roundMetric(selected.line_delta, 3),
    fair_prob: roundMetric(selected.fair_prob, 4),
    implied_prob: roundMetric(selected.implied_prob, 4),
    prob_edge_pp: roundMetric(selected.prob_edge_pp, 4),
    ev: roundMetric(selected.ev, 4),
    l5_mean: Number.isFinite(l5Mean) ? roundMetric(l5Mean, 3) : null,
    l5_trend: computePropTrendLabel(l5Mean, projection),
    why,
    flags: selectedFlags,
  };
}

function buildV2PricingState(v2Projection, v2AnomalyDetected) {
  return {
    edgeOverPp:
      v2AnomalyDetected
        ? null
        : (v2Projection.edge_over_pp != null
          ? Math.round(v2Projection.edge_over_pp * 10000) / 10000
          : null),
    edgeUnderPp:
      v2AnomalyDetected
        ? null
        : (v2Projection.edge_under_pp != null
          ? Math.round(v2Projection.edge_under_pp * 10000) / 10000
          : null),
    evOver:
      v2AnomalyDetected
        ? null
        : (v2Projection.ev_over != null
          ? Math.round(v2Projection.ev_over * 10000) / 10000
          : null),
    evUnder:
      v2AnomalyDetected
        ? null
        : (v2Projection.ev_under != null
          ? Math.round(v2Projection.ev_under * 10000) / 10000
          : null),
    opportunityScore: v2AnomalyDetected ? null : (v2Projection.opportunity_score ?? null),
    impliedOverProb: v2AnomalyDetected ? null : (v2Projection.implied_over_prob ?? null),
    impliedUnderProb: v2AnomalyDetected ? null : (v2Projection.implied_under_prob ?? null),
  };
}

function attachRunId(card, runId) {
  if (!card) return;
  card.runId = runId;
  if (card.payloadData && typeof card.payloadData === 'object') {
    if (!card.payloadData.run_id) {
      card.payloadData.run_id = runId;
    }
  }
}

// Gap 2: Complete 32-team NHL abbreviation map.
// If a player's team_abbrev is not found here, a startup warning is logged.
const TEAM_ABBREV_TO_NAME = {
  ANA: 'Anaheim Ducks',
  BOS: 'Boston Bruins',
  BUF: 'Buffalo Sabres',
  CGY: 'Calgary Flames',
  CAR: 'Carolina Hurricanes',
  CHI: 'Chicago Blackhawks',
  COL: 'Colorado Avalanche',
  CBJ: 'Columbus Blue Jackets',
  DAL: 'Dallas Stars',
  DET: 'Detroit Red Wings',
  EDM: 'Edmonton Oilers',
  FLA: 'Florida Panthers',
  LAK: 'Los Angeles Kings',
  MIN: 'Minnesota Wild',
  MTL: 'Montreal Canadiens',
  NSH: 'Nashville Predators',
  NJD: 'New Jersey Devils',
  NYI: 'New York Islanders',
  NYR: 'New York Rangers',
  OTT: 'Ottawa Senators',
  PHI: 'Philadelphia Flyers',
  PIT: 'Pittsburgh Penguins',
  SEA: 'Seattle Kraken',
  SJS: 'San Jose Sharks',
  STL: 'St. Louis Blues',
  TBL: 'Tampa Bay Lightning',
  TOR: 'Toronto Maple Leafs',
  UTA: 'Utah Mammoth',
  VAN: 'Vancouver Canucks',
  VGK: 'Vegas Golden Knights',
  WSH: 'Washington Capitals',
  WPG: 'Winnipeg Jets',
};
const TEAM_NAME_TO_ABBREV = Object.fromEntries(
  Object.entries(TEAM_ABBREV_TO_NAME).map(([abbrev, teamName]) => [
    teamName.toUpperCase(),
    abbrev,
  ]),
);
TEAM_NAME_TO_ABBREV['UTAH HOCKEY CLUB'] = 'UTA';

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function deriveNhlSeasonId(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const startYear = month >= 9 ? year : year - 1;
  return Number(`${startYear}${startYear + 1}`);
}

function resolveNhlSeasonKey() {
  const raw = String(
    process.env.NHL_CURRENT_SEASON ||
    process.env.NHL_SOG_SEASON_ID ||
    '',
  ).trim();
  if (/^\d{8}$/.test(raw)) {
    return raw;
  }
  return String(deriveNhlSeasonId());
}

function toFinitePositive(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function firstPositive(...values) {
  for (const value of values) {
    const numeric = toFinitePositive(value);
    if (numeric !== null) {
      return numeric;
    }
  }
  return null;
}

function computePpMatchupFactor({
  opponentPenaltiesPer60,
  opponentPkPct,
  leagueAvgPenaltiesPer60,
  leagueAvgPkPct,
}) {
  const oppPenalties = toFinitePositive(opponentPenaltiesPer60);
  const oppPk = toFinitePositive(opponentPkPct);
  const leaguePenalties = toFinitePositive(leagueAvgPenaltiesPer60);
  const leaguePk = toFinitePositive(leagueAvgPkPct);

  if (
    oppPenalties === null ||
    oppPk === null ||
    leaguePenalties === null ||
    leaguePk === null
  ) {
    return null;
  }

  const denom = 1 - leaguePk;
  const numer = 1 - oppPk;
  if (denom <= 0 || numer <= 0) return null;

  const raw =
    (oppPenalties / leaguePenalties) *
    (numer / denom);
  if (!Number.isFinite(raw) || raw <= 0) return null;

  return clamp(raw, 0.5, 1.8);
}

function computeL5Mean(l5Sog) {
  if (!Array.isArray(l5Sog) || l5Sog.length === 0) return 0;
  return l5Sog.reduce((sum, value) => sum + value, 0) / l5Sog.length;
}

function computeL5StdDev(l5Sog, mean) {
  if (!Array.isArray(l5Sog) || l5Sog.length === 0) return 0;
  const variance =
    l5Sog.reduce((sum, value) => sum + (value - mean) ** 2, 0) / l5Sog.length;
  return Math.sqrt(variance);
}

function computeConsistencyScore(l5Sog, marketLine, direction) {
  if (!Array.isArray(l5Sog) || l5Sog.length === 0) return 0.5;

  const mean = computeL5Mean(l5Sog);
  const stdDev = computeL5StdDev(l5Sog, mean);
  const variation = mean > 0 ? stdDev / mean : 1;
  const stabilityScore = 1 - clamp(variation / 1.25, 0, 1);

  let hitRate = 0.5;
  if (typeof marketLine === 'number' && marketLine > 0) {
    const hits = l5Sog.filter((shots) =>
      direction === 'UNDER' ? shots <= marketLine : shots >= marketLine,
    ).length;
    hitRate = hits / l5Sog.length;
  }

  return clamp(hitRate * 0.7 + stabilityScore * 0.3, 0, 1);
}

function computeMatchupScore(opponentFactor, direction) {
  if (typeof opponentFactor !== 'number' || !Number.isFinite(opponentFactor)) {
    return 0.5;
  }

  const boundedOpponentFactor = clamp(opponentFactor, 0.75, 1.25);
  if (direction === 'UNDER') {
    return clamp((1.15 - boundedOpponentFactor) / 0.4, 0, 1);
  }
  return clamp((boundedOpponentFactor - 0.85) / 0.4, 0, 1);
}

function computeDecisionSupport(consistencyScore, matchupScore) {
  return clamp(consistencyScore * 0.7 + matchupScore * 0.3, 0, 1);
}

function computeConfidence(consistencyScore, matchupScore, absEdge) {
  const edgeScore = clamp(absEdge / 1.4, 0, 1);
  return clamp(
    0.45 + consistencyScore * 0.3 + matchupScore * 0.15 + edgeScore * 0.1,
    0.5,
    0.92,
  );
}

function derivePlayDecision({ edgeTier, supportScore, confidence }) {
  if (
    edgeTier === 'HOT' &&
    supportScore >= 0.62 &&
    confidence >= 0.65
  ) {
    return {
      action: 'FIRE',
      status: 'FIRE',
      classification: 'BASE',
      officialStatus: 'PLAY',
    };
  }

  if (
    (edgeTier === 'HOT' || edgeTier === 'WATCH') &&
    supportScore >= 0.5 &&
    confidence >= 0.58
  ) {
    return {
      action: 'HOLD',
      status: 'WATCH',
      classification: 'LEAN',
      officialStatus: 'LEAN',
    };
  }

  return {
    action: 'PASS',
    status: 'PASS',
    classification: 'PASS',
    officialStatus: 'PASS',
  };
}

function roundToHalfLine(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 2) / 2;
}

function computeEdgePct(projection, line) {
  if (!Number.isFinite(projection) || !Number.isFinite(line) || line <= 0) {
    return null;
  }
  return Math.round(((projection - line) / line) * 1000) / 10;
}

function formatSignedEdge(edge) {
  const rounded = Math.round(edge * 10) / 10;
  return (rounded >= 0 ? '+' : '') + rounded.toFixed(1);
}

function parsePlayerIds(raw) {
  if (!raw) return [];
  const trimmed = String(raw).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((value) => Number(value)).filter(Number.isFinite);
      }
    } catch {
      return [];
    }
  }
  return trimmed
    .split(',')
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite);
}

function removeDiacritics(text) {
  if (!text || typeof text !== 'string') return '';
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizePlayerNameForLookup(name) {
  if (!name || typeof name !== 'string') return '';
  return removeDiacritics(name)
    .toLowerCase()
    .replace(/[.'\u2019-]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeUniqueFlags(...flagLists) {
  return Array.from(
    new Set(
      flagLists
        .flat()
        .filter((flag) => typeof flag === 'string' && flag.length > 0),
    ),
  );
}

function computeAverage(values) {
  const finiteValues = (Array.isArray(values) ? values : []).filter(Number.isFinite);
  if (finiteValues.length === 0) return null;
  return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
}

function computeShotsPer60FromGames(games = []) {
  const validGames = (Array.isArray(games) ? games : []).filter((game) =>
    Number.isFinite(Number(game?.toi_minutes)) && Number(game.toi_minutes) > 0,
  );
  if (validGames.length === 0) return null;

  const totalShots = validGames.reduce(
    (sum, game) => sum + Number(game?.shots || 0),
    0,
  );
  const totalToi = validGames.reduce(
    (sum, game) => sum + Number(game.toi_minutes || 0),
    0,
  );
  if (!Number.isFinite(totalShots) || !Number.isFinite(totalToi) || totalToi <= 0) {
    return null;
  }

  return (totalShots / totalToi) * 60;
}

function resolveMoneyPuckSkatersForTeam(snapshot, teamName) {
  const skatersByTeam = snapshot?.skaters?.by_team || {};
  const direct = skatersByTeam?.[teamName];
  if (direct && typeof direct === 'object') return direct;

  const normalizedTeamName =
    typeof teamName === 'string' ? teamName.trim().toLowerCase() : '';
  if (normalizedTeamName) {
    const caseInsensitiveKey = Object.keys(skatersByTeam).find(
      (key) =>
        typeof key === 'string' && key.trim().toLowerCase() === normalizedTeamName,
    );
    if (caseInsensitiveKey && skatersByTeam[caseInsensitiveKey]) {
      return skatersByTeam[caseInsensitiveKey];
    }
  }

  if (teamName === 'Utah Mammoth' && skatersByTeam['Utah Hockey Club']) {
    return skatersByTeam['Utah Hockey Club'];
  }
  if (teamName === 'Utah Hockey Club' && skatersByTeam['Utah Mammoth']) {
    return skatersByTeam['Utah Mammoth'];
  }

  return {};
}

function resolveMoneyPuckSkaterEntry(snapshot, teamName, playerName) {
  if (!snapshot || typeof playerName !== 'string' || playerName.trim().length === 0) {
    return null;
  }

  const lookupKey = normalizePlayerNameForLookup(playerName);
  if (!lookupKey) return null;
  const teamSkaters = resolveMoneyPuckSkatersForTeam(snapshot, teamName);
  return teamSkaters?.[lookupKey] || teamSkaters?.[lookupKey.replace(/\s+/g, '')] || null;
}

function buildBreakoutPayload(breakoutContext) {
  if (!breakoutContext) return null;
  return {
    baseline_toi: roundMetric(breakoutContext.baselineToi, 3),
    baseline_shots60: roundMetric(breakoutContext.baselineShots60, 3),
    baseline_sog_mu: roundMetric(breakoutContext.baselineSogMu, 3),
    tonight_toi_proj: roundMetric(breakoutContext.tonightToiProj, 3),
    adjusted_shots60: roundMetric(breakoutContext.adjustedShots60, 3),
    breakout_sog_mu: roundMetric(breakoutContext.breakoutSogMu, 3),
    delta_mu: roundMetric(breakoutContext.deltaMu, 3),
    score: breakoutContext.score,
    flags: [...breakoutContext.flags],
    eligible: breakoutContext.eligible,
  };
}

function shouldAdoptBreakoutEvaluation(baseEvaluation, breakoutEvaluation) {
  if (!baseEvaluation || !breakoutEvaluation) return false;
  if (breakoutEvaluation.propDecision?.lean_side !== 'OVER') return false;

  const baseRank = getPropVerdictRank(baseEvaluation.propDecision?.verdict);
  const breakoutRank = getPropVerdictRank(breakoutEvaluation.propDecision?.verdict);
  if (breakoutRank > baseRank) return true;
  if (breakoutRank < baseRank) return false;

  return (
    (breakoutEvaluation.propDecision?.prob_edge_pp ?? Number.NEGATIVE_INFINITY) >
    (baseEvaluation.propDecision?.prob_edge_pp ?? Number.NEGATIVE_INFINITY)
  );
}

function computeBreakoutContext({
  lookbackGames,
  baselineShots60,
  projToi,
  ppToi,
  ppMatchupFactor,
  opponentFactor,
  paceFactor,
  playerAvailabilityTier,
  usingRealLine,
  isOddsBacked,
  basePropDecision,
  baseV2Projection,
  moneyPuckSkater,
}) {
  const validLookbackGames = Array.isArray(lookbackGames) ? lookbackGames : [];
  const validToiGames = validLookbackGames.filter((game) =>
    Number.isFinite(Number(game?.toi_minutes)) && Number(game.toi_minutes) > 0,
  );
  const recentGames = validToiGames.slice(0, 3);

  const baselineToi = computeAverage(
    validToiGames.map((game) => Number(game.toi_minutes)),
  );
  const last3ToiAvg = computeAverage(
    recentGames.map((game) => Number(game.toi_minutes)),
  );
  const recentShots60 = computeShotsPer60FromGames(recentGames);
  const resolvedBaselineShots60 = Number.isFinite(baselineShots60)
    ? baselineShots60
    : computeShotsPer60FromGames(validToiGames);

  const flags = [];
  const toiTrendDelta =
    Number.isFinite(last3ToiAvg) && Number.isFinite(baselineToi)
      ? last3ToiAvg - baselineToi
      : 0;
  if (toiTrendDelta >= 1.0) flags.push('TOI_TREND_UP');
  if (toiTrendDelta >= 2.0) flags.push('TOI_TREND_STRONG');
  if (Number.isFinite(ppToi) && ppToi >= 1.8) flags.push('PP_ROLE_ELEVATED');
  if (
    Number.isFinite(recentShots60) &&
    Number.isFinite(resolvedBaselineShots60) &&
    resolvedBaselineShots60 > 0 &&
    recentShots60 >= resolvedBaselineShots60 * 1.15
  ) {
    flags.push('SHOTS60_TREND_UP');
  }

  const moneypuckImpact = Number(moneyPuckSkater?.impact);
  const moneypuckUsageFactor = Number.isFinite(moneypuckImpact)
    ? clamp(1 + ((moneypuckImpact - 1) * 0.15), 1.0, 1.03)
    : 1.0;
  const positionEnvFactor = 1.0;
  if (
    Number(opponentFactor) > 1.02 ||
    Number(paceFactor) > 1.02 ||
    moneypuckUsageFactor > 1.0
  ) {
    flags.push('ENV_BOOST');
  }

  const toiUplift = clamp(Math.max(toiTrendDelta, 0), 0, 2.5);
  const tonightToiBase = Number.isFinite(projToi) ? projToi : baselineToi;
  const tonightToiProj = Number.isFinite(tonightToiBase)
    ? tonightToiBase + toiUplift
    : null;
  const rateRatio =
    Number.isFinite(recentShots60) &&
    Number.isFinite(resolvedBaselineShots60) &&
    resolvedBaselineShots60 > 0
      ? recentShots60 / resolvedBaselineShots60
      : 1.0;
  const adjustedShots60 = Number.isFinite(resolvedBaselineShots60)
    ? resolvedBaselineShots60 * clamp(rateRatio, 1.0, 1.15)
    : null;
  const baselineSogMu =
    Number.isFinite(baselineToi) &&
    Number.isFinite(resolvedBaselineShots60)
      ? (baselineToi * resolvedBaselineShots60) / 60
      : null;

  const breakoutSogMu =
    Number.isFinite(adjustedShots60) &&
    Number.isFinite(tonightToiProj)
      ? (
        ((adjustedShots60 * tonightToiProj) / 60) +
        (((baseV2Projection?.shot_rate_pp_per60 || 0) * (ppToi || 0)) / 60 * (ppMatchupFactor || 1.0))
      ) *
        (opponentFactor || 1.0) *
        (paceFactor || 1.0) *
        moneypuckUsageFactor *
        positionEnvFactor
      : null;
  const deltaMu =
    Number.isFinite(breakoutSogMu) && Number.isFinite(baseV2Projection?.sog_mu)
      ? breakoutSogMu - baseV2Projection.sog_mu
      : null;

  const blockedAnomaly =
    Array.isArray(basePropDecision?.flags) &&
    (basePropDecision.flags.includes('PROJECTION_ANOMALY') ||
      basePropDecision.flags.includes(PROP_PROJECTION_CONFLICT_FLAG));
  const blockedRole =
    playerAvailabilityTier === 'DTD' || baseV2Projection?.role_stability === 'LOW';
  const blockedNoRealLine = !usingRealLine || !isOddsBacked;
  const breakoutLeanSide = basePropDecision?.lean_side || 'OVER';
  const eligible =
    breakoutLeanSide === 'OVER' &&
    !blockedAnomaly &&
    !blockedRole &&
    !blockedNoRealLine;

  if (blockedAnomaly) flags.push('BREAKOUT_BLOCKED_ANOMALY');
  if (blockedRole) flags.push('BREAKOUT_BLOCKED_ROLE');
  if (blockedNoRealLine) flags.push('BREAKOUT_BLOCKED_NO_REAL_LINE');

  let score = 0;
  if (flags.includes('TOI_TREND_UP')) score += 1;
  if (flags.includes('TOI_TREND_STRONG')) score += 1;
  if (flags.includes('PP_ROLE_ELEVATED')) score += 1;
  if (flags.includes('SHOTS60_TREND_UP')) score += 1;
  if (flags.includes('ENV_BOOST')) score += 1;
  if (Number.isFinite(deltaMu) && deltaMu >= 0.6) score += 1;

  const breakoutCandidate =
    eligible &&
    Number.isFinite(deltaMu) &&
    deltaMu >= 0.45 &&
    Number.isFinite(breakoutSogMu) &&
    breakoutSogMu >= 2.4;
  if (breakoutCandidate) flags.push('BREAKOUT_CANDIDATE');

  return {
    baselineToi,
    baselineShots60: resolvedBaselineShots60,
    baselineSogMu,
    last3ToiAvg,
    recentShots60,
    tonightToiProj,
    adjustedShots60,
    breakoutSogMu,
    deltaMu,
    moneypuckUsageFactor,
    positionEnvFactor,
    eligible,
    score,
    flags: mergeUniqueFlags(flags),
  };
}

function classifyMoneyPuckInjuryEntry(entry = {}) {
  const status =
    typeof entry?.status === 'string' ? entry.status.trim().toLowerCase() : '';
  const detail =
    typeof entry?.detail === 'string' ? entry.detail.trim().toLowerCase() : '';
  const combined = `${status} ${detail}`.trim();

  if (
    combined.includes('day-to-day') ||
    combined.includes('dtd') ||
    combined.includes('questionable') ||
    combined.includes('doubtful')
  ) {
    return 'DTD';
  }

  // MoneyPuck injuries list presence is treated as unavailable by default.
  return 'INJURED';
}

function buildMoneyPuckInjuryMap(rawData = {}) {
  const map = new Map();
  const injuryStatus = rawData?.injury_status || {};
  const entries = [
    ...(Array.isArray(injuryStatus.home) ? injuryStatus.home : []),
    ...(Array.isArray(injuryStatus.away) ? injuryStatus.away : []),
  ];

  for (const entry of entries) {
    const playerName =
      typeof entry?.player === 'string' ? entry.player.trim() : null;
    if (!playerName) continue;
    const lookupKey = normalizePlayerNameForLookup(playerName);
    if (!lookupKey) continue;
    map.set(lookupKey, {
      status: classifyMoneyPuckInjuryEntry(entry),
      reason: entry?.status || entry?.detail || 'moneypuck-injury-list',
    });
  }

  return map;
}

function resolveMoneyPuckInjuriesForTeam(snapshot, teamName) {
  const injuriesByTeam = snapshot?.injuries || {};
  const direct = injuriesByTeam?.[teamName];
  if (Array.isArray(direct)) return direct;

  const normalizedTeamName =
    typeof teamName === 'string' ? teamName.trim().toLowerCase() : '';
  if (normalizedTeamName) {
    const caseInsensitiveKey = Object.keys(injuriesByTeam).find(
      (key) =>
        typeof key === 'string' && key.trim().toLowerCase() === normalizedTeamName,
    );
    if (caseInsensitiveKey && Array.isArray(injuriesByTeam[caseInsensitiveKey])) {
      return injuriesByTeam[caseInsensitiveKey];
    }
  }

  if (teamName === 'Utah Mammoth' && Array.isArray(injuriesByTeam['Utah Hockey Club'])) {
    return injuriesByTeam['Utah Hockey Club'];
  }
  if (teamName === 'Utah Hockey Club' && Array.isArray(injuriesByTeam['Utah Mammoth'])) {
    return injuriesByTeam['Utah Mammoth'];
  }

  return [];
}

function buildMoneyPuckInjuryMapForGame(snapshot, homeTeam, awayTeam) {
  return buildMoneyPuckInjuryMap({
    injury_status: {
      home: resolveMoneyPuckInjuriesForTeam(snapshot, homeTeam),
      away: resolveMoneyPuckInjuriesForTeam(snapshot, awayTeam),
    },
  });
}

function resolveTeamAbbrev(teamValue) {
  if (typeof teamValue !== 'string' || teamValue.trim().length === 0) {
    return null;
  }

  const normalized = teamValue.trim().toUpperCase();
  if (TEAM_ABBREV_TO_NAME[normalized]) {
    return normalized;
  }

  return TEAM_NAME_TO_ABBREV[normalized] || null;
}

function buildPlayerNameCandidates(playerName) {
  if (typeof playerName !== 'string') return [];
  const base = playerName.trim();
  if (!base) return [];

  const noPeriods = base.replace(/\./g, '');
  const normalizedSpacing = noPeriods.replace(/\s+/g, ' ').trim();
  const noSuffix = normalizedSpacing
    .replace(/\b(JR|SR|II|III|IV)\b$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return [...new Set([base, normalizedSpacing, noSuffix].filter(Boolean))];
}

function getBookmakerPriority(bookmaker) {
  switch (String(bookmaker || '').toLowerCase()) {
    case 'draftkings':
      return 1;
    case 'fanduel':
      return 2;
    case 'betmgm':
      return 3;
    default:
      return 4;
  }
}

function normalizePropOddsPrice(rawPrice) {
  const numericPrice = Number(rawPrice);
  if (!Number.isFinite(numericPrice) || numericPrice === 0) return null;
  if (numericPrice <= -100 || numericPrice >= 100) {
    return Math.trunc(numericPrice);
  }
  if (numericPrice <= 1) return null;
  if (numericPrice >= 2) {
    return Math.round((numericPrice - 1) * 100);
  }
  return Math.round(-100 / (numericPrice - 1));
}

function queryPlayerPropLineCandidates(
  db,
  {
    sport,
    gameId,
    playerName,
    propType,
    period,
  },
) {
  const resolvedPeriod = period || 'full_game';
  const stmt = db.prepare(`
    SELECT line, over_price, under_price, bookmaker, fetched_at
    FROM player_prop_lines
    WHERE sport = ?
      AND game_id = ?
      AND LOWER(player_name) = LOWER(?)
      AND prop_type = ?
      AND period = ?
    ORDER BY
      CASE bookmaker
        WHEN 'draftkings' THEN 1
        WHEN 'fanduel' THEN 2
        WHEN 'betmgm' THEN 3
        ELSE 4
      END ASC,
      line ASC,
      datetime(fetched_at) DESC
  `);
  return stmt
    .all(sport, gameId, playerName, propType, resolvedPeriod)
    .map((row) => ({
      line: Number(row.line),
      over_price: normalizePropOddsPrice(row.over_price),
      under_price: normalizePropOddsPrice(row.under_price),
      bookmaker: row.bookmaker || null,
      fetched_at: row.fetched_at || null,
    }))
    .filter((row) => Number.isFinite(row.line));
}

function resolvePlayerPropLineCandidatesWithFallback({
  db,
  sport,
  gameId,
  playerName,
  propType,
  period,
}) {
  const candidates = buildPlayerNameCandidates(playerName);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidateName = candidates[index];
    const resolvedRows = queryPlayerPropLineCandidates(db, {
      sport,
      gameId,
      playerName: candidateName,
      propType,
      period,
    });
    if (resolvedRows.length > 0) {
      if (index > 0) {
        console.warn(
          `[${JOB_NAME}] Name-match fallback resolved ${period} line candidates for '${playerName}' via '${candidateName}'`,
        );
      }
      return resolvedRows;
    }

    const resolved = getPlayerPropLine(
      sport,
      gameId,
      candidateName,
      propType,
      period,
    );
    if (resolved) {
      if (index > 0) {
        console.warn(
          `[${JOB_NAME}] Name-match fallback resolved ${period} line for '${playerName}' via '${candidateName}'`,
        );
      }
      return [{
        line: Number(resolved.line),
        over_price: normalizePropOddsPrice(resolved.over_price),
        under_price: normalizePropOddsPrice(resolved.under_price),
        bookmaker: resolved.bookmaker || null,
        fetched_at: resolved.fetched_at || null,
      }].filter((row) => Number.isFinite(row.line));
    }
  }

  if (candidates.length > 1) {
    console.debug(
      `[${JOB_NAME}] No ${period} line for '${playerName}' after ${candidates.length} name candidates`,
    );
  }

  return [];
}

function resolvePlayerPropLineWithFallback({
  sport,
  gameId,
  playerName,
  propType,
  period,
}) {
  const candidates = buildPlayerNameCandidates(playerName);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidateName = candidates[index];
    const resolved = getPlayerPropLine(
      sport,
      gameId,
      candidateName,
      propType,
      period,
    );
    if (resolved) {
      if (index > 0) {
        console.warn(
          `[${JOB_NAME}] Name-match fallback resolved ${period} line for '${playerName}' via '${candidateName}'`,
        );
      }
      return resolved;
    }
  }

  if (candidates.length > 1) {
    console.debug(
      `[${JOB_NAME}] No ${period} line for '${playerName}' after ${candidates.length} name candidates`,
    );
  }

  return null;
}

function buildSharedPropFlags({
  ppRatePer60,
  ppToi,
  ppRateL10Per60,
  ppRateL5Per60,
  ppMatchupMissing,
  opponentFactorMissing,
  paceFactorMissing,
}) {
  const flags = [];
  if (ppRatePer60 === null && ppToi > 0) {
    flags.push('PP_RATE_MISSING');
  }
  if (ppRatePer60 !== null && ppRateL10Per60 === null && ppRateL5Per60 === null) {
    flags.push('PP_SMALL_SAMPLE');
  }
  if (ppMatchupMissing) {
    flags.push('PP_MATCHUP_MISSING');
  }
  if (opponentFactorMissing) {
    flags.push('OPPONENT_FACTOR_MISSING');
  }
  if (paceFactorMissing) {
    flags.push('PACE_FACTOR_MISSING');
  }
  return flags;
}

function getPropVerdictRank(verdict) {
  switch (verdict) {
    case 'PLAY':
      return 3;
    case 'WATCH':
      return 2;
    case 'NO_PLAY':
      return 1;
    case 'PROJECTION':
    default:
      return 0;
  }
}

function comparePropMarketEvaluations(a, b) {
  const verdictDelta =
    getPropVerdictRank(b.propDecision.verdict) -
    getPropVerdictRank(a.propDecision.verdict);
  if (verdictDelta !== 0) return verdictDelta;

  const edgeDelta =
    (b.propDecision.prob_edge_pp ?? Number.NEGATIVE_INFINITY) -
    (a.propDecision.prob_edge_pp ?? Number.NEGATIVE_INFINITY);
  if (edgeDelta !== 0) return edgeDelta;

  const lineDelta =
    Math.abs(b.propDecision.line_delta ?? 0) -
    Math.abs(a.propDecision.line_delta ?? 0);
  if (lineDelta !== 0) return lineDelta;

  const bookDelta =
    getBookmakerPriority(a.market.bookmaker) -
    getBookmakerPriority(b.market.bookmaker);
  if (bookDelta !== 0) return bookDelta;

  return Number(b.market.line ?? 0) - Number(a.market.line ?? 0);
}

function evaluatePropMarketCandidate({
  market,
  mu,
  l5Sog,
  l5Mean,
  opponentFactor,
  sharedPropFlags,
  projectionInputs,
  projectionInputOverrides = null,
}) {
  const directionSeed = classifyEdge(mu, market.line, 0.75);
  const consistencyScore = computeConsistencyScore(
    l5Sog,
    market.line,
    directionSeed.direction,
  );
  const matchupScore = computeMatchupScore(
    opponentFactor,
    directionSeed.direction,
  );
  const supportScore = computeDecisionSupport(
    consistencyScore,
    matchupScore,
  );
  const confidence = computeConfidence(
    consistencyScore,
    matchupScore,
    Math.abs(mu - market.line),
  );
  const v2Projection = projectSogV2({
    ...projectionInputs,
    ...(projectionInputOverrides || {}),
    market_line: market.line,
    market_price_over: market.over_price,
    market_price_under: market.under_price,
    play_direction: directionSeed.direction,
  });
  const v2AnomalyDetected = v2Projection.sog_mu < 0.6 * l5Mean;
  const propDecisionFlags = [
    ...(v2Projection.flags ?? []),
    ...sharedPropFlags,
    ...(v2AnomalyDetected ? ['PROJECTION_ANOMALY'] : []),
  ];
  const propDecision = buildCanonicalPropDecision({
    projection: mu,
    marketLine: market.line,
    marketPriceOver: market.over_price,
    marketPriceUnder: market.under_price,
    fairOverProb:
      v2Projection.fair_over_prob_by_line?.[String(market.line)] ?? null,
    fairUnderProb:
      v2Projection.fair_under_prob_by_line?.[String(market.line)] ?? null,
    impliedOverProb: v2AnomalyDetected ? null : (v2Projection.implied_over_prob ?? null),
    impliedUnderProb: v2AnomalyDetected ? null : (v2Projection.implied_under_prob ?? null),
    edgeOverPp:
      v2AnomalyDetected
        ? null
        : (v2Projection.edge_over_pp != null
          ? Math.round(v2Projection.edge_over_pp * 10000) / 10000
          : null),
    edgeUnderPp:
      v2AnomalyDetected
        ? null
        : (v2Projection.edge_under_pp != null
          ? Math.round(v2Projection.edge_under_pp * 10000) / 10000
          : null),
    evOver:
      v2AnomalyDetected
        ? null
        : (v2Projection.ev_over != null
          ? Math.round(v2Projection.ev_over * 10000) / 10000
          : null),
    evUnder:
      v2AnomalyDetected
        ? null
        : (v2Projection.ev_under != null
          ? Math.round(v2Projection.ev_under * 10000) / 10000
          : null),
    opportunityScore: v2AnomalyDetected ? null : (v2Projection.opportunity_score ?? null),
    confidence,
    roleStability: v2Projection.role_stability ?? 'HIGH',
    l5Mean,
    flags: propDecisionFlags,
    usingRealLine: true,
  });

  return {
    market,
    directionSeed,
    consistencyScore,
    matchupScore,
    supportScore,
    confidence,
    v2Projection,
    v2AnomalyDetected,
    propDecisionFlags,
    propDecision,
  };
}

/**
 * Gap 6: Resolve a canonical game ID by consulting the game_id_map table first,
 * then falling back to a time+team proximity match in the games table.
 *
 * @param {string} gameId     - The game ID as stored in player_shot_logs
 * @param {string} homeTeam   - Home team full name (from games table)
 * @param {string} awayTeam   - Away team full name (from games table)
 * @param {string} gameTime   - Game time UTC (ISO string)
 * @param {object} db         - better-sqlite3 Database instance
 * @returns {string}          - Canonical game ID (or original gameId on no match)
 */
function resolveCanonicalGameId(gameId, homeTeam, awayTeam, gameTime, db) {
  try {
    // Try game_id_map first (explicit mapping)
    try {
      const mapRow = db.prepare(
        'SELECT canonical_game_id FROM game_id_map WHERE espn_game_id = ? LIMIT 1',
      ).get(gameId);
      if (mapRow && mapRow.canonical_game_id) {
        return mapRow.canonical_game_id;
      }
    } catch {
      // game_id_map may not exist — proceed to fallback
    }

    // Fallback: time + team proximity match (within 15 minutes = 0.010416 julian days)
    const proximityRow = db.prepare(`
      SELECT game_id
      FROM games
      WHERE LOWER(home_team) = LOWER(?)
        AND LOWER(away_team) = LOWER(?)
        AND ABS(julianday(game_time_utc) - julianday(?)) < 0.010416
      ORDER BY game_time_utc
      LIMIT 1
    `).get(homeTeam, awayTeam, gameTime);

    if (proximityRow && proximityRow.game_id) {
      return proximityRow.game_id;
    }
  } catch {
    // Any DB error — return original to avoid crashing the job
  }

  return gameId;
}

function purgePlayerCardsForGame({ db, gameIds, playerId, playerName }) {
  const normalizedGameIds = Array.from(
    new Set(
      (Array.isArray(gameIds) ? gameIds : [gameIds]).filter(
        (value) => typeof value === 'string' && value.trim().length > 0,
      ),
    ),
  );

  const gamePlaceholders = normalizedGameIds.map(() => '?').join(', ');
  const gameFilterClause =
    normalizedGameIds.length > 0 ? `AND game_id IN (${gamePlaceholders})` : '';

  const matchSql = `
    SELECT id
    FROM card_payloads
    WHERE LOWER(sport) = 'nhl'
      ${gameFilterClause}
      AND card_type IN ('nhl-player-shots', 'nhl-player-shots-1p', 'nhl-player-blk')
      AND (
        CAST(json_extract(payload_data, '$.play.player_id') AS TEXT) = CAST(? AS TEXT)
        OR LOWER(COALESCE(json_extract(payload_data, '$.play.player_name'), '')) = LOWER(COALESCE(?, ''))
      )
  `;

  const matchRows = db
    .prepare(matchSql)
    .all(...normalizedGameIds, String(playerId), playerName || null);
  const cardIds = matchRows
    .map((row) => (row && typeof row.id === 'string' ? row.id : null))
    .filter((value) => Boolean(value));

  if (cardIds.length === 0) {
    return { changes: 0 };
  }

  const idPlaceholders = cardIds.map(() => '?').join(', ');
  const now = new Date().toISOString();

  db.prepare(`
    DELETE FROM card_results
    WHERE status = 'pending'
      AND card_id IN (${idPlaceholders})
  `).run(...cardIds);

  const deleted = db
    .prepare(`
      DELETE FROM card_payloads
      WHERE id IN (${idPlaceholders})
        AND id NOT IN (
          SELECT card_id
          FROM card_results
        )
    `)
    .run(...cardIds).changes;

  db.prepare(`
    UPDATE card_payloads
    SET expires_at = COALESCE(expires_at, ?), updated_at = ?
    WHERE id IN (${idPlaceholders})
      AND id IN (
        SELECT card_id
        FROM card_results
      )
      AND expires_at IS NULL
  `).run(now, now, ...cardIds);

  return { changes: deleted };
}

/**
 * Main entry point
 */
async function runNHLPlayerShotsModel() {
  return withDb(async () => {
    const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;
    const db = getDatabase();

    console.log(`[${JOB_NAME}] Starting job run: ${jobRunId}`);

    try {
      insertJobRun(JOB_NAME, jobRunId, null);

      // Step 1: Get active NHL games within the display window (36h from now)
      const gamesStmt = db.prepare(`
        SELECT game_id, home_team, away_team, game_time_utc, sport
        FROM games
        WHERE LOWER(sport) = 'nhl'
          AND status = 'scheduled'
          AND datetime(game_time_utc) > datetime('now')
          AND datetime(game_time_utc) < datetime('now', '+36 hours')
        ORDER BY game_time_utc ASC
      `);
      const games = gamesStmt.all();

      if (!games || games.length === 0) {
        console.log(`[${JOB_NAME}] No upcoming NHL games found`);
        markJobRunSuccess(jobRunId, { gamesProcessed: 0, cardsCreated: 0 });
        // Gap 7: setCurrentRunId called unconditionally on success path
        try {
          setCurrentRunId(jobRunId, 'nhl_props');
        } catch (runStateError) {
          console.error(
            `[${JOB_NAME}] Failed to update run state: ${runStateError.message}`,
          );
        }
        return { success: true, gamesProcessed: 0, cardsCreated: 0 };
      }

      console.log(`[${JOB_NAME}] Found ${games.length} upcoming NHL games`);

      // Step 2: Get unique players with recent data (within last 7 days)
      const uniquePlayersStmt = db.prepare(`
      SELECT DISTINCT
        player_id,
        player_name,
        json_extract(raw_data, '$.teamAbbrev') as team_abbrev
      FROM player_shot_logs
      WHERE fetched_at > datetime('now', '-7 days')
      ORDER BY player_id ASC
    `);
      const uniquePlayersRaw = uniquePlayersStmt.all();
      const uniqueBlkPlayersStmt = db.prepare(`
      SELECT DISTINCT
        player_id,
        player_name,
        json_extract(raw_data, '$.teamAbbrev') as team_abbrev
      FROM player_blk_logs
      WHERE fetched_at > datetime('now', '-7 days')
      ORDER BY player_id ASC
    `);
      const uniqueBlkPlayersRaw = uniqueBlkPlayersStmt.all();

      if (
        (!uniquePlayersRaw || uniquePlayersRaw.length === 0) &&
        (!uniqueBlkPlayersRaw || uniqueBlkPlayersRaw.length === 0)
      ) {
        console.log(
          `[${JOB_NAME}] No player shot or block logs found. Run the NHL player pull jobs first.`,
        );
        markJobRunFailure(jobRunId, { error: 'No player shot or block logs available' });
        return { success: false, error: 'No player shot or block logs available' };
      }

      const uniquePlayerMap = new Map();
      for (const row of [...uniquePlayersRaw, ...uniqueBlkPlayersRaw]) {
        const existing = uniquePlayerMap.get(row.player_id);
        const existingName =
          typeof existing?.player_name === 'string' ? existing.player_name : '';
        const nextName =
          typeof row?.player_name === 'string' ? row.player_name : '';

        if (!existing || nextName.length > existingName.length) {
          uniquePlayerMap.set(row.player_id, row);
        }
      }
      const uniquePlayers = Array.from(uniquePlayerMap.values());

      console.log(
        `[${JOB_NAME}] Found ${uniquePlayers.length} deduped players with recent data`,
      );

      let moneyPuckSnapshot = null;
      try {
        moneyPuckSnapshot = await fetchMoneyPuckSnapshot({ ttlMs: 0 });
      } catch (err) {
        console.warn(`[${JOB_NAME}] MoneyPuck snapshot unavailable: ${err.message}`);
      }

      // Gap 5: 1P card generation is gated behind NHL_SOG_1P_CARDS_ENABLED env flag (default off).
      // The 1P Odds API market is unreliable — enable only when lines are consistently available.
      const sog1pEnabled = process.env.NHL_SOG_1P_CARDS_ENABLED === 'true';
      const blkEnabled = process.env.NHL_BLK_CARDS_ENABLED === 'true';
      const excludedPlayerIds = new Set(
        parsePlayerIds(process.env.NHL_SOG_EXCLUDE_PLAYER_IDS),
      );
      const nhlSeasonKey = resolveNhlSeasonKey();

      // Hoist block-rates staleness check — single DB query per model run (not per player).
      const blkRatesMaxAge = db.prepare(
        `SELECT MAX(updated_at) AS max_updated_at FROM player_blk_rates WHERE season = ?`
      ).get(nhlSeasonKey);
      const blkRatesStale = (() => {
        if (!blkRatesMaxAge?.max_updated_at) return true;
        const ageMs = Date.now() - new Date(blkRatesMaxAge.max_updated_at).getTime();
        return ageMs > 8 * 24 * 60 * 60 * 1000;
      })();

      if (excludedPlayerIds.size > 0) {
        console.log(
          `[${JOB_NAME}] Applying NHL_SOG_EXCLUDE_PLAYER_IDS (${excludedPlayerIds.size} players)`,
        );
      }

      // Step 4: Generate cards for each player in upcoming games
      let cardsCreated = 0;
      const timestamp = new Date().toISOString();
      const processedGamePlayers = new Set();

      for (const game of games) {
        const gameId = game.game_id;
        const homeTeam = game.home_team;
        const awayTeam = game.away_team;

        // Gap 6: Resolve canonical game ID via game_id_map / proximity match
        const resolvedGameId = resolveCanonicalGameId(gameId, homeTeam, awayTeam, game.game_time_utc, db);
        const moneyPuckInjuryMap = buildMoneyPuckInjuryMapForGame(
          moneyPuckSnapshot,
          homeTeam,
          awayTeam,
        );

        // Find players for this game (case-insensitive match against abbreviations)
        const homeTeamUpper =
          typeof homeTeam === 'string' ? homeTeam.trim().toUpperCase() : '';
        const awayTeamUpper =
          typeof awayTeam === 'string' ? awayTeam.trim().toUpperCase() : '';
        const homeTeamAbbrev = resolveTeamAbbrev(homeTeam);
        const awayTeamAbbrev = resolveTeamAbbrev(awayTeam);

        const gamePlayersMatched = uniquePlayers.filter((p) => {
          const playerTeamAbbrev =
            typeof p.team_abbrev === 'string'
              ? p.team_abbrev.toUpperCase()
              : null;
          if (!playerTeamAbbrev) {
            return false;
          }
          // Gap 2: Warn if team_abbrev is not in the map
          if (playerTeamAbbrev && !(playerTeamAbbrev in TEAM_ABBREV_TO_NAME)) {
            console.log(
              `[${JOB_NAME}] WARN: team_abbrev '${playerTeamAbbrev}' not found in TEAM_ABBREV_TO_NAME map — player ${p.player_name} may not match any game`,
            );
          }
          const playerTeamFullName = TEAM_ABBREV_TO_NAME[playerTeamAbbrev];
          const playerTeamUpper =
            typeof playerTeamFullName === 'string'
              ? playerTeamFullName.toUpperCase()
              : null;

          // Match by exact team identity only (abbreviation or canonical full name).
          // Do not use substring checks (e.g., TOR incorrectly matching "PREDATORS").
          return (
            (homeTeamAbbrev && homeTeamAbbrev === playerTeamAbbrev) ||
            (awayTeamAbbrev && awayTeamAbbrev === playerTeamAbbrev) ||
            (playerTeamUpper && playerTeamUpper === homeTeamUpper) ||
            (playerTeamUpper && playerTeamUpper === awayTeamUpper)
          );
        });

        const gamePlayers = Array.from(
          new Map(gamePlayersMatched.map((player) => [player.player_id, player])).values(),
        );

        if (gamePlayers.length === 0) {
          continue;
        }

        console.log(
          `[${JOB_NAME}] Processing ${gamePlayers.length} players for game ${resolvedGameId}`,
        );

        for (const player of gamePlayers) {
          try {
            if (excludedPlayerIds.has(Number(player.player_id))) {
              console.log(
                `[${JOB_NAME}] Skipping ${player.player_name} (${player.player_id}): excluded by NHL_SOG_EXCLUDE_PLAYER_IDS`,
              );
              continue;
            }

            const playerRunKey = `${resolvedGameId}:${player.player_id}`;
            if (processedGamePlayers.has(playerRunKey)) {
              console.log(
                `[${JOB_NAME}] Skipping duplicate player for game ${resolvedGameId}: ${player.player_name} (${player.player_id})`,
              );
              continue;
            }
            processedGamePlayers.add(playerRunKey);

            // Availability check: skip players recorded as INJURED/unavailable.
            // DTD (day-to-day/questionable) players proceed but carry a 'DTD' tier
            // flag in the card payload so downstream consumers can surface it.
            // Fail-open: if NO row exists at all (table missing or player never fetched),
            // proceed normally so new players are not permanently blocked.
            let playerAvailabilityTier = 'ACTIVE';
            const displayName =
              typeof player?.player_name === 'string' &&
              player.player_name.trim().length > 0
                ? player.player_name.trim()
                : `Player #${player.player_id}`;

            const moneyPuckInjury = moneyPuckInjuryMap.get(
              normalizePlayerNameForLookup(displayName),
            );

            try {
              const purgeGameIds = Array.from(
                new Set(
                  [resolvedGameId, gameId].filter(
                    (value) => typeof value === 'string' && value.length > 0,
                  ),
                ),
              );
              const purgeResult = purgePlayerCardsForGame({
                db,
                gameIds: purgeGameIds,
                playerId: player.player_id,
                playerName: displayName,
              });
              const purgedCount = Number(purgeResult?.changes || 0);
              if (purgedCount > 0) {
                console.log(
                  `[${JOB_NAME}] Purged ${purgedCount} existing card(s) for ${displayName} (${player.player_id}) in game ${resolvedGameId} before recalculation`,
                );
              } else {
                console.warn(
                  `[${JOB_NAME}] purgePlayerCardsForGame returned 0 rows deleted for ${displayName} (${player.player_id}) in game ${resolvedGameId} — duplicate cards may persist`,
                );
              }
            } catch (purgeErr) {
              console.warn(
                `[${JOB_NAME}] Could not purge existing cards for ${displayName} (${player.player_id}) before recalculation: ${purgeErr.message}`,
              );
            }

            try {
              const availRow = db.prepare(`
                SELECT status, status_reason, checked_at
                FROM player_availability
                WHERE player_id = ? AND sport = 'NHL'
                LIMIT 1
              `).get(player.player_id);
              if (availRow) {
                if (availRow.status === 'INJURED') {
                  try {
                    purgePlayerCardsForGame({
                      db,
                      gameIds: [],
                      playerId: player.player_id,
                      playerName: displayName,
                    });
                  } catch (purgeErr) {
                    console.warn(
                      `[${JOB_NAME}] Could not purge injured-player cards for ${displayName} (${player.player_id}): ${purgeErr.message}`,
                    );
                  }
                  console.log(
                    `[${JOB_NAME}] Skipping ${player.player_name} (${player.player_id}): availability status=INJURED${availRow.status_reason ? ` reason=${availRow.status_reason}` : ''}`,
                  );
                  continue;
                }
                if (availRow.status === 'DTD') {
                  playerAvailabilityTier = 'DTD';
                  console.log(
                    `[${JOB_NAME}] Note: ${player.player_name} (${player.player_id}) is DTD${availRow.status_reason ? ` reason=${availRow.status_reason}` : ''} — generating card with DTD tier`,
                  );
                }
              }
            } catch {
              // player_availability table may not exist in older DBs — proceed normally
            }

            if (moneyPuckInjury?.status === 'INJURED') {
              try {
                purgePlayerCardsForGame({
                  db,
                  gameIds: [],
                  playerId: player.player_id,
                  playerName: displayName,
                });
              } catch (purgeErr) {
                console.warn(
                  `[${JOB_NAME}] Could not purge MoneyPuck-injured cards for ${displayName} (${player.player_id}): ${purgeErr.message}`,
                );
              }
              console.log(
                `[${JOB_NAME}] Skipping ${displayName} (${player.player_id}): MoneyPuck injury status=${moneyPuckInjury.reason || 'listed-injured'}`,
              );
              continue;
            }

            if (moneyPuckInjury?.status === 'DTD' && playerAvailabilityTier !== 'DTD') {
              playerAvailabilityTier = 'DTD';
              console.log(
                `[${JOB_NAME}] Note: ${displayName} (${player.player_id}) is MoneyPuck DTD${moneyPuckInjury.reason ? ` reason=${moneyPuckInjury.reason}` : ''} — generating card with DTD tier`,
              );
            }

            // Pull up to 10 games for breakout context while preserving L5 core logic.
            const getPlayerLookbackStmt = db.prepare(`
            SELECT
              game_id,
              game_date,
              opponent,
              is_home,
              shots,
              toi_minutes,
              raw_data
            FROM player_shot_logs
            WHERE player_id = ?
            ORDER BY game_date DESC
            LIMIT 10
          `);
            const playerLookbackGames = getPlayerLookbackStmt.all(player.player_id);
            const getPlayerBlkLookbackStmt = db.prepare(`
            SELECT
              game_id,
              game_date,
              opponent,
              is_home,
              blocked_shots,
              toi_minutes,
              raw_data
            FROM player_blk_logs
            WHERE player_id = ?
            ORDER BY game_date DESC
            LIMIT 10
          `);
            const playerBlkLookbackGames = getPlayerBlkLookbackStmt.all(player.player_id);
            const hasSogLookback = playerLookbackGames.length >= 5;
            const hasBlkLookback = playerBlkLookbackGames.length >= 5;

            if (!hasSogLookback && !hasBlkLookback) {
              // Task 1: Log explicit skip reason for players with insufficient recent logs
              console.log(
                `[${JOB_NAME}] Skipping ${player.player_name} (${player.player_id}): fewer than 5 recent shot or blocked-shot logs (possible injury/absence)`,
              );
              continue;
            }

            // Prefer stored player name from pull job; fallback to stable placeholder
            const hasValidName =
              typeof player.player_name === 'string' &&
              player.player_name.trim().length > 0 &&
              !player.player_name.includes('[object Object]');
            const playerName = hasValidName
              ? player.player_name.trim()
              : `Player #${player.player_id}`;
            const roleStability = playerAvailabilityTier === 'DTD' ? 'MEDIUM' : 'HIGH';

            if (hasSogLookback) {
            const l5Games = playerLookbackGames.slice(0, 5);

            // Build L5 SOG array (most recent first)
            const l5Sog = l5Games.map((g) => g.shots || 0);

            // Extract season stats from most recent game's raw_data if available
            let shotsPer60 = null;
            let projToi = null;
            let ppToi = 0; // WI-0528: default 0 for safe fallback on legacy log rows
            let ppRatePer60 = null; // WI-0530: season PP shot rate from NST player_pp_rates
            let ppRateL10Per60 = null; // WI-0531: L10 rolling PP shot rate
            let ppRateL5Per60 = null;  // WI-0531: L5 rolling PP shot rate
            if (playerLookbackGames[0]?.raw_data) {
              try {
                const rawData = JSON.parse(playerLookbackGames[0].raw_data);
                shotsPer60 = rawData.shotsPer60 || null;
                projToi = rawData.projToi || playerLookbackGames[0].toi_minutes || null;
                ppToi = Number.isFinite(rawData.ppToi) && rawData.ppToi > 0 ? rawData.ppToi : 0; // WI-0528: real PP TOI
                // WI-0530: treat 0 same as null — only positive rates are meaningful
                if (Number.isFinite(rawData.ppRatePer60) && rawData.ppRatePer60 > 0) {
                  ppRatePer60 = rawData.ppRatePer60;
                }
                // WI-0531: extract L10/L5 rolling rates (null if absent or non-positive)
                if (Number.isFinite(rawData.ppRateL10Per60) && rawData.ppRateL10Per60 > 0) {
                  ppRateL10Per60 = rawData.ppRateL10Per60;
                }
                if (Number.isFinite(rawData.ppRateL5Per60) && rawData.ppRateL5Per60 > 0) {
                  ppRateL5Per60 = rawData.ppRateL5Per60;
                }
              } catch {
                // Ignore parse errors
              }
            }

            const isHome =
              player.team_abbrev?.toUpperCase() === homeTeam.toUpperCase() ||
              TEAM_ABBREV_TO_NAME[player.team_abbrev?.toUpperCase()]?.toUpperCase() === homeTeam.toUpperCase();

            const playerTeamAbbrev = resolveTeamAbbrev(player.team_abbrev);
            const playerTeamName =
              (playerTeamAbbrev && TEAM_ABBREV_TO_NAME[playerTeamAbbrev]) ||
              player.team_abbrev;
            const moneyPuckSkater = resolveMoneyPuckSkaterEntry(
              moneyPuckSnapshot,
              playerTeamName,
              playerName,
            );
            const opponentTeam = isHome ? awayTeam : homeTeam;
            const opponentAbbrev = resolveTeamAbbrev(opponentTeam);
            if (!opponentAbbrev) {
              console.debug(
                `[${JOB_NAME}] Could not resolve opponent abbreviation for '${opponentTeam}' — using raw team name for matchup lookup`,
              );
            }
            const opponentTeamName =
              (opponentAbbrev && TEAM_ABBREV_TO_NAME[opponentAbbrev]) ||
              opponentTeam;

            let opponentFactor = 1.0;
            let paceFactor = 1.0;
            let blkOppAttemptFactor = 1.0;
            let opponentFactorMissing = false;
            let paceFactorMissing = false;
            const opponentLookupNote = !opponentAbbrev
              ? 'opponent abbreviation unresolved; '
              : '';
            const matchupContext =
              `${playerName} (${playerTeamName}) vs ${opponentTeamName} [game=${resolvedGameId}]`;
            try {
              const factorRow = db.prepare(`
                SELECT
                  (
                    SELECT COALESCE(
                      CAST(json_extract(metrics, '$.shots_against_pg') AS REAL),
                      CAST(json_extract(metrics, '$.avgShotsAgainst') AS REAL),
                      CAST(json_extract(metrics, '$.shotsAgainstPerGame') AS REAL),
                      CAST(json_extract(metrics, '$.avgGoalsAgainst') AS REAL)
                    )
                    FROM team_metrics_cache
                    WHERE UPPER(sport) = 'NHL'
                      AND status = 'ok'
                      AND UPPER(team_name) = UPPER(?)
                    ORDER BY cache_date DESC
                    LIMIT 1
                  ) AS opponent_shots_against_pg,
                  (
                    SELECT AVG(COALESCE(
                      CAST(json_extract(metrics, '$.shots_against_pg') AS REAL),
                      CAST(json_extract(metrics, '$.avgShotsAgainst') AS REAL),
                      CAST(json_extract(metrics, '$.shotsAgainstPerGame') AS REAL),
                      CAST(json_extract(metrics, '$.avgGoalsAgainst') AS REAL)
                    ))
                    FROM team_metrics_cache
                    WHERE UPPER(sport) = 'NHL'
                      AND status = 'ok'
                      AND COALESCE(
                        CAST(json_extract(metrics, '$.shots_against_pg') AS REAL),
                        CAST(json_extract(metrics, '$.avgShotsAgainst') AS REAL),
                        CAST(json_extract(metrics, '$.shotsAgainstPerGame') AS REAL),
                        CAST(json_extract(metrics, '$.avgGoalsAgainst') AS REAL)
                      ) IS NOT NULL
                  ) AS league_avg_shots_against_pg,
                  (
                    SELECT COALESCE(
                      CAST(json_extract(metrics, '$.pace_proxy') AS REAL),
                      CAST(json_extract(metrics, '$.paceFactor') AS REAL),
                      CAST(json_extract(metrics, '$.pace') AS REAL),
                      CAST(json_extract(metrics, '$.corsi_for_pct') AS REAL) / 50.0,
                      CAST(json_extract(metrics, '$.shots_for_pg') AS REAL) /
                        NULLIF((
                          SELECT AVG(CAST(json_extract(metrics, '$.shots_for_pg') AS REAL))
                          FROM team_metrics_cache
                          WHERE UPPER(sport) = 'NHL'
                            AND status = 'ok'
                            AND json_extract(metrics, '$.shots_for_pg') IS NOT NULL
                        ), 0)
                    )
                    FROM team_metrics_cache
                    WHERE UPPER(sport) = 'NHL'
                      AND status = 'ok'
                      AND UPPER(team_name) = UPPER(?)
                    ORDER BY cache_date DESC
                    LIMIT 1
                  ) AS team_pace_proxy,
                  (
                    SELECT COALESCE(
                      CAST(json_extract(metrics, '$.pace_proxy') AS REAL),
                      CAST(json_extract(metrics, '$.paceFactor') AS REAL),
                      CAST(json_extract(metrics, '$.pace') AS REAL),
                      CAST(json_extract(metrics, '$.corsi_for_pct') AS REAL) / 50.0,
                      CAST(json_extract(metrics, '$.shots_for_pg') AS REAL) /
                        NULLIF((
                          SELECT AVG(CAST(json_extract(metrics, '$.shots_for_pg') AS REAL))
                          FROM team_metrics_cache
                          WHERE UPPER(sport) = 'NHL'
                            AND status = 'ok'
                            AND json_extract(metrics, '$.shots_for_pg') IS NOT NULL
                        ), 0)
                    )
                    FROM team_metrics_cache
                    WHERE UPPER(sport) = 'NHL'
                      AND status = 'ok'
                      AND UPPER(team_name) = UPPER(?)
                    ORDER BY cache_date DESC
                    LIMIT 1
                  ) AS opponent_pace_proxy
              `).get(opponentTeamName, playerTeamName, opponentTeamName);

              if (
                factorRow &&
                factorRow.opponent_shots_against_pg > 0 &&
                factorRow.league_avg_shots_against_pg > 0
              ) {
                opponentFactor =
                  factorRow.opponent_shots_against_pg /
                  factorRow.league_avg_shots_against_pg;
              } else {
                opponentFactorMissing = true;
                console.warn(
                  `[${JOB_NAME}] [opponent-factor-fallback] ${matchupContext} — ${opponentLookupNote}no usable team_metrics_cache matchup data; opponentFactor defaulting to 1.0`,
                );
              }

              const teamPaceProxy = Number(factorRow?.team_pace_proxy);
              const opponentPaceProxy = Number(factorRow?.opponent_pace_proxy);
              // BLK: opponent attempt factor — opponent's corsi proxy (shots generated ratio)
              // Clamping to [0.90, 1.12] is enforced inside projectBlkV1.
              if (Number.isFinite(opponentPaceProxy) && opponentPaceProxy > 0) {
                blkOppAttemptFactor = opponentPaceProxy;
              }
              if (
                Number.isFinite(teamPaceProxy) &&
                teamPaceProxy > 0 &&
                Number.isFinite(opponentPaceProxy) &&
                opponentPaceProxy > 0
              ) {
                paceFactor = clamp((teamPaceProxy + opponentPaceProxy) / 2, 0.85, 1.2);
              } else {
                paceFactorMissing = true;
                console.warn(
                  `[${JOB_NAME}] [pace-factor-fallback] ${matchupContext} — no usable NHL pace proxy; paceFactor defaulting to 1.0`,
                );
              }
            } catch (error) {
              opponentFactorMissing = true;
              paceFactorMissing = true;
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.warn(
                `[${JOB_NAME}] [matchup-factor-fallback] ${matchupContext} — could not query team_metrics_cache for matchup factors; defaulting to opponentFactor=1.0 paceFactor=1.0 (${errorMessage})`,
              );
            }

            // WI-0532: PP matchup layer from opponent PK quality + penalties against/60.
            let ppMatchupFactor = 1.0;
            let oppPkPct = null;
            let oppPenaltiesPer60 = null;
            let leagueAvgPkPct = null;
            let leagueAvgPenaltiesPer60 = null;
            let ppMatchupMissing = false;
            try {
              const opponentHomeRoad = isHome ? 'R' : 'H';
              const ppRow = db.prepare(`
                SELECT
                  (
                    SELECT pk_pct
                    FROM team_stats
                    WHERE season = ?
                      AND UPPER(team_name) = UPPER(?)
                      AND home_road = ?
                    ORDER BY updated_at DESC
                    LIMIT 1
                  ) AS opp_pk_pct_split,
                  (
                    SELECT pk_pct
                    FROM team_stats
                    WHERE season = ?
                      AND UPPER(team_name) = UPPER(?)
                      AND home_road = 'ALL'
                    ORDER BY updated_at DESC
                    LIMIT 1
                  ) AS opp_pk_pct_all,
                  (
                    SELECT penalties_against_per60
                    FROM team_stats
                    WHERE season = ?
                      AND UPPER(team_name) = UPPER(?)
                      AND home_road = ?
                    ORDER BY updated_at DESC
                    LIMIT 1
                  ) AS opp_penalties_per60_split,
                  (
                    SELECT penalties_against_per60
                    FROM team_stats
                    WHERE season = ?
                      AND UPPER(team_name) = UPPER(?)
                      AND home_road = 'ALL'
                    ORDER BY updated_at DESC
                    LIMIT 1
                  ) AS opp_penalties_per60_all,
                  (
                    SELECT AVG(pk_pct)
                    FROM team_stats
                    WHERE season = ?
                      AND home_road = ?
                      AND pk_pct IS NOT NULL
                  ) AS league_avg_pk_pct_split,
                  (
                    SELECT AVG(pk_pct)
                    FROM team_stats
                    WHERE season = ?
                      AND home_road = 'ALL'
                      AND pk_pct IS NOT NULL
                  ) AS league_avg_pk_pct_all,
                  (
                    SELECT AVG(penalties_against_per60)
                    FROM team_stats
                    WHERE season = ?
                      AND home_road = ?
                      AND penalties_against_per60 IS NOT NULL
                  ) AS league_avg_penalties_per60_split,
                  (
                    SELECT AVG(penalties_against_per60)
                    FROM team_stats
                    WHERE season = ?
                      AND home_road = 'ALL'
                      AND penalties_against_per60 IS NOT NULL
                  ) AS league_avg_penalties_per60_all
              `).get(
                nhlSeasonKey,
                opponentTeamName,
                opponentHomeRoad,
                nhlSeasonKey,
                opponentTeamName,
                nhlSeasonKey,
                opponentTeamName,
                opponentHomeRoad,
                nhlSeasonKey,
                opponentTeamName,
                nhlSeasonKey,
                opponentHomeRoad,
                nhlSeasonKey,
                nhlSeasonKey,
                opponentHomeRoad,
                nhlSeasonKey,
              );

              oppPkPct = firstPositive(
                ppRow?.opp_pk_pct_split,
                ppRow?.opp_pk_pct_all,
              );
              oppPenaltiesPer60 = firstPositive(
                ppRow?.opp_penalties_per60_split,
                ppRow?.opp_penalties_per60_all,
              );
              leagueAvgPkPct = firstPositive(
                ppRow?.league_avg_pk_pct_split,
                ppRow?.league_avg_pk_pct_all,
              );
              leagueAvgPenaltiesPer60 = firstPositive(
                ppRow?.league_avg_penalties_per60_split,
                ppRow?.league_avg_penalties_per60_all,
              );

              const computedPpMatchupFactor = computePpMatchupFactor({
                opponentPenaltiesPer60: oppPenaltiesPer60,
                opponentPkPct: oppPkPct,
                leagueAvgPenaltiesPer60,
                leagueAvgPkPct,
              });
              if (computedPpMatchupFactor !== null) {
                ppMatchupFactor = computedPpMatchupFactor;
              } else if (ppToi > 0) {
                ppMatchupMissing = true;
                console.debug(
                  `[${JOB_NAME}] Missing PP matchup inputs for '${opponentTeamName}' season=${nhlSeasonKey} — pp_matchup_factor defaulting to 1.0`,
                );
              }
            } catch {
              if (ppToi > 0) {
                ppMatchupMissing = true;
              }
              console.debug(
                `[${JOB_NAME}] Could not query team_stats for PP matchup factor — defaulting to 1.0`,
              );
            }

            // Run model for full game
            const mu = calcMu({
              l5Sog,
              shotsPer60: shotsPer60,
              projToi: projToi,
              opponentFactor,
              paceFactor,
              isHome,
            });

            // Run model for 1st period
            const mu1p = calcMu1p({
              l5Sog,
              shotsPer60: shotsPer60,
              projToi: projToi,
              opponentFactor,
              paceFactor,
              isHome,
            });

            // Derive a trending L5 rate for projectSogV2's weighted blend.
            // l5RatePer60: L5 mean shots / projected TOI * 60 (per-60 normalised).
            const l5Mean = computeL5Mean(l5Sog);
            const l5RatePer60 =
              projToi && projToi > 0
                ? (l5Mean / projToi) * 60
                : shotsPer60 ?? null;
            const sharedPropFlags = buildSharedPropFlags({
              ppRatePer60,
              ppToi,
              ppRateL10Per60,
              ppRateL5Per60,
              ppMatchupMissing,
              opponentFactorMissing,
              paceFactorMissing,
            });
            const roleStability = playerAvailabilityTier === 'DTD' ? 'MEDIUM' : 'HIGH';
            const v2ProjectionInputs = {
              player_id: player.player_id,
              game_id: resolvedGameId,
              ev_shots_season_per60: shotsPer60 ?? null,
              // L10 is not stored separately; use L5-derived rate as a proxy
              // rather than copying shotsPer60 (which is a season average, not L10).
              // This avoids a false LOW_SAMPLE flag while being directionally correct.
              ev_shots_l10_per60: l5RatePer60 ?? shotsPer60 ?? null,
              ev_shots_l5_per60: l5RatePer60,
              // WI-0578: When PP_RATE_MISSING (NST rate unavailable but player has real ppToi),
              // use a conservative league-average fallback instead of null. Passing null silently
              // collapses pp_component to 0, under-projecting by 0.3–0.5 SOG for top PP players.
              pp_shots_season_per60: ppRatePer60 ?? (
                ppToi > 0
                  ? (() => {
                      console.warn(
                        `[${JOB_NAME}] [pp-rate-fallback] ${playerName}: ppRatePer60 missing with ppToi=${ppToi.toFixed(2)} — using league-avg fallback ${PP_RATE_LEAGUE_AVG_PER60}/60`,
                      );
                      return PP_RATE_LEAGUE_AVG_PER60;
                    })()
                  : null
              ),
              pp_shots_l10_per60: ppRateL10Per60,
              pp_shots_l5_per60: ppRateL5Per60,
              toi_proj_ev: projToi ?? 0,
              toi_proj_pp: ppToi,
              pp_matchup_factor: ppMatchupFactor,
              shot_env_factor: paceFactor,
              opponent_suppression_factor: opponentFactor,
              role_stability: roleStability,
            };

            // Event-priced odds are disabled for this lane, so full-game SOG cards
            // always use the synthetic projection-floor reference line.
            const realPropLineCandidates = EVENT_PRICING_DISABLED
              ? []
              : resolvePlayerPropLineCandidatesWithFallback({
                db,
                sport: 'NHL',
                gameId: resolvedGameId,
                playerName,
                propType: 'shots_on_goal',
                period: 'full_game',
              });
            const baseSelectedPropMarketEvaluation = realPropLineCandidates.length > 0
              ? [...realPropLineCandidates]
                .map((market) =>
                  evaluatePropMarketCandidate({
                    market,
                    mu,
                    l5Sog,
                    l5Mean,
                    opponentFactor,
                    sharedPropFlags,
                    projectionInputs: v2ProjectionInputs,
                  }))
                .sort(comparePropMarketEvaluations)[0]
              : null;
            let activeSelectedPropMarketEvaluation = baseSelectedPropMarketEvaluation;
            let breakoutContext = null;
            let breakoutAdopted = false;

            let marketLine;
            let overPrice = null;
            let underPrice = null;
            let propBookmaker = null;
            let v2Projection;
            let v2AnomalyDetected;
            let v2EdgeOverPp;
            let v2EdgeUnderPp;
            let v2EvOver;
            let v2EvUnder;
            let v2OpportunityScore;
            let v2ImpliedOverProb;
            let v2ImpliedUnderProb;
            let preselectedPropDecision = null;
            let preselectedPropDecisionFlags = null;
            const usingRealLine = !!baseSelectedPropMarketEvaluation;

            if (activeSelectedPropMarketEvaluation) {
              marketLine = activeSelectedPropMarketEvaluation.market.line;
              overPrice = activeSelectedPropMarketEvaluation.market.over_price;
              underPrice = activeSelectedPropMarketEvaluation.market.under_price;
              propBookmaker = activeSelectedPropMarketEvaluation.market.bookmaker ?? null;
              v2Projection = activeSelectedPropMarketEvaluation.v2Projection;
              v2AnomalyDetected = activeSelectedPropMarketEvaluation.v2AnomalyDetected;
              preselectedPropDecision = activeSelectedPropMarketEvaluation.propDecision;
              preselectedPropDecisionFlags =
                activeSelectedPropMarketEvaluation.propDecisionFlags;
            } else {
              marketLine = parseFloat(process.env.NHL_SOG_PROJECTION_LINE || '2.5');
              console.log(`[projection-mode] line=${marketLine} (no real Odds API line — using projection floor)`);
              v2Projection = projectSogV2({
                ...v2ProjectionInputs,
                market_line: marketLine,
                market_price_over: null,
                market_price_under: null,
                play_direction: classifyEdge(mu, marketLine, 0.75).direction,
              });
              v2AnomalyDetected = v2Projection.sog_mu < 0.6 * l5Mean;
              preselectedPropDecisionFlags = [
                ...(v2Projection.flags ?? []),
                ...sharedPropFlags,
                ...(v2AnomalyDetected ? ['PROJECTION_ANOMALY'] : []),
                'SYNTHETIC_LINE',
              ];
            }

            const isOddsBacked = overPrice !== null && underPrice !== null;
            if (!isOddsBacked) {
              console.log(
                `[${JOB_NAME}] [projection-mode] No prices for ${playerName} — MISSING_PRICE flag, opportunity_score=null`,
              );
            }

            breakoutContext = computeBreakoutContext({
              lookbackGames: playerLookbackGames,
              baselineShots60: shotsPer60,
              projToi,
              ppToi,
              ppMatchupFactor,
              opponentFactor,
              paceFactor,
              playerAvailabilityTier,
              usingRealLine,
              isOddsBacked,
              basePropDecision: preselectedPropDecision,
              baseV2Projection: v2Projection,
              moneyPuckSkater,
            });

            if (
              breakoutContext?.flags.includes('BREAKOUT_CANDIDATE') &&
              realPropLineCandidates.length > 0
            ) {
              const breakoutProjectionOverrides = {
                ev_shots_season_per60: breakoutContext.adjustedShots60,
                ev_shots_l10_per60: breakoutContext.adjustedShots60,
                ev_shots_l5_per60: breakoutContext.adjustedShots60,
                toi_proj_ev: breakoutContext.tonightToiProj ?? (projToi ?? 0),
                shot_env_factor:
                  paceFactor *
                  breakoutContext.moneypuckUsageFactor *
                  breakoutContext.positionEnvFactor,
              };

              const breakoutSelectedPropMarketEvaluation = [...realPropLineCandidates]
                .map((market) =>
                  evaluatePropMarketCandidate({
                    market,
                    mu: breakoutContext.breakoutSogMu,
                    l5Sog,
                    l5Mean,
                    opponentFactor,
                    sharedPropFlags,
                    projectionInputs: v2ProjectionInputs,
                    projectionInputOverrides: breakoutProjectionOverrides,
                  }))
                .sort(comparePropMarketEvaluations)[0];

              const breakoutProbEdge =
                breakoutSelectedPropMarketEvaluation?.propDecision?.prob_edge_pp;
              if (
                breakoutContext.eligible &&
                (
                  Number(breakoutSelectedPropMarketEvaluation?.market?.over_price) <= -160 ||
                  (Number.isFinite(breakoutProbEdge) && breakoutProbEdge < 0.02)
                )
              ) {
                breakoutContext.flags = mergeUniqueFlags(
                  breakoutContext.flags,
                  'PRICE_TOO_JUICED',
                );
              }

              if (
                shouldAdoptBreakoutEvaluation(
                  baseSelectedPropMarketEvaluation,
                  breakoutSelectedPropMarketEvaluation,
                )
              ) {
                activeSelectedPropMarketEvaluation = breakoutSelectedPropMarketEvaluation;
                breakoutAdopted = true;
              }
            }

            if (activeSelectedPropMarketEvaluation) {
              marketLine = activeSelectedPropMarketEvaluation.market.line;
              overPrice = activeSelectedPropMarketEvaluation.market.over_price;
              underPrice = activeSelectedPropMarketEvaluation.market.under_price;
              propBookmaker = activeSelectedPropMarketEvaluation.market.bookmaker ?? null;
              v2Projection = activeSelectedPropMarketEvaluation.v2Projection;
              v2AnomalyDetected = activeSelectedPropMarketEvaluation.v2AnomalyDetected;
              preselectedPropDecision = activeSelectedPropMarketEvaluation.propDecision;
              preselectedPropDecisionFlags = mergeUniqueFlags(
                activeSelectedPropMarketEvaluation.propDecisionFlags,
                breakoutContext?.flags || [],
              );
            } else {
              preselectedPropDecisionFlags = mergeUniqueFlags(
                preselectedPropDecisionFlags,
                breakoutContext?.flags || [],
              );
            }

            // WI-0531: Compute the actual PP blend rate for drivers display.
            // Mirrors weightedRateBlendPP logic (0.40/0.35/0.25) so drivers is consistent with model.
            const ppBlendRate = (() => {
              const vals = [ppRatePer60, ppRateL10Per60, ppRateL5Per60];
              const wts = [0.40, 0.35, 0.25];
              const present = vals.map((v, i) => (v !== null ? { v, w: wts[i] } : null)).filter(Boolean);
              if (present.length === 0) return null;
              const totalW = present.reduce((s, x) => s + x.w, 0);
              return present.reduce((s, x) => s + (x.v * x.w) / totalW, 0);
            })();

            // V2 anomaly: sog_mu collapsing far below L5 average signals model breakdown.
            // This is separate from projectionAnomalyDetected (V1 path) and gates V2 pricing only.
            // Null out pricing fields when V2 anomaly is present — no bet-worthy signal should be emitted.
            ({
              edgeOverPp: v2EdgeOverPp,
              edgeUnderPp: v2EdgeUnderPp,
              evOver: v2EvOver,
              evUnder: v2EvUnder,
              opportunityScore: v2OpportunityScore,
              impliedOverProb: v2ImpliedOverProb,
              impliedUnderProb: v2ImpliedUnderProb,
            } = buildV2PricingState(v2Projection, v2AnomalyDetected));

            const syntheticLine = marketLine; // kept for card payload references below

            // 1P: also use projection floor when no real line (scaled from full-game floor by 1P share)
            const realPropLine1p = EVENT_PRICING_DISABLED
              ? null
              : resolvePlayerPropLineWithFallback({
                sport: 'NHL',
                gameId: resolvedGameId,
                playerName,
                propType: 'shots_on_goal',
                period: 'first_period',
              });
            const overPrice1p = normalizePropOddsPrice(realPropLine1p?.over_price);
            const underPrice1p = normalizePropOddsPrice(realPropLine1p?.under_price);
            let syntheticLine1p;
            if (realPropLine1p) {
              syntheticLine1p = realPropLine1p.line;
            } else {
              const floorFull = parseFloat(process.env.NHL_SOG_PROJECTION_LINE || '2.5');
              syntheticLine1p = Math.round(floorFull * 0.32 * 2) / 2;
              if (sog1pEnabled) {
                console.log(`[projection-mode] 1P line=${syntheticLine1p} (no real Odds API line — using projection floor)`);
              }
            }

            if (!usingRealLine) {
              console.warn(`[${JOB_NAME}] No real prop line for ${playerName} game ${resolvedGameId} — using synthetic fallback`);
            }

            const effectiveMu =
              breakoutAdopted && Number.isFinite(breakoutContext?.breakoutSogMu)
                ? breakoutContext.breakoutSogMu
                : mu;

            // Fair line: L5 consistency baseline (no matchup adjustments).
            // This is what the market typically prices the player at.
            const l5FairValue = calcFairLine({ l5Sog, shotsPer60, projToi });
            const fairLine = roundToHalfLine(l5FairValue) ?? syntheticLine;

            // Matchup edge: how much the projection departs from the L5 baseline.
            // Positive = matchup-positive (tough defense hurt opponents, home ice, etc.).
            const matchupEdge = Math.round((effectiveMu - l5FairValue) * 10) / 10;

            const fullDirectionSeed = activeSelectedPropMarketEvaluation
              ? activeSelectedPropMarketEvaluation.directionSeed
              : classifyEdge(effectiveMu, syntheticLine, 0.75);
            const fullConsistencyScore = activeSelectedPropMarketEvaluation
              ? activeSelectedPropMarketEvaluation.consistencyScore
              : computeConsistencyScore(
                l5Sog,
                syntheticLine,
                fullDirectionSeed.direction,
              );
            const fullMatchupScore = activeSelectedPropMarketEvaluation
              ? activeSelectedPropMarketEvaluation.matchupScore
              : computeMatchupScore(
                opponentFactor,
                fullDirectionSeed.direction,
              );
            const fullSupportScore = activeSelectedPropMarketEvaluation
              ? activeSelectedPropMarketEvaluation.supportScore
              : computeDecisionSupport(
                fullConsistencyScore,
                fullMatchupScore,
              );
            const confidence = activeSelectedPropMarketEvaluation
              ? activeSelectedPropMarketEvaluation.confidence
              : computeConfidence(
                fullConsistencyScore,
                fullMatchupScore,
                Math.abs(effectiveMu - syntheticLine),
              );

            // Projection anomaly guard: when recency-weighted mu is <60% of the
            // arithmetic L5 mean, the model is collapsing due to recent low-shot
            // games. In this case we must never emit FIRE — the "huge UNDER edge"
            // against a synthetic floor line is not a real signal.
            const projectionAnomalyDetected = effectiveMu < 0.6 * l5Mean;
            if (projectionAnomalyDetected) {
              console.warn(
                `[${JOB_NAME}] PROJECTION_ANOMALY: ${playerName} weighted_mu=${effectiveMu.toFixed(2)} < 0.6 * l5_arith_mean=${l5Mean.toFixed(2)} — FIRE will be blocked. Check recent shot log; likely had 0–1 shots in last 2 games.`,
              );
            }

            // Structured debug log — every player gets one line for diagnostics.
            console.log(
              `[${JOB_NAME}] [debug] ${playerName}: l5=${JSON.stringify(l5Sog)} l5_arith=${l5Mean.toFixed(2)} mu=${mu.toFixed(3)} effective_mu=${effectiveMu.toFixed(3)} breakout_adopted=${breakoutAdopted} breakout_flags=${JSON.stringify(breakoutContext?.flags || [])} line=${syntheticLine} real_line=${usingRealLine} projToi=${projToi ?? 'null'} shotsPer60=${shotsPer60 ?? 'null'} oppF=${opponentFactor.toFixed(3)} paceF=${paceFactor.toFixed(3)} ppMatch=${ppMatchupFactor.toFixed(3)} isHome=${isHome} anomaly=${projectionAnomalyDetected}`,
            );

            // Classify edges after confidence is derived from consistency + matchup.
            const fullGameEdge = classifyEdge(effectiveMu, syntheticLine, confidence);
            let fullDecision = derivePlayDecision({
              edgeTier: fullGameEdge.tier,
              supportScore: fullSupportScore,
              confidence,
            });

            // Guard 1: Never FIRE on projection-only cards (no real Odds API line).
            // A synthetic floor line creates fake edge even when the player projects
            // legitimately. Real odds are required to validate a bet-worthy signal.
            if (!usingRealLine && fullDecision.action === 'FIRE') {
              console.warn(
                `[${JOB_NAME}] [no-real-line] Downgraded ${playerName} FIRE→WATCH (projection-mode card — no real Odds API line)`,
              );
              fullDecision = {
                action: 'HOLD',
                status: 'WATCH',
                classification: 'LEAN',
                officialStatus: 'LEAN',
              };
            }

            // Guard 2: Never FIRE when weighted projection has collapsed below 60%
            // of the arithmetic L5 mean. This catches the aggressive-recency-decay
            // scenario where 0-shot games dominate the weighted average.
            if (projectionAnomalyDetected && fullDecision.action === 'FIRE') {
              console.warn(
                `[${JOB_NAME}] [anomaly-guard] Downgraded ${playerName} FIRE→WATCH (PROJECTION_ANOMALY)`,
              );
              fullDecision = {
                action: 'HOLD',
                status: 'WATCH',
                classification: 'LEAN',
                officialStatus: 'LEAN',
              };
            }

            // Guard 3 (WI-0577): V2 Poisson veto — on odds-backed full-game cards,
            // if V2's probability edge for the selected direction is negative,
            // downgrade FIRE→WATCH. V1 can overstate edge when classifyEdge HOT tier
            // is met while Poisson fair pricing disagrees with the market line.
            if (usingRealLine && fullDecision.action === 'FIRE') {
              const v2EdgeForDir =
                fullGameEdge.direction === 'UNDER'
                  ? v2EdgeUnderPp
                  : v2EdgeOverPp;
              if (
                typeof v2EdgeForDir === 'number' &&
                Number.isFinite(v2EdgeForDir) &&
                v2EdgeForDir < 0
              ) {
                console.warn(
                  `[${JOB_NAME}] [v2-veto-full] Downgraded ${playerName} FIRE→WATCH (V2 edge_${fullGameEdge.direction.toLowerCase()}_pp=${v2EdgeForDir.toFixed(4)} < 0)`,
                );
                fullDecision = {
                  action: 'HOLD',
                  status: 'WATCH',
                  classification: 'LEAN',
                  officialStatus: 'LEAN',
                };
              }
            }

            const fullDirectionLabel =
              fullGameEdge.direction === 'OVER' ? 'Over' : 'Under';

            const propDecisionFlags =
              preselectedPropDecisionFlags ?? [
                ...(v2Projection.flags ?? []),
                ...sharedPropFlags,
                ...(v2AnomalyDetected ? ['PROJECTION_ANOMALY'] : []),
                ...(!usingRealLine ? ['SYNTHETIC_LINE'] : []),
              ];
            const fullPropDecision =
              preselectedPropDecision ?? buildCanonicalPropDecision({
                projection: effectiveMu,
                marketLine: syntheticLine,
                marketPriceOver: overPrice,
                marketPriceUnder: underPrice,
                fairOverProb:
                  v2Projection.fair_over_prob_by_line?.[String(marketLine)] ?? null,
                fairUnderProb:
                  v2Projection.fair_under_prob_by_line?.[String(marketLine)] ?? null,
                impliedOverProb: v2ImpliedOverProb,
                impliedUnderProb: v2ImpliedUnderProb,
                edgeOverPp: v2EdgeOverPp,
                edgeUnderPp: v2EdgeUnderPp,
                evOver: v2EvOver,
                evUnder: v2EvUnder,
                opportunityScore: v2OpportunityScore,
                confidence,
                roleStability: v2Projection.role_stability ?? 'HIGH',
                l5Mean,
                flags: propDecisionFlags,
                usingRealLine,
              });
            const legacyDecisionFromProp = deriveLegacyActionFromVerdict(
              fullPropDecision.verdict,
            );
            const fullVerdictPrefix =
              fullPropDecision.verdict === 'PLAY'
                ? 'Play'
                : fullPropDecision.verdict === 'WATCH'
                  ? 'Watch'
                  : fullPropDecision.verdict === 'PROJECTION'
                    ? 'Projection'
                    : 'No Play';

            {
              const cardId = `nhl-player-sog-${player.player_id}-${resolvedGameId}-full-${uuidV4().slice(0, 8)}`;

              // For PROP cards, don't set market_type to 'PROP' in the root; keep it implied
              // and let the data layer treat it as a PROP without trying to lock it via deriveLockedMarketContext
              const payloadData = {
                sport: 'NHL',
                home_team: homeTeam,
                away_team: awayTeam,
                game_time_utc: game.game_time_utc,
                card_type: 'nhl-player-shots',
                tier: fullGameEdge.tier,
                availability_tier: playerAvailabilityTier,
                card_status: 'active',
                model_name: 'nhl-player-shots-v1',
                model_version: '1.0.0',
                action: legacyDecisionFromProp.action,
                status: legacyDecisionFromProp.status,
                classification: legacyDecisionFromProp.classification,
                // Required by basePayloadSchema
                prediction: `${fullVerdictPrefix} ${playerName} ${fullPropDecision.lean_side ?? fullDirectionLabel} ${syntheticLine} SOG | Proj ${effectiveMu.toFixed(1)} · Fair ${fairLine} · Edge ${formatSignedEdge(matchupEdge)}`,
                confidence: confidence,
                recommended_bet_type: 'unknown',
                generated_at: timestamp,
                suggested_line: fairLine,
                threshold: fairLine,
                decision_v2: {
                  // Projection-delta percent vs. line; pricing edge lives in edge_over_pp / edge_under_pp.
                  official_status: legacyDecisionFromProp.officialStatus,
                  direction: fullPropDecision.lean_side ?? fullGameEdge.direction,
                  edge_delta_pct: computeEdgePct(effectiveMu, syntheticLine),
                  fair_line: fairLine,
                },
                prop_decision: fullPropDecision,
                breakout: buildBreakoutPayload(breakoutContext),
                // PROP-specific
                play: {
                  action: legacyDecisionFromProp.action,
                  status: legacyDecisionFromProp.status,
                  classification: legacyDecisionFromProp.classification,
                  decision_v2: {
                    official_status: legacyDecisionFromProp.officialStatus,
                    direction: fullPropDecision.lean_side ?? fullGameEdge.direction,
                    edge_delta_pct: computeEdgePct(effectiveMu, syntheticLine),
                    fair_line: fairLine,
                  },
                  prop_decision: fullPropDecision,
                  pick_string: `${fullVerdictPrefix} ${playerName} ${fullPropDecision.lean_side ?? fullDirectionLabel} ${syntheticLine} SOG | Proj ${effectiveMu.toFixed(1)} · Fair ${fairLine} · Edge ${formatSignedEdge(matchupEdge)}`,
                  market_type: 'PROP',
                  player_name: playerName,
                  player_id: player.player_id.toString(),
                  prop_type: 'shots_on_goal',
                  period: 'full_game',
                  selection: {
                    side:
                      (fullPropDecision.lean_side ?? fullGameEdge.direction) === 'OVER'
                        ? 'over'
                        : 'under',
                    line: syntheticLine,
                    price:
                      (fullPropDecision.lean_side ?? fullGameEdge.direction) === 'OVER'
                        ? (overPrice ?? -110)
                        : (underPrice ?? -110),
                    team: player.team_abbrev,
                    player_name: playerName,
                    player_id: player.player_id.toString(),
                  },
                },
                odds_backed: isOddsBacked,
                over_price: isOddsBacked ? overPrice : null,
                under_price: isOddsBacked ? underPrice : null,
                market_bookmaker: isOddsBacked ? propBookmaker : null,
                opportunity_score: v2OpportunityScore,
                prop_display_state: computePropDisplayState(v2AnomalyDetected, v2OpportunityScore),
                decision: {
                  edge_pct: computeEdgePct(effectiveMu, syntheticLine),
                  projection: Math.round(effectiveMu * 100) / 100,
                  fair_line: fairLine,
                  matchup_edge: matchupEdge,
                  model_projection: effectiveMu,
                  market_line: syntheticLine,
                  direction: fullPropDecision.lean_side ?? fullGameEdge.direction,
                  confidence: confidence,
                  market_line_source: usingRealLine ? 'odds_api' : 'synthetic_fallback',
                  consistency_score:
                    Math.round(fullConsistencyScore * 1000) / 1000,
                  matchup_score: Math.round(fullMatchupScore * 1000) / 1000,
                  support_score: Math.round(fullSupportScore * 1000) / 1000,
                  opportunity_score: v2OpportunityScore,
                  v2: {
                    sog_mu: v2Projection.sog_mu != null ? Math.round(v2Projection.sog_mu * 1000) / 1000 : null,
                    edge_over_pp: v2EdgeOverPp,
                    edge_under_pp: v2EdgeUnderPp,
                    ev_over: v2EvOver,
                    ev_under: v2EvUnder,
                    opportunity_score: v2OpportunityScore,
                    implied_over_prob: v2ImpliedOverProb,
                    implied_under_prob: v2ImpliedUnderProb,
                    flags: propDecisionFlags,
                    odds_backed: isOddsBacked,
                  },
                },
                drivers: {
                  l5_avg: l5Sog.reduce((a, b) => a + b, 0) / 5,
                  l5_fair_value: Math.round(l5FairValue * 100) / 100,
                  l5_sog: l5Sog,
                  shots_per_60: shotsPer60,
                  proj_toi: projToi,
                  is_home: isHome,
                  opponent_factor: opponentFactor,
                  pace_factor: paceFactor,
                  pp_matchup_factor:
                    v2Projection.pp_matchup_factor != null
                      ? Math.round(v2Projection.pp_matchup_factor * 1000) / 1000
                      : Math.round(ppMatchupFactor * 1000) / 1000,
                  opp_pk_pct: oppPkPct != null ? Math.round(oppPkPct * 1000) / 1000 : null,
                  opp_penalties_per60:
                    oppPenaltiesPer60 != null
                      ? Math.round(oppPenaltiesPer60 * 1000) / 1000
                      : null,
                  consistency_score:
                    Math.round(fullConsistencyScore * 1000) / 1000,
                    matchup_score: Math.round(fullMatchupScore * 1000) / 1000,
                  // Projection model inputs surfaced for debugging and audit
                  sog_mu: v2Projection.sog_mu != null ? Math.round(v2Projection.sog_mu * 1000) / 1000 : null,
                  toi_proj_ev: v2Projection.toi_proj != null ? v2Projection.toi_proj : (projToi ?? null),
                  ev_rate: v2Projection.shot_rate_ev_per60 != null ? Math.round(v2Projection.shot_rate_ev_per60 * 100) / 100 : null,
                  pp_rate: v2Projection.shot_rate_pp_per60 != null ? Math.round(v2Projection.shot_rate_pp_per60 * 100) / 100 : null,
                  pp_rate_per60: ppRatePer60,   // WI-0530: raw NST season rate before blend
                  pp_season_rate: ppRatePer60,  // WI-0531: alias for clarity
                  pp_l10_rate: ppRateL10Per60,  // WI-0531: L10 rolling rate (null if absent)
                  pp_l5_rate: ppRateL5Per60,    // WI-0531: L5 rolling rate (null if absent)
                  pp_blend_rate: ppBlendRate !== null ? Math.round(ppBlendRate * 100) / 100 : null, // WI-0531
                  shot_env_factor: v2Projection.shot_env_factor != null ? Math.round(v2Projection.shot_env_factor * 1000) / 1000 : null,
                  trend_factor: v2Projection.trend_score != null ? Math.round(v2Projection.trend_score * 1000) / 1000 : null,
                  v2_anomaly: v2AnomalyDetected,
                  breakout_applied: breakoutAdopted,
                },
              };

              const edgePct = computeEdgePct(effectiveMu, syntheticLine);
              applyNhlDecisionBasisMeta(payloadData, {
                usingRealLine,
                edgePct,
              });
              if (!usingRealLine && payloadData.decision_basis_meta) {
                payloadData.decision_basis_meta.market_line_source = 'synthetic_fallback';
              }

              const card = {
                id: cardId,
                gameId: resolvedGameId,
                sport: 'NHL',
                cardType: 'nhl-player-shots',
                cardTitle: `${playerName} Shots on Goal`,
                createdAt: timestamp,
                payloadData: payloadData,
              };
              attachRunId(card, jobRunId);

                try {
                  insertCardPayload(card);
                cardsCreated++;
                console.log(
                  `[${JOB_NAME}] ✓ Created ${fullPropDecision.verdict} card: ${playerName} ${fullPropDecision.lean_side ?? fullGameEdge.direction} ${syntheticLine} (fair ${fairLine}, conf ${Math.round(confidence * 100)}%)`,
                );
              } catch (insertErr) {
                console.error(
                  `[${JOB_NAME}] Failed to insert card: ${insertErr.message}`,
                );
              }
            }

            // Gap 5: 1P card block gated by NHL_SOG_1P_CARDS_ENABLED flag (default off).
            // The 1P Odds API market (player_shots_on_goal_1p) is unreliable — lines
            // are rarely available, so 1P cards almost always use synthetic fallback.
            // Enable via NHL_SOG_1P_CARDS_ENABLED=true only after confirming line availability.
            if (sog1pEnabled) {
              const l5Sog1p = l5Sog.map((shots) =>
                Math.round(shots * 0.32 * 10) / 10,
              );
              const l5Mean1p = computeL5Mean(l5Sog1p);
              const firstPeriodDirectionSeed = classifyEdge(
                mu1p,
                syntheticLine1p,
                0.75,
              );
              const firstPeriodV2Projection = projectSogV2({
                ...v2ProjectionInputs,
                market_line: syntheticLine1p,
                market_price_over: overPrice1p,
                market_price_under: underPrice1p,
                play_direction: firstPeriodDirectionSeed.direction,
              });
              const firstPeriodV2AnomalyDetected =
                firstPeriodV2Projection.sog_mu < 0.6 * l5Mean1p;
              const {
                edgeOverPp: v2EdgeOverPp1p,
                edgeUnderPp: v2EdgeUnderPp1p,
              } = buildV2PricingState(
                firstPeriodV2Projection,
                firstPeriodV2AnomalyDetected,
              );
              const firstPeriodConsistencyScore = computeConsistencyScore(
                l5Sog1p,
                syntheticLine1p,
                firstPeriodDirectionSeed.direction,
              );
              const firstPeriodMatchupScore = computeMatchupScore(
                opponentFactor,
                firstPeriodDirectionSeed.direction,
              );
              const firstPeriodSupportScore = computeDecisionSupport(
                firstPeriodConsistencyScore,
                firstPeriodMatchupScore,
              );
              const firstPeriodConfidence = computeConfidence(
                firstPeriodConsistencyScore,
                firstPeriodMatchupScore,
                Math.abs(mu1p - syntheticLine1p),
              );
              const firstPeriodEdge = classifyEdge(
                mu1p,
                syntheticLine1p,
                firstPeriodConfidence,
              );
              let firstPeriodDecision = derivePlayDecision({
                edgeTier: firstPeriodEdge.tier,
                supportScore: firstPeriodSupportScore,
                confidence: firstPeriodConfidence,
              });

              // Apply same guards as full-game path.
              if (!realPropLine1p && firstPeriodDecision.action === 'FIRE') {
                firstPeriodDecision = { action: 'HOLD', status: 'WATCH', classification: 'LEAN', officialStatus: 'LEAN' };
              }
              if (firstPeriodV2AnomalyDetected && firstPeriodDecision.action === 'FIRE') {
                console.warn(
                  `[${JOB_NAME}] [anomaly-guard-1p] Downgraded ${playerName} 1P FIRE→WATCH (1P PROJECTION_ANOMALY)`,
                );
                firstPeriodDecision = { action: 'HOLD', status: 'WATCH', classification: 'LEAN', officialStatus: 'LEAN' };
              }

              // Guard 3 (WI-0577): V2 Poisson veto — on odds-backed 1P cards,
              // if V2's probability edge for the selected direction is negative,
              // downgrade FIRE→WATCH. V1 can overstate edge when its recency
              // weighting diverges from Poisson fair pricing.
              if (realPropLine1p && firstPeriodDecision.action === 'FIRE') {
                const v2EdgeForDir1p =
                  firstPeriodEdge.direction === 'UNDER'
                    ? v2EdgeUnderPp1p
                    : v2EdgeOverPp1p;
                if (
                  typeof v2EdgeForDir1p === 'number' &&
                  Number.isFinite(v2EdgeForDir1p) &&
                  v2EdgeForDir1p < 0
                ) {
                  console.warn(
                    `[${JOB_NAME}] [v2-veto-1p] Downgraded ${playerName} 1P FIRE→WATCH (V2 edge_${firstPeriodEdge.direction.toLowerCase()}_pp=${v2EdgeForDir1p.toFixed(4)} < 0)`,
                  );
                  firstPeriodDecision = {
                    action: 'HOLD',
                    status: 'WATCH',
                    classification: 'LEAN',
                    officialStatus: 'LEAN',
                  };
                }
              }

              const l5FairValue1p = calcFairLine1p({ l5Sog, shotsPer60, projToi });
              const fairLine1p = roundToHalfLine(l5FairValue1p) ?? syntheticLine1p;
              const matchupEdge1p = Math.round((mu1p - l5FairValue1p) * 10) / 10;
              const firstPeriodDirectionLabel =
                firstPeriodEdge.direction === 'OVER' ? 'Over' : 'Under';
              const firstPeriodRecommendationPrefix =
                firstPeriodDecision.action === 'FIRE'
                  ? 'Play'
                  : firstPeriodDecision.action === 'HOLD'
                    ? 'Lean'
                    : 'Pass';
              const firstPeriodFlags = [
                ...(firstPeriodV2Projection.flags ?? []),
                ...sharedPropFlags,
                ...(firstPeriodV2AnomalyDetected ? ['PROJECTION_ANOMALY'] : []),
                ...(!realPropLine1p ? ['SYNTHETIC_LINE'] : []),
              ];

              if (
                (firstPeriodEdge.tier === 'HOT' ||
                  firstPeriodEdge.tier === 'WATCH') &&
                firstPeriodDecision.action !== 'PASS'
              ) {
                const cardId1p = `nhl-player-sog-${player.player_id}-${resolvedGameId}-1p-${uuidV4().slice(0, 8)}`;

                const payloadData1p = {
                  sport: 'NHL',
                  home_team: homeTeam,
                  away_team: awayTeam,
                  game_time_utc: game.game_time_utc,
                  card_type: 'nhl-player-shots-1p',
                  tier: firstPeriodEdge.tier,
                  availability_tier: playerAvailabilityTier,
                  card_status: 'active',
                  model_name: 'nhl-player-shots-v1',
                  model_version: '1.0.0',
                  action: firstPeriodDecision.action,
                  status: firstPeriodDecision.status,
                  classification: firstPeriodDecision.classification,
                  // Required by basePayloadSchema
                  prediction: `${firstPeriodRecommendationPrefix} ${playerName} ${firstPeriodDirectionLabel} ${syntheticLine1p} SOG (1P) | Proj ${mu1p.toFixed(1)} · Fair ${fairLine1p} · Edge ${formatSignedEdge(matchupEdge1p)}`,
                  confidence: firstPeriodConfidence,
                  recommended_bet_type: 'unknown',
                  generated_at: timestamp,
                  suggested_line: fairLine1p,
                  threshold: fairLine1p,
                  decision_v2: {
                    // Projection-delta percent vs. line; pricing edge lives in edge_over_pp / edge_under_pp.
                    official_status: firstPeriodDecision.officialStatus,
                    direction: firstPeriodEdge.direction,
                    edge_delta_pct: computeEdgePct(mu1p, syntheticLine1p),
                    fair_line: fairLine1p,
                  },
                  // PROP-specific
                  play: {
                    action: firstPeriodDecision.action,
                    status: firstPeriodDecision.status,
                    classification: firstPeriodDecision.classification,
                    decision_v2: {
                      official_status: firstPeriodDecision.officialStatus,
                      direction: firstPeriodEdge.direction,
                      edge_delta_pct: computeEdgePct(mu1p, syntheticLine1p),
                      fair_line: fairLine1p,
                    },
                    pick_string: `${firstPeriodRecommendationPrefix} ${playerName} ${firstPeriodDirectionLabel} ${syntheticLine1p} SOG (1P) | Proj ${mu1p.toFixed(1)} · Fair ${fairLine1p} · Edge ${formatSignedEdge(matchupEdge1p)}`,
                    market_type: 'PROP',
                    player_name: playerName,
                    player_id: player.player_id.toString(),
                    prop_type: 'shots_on_goal',
                    period: 'first_period',
                    selection: {
                      side:
                        firstPeriodEdge.direction === 'OVER' ? 'over' : 'under',
                      line: syntheticLine1p,
                      price: firstPeriodEdge.direction === 'OVER' ? (overPrice1p ?? -110) : (underPrice1p ?? -110),
                      team: player.team_abbrev,
                      player_name: playerName,
                      player_id: player.player_id.toString(),
                    },
                  },
                  decision: {
                    projection: Math.round(mu1p * 100) / 100,
                    fair_line: fairLine1p,
                    matchup_edge: matchupEdge1p,
                    edge_pct: computeEdgePct(mu1p, syntheticLine1p),
                    model_projection: mu1p,
                    market_line: syntheticLine1p,
                    direction: firstPeriodEdge.direction,
                    confidence: firstPeriodConfidence,
                    market_line_source: realPropLine1p ? 'odds_api' : 'synthetic_fallback',
                    consistency_score:
                      Math.round(firstPeriodConsistencyScore * 1000) / 1000,
                    matchup_score:
                      Math.round(firstPeriodMatchupScore * 1000) / 1000,
                    support_score:
                      Math.round(firstPeriodSupportScore * 1000) / 1000,
                    v2: {
                      flags: firstPeriodFlags,
                    },
                  },
                  drivers: {
                    l5_avg_1p: (l5Sog.reduce((a, b) => a + b, 0) / 5) * 0.32,
                    l5_fair_value_1p: Math.round(l5FairValue1p * 100) / 100,
                    l5_sog: l5Sog,
                    shots_per_60: shotsPer60,
                    proj_toi: projToi,
                    is_home: isHome,
                    opponent_factor: opponentFactor,
                    pace_factor: paceFactor,
                    consistency_score:
                      Math.round(firstPeriodConsistencyScore * 1000) / 1000,
                    matchup_score:
                      Math.round(firstPeriodMatchupScore * 1000) / 1000,
                  },
                };

                const edgePct1p = computeEdgePct(mu1p, syntheticLine1p);
                applyNhlDecisionBasisMeta(payloadData1p, {
                  usingRealLine: !!realPropLine1p,
                  edgePct: edgePct1p,
                });
                if (!realPropLine1p && payloadData1p.decision_basis_meta) {
                  payloadData1p.decision_basis_meta.market_line_source = 'synthetic_fallback';
                }

                const card1p = {
                  id: cardId1p,
                  gameId: resolvedGameId,
                  sport: 'NHL',
                  cardType: 'nhl-player-shots-1p',
                  cardTitle: `${playerName} Shots on Goal (1P)`,
                  createdAt: timestamp,
                  payloadData: payloadData1p,
                };
                attachRunId(card1p, jobRunId);

                try {
                  insertCardPayload(card1p);
                  cardsCreated++;
                  console.log(
                    `[${JOB_NAME}] ✓ Created ${firstPeriodEdge.tier} 1P card: ${playerName} ${firstPeriodEdge.direction} ${syntheticLine1p} (fair ${fairLine1p}, conf ${Math.round(firstPeriodConfidence * 100)}%)`,
                  );
                } catch (insertErr) {
                  console.error(
                    `[${JOB_NAME}] Failed to insert 1P card: ${insertErr.message}`,
                  );
                }
              } else if (firstPeriodDecision.action === 'PASS') {
                console.log(
                  `[${JOB_NAME}] Skipping 1P ${playerName} ${firstPeriodEdge.direction} ${syntheticLine1p}: PASS (consistency=${firstPeriodConsistencyScore.toFixed(2)}, matchup=${firstPeriodMatchupScore.toFixed(2)})`,
                );
              }
            }
            }

            if (blkEnabled && hasBlkLookback) {
              const blkGames = playerBlkLookbackGames.slice(0, 5);
              const l5Blk = blkGames.map((g) => Number(g.blocked_shots) || 0);
              const l5BlkMean = computeL5Mean(l5Blk);
              let blkTotalToi = playerBlkLookbackGames[0]?.toi_minutes || null;

              if (playerBlkLookbackGames[0]?.raw_data) {
                try {
                  const rawData = JSON.parse(playerBlkLookbackGames[0].raw_data);
                  if (Number.isFinite(rawData.projToi) && rawData.projToi > 0) {
                    blkTotalToi = rawData.projToi;
                  }
                } catch {
                  // ignore legacy parse failures
                }
              }

              const blkRateRow = db.prepare(`
                SELECT *
                FROM player_blk_rates
                WHERE nhl_player_id = ?
                  AND season = ?
                LIMIT 1
              `).get(String(player.player_id), nhlSeasonKey);

              if (!blkRateRow) {
                console.warn(`[run-nhl-player-shots-model] WARN: no player_blk_rates row for player ${player.player_id} season ${nhlSeasonKey} — BLK mu will be 0`);
              }

              const blkLineCandidates = EVENT_PRICING_DISABLED
                ? []
                : resolvePlayerPropLineCandidatesWithFallback({
                  db,
                  sport: 'NHL',
                  gameId: resolvedGameId,
                  playerName,
                  propType: 'blocked_shots',
                  period: 'full_game',
                });
              const blkMarket =
                blkLineCandidates[0] || (
                  EVENT_PRICING_DISABLED
                    ? {
                        line: Math.max(
                          0.5,
                          Math.round(Math.max(l5BlkMean || 0.5, 0.5) * 2) / 2,
                        ),
                        over_price: null,
                        under_price: null,
                        bookmaker: null,
                      }
                    : null
                );

              if (blkMarket) {
                const blkUsingRealLine =
                  !EVENT_PRICING_DISABLED &&
                  blkLineCandidates.length > 0 &&
                  blkMarket.over_price != null &&
                  blkMarket.under_price != null;
                const blkToiProjPk =
                  Number.isFinite(blkRateRow?.pk_toi_per_game) &&
                  blkRateRow.pk_toi_per_game > 0
                    ? blkRateRow.pk_toi_per_game
                    : 0;
                const blkToiProjEv = Math.max(
                  (Number.isFinite(blkTotalToi) ? blkTotalToi : 0) - blkToiProjPk,
                  0,
                );
                const blkLeanSide =
                  Number.isFinite(l5BlkMean) && Number.isFinite(blkMarket.line)
                    ? l5BlkMean >= Math.ceil(blkMarket.line)
                      ? 'OVER'
                      : 'UNDER'
                    : 'OVER';
                // BLK: playoff tightening — games in NHL playoff window (Apr 19 – Jun 30) get 1.06 boost.
                const blkGameDate = new Date(game.game_time_utc);
                const blkGameMonth = blkGameDate.getUTCMonth() + 1; // 1-12
                const blkGameDay = blkGameDate.getUTCDate();
                const blkInPlayoffs =
                  (blkGameMonth === 4 && blkGameDay >= 19) ||
                  blkGameMonth === 5 ||
                  blkGameMonth === 6;
                const blkPlayoffFactor = blkInPlayoffs ? 1.06 : 1.0;

                const blkProjection = projectBlkV1({
                  player_id: player.player_id,
                  game_id: resolvedGameId,
                  ev_blocks_season_per60: blkRateRow?.ev_blocks_season_per60 ?? null,
                  ev_blocks_l10_per60: blkRateRow?.ev_blocks_l10_per60 ?? null,
                  ev_blocks_l5_per60: blkRateRow?.ev_blocks_l5_per60 ?? null,
                  pk_blocks_season_per60: blkRateRow?.pk_blocks_season_per60 ?? null,
                  pk_blocks_l10_per60: blkRateRow?.pk_blocks_l10_per60 ?? null,
                  pk_blocks_l5_per60: blkRateRow?.pk_blocks_l5_per60 ?? null,
                  toi_proj_ev: blkToiProjEv,
                  toi_proj_pk: blkToiProjPk,
                  role_stability: roleStability,
                  market_line: blkMarket.line,
                  market_price_over: blkMarket.over_price,
                  market_price_under: blkMarket.under_price,
                  play_direction: blkLeanSide,
                  opponent_attempt_factor: blkOppAttemptFactor,
                  playoff_tightening_factor: blkPlayoffFactor,
                });
                const blkConfidence = Math.max(
                  0.55,
                  Math.min(
                    0.8,
                    0.55 + Math.abs((blkProjection.blk_mu ?? 0) - blkMarket.line) * 0.08,
                  ),
                );
                const blkFlags = Array.from(new Set(blkProjection.flags ?? []));
                let blkPropDecision = buildCanonicalPropDecision({
                  projection: blkProjection.blk_mu,
                  marketLine: blkMarket.line,
                  marketPriceOver: blkMarket.over_price,
                  marketPriceUnder: blkMarket.under_price,
                  fairOverProb:
                    blkProjection.fair_over_prob_by_line?.[String(blkMarket.line)] ?? null,
                  fairUnderProb:
                    blkProjection.fair_under_prob_by_line?.[String(blkMarket.line)] ?? null,
                  impliedOverProb:
                    blkMarket.over_price != null
                      ? americanToImplied(blkMarket.over_price)
                      : null,
                  impliedUnderProb:
                    blkMarket.under_price != null
                      ? americanToImplied(blkMarket.under_price)
                      : null,
                  edgeOverPp: blkProjection.edge_over_pp,
                  edgeUnderPp: blkProjection.edge_under_pp,
                  evOver: blkProjection.ev_over,
                  evUnder: blkProjection.ev_under,
                  opportunityScore: blkProjection.opportunity_score,
                  confidence: blkConfidence,
                  roleStability: blkProjection.role_stability ?? roleStability,
                  l5Mean: l5BlkMean,
                  flags: blkFlags,
                  usingRealLine: blkUsingRealLine,
                });

                if (blkFlags.includes('LOW_SAMPLE')) {
                  blkPropDecision = {
                    ...blkPropDecision,
                    verdict: 'PROJECTION',
                    why: 'Projection only — missing NST blocked-shot rates',
                    flags: Array.from(new Set([...(blkPropDecision.flags || []), 'LOW_SAMPLE'])),
                  };
                }
                if (!blkUsingRealLine) {
                  blkPropDecision = {
                    ...blkPropDecision,
                    verdict: 'PROJECTION',
                    why: 'Projection only — event-priced blocked-shot market disabled',
                    flags: Array.from(
                      new Set([...(blkPropDecision.flags || []), 'SYNTHETIC_LINE']),
                    ),
                  };
                }

                const blkLegacyDecision = deriveLegacyActionFromVerdict(
                  blkPropDecision.verdict,
                );
                const blkResolvedLean = blkPropDecision.lean_side || blkLeanSide;
                const blkFairLine = roundToHalfLine(blkProjection.blk_mu) ?? blkMarket.line;
                const blkPrediction = `${playerName} ${blkResolvedLean} ${blkMarket.line} BLK | Proj ${blkProjection.blk_mu.toFixed(1)} · Fair ${blkFairLine}`;
                const blkCardId = `nhl-player-blk-${player.player_id}-${resolvedGameId}-${uuidV4().slice(0, 8)}`;
                const payloadDataBlk = {
                  sport: 'NHL',
                  home_team: homeTeam,
                  away_team: awayTeam,
                  game_time_utc: game.game_time_utc,
                  card_type: 'nhl-player-blk',
                  canonical_market_key: 'player_blocked_shots',
                  tier:
                    blkPropDecision.verdict === 'PLAY'
                      ? 'HOT'
                      : blkPropDecision.verdict === 'WATCH'
                        ? 'WATCH'
                        : 'COLD',
                  availability_tier: playerAvailabilityTier,
                  card_status: 'active',
                  model_name: 'nhl-player-blk-v1',
                  model_version: '1.0.0',
                  action: blkLegacyDecision.action,
                  status: blkLegacyDecision.status,
                  classification: blkLegacyDecision.classification,
                  prediction: blkPrediction,
                  confidence: blkConfidence,
                  recommended_bet_type: 'unknown',
                  generated_at: timestamp,
                  suggested_line: blkFairLine,
                  threshold: blkFairLine,
                  prop_decision: blkPropDecision,
                  prop_display_state: computePropDisplayStateFromVerdict(
                    blkPropDecision.verdict,
                  ),
                  mu: blkProjection.blk_mu,
                  projectedTotal: blkProjection.blk_mu,
                  l5_mean: l5BlkMean,
                  l5_sog: l5Blk,
                  line: blkMarket.line,
                  market_price_over: blkMarket.over_price,
                  market_price_under: blkMarket.under_price,
                  market_bookmaker: blkMarket.bookmaker ?? null,
                  price:
                    blkResolvedLean === 'OVER'
                      ? blkMarket.over_price
                      : blkMarket.under_price,
                  player_name: playerName,
                  player_id: player.player_id.toString(),
                  team_abbr: player.team_abbrev ?? null,
                  reasoning: blkPropDecision.why,
                  decision_v2: {
                    official_status: blkLegacyDecision.officialStatus,
                    direction: blkResolvedLean,
                    edge_delta_pct: computeEdgePct(blkProjection.blk_mu, blkMarket.line),
                    fair_line: blkFairLine,
                  },
                  play: {
                    action: blkLegacyDecision.action,
                    status: blkLegacyDecision.status,
                    classification: blkLegacyDecision.classification,
                    decision_v2: {
                      official_status: blkLegacyDecision.officialStatus,
                      direction: blkResolvedLean,
                      edge_delta_pct: computeEdgePct(blkProjection.blk_mu, blkMarket.line),
                      fair_line: blkFairLine,
                    },
                    prop_decision: blkPropDecision,
                    pick_string: blkPrediction,
                    market_type: 'PROP',
                    player_name: playerName,
                    player_id: player.player_id.toString(),
                    prop_type: 'blocked_shots',
                    period: 'full_game',
                    canonical_market_key: 'player_blocked_shots',
                    selection: {
                      side: blkResolvedLean === 'OVER' ? 'over' : 'under',
                      line: blkMarket.line,
                      price:
                        blkResolvedLean === 'OVER'
                          ? blkMarket.over_price
                          : blkMarket.under_price,
                      team: player.team_abbrev,
                      player_name: playerName,
                      player_id: player.player_id.toString(),
                    },
                  },
                  decision: {
                    edge_pct: computeEdgePct(blkProjection.blk_mu, blkMarket.line),
                    projection: Math.round(blkProjection.blk_mu * 100) / 100,
                    fair_line: blkFairLine,
                    market_line: blkMarket.line,
                    direction: blkResolvedLean,
                    confidence: blkConfidence,
                  },
                  drivers: {
                    l5_avg: l5BlkMean,
                    l5_blk: l5Blk,
                    proj_toi_total: blkTotalToi,
                    proj_toi_pk: blkToiProjPk,
                    proj_toi_ev: blkToiProjEv,
                    ev_block_rate: blkProjection.block_rate_ev_per60,
                    pk_block_rate: blkProjection.block_rate_pk_per60,
                    role_stability: blkProjection.role_stability ?? roleStability,
                  },
                };

                if (blkRatesStale) {
                  payloadDataBlk.missing_inputs = ['block_rates_stale'];
                }

                applyNhlDecisionBasisMeta(payloadDataBlk, {
                  usingRealLine: blkUsingRealLine,
                  edgePct: computeEdgePct(blkProjection.blk_mu, blkMarket.line),
                });

                const blkCard = {
                  id: blkCardId,
                  gameId: resolvedGameId,
                  sport: 'NHL',
                  cardType: 'nhl-player-blk',
                  cardTitle: `${playerName} Blocked Shots`,
                  createdAt: timestamp,
                  payloadData: payloadDataBlk,
                };
                attachRunId(blkCard, jobRunId);

                try {
                  insertCardPayload(blkCard);
                  cardsCreated++;
                  console.log(
                    `[${JOB_NAME}] ✓ Created ${blkPropDecision.verdict} BLK card: ${playerName} ${blkResolvedLean} ${blkMarket.line}`,
                  );
                } catch (insertErr) {
                  console.error(
                    `[${JOB_NAME}] Failed to insert BLK card: ${insertErr.message}`,
                  );
                }
              }
            }
          } catch (err) {
            console.error(
              `[${JOB_NAME}] Error processing ${player.player_name}: ${err.message}`,
            );
          }
        }
      }

      const result = {
        gamesProcessed: games.length,
        cardsCreated,
      };

      markJobRunSuccess(jobRunId, result);

      // Gap 7: setCurrentRunId called unconditionally on the success path,
      // regardless of whether any cards were created. This ensures run_state
      // is always updated after a successful model run.
      try {
        setCurrentRunId(jobRunId, 'nhl_props');
      } catch (runStateError) {
        console.error(
          `[${JOB_NAME}] Failed to update run state: ${runStateError.message}`,
        );
      }

      console.log(
        `[${JOB_NAME}] ✅ Job complete: ${cardsCreated} cards created from ${games.length} games`,
      );

      return { success: true, ...result };
    } catch (err) {
      console.error(`[${JOB_NAME}] Job failed:`, err);
      markJobRunFailure(jobRunId, { error: err.message, stack: err.stack });
      return { success: false, error: err.message };
    }
  });
}

// Run if called directly
if (require.main === module) {
  runNHLPlayerShotsModel()
    .then((result) => {
      console.log('[run_nhl_player_shots_model] Result:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('[run_nhl_player_shots_model] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { runNHLPlayerShotsModel };
