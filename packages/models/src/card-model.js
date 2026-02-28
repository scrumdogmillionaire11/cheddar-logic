const RecommendationType = Object.freeze({
  PASS: 'PASS',
  TOTAL_OVER: 'TOTAL_OVER',
  TOTAL_UNDER: 'TOTAL_UNDER',
  SPREAD_HOME: 'SPREAD_HOME',
  SPREAD_AWAY: 'SPREAD_AWAY',
  ML_HOME: 'ML_HOME',
  ML_AWAY: 'ML_AWAY'
});

const PassReason = Object.freeze({
  NONE: '',
  DRIVER_CONTRADICTED_BY_MATCHUP: 'Driver signal contradicted by matchup analysis',
  MISSING_INPUTS: 'Required data unavailable',
  EDGE_SANITY_FAIL: 'Edge too large without corroboration',
  NO_MARKET_DATA: 'No market line available',
  INSUFFICIENT_CONFIDENCE: 'Confidence below threshold',
  INJURY_UNCERTAINTY: 'Key injury status unclear',
  CLOSE_LINE: 'Line too close to projection',
  TIME_CONSTRAINEDPASS: 'Game time constraint violation',
  MODEL_DISAGREEMENT: 'Multiple models disagree significantly'
});

const EdgeUnits = Object.freeze({
  POINTS: 'pts',
  PROBABILITY: 'prob',
  EXPECTED_VALUE: 'ev'
});

function calculateTotalEdge(recommendationType, projTotal, marketTotalLine) {
  if (projTotal == null || marketTotalLine == null) return null;
  if (recommendationType === RecommendationType.TOTAL_OVER) {
    return roundTo(projTotal - marketTotalLine, 1);
  }
  if (recommendationType === RecommendationType.TOTAL_UNDER) {
    return roundTo(marketTotalLine - projTotal, 1);
  }
  return null;
}

function calculateSpreadEdge(recommendationType, projMarginHome, marketSpreadHome) {
  if (projMarginHome == null || marketSpreadHome == null) return null;
  if (recommendationType === RecommendationType.SPREAD_AWAY) {
    return roundTo(Math.abs(marketSpreadHome) - projMarginHome, 1);
  }
  if (recommendationType === RecommendationType.SPREAD_HOME) {
    return roundTo(projMarginHome - Math.abs(marketSpreadHome), 1);
  }
  return null;
}

function oddsToProbability(americanOdds) {
  if (americanOdds == null) return null;
  const odds = Number.parseInt(americanOdds, 10);
  if (Number.isNaN(odds)) return null;
  if (odds < 0) {
    return Math.abs(odds) / (Math.abs(odds) + 100);
  }
  return 100 / (odds + 100);
}

function calculateMoneylineEdge(recommendationType, projWinProbHome, marketMoneylineHome, marketMoneylineAway) {
  if (projWinProbHome == null) return null;
  if (recommendationType === RecommendationType.ML_HOME) {
    if (marketMoneylineHome == null) return null;
    const implied = oddsToProbability(marketMoneylineHome);
    if (implied == null) return null;
    return roundTo(projWinProbHome - implied, 3);
  }
  if (recommendationType === RecommendationType.ML_AWAY) {
    if (marketMoneylineAway == null) return null;
    const implied = oddsToProbability(marketMoneylineAway);
    if (implied == null) return null;
    return roundTo((1 - projWinProbHome) - implied, 3);
  }
  return null;
}

function marginToWinProbability(marginHome, sigma = 12.0) {
  const z = marginHome / sigma;
  return 0.5 * (1 + erf(z / Math.sqrt(2.0)));
}

function buildRecommendationFromPrediction({ prediction, recommendedBetType }) {
  if (!prediction || prediction === 'PASS') {
    return {
      type: RecommendationType.PASS,
      text: 'PASS',
      pass_reason: PassReason.INSUFFICIENT_CONFIDENCE
    };
  }

  const betType = (recommendedBetType || '').toLowerCase();
  const pred = prediction.toUpperCase();

  if (betType === 'moneyline' || betType === 'ml') {
    if (pred === 'HOME') {
      return { type: RecommendationType.ML_HOME, text: 'HOME ML', pass_reason: null };
    }
    if (pred === 'AWAY') {
      return { type: RecommendationType.ML_AWAY, text: 'AWAY ML', pass_reason: null };
    }
  }

  if (betType === 'spread' || betType === 'puck_line') {
    if (pred === 'HOME') {
      return { type: RecommendationType.SPREAD_HOME, text: 'HOME SPREAD', pass_reason: null };
    }
    if (pred === 'AWAY') {
      return { type: RecommendationType.SPREAD_AWAY, text: 'AWAY SPREAD', pass_reason: null };
    }
  }

  if (betType === 'total') {
    if (pred === 'OVER') {
      return { type: RecommendationType.TOTAL_OVER, text: 'OVER TOTAL', pass_reason: null };
    }
    if (pred === 'UNDER') {
      return { type: RecommendationType.TOTAL_UNDER, text: 'UNDER TOTAL', pass_reason: null };
    }
  }

  return {
    type: RecommendationType.PASS,
    text: 'PASS',
    pass_reason: PassReason.NO_MARKET_DATA
  };
}

function buildMatchup(homeTeam, awayTeam) {
  if (!homeTeam || !awayTeam) return null;
  return `${awayTeam} @ ${homeTeam}`;
}

function formatStartTimeLocal(startTimeUtc, timeZone = 'UTC') {
  if (!startTimeUtc) return { start_time_local: null, timezone: null };
  const date = new Date(startTimeUtc);
  return {
    start_time_local: date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: 'short'
    }),
    timezone: timeZone
  };
}

function formatCountdown(startTimeUtc) {
  if (!startTimeUtc) return null;
  const now = new Date();
  const game = new Date(startTimeUtc);
  const diff = game.getTime() - now.getTime();
  if (diff <= 0) return 'Game in progress or finished';

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) {
    return `in ${hours}h ${minutes}m`;
  }
  return `in ${minutes}m`;
}

function buildMarketFromOdds(oddsSnapshot) {
  if (!oddsSnapshot) return null;
  return {
    total_line: oddsSnapshot.total ?? null,
    spread_home: oddsSnapshot.spread_home ?? null,
    moneyline_home: oddsSnapshot.h2h_home != null ? formatAmerican(oddsSnapshot.h2h_home) : null,
    moneyline_away: oddsSnapshot.h2h_away != null ? formatAmerican(oddsSnapshot.h2h_away) : null
  };
}

function formatAmerican(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (Number.isFinite(value)) {
    return value > 0 ? `+${value}` : `${value}`;
  }
  return null;
}

function roundTo(value, decimals) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}

function validateCardOutput(card) {
  const errors = [];
  if (!card || !card.recommendation) {
    errors.push('recommendation is required');
    return errors;
  }
  if (card.recommendation.type === RecommendationType.PASS) {
    if (card.edge != null && card.edge.value != null) {
      errors.push('PASS recommendation must have edge.value = null');
    }
    if (!card.recommendation.pass_reason) {
      errors.push('PASS recommendation must have a pass_reason');
    }
  } else if (card.recommendation.pass_reason) {
    errors.push('Non-PASS recommendation should not have a pass_reason');
  }
  return errors;
}

module.exports = {
  RecommendationType,
  PassReason,
  EdgeUnits,
  calculateTotalEdge,
  calculateSpreadEdge,
  calculateMoneylineEdge,
  oddsToProbability,
  marginToWinProbability,
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds,
  validateCardOutput
};
