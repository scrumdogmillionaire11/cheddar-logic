ajcolubiale@AJs-MacBook-Pro cheddar-logic % wc -l apps/worker/src/jobs/run_nba_model.js apps/worker/src/jobs/run_nhl_model.js apps/worker/src/jobs/run_ncaam_model.js apps/worker/src/models/cross-market.js

cat apps/worker/src/jobs/run_nba_model.js | grep -E "function (computeWinProbHome|buildDriverSummary|generateCard|computeEdge)" | head -20

cat apps/worker/src/models/cross-market.js | tail -200
     783 apps/worker/src/jobs/run_nba_model.js
     830 apps/worker/src/jobs/run_nhl_model.js
     453 apps/worker/src/jobs/run_ncaam_model.js
     845 apps/worker/src/models/cross-market.js
    2911 total
function computeWinProbHome(projectedMargin, sport) {
function buildDriverSummary(descriptor, weightMap) {
  const awayNetRating = avgPtsAway !== null && avgPtsAllowedAway !== null ? avgPtsAway - avgPtsAllowedAway : null;

  const spreadBadNumber = spreadHome !== null && Math.abs(spreadHome) >= 8;

  const spreadDrivers = [
    buildDriver({
      driverKey: 'powerRating',
      weight: 0.40,
      eligible: projectedMargin !== null,
      signal: projectedMargin !== null ? clamp(projectedMargin / 15, -1, 1) : 0,
      status: statusFromNumbers([projectedMargin]),
      note: 'Projected margin favors HOME when positive.'
    }),
    buildDriver({
      driverKey: 'restAdvantage',
      weight: 0.20,
      eligible: restGap !== null,
      signal: restGap !== null ? clamp(restGap / 3, -1, 1) : 0,
      status: statusFromNumbers([restDaysHome, restDaysAway]),
      note: 'Rest gap favors the more rested team.'
    }),
    buildDriver({
      driverKey: 'matchupStyle',
      weight: 0.25,
      eligible: homeNetRating !== null && awayNetRating !== null,
      signal: homeNetRating !== null && awayNetRating !== null
        ? clamp((homeNetRating - awayNetRating) / 10, -1, 1)
        : 0,
      status: statusFromNumbers([avgPtsHome, avgPtsAllowedHome, avgPtsAway, avgPtsAllowedAway]),
      note: 'Net rating differential favors HOME when positive.'
    }),
    buildDriver({
      driverKey: 'blowoutRisk',
      weight: spreadBadNumber ? 0.15 : 0,
      eligible: spreadBadNumber,
      signal: -0.3,
      status: statusFromNumbers([spreadHome]),
      note: 'Risk-only: large spread reduces confidence toward favored side.'
    })
  ];

  const spreadBadNumberPenalty = spreadBadNumber ? 0.06 : 0;

  const spreadDecision = buildMarketDecision({
    market: 'SPREAD',
    defaultSide: 'HOME',
    drivers: spreadDrivers,
    penalties: [{ key: 'bad_number', value: spreadBadNumberPenalty }],
    thresholds: { t_dir: 0.12, t_fire: 0.42, t_watch: 0.22, conflict_cap: 0.22, min_coverage_fire: 0.55, min_coverage_watch: 0.45 },
      edgeResolver: (side) => {
        if (projectedMargin === null || spreadHome === null) return null;
        const spreadEdge = edgeCalculator.computeSpreadEdge({
          projectionMarginHome: projectedMargin,
          spreadLine: spreadHome,
          spreadPriceHome: toNumber(oddsSnapshot?.spread_price_home),
          spreadPriceAway: toNumber(oddsSnapshot?.spread_price_away),
          sigmaMargin: edgeCalculator.getSigmaDefaults('NBA')?.margin ?? 12,
          isPredictionHome: side === 'HOME'
        });
        return spreadEdge.edge;
      },
    fairPriceResolver: null,
    lineResolver: (side) => spreadHome !== null ? (side === 'HOME' ? spreadHome : -spreadHome) : null,
    priceResolver: null,
    riskFlags: spreadBadNumber ? ['BAD_NUMBER'] : []
  });

  return { TOTAL: totalDecision, SPREAD: spreadDecision };
}

function selectExpressionChoice(decisions) {
  const orderedMarkets = [Market.TOTAL, Market.SPREAD, Market.ML];
  const available = orderedMarkets.map((market) => decisions[market]).filter(Boolean);

  if (available.length === 0) {
    return null;
  }

  const statusRank = {
    [DecisionStatus.FIRE]: 2,
    [DecisionStatus.WATCH]: 1,
    [DecisionStatus.PASS]: 0
  };

  const byStatus = [...available].sort((a, b) => statusRank[b.status] - statusRank[a.status]);
  const topStatus = byStatus[0].status;
  const sameStatus = byStatus.filter((decision) => decision.status === topStatus);

  let chosen = sameStatus[0];
  let rule = 'Rule 1: status';

  if (sameStatus.length > 1) {
    const sortedByScore = [...sameStatus].sort((a, b) => b.score - a.score);
    const scoreDiff = sortedByScore[0].score - sortedByScore[1].score;
    if (scoreDiff > 0.10) {
      chosen = sortedByScore[0];
      rule = 'Rule 2: score gap';
    } else {
      const spreadDecision = decisions[Market.SPREAD];
      const mlDecision = decisions[Market.ML];
      const inTie = [spreadDecision, mlDecision].every((decision) => decision && decision.status === topStatus);
      const tightGap = spreadDecision && mlDecision
        ? Math.abs(spreadDecision.score - mlDecision.score) <= 0.05
        : false;

      if (inTie && tightGap) {
        const spreadBadNumber = spreadDecision.risk_flags.includes('BAD_NUMBER');
        const mlCoinflip = mlDecision.risk_flags.includes('COINFLIP_ZONE');
        if (spreadBadNumber && mlCoinflip && (mlDecision.edge ?? 0) > 0) {
          chosen = mlDecision;
          rule = 'Rule 4: ML value realism';
        } else {
          chosen = sortedByScore[0];
          rule = 'Rule 2: score tie';
        }
      } else {
        chosen = orderedMarkets.map((market) => decisions[market]).find((decision) => decision && decision.status === topStatus);
        rule = 'Rule 3: market preference';
      }
    }
  }

  const rejected = orderedMarkets
    .map((market) => decisions[market])
    .filter((decision) => decision && decision.market !== chosen.market)
    .map((decision) => {
      let reason = 'LOWER_SCORE';
      if (decision.status === DecisionStatus.PASS) reason = 'PASS';
      else if (statusRank[decision.status] < statusRank[chosen.status]) reason = 'LOWER_STATUS';
      return { market: decision.market, decision, rejection_reason: reason };
    });

  const alternatives = rejected.reduce((acc, entry) => {
    acc[entry.market] = entry.rejection_reason;
    return acc;
  }, {});

  return {
    chosen_market: chosen.market,
    chosen,
    rejected,
    why_this_market: rule,
    story: {
      chosen_narrative: `${chosen.market} leads on ${rule.toLowerCase()}.`,
      alternatives
    }
  };
}

function buildMarketPayload({ decisions, expressionChoice }) {
  const totalDecision = decisions?.TOTAL;
  const totalEligibleDrivers = (totalDecision?.drivers || []).filter((driver) => driver.eligible).length;
  const hasTotalLine = totalDecision?.best_candidate?.line !== undefined && totalDecision?.best_candidate?.line !== null;
  const hasTotalEdge = typeof totalDecision?.edge === 'number';
  const hasTotalCoverage = typeof totalDecision?.coverage === 'number' && totalDecision.coverage >= 0.45;
  const totalBias =
    totalDecision &&
    totalDecision.status !== DecisionStatus.PASS &&
    totalEligibleDrivers > 0 &&
    hasTotalLine &&
    hasTotalEdge &&
    hasTotalCoverage
      ? 'OK'
      : 'INSUFFICIENT_DATA';

  if (!expressionChoice) {
    return {
      consistency: {
        total_bias: totalBias
      }
    };
  }
  const chosen = expressionChoice.chosen;
  return {
    consistency: {
      total_bias: totalBias
    },
    expression_choice: {
      chosen_market: expressionChoice.chosen_market,
      pick: formatPick(chosen),
      status: chosen.status,
      score: chosen.score,
      net: chosen.net,
      edge: chosen.edge ?? null
    },
    market_narrative: {
      chosen_story: expressionChoice.story.chosen_narrative,
      alternatives: expressionChoice.story.alternatives,
      orchestration: expressionChoice.why_this_market
    },
    all_markets: decisions
  };
}

module.exports = {
  computeNHLMarketDecisions,
  computeNBAMarketDecisions,
  selectExpressionChoice,
  buildMarketPayload
};