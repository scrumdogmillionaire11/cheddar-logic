const {
  Market,
  DecisionStatus,
  renormalizeDriverWeights,
  computeConflict,
  computeCoverage,
  marginToWinProbability,
  oddsToProbability
} = require('@cheddar-logic/models');

const { projectNHL, projectNBA } = require('./projections');
const { analyzePaceSynergy } = require('./nba-pace-synergy');

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRawData(rawData) {
  if (!rawData) return {};
  if (typeof rawData === 'object') return rawData;
  if (typeof rawData !== 'string') return {};
  try {
    return JSON.parse(rawData);
  } catch {
    return {};
  }
}

function statusFromNumbers(values) {
  const present = values.filter((value) => value !== null && value !== undefined).length;
  if (present === values.length && values.length > 0) return 'ok';
  if (present > 0) return 'partial';
  return 'missing';
}

function buildDriver({ driverKey, weight, eligible, signal, status, note }) {
  return {
    driverKey,
    weight,
    eligible,
    signal,
    contrib: eligible ? signal * weight : 0,
    status,
    note
  };
}

function applyDirection(drivers, direction) {
  return drivers.map((driver) => {
    if (!driver.eligible) {
      return { ...driver, signal: 0, contrib: 0 };
    }
    const adjustedSignal = driver.signal * direction;
    return {
      ...driver,
      signal: adjustedSignal,
      contrib: adjustedSignal * driver.weight
    };
  });
}

function computeNet(drivers) {
  return Number(drivers.reduce((sum, driver) => sum + (driver.eligible ? driver.contrib : 0), 0).toFixed(3));
}

function selectStatus({ score, conflict, coverage, thresholds }) {
  const { t_fire, t_watch, conflict_cap, min_coverage_fire, min_coverage_watch } = thresholds;
  let maxStatus = DecisionStatus.FIRE;
  if (conflict > 0.30) {
    maxStatus = DecisionStatus.PASS;
  } else if (conflict > conflict_cap) {
    maxStatus = DecisionStatus.WATCH;
  }

  if (score >= t_fire && conflict <= conflict_cap && coverage >= min_coverage_fire) {
    return maxStatus === DecisionStatus.FIRE ? DecisionStatus.FIRE : maxStatus;
  }
  if (score >= t_watch && coverage >= min_coverage_watch) {
    return maxStatus === DecisionStatus.PASS ? DecisionStatus.PASS : DecisionStatus.WATCH;
  }
  return DecisionStatus.PASS;
}

function buildReasoning({ status, score, conflict, coverage, topDrivers }) {
  const driverNote = topDrivers.length ? ` Drivers: ${topDrivers.join(', ')}.` : '';
  return `Status ${status} (score ${score.toFixed(2)}, conflict ${conflict.toFixed(2)}, coverage ${coverage.toFixed(2)}).${driverNote}`;
}

function oppositeSide(side) {
  if (side === 'OVER') return 'UNDER';
  if (side === 'UNDER') return 'OVER';
  if (side === 'HOME') return 'AWAY';
  if (side === 'AWAY') return 'HOME';
  return side;
}

function buildMarketDecision({
  market,
  defaultSide,
  drivers,
  penalties,
  thresholds,
  edgeResolver,
  fairPriceResolver,
  lineResolver,
  priceResolver,
  riskFlags
}) {
  const normalized = renormalizeDriverWeights(drivers);
  const baseNet = computeNet(applyDirection(normalized, 1));
  const direction = baseNet >= 0 ? 1 : -1;
  const candidateSide = direction === 1 ? defaultSide : oppositeSide(defaultSide);
  const directed = applyDirection(normalized, direction);
  const net = Math.abs(computeNet(directed));
  const conflict = computeConflict(directed);
  const coverage = computeCoverage(directed);
  const sumPenalties = penalties.reduce((sum, penalty) => sum + penalty.value, 0);
  const score = Number((net - sumPenalties).toFixed(3));

  const status = net < thresholds.t_dir
    ? DecisionStatus.PASS
    : selectStatus({ score, conflict, coverage, thresholds });

  const topDrivers = directed
    .filter((driver) => driver.eligible)
    .sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal))
    .slice(0, 3)
    .map((driver) => `${driver.driverKey}:${driver.signal.toFixed(2)}`);

  const flags = [...riskFlags];
  if (coverage < thresholds.min_coverage_watch) flags.push('LOW_COVERAGE');
  if (conflict > thresholds.conflict_cap) flags.push('CONFLICT_HIGH');

  const edge = edgeResolver ? edgeResolver(candidateSide) : null;
  const fairPrice = fairPriceResolver ? fairPriceResolver(candidateSide) : null;
  const line = lineResolver ? lineResolver(candidateSide) : null;
  const price = priceResolver ? priceResolver(candidateSide) : null;

  return {
    market,
    best_candidate: {
      side: candidateSide,
      line: line ?? undefined,
      price: price ?? undefined
    },
    status,
    score,
    net,
    conflict,
    coverage,
    edge: edge ?? undefined,
    fair_price: fairPrice ?? undefined,
    drivers: directed,
    risk_flags: flags,
    reasoning: buildReasoning({ status, score, conflict, coverage, topDrivers })
  };
}

function formatPick(decision) {
  const { side, line, price } = decision.best_candidate;
  if (decision.market === Market.TOTAL) {
    const lineText = line != null ? ` ${line}` : '';
    return `${side === 'OVER' ? 'Over' : 'Under'}${lineText}`.trim();
  }
  if (decision.market === Market.SPREAD) {
    const lineText = line != null ? ` ${line > 0 ? `+${line}` : line}` : '';
    return `${side === 'HOME' ? 'Home' : 'Away'}${lineText}`.trim();
  }
  if (decision.market === Market.ML) {
    const priceText = price != null ? ` ${price}` : '';
    return `${side === 'HOME' ? 'Home' : 'Away'}${priceText}`.trim();
  }
  return side;
}

function computeNHLMarketDecisions(oddsSnapshot) {
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const totalLine = toNumber(oddsSnapshot?.total);
  const spreadHome = toNumber(oddsSnapshot?.spread_home);
  const moneylineHome = toNumber(oddsSnapshot?.h2h_home);
  const moneylineAway = toNumber(oddsSnapshot?.h2h_away);

  const goalsForHome = toNumber(raw?.espn_metrics?.home?.metrics?.avgGoalsFor ?? raw?.goals_for_home ?? null);
  const goalsForAway = toNumber(raw?.espn_metrics?.away?.metrics?.avgGoalsFor ?? raw?.goals_for_away ?? null);
  const goalsAgainstHome = toNumber(raw?.espn_metrics?.home?.metrics?.avgGoalsAgainst ?? raw?.goals_against_home ?? null);
  const goalsAgainstAway = toNumber(raw?.espn_metrics?.away?.metrics?.avgGoalsAgainst ?? raw?.goals_against_away ?? null);

  const restDaysHome = toNumber(raw?.espn_metrics?.home?.metrics?.restDays ?? raw?.rest_days_home ?? null);
  const restDaysAway = toNumber(raw?.espn_metrics?.away?.metrics?.restDays ?? raw?.rest_days_away ?? null);

  const goalieHomeGsax = toNumber(raw?.goalie_home_gsax ?? raw?.goalie?.home?.gsax ?? raw?.goalies?.home?.gsax);
  const goalieAwayGsax = toNumber(raw?.goalie_away_gsax ?? raw?.goalie?.away?.gsax ?? raw?.goalies?.away?.gsax);
  const goalieSum = goalieHomeGsax !== null && goalieAwayGsax !== null ? goalieHomeGsax + goalieAwayGsax : null;

  const pulledHomeSec = toNumber(raw?.empty_net_pull_home_sec ?? raw?.empty_net?.home_pull_seconds_remaining);
  const pulledAwaySec = toNumber(raw?.empty_net_pull_away_sec ?? raw?.empty_net?.away_pull_seconds_remaining);
  const pullAvg = pulledHomeSec !== null && pulledAwaySec !== null ? (pulledHomeSec + pulledAwaySec) / 2 : null;

  const ppHome = toNumber(raw?.pp_home_pct ?? raw?.special_teams?.home?.pp_pct);
  const pkHome = toNumber(raw?.pk_home_pct ?? raw?.special_teams?.home?.pk_pct);
  const ppAway = toNumber(raw?.pp_away_pct ?? raw?.special_teams?.away?.pp_pct);
  const pkAway = toNumber(raw?.pk_away_pct ?? raw?.special_teams?.away?.pk_pct);

  const pdoHome = toNumber(raw?.pdo_home ?? raw?.teams?.home?.pdo);
  const pdoAway = toNumber(raw?.pdo_away ?? raw?.teams?.away?.pdo);

  const xgfHome = toNumber(raw?.xgf_home_pct ?? raw?.teams?.home?.xgf_pct ?? raw?.xgf?.home_pct);
  const xgfAway = toNumber(raw?.xgf_away_pct ?? raw?.teams?.away?.xgf_pct ?? raw?.xgf?.away_pct);

  const projection = projectNHL(
    goalsForHome,
    goalsAgainstHome,
    goalsForAway,
    goalsAgainstAway,
    goalieHomeGsax !== null,
    goalieAwayGsax !== null
  );
  const projectedMargin = projection.homeProjected != null && projection.awayProjected != null
    ? projection.homeProjected - projection.awayProjected
    : null;
  const projectedTotal = projection.totalProjected ?? null;

  const restGap = restDaysHome !== null && restDaysAway !== null ? restDaysHome - restDaysAway : null;
  const restAvg = restDaysHome !== null && restDaysAway !== null ? (restDaysHome + restDaysAway) / 2 : null;

  const goalieSignal = goalieSum === null ? 0 : clamp(-goalieSum / 6, -1, 1);
  const emptyNetSignal = pullAvg === null ? 0 : clamp((pullAvg - 60) / 60, -1, 1);
  const powerPlayEnvSignal = [ppHome, pkHome, ppAway, pkAway].every((value) => value !== null)
    ? clamp(((ppHome + ppAway) - (pkHome + pkAway)) / 40, -1, 1)
    : 0;
  const pdoAvg = pdoHome !== null && pdoAway !== null ? (pdoHome + pdoAway) / 2 : null;
  const pdoSignal = pdoAvg === null ? 0 : clamp((1 - pdoAvg) / 0.04, -1, 1);
  const shotQualitySignal = xgfHome !== null && xgfAway !== null
    ? clamp(((xgfHome + xgfAway) - 100) / 20, -1, 1)
    : 0;
  const restSignalTotal = restAvg === null ? 0 : clamp((1.5 - restAvg) / 3, -1, 1);

  const paceValue = toNumber(raw?.pace ?? raw?.shot_pace ?? null);
  const paceSignal = paceValue === null ? 0 : clamp((paceValue - 100) / 15, -1, 1);

  const totalDrivers = [
    buildDriver({
      driverKey: 'goalie_quality',
      weight: 0.18,
      eligible: goalieSum !== null,
      signal: goalieSignal,
      status: statusFromNumbers([goalieHomeGsax, goalieAwayGsax]),
      note: 'Combined goalie quality signal (higher quality favors UNDER).'
    }),
    buildDriver({
      driverKey: 'empty_net_propensity',
      weight: 0.08,
      eligible: pullAvg !== null,
      signal: emptyNetSignal,
      status: statusFromNumbers([pulledHomeSec, pulledAwaySec]),
      note: 'Earlier pull behavior increases late scoring (OVER bias).'
    }),
    buildDriver({
      driverKey: 'pace',
      weight: 0.18,
      eligible: paceValue !== null,
      signal: paceSignal,
      status: statusFromNumbers([paceValue]),
      note: 'Higher pace increases total scoring.'
    }),
    buildDriver({
      driverKey: 'powerPlayEnv',
      weight: 0.16,
      eligible: [ppHome, pkHome, ppAway, pkAway].every((value) => value !== null),
      signal: powerPlayEnvSignal,
      status: statusFromNumbers([ppHome, pkHome, ppAway, pkAway]),
      note: 'Combined PP/PK environment for total scoring.'
    }),
    buildDriver({
      driverKey: 'pdoRegression',
      weight: 0.12,
      eligible: pdoAvg !== null,
      signal: pdoSignal,
      status: statusFromNumbers([pdoHome, pdoAway]),
      note: 'PDO regression pressure toward mean (UNDER when PDO is high).'
    }),
    buildDriver({
      driverKey: 'shotQuality',
      weight: 0.20,
      eligible: xgfHome !== null && xgfAway !== null,
      signal: shotQualitySignal,
      status: statusFromNumbers([xgfHome, xgfAway]),
      note: 'Shot quality environment for total scoring.'
    }),
    buildDriver({
      driverKey: 'rest',
      weight: 0.08,
      eligible: restAvg !== null,
      signal: restSignalTotal,
      status: statusFromNumbers([restDaysHome, restDaysAway]),
      note: 'Rest affects pace and defensive execution (more rest, lower totals).'
    }),
    buildDriver({
      driverKey: 'totalFragility',
      weight: 0,
      eligible: false,
      signal: 0,
      status: statusFromNumbers([totalLine]),
      note: 'Risk-only: key number sensitivity.'
    })
  ];

  const totalFragilityDistance = totalLine === null
    ? null
    : Math.min(Math.abs(totalLine - 5.5), Math.abs(totalLine - 6.5));
  const totalFragilityPenalty = totalFragilityDistance !== null && totalFragilityDistance <= 0.2 ? 0.08 : 0;

  const totalPenalties = [
    { key: 'total_fragility', value: totalFragilityPenalty },
    { key: 'line_move', value: 0 },
    { key: 'coverage', value: 0 }
  ];

  const totalDecision = buildMarketDecision({
    market: Market.TOTAL,
    defaultSide: 'OVER',
    drivers: totalDrivers,
    penalties: totalPenalties,
    thresholds: {
      t_dir: 0.10,
      t_fire: 0.40,
      t_watch: 0.20,
      conflict_cap: 0.25,
      min_coverage_fire: 0.60,
      min_coverage_watch: 0.50
    },
    edgeResolver: () => {
      if (totalLine === null || projectedTotal === null) return null;
      return Number(Math.abs(projectedTotal - totalLine).toFixed(2));
    },
    fairPriceResolver: null,
    lineResolver: () => totalLine,
    priceResolver: null,
    riskFlags: totalFragilityPenalty > 0 ? ['KEY_NUMBER'] : []
  });

  const powerRatingSignal = projectedMargin !== null ? clamp(projectedMargin / 3, -1, 1) : 0;
  const restSignalSide = restGap !== null ? clamp(restGap / 3, -1, 1) : 0;
  const matchupSignal = xgfHome !== null && xgfAway !== null ? clamp((xgfHome - xgfAway) / 20, -1, 1) : 0;
  const recentTrendValue = toNumber(raw?.recent_trend_home ?? raw?.recent_form_home ?? null);
  const recentTrendAway = toNumber(raw?.recent_trend_away ?? raw?.recent_form_away ?? null);
  const recentTrendSignal = recentTrendValue !== null && recentTrendAway !== null
    ? clamp((recentTrendValue - recentTrendAway) / 20, -1, 1)
    : 0;

  const welcomeHomeActive = Boolean(raw?.welcome_home_fade_active);
  const welcomeHomeSignal = welcomeHomeActive ? -0.4 : 0;

  const spreadDrivers = [
    buildDriver({
      driverKey: 'powerRating',
      weight: 0.35,
      eligible: projectedMargin !== null,
      signal: powerRatingSignal,
      status: statusFromNumbers([projectedMargin]),
      note: 'Projected margin favors HOME when positive.'
    }),
    buildDriver({
      driverKey: 'rest',
      weight: 0.15,
      eligible: restGap !== null,
      signal: restSignalSide,
      status: statusFromNumbers([restDaysHome, restDaysAway]),
      note: 'Rest advantage favors the more rested team.'
    }),
    buildDriver({
      driverKey: 'matchupStyle',
      weight: 0.20,
      eligible: xgfHome !== null && xgfAway !== null,
      signal: matchupSignal,
      status: statusFromNumbers([xgfHome, xgfAway]),
      note: 'Matchup style via shot-quality differential.'
    }),
    buildDriver({
      driverKey: 'welcomeHomeFade',
      weight: 0.10,
      eligible: welcomeHomeActive,
      signal: welcomeHomeSignal,
      status: welcomeHomeActive ? 'ok' : 'missing',
      note: 'Visitor edge on road-trip return.'
    }),
    buildDriver({
      driverKey: 'recentTrend',
      weight: 0.20,
      eligible: recentTrendValue !== null && recentTrendAway !== null,
      signal: recentTrendSignal,
      status: statusFromNumbers([recentTrendValue, recentTrendAway]),
      note: 'Recent form differential.'
    }),
    buildDriver({
      driverKey: 'spreadFragility',
      weight: 0,
      eligible: false,
      signal: 0,
      status: statusFromNumbers([spreadHome]),
      note: 'Risk-only: bad number exposure.'
    }),
    buildDriver({
      driverKey: 'pace',
      weight: 0,
      eligible: false,
      signal: 0,
      status: statusFromNumbers([paceValue]),
      note: 'Risk-only: variance overlay.'
    }),
    buildDriver({
      driverKey: 'pdoRegression',
      weight: 0,
      eligible: false,
      signal: 0,
      status: statusFromNumbers([pdoHome, pdoAway]),
      note: 'Risk-only: variance overlay.'
    })
  ];

  const spreadBadNumber = spreadHome !== null && Math.abs(spreadHome) >= 3.5;
  const spreadPenalty = spreadBadNumber ? 0.08 : 0;
  const spreadLineMovePenalty = 0;
  const spreadQualityPenalty = 0;
  const spreadDecision = buildMarketDecision({
    market: Market.SPREAD,
    defaultSide: 'HOME',
    drivers: spreadDrivers,
    penalties: [
      { key: 'spread_fragility', value: spreadPenalty },
      { key: 'line_move', value: spreadLineMovePenalty },
      { key: 'line_quality', value: spreadQualityPenalty }
    ],
    thresholds: {
      t_dir: 0.12,
      t_fire: 0.45,
      t_watch: 0.25,
      conflict_cap: 0.20,
      min_coverage_fire: 0.60,
      min_coverage_watch: 0.50
    },
    edgeResolver: () => {
      if (projectedMargin === null || spreadHome === null) return null;
      return Number(Math.abs(Math.abs(projectedMargin) - Math.abs(spreadHome)).toFixed(2));
    },
    fairPriceResolver: null,
    lineResolver: (side) => {
      if (spreadHome === null) return null;
      return side === 'HOME' ? spreadHome : -spreadHome;
    },
    priceResolver: null,
    riskFlags: spreadBadNumber ? ['BAD_NUMBER'] : []
  });

  const modelWinProb = projectedMargin !== null ? marginToWinProbability(projectedMargin) : null;
  const impliedHome = moneylineHome !== null ? oddsToProbability(moneylineHome) : null;
  const impliedAway = moneylineAway !== null ? oddsToProbability(moneylineAway) : null;

  const mlBaseNet = computeNet(applyDirection(renormalizeDriverWeights(spreadDrivers), 1));
  const mlCandidate = mlBaseNet >= 0 ? 'HOME' : 'AWAY';
  const impliedCandidate = mlCandidate === 'HOME' ? impliedHome : impliedAway;
  const modelProbCandidate = modelWinProb !== null
    ? (mlCandidate === 'HOME' ? modelWinProb : 1 - modelWinProb)
    : null;
  const mlEdge = impliedCandidate !== null && modelProbCandidate !== null
    ? modelProbCandidate - impliedCandidate
    : null;
  const mlCoinflip = impliedCandidate !== null && impliedCandidate >= 0.45 && impliedCandidate <= 0.55;
  const mlPenalty = mlEdge !== null && mlEdge > 0.015
    ? 0
    : mlCoinflip && mlEdge !== null && mlEdge > 0
      ? 0
      : 0.05;

  const mlDecision = buildMarketDecision({
    market: Market.ML,
    defaultSide: 'HOME',
    drivers: spreadDrivers,
    penalties: [
      { key: 'edge_strength', value: mlPenalty },
      { key: 'line_move', value: 0.03 }
    ],
    thresholds: {
      t_dir: 0.08,
      t_fire: 0.35,
      t_watch: 0.15,
      conflict_cap: 0.20,
      min_coverage_fire: 0.60,
      min_coverage_watch: 0.50
    },
    edgeResolver: (side) => {
      const implied = side === 'HOME' ? impliedHome : impliedAway;
      const modelProb = modelWinProb !== null
        ? (side === 'HOME' ? modelWinProb : 1 - modelWinProb)
        : null;
      if (implied === null || modelProb === null) return null;
      return Number(Math.abs(modelProb - implied).toFixed(3));
    },
    fairPriceResolver: (side) => {
      const implied = side === 'HOME' ? impliedHome : impliedAway;
      return implied !== null ? Number(implied.toFixed(3)) : null;
    },
    lineResolver: () => null,
    priceResolver: (side) => (side === 'HOME' ? moneylineHome : moneylineAway),
    riskFlags: mlCoinflip ? ['COINFLIP_ZONE'] : []
  });

  return {
    TOTAL: totalDecision,
    SPREAD: spreadDecision,
    ML: mlDecision
  };
}

function computeNBAMarketDecisions(oddsSnapshot) {
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const totalLine = toNumber(oddsSnapshot?.total);
  const spreadHome = toNumber(oddsSnapshot?.spread_home);

  const avgPtsHome = toNumber(raw?.espn_metrics?.home?.metrics?.avgPtsHome ?? raw?.espn_metrics?.home?.metrics?.avgPoints ?? null);
  const avgPtsAway = toNumber(raw?.espn_metrics?.away?.metrics?.avgPtsAway ?? raw?.espn_metrics?.away?.metrics?.avgPoints ?? null);
  const avgPtsAllowedHome = toNumber(raw?.espn_metrics?.home?.metrics?.avgPtsAllowedHome ?? raw?.espn_metrics?.home?.metrics?.avgPointsAllowed ?? null);
  const avgPtsAllowedAway = toNumber(raw?.espn_metrics?.away?.metrics?.avgPtsAllowedAway ?? raw?.espn_metrics?.away?.metrics?.avgPointsAllowed ?? null);
  const paceHome = toNumber(raw?.espn_metrics?.home?.metrics?.paceHome ?? raw?.espn_metrics?.home?.metrics?.pace ?? null);
  const paceAway = toNumber(raw?.espn_metrics?.away?.metrics?.paceAway ?? raw?.espn_metrics?.away?.metrics?.pace ?? null);
  const restDaysHome = toNumber(raw?.espn_metrics?.home?.metrics?.restDays ?? null);
  const restDaysAway = toNumber(raw?.espn_metrics?.away?.metrics?.restDays ?? null);

  const projection = projectNBA(avgPtsHome, avgPtsAllowedHome, avgPtsAway, avgPtsAllowedAway, paceHome, paceAway, restDaysHome, restDaysAway);
  const projectedHome = projection.homeProjected;
  const projectedAway = projection.awayProjected;
  const projectedTotal = projectedHome !== null && projectedAway !== null ? projectedHome + projectedAway : null;
  const projectedMargin = projectedHome !== null && projectedAway !== null ? projectedHome - projectedAway : null;
  const paceSignalData = (paceHome !== null && paceAway !== null)
    ? analyzePaceSynergy(paceHome, paceAway, avgPtsHome, avgPtsAway)
    : null;

  const restGap = restDaysHome !== null && restDaysAway !== null ? restDaysHome - restDaysAway : null;

  // TOTAL market drivers
  const paceEnvSignalMap = {
    'ELITE_OVER': 0.6,
    'ATTACK_OVER': 0.6,
    'LEAN_OVER': 0.4,
    'BEST_UNDER': -0.6,
    'STRONG_UNDER': -0.4
  };
  const paceEnvRawSignal = paceSignalData
    ? (paceEnvSignalMap[paceSignalData.bettingSignal] ?? 0)
    : 0;

  const defensiveShellSignal =
    avgPtsAllowedHome !== null && avgPtsAllowedAway !== null
      ? (avgPtsAllowedHome < 108 && avgPtsAllowedAway < 108 ? -0.5
        : avgPtsAllowedHome > 115 && avgPtsAllowedAway > 115 ? 0.4
        : 0)
      : 0;

  const totalDrivers = [
    buildDriver({
      driverKey: 'totalProjection',
      weight: 0.45,
      eligible: projectedTotal !== null && totalLine !== null,
      signal: projectedTotal !== null && totalLine !== null
        ? clamp((projectedTotal - totalLine) / 10, -1, 1)
        : 0,
      status: statusFromNumbers([projectedTotal, totalLine]),
      note: 'Projected total vs. line — positive favors OVER.'
    }),
    buildDriver({
      driverKey: 'paceEnvironment',
      weight: 0.35,
      eligible: paceSignalData !== null,
      signal: paceEnvRawSignal,
      status: paceSignalData !== null ? 'ok' : 'missing',
      note: 'Pace synergy environment signal.'
    }),
    buildDriver({
      driverKey: 'defensiveShell',
      weight: 0.20,
      eligible: avgPtsAllowedHome !== null && avgPtsAllowedAway !== null,
      signal: defensiveShellSignal,
      status: statusFromNumbers([avgPtsAllowedHome, avgPtsAllowedAway]),
      note: 'Both teams allow low/high points — defensive shell or open game.'
    })
  ];

  const totalFragilityPenalty =
    totalLine !== null &&
    Math.min(Math.abs(totalLine - 224), Math.abs(totalLine - 225), Math.abs(totalLine - 226)) <= 0.5
      ? 0.06
      : 0;

  const totalDecision = buildMarketDecision({
    market: 'TOTAL',
    defaultSide: 'OVER',
    drivers: totalDrivers,
    penalties: [{ key: 'total_fragility', value: totalFragilityPenalty }],
    thresholds: { t_dir: 0.12, t_fire: 0.38, t_watch: 0.20, conflict_cap: 0.25, min_coverage_fire: 0.55, min_coverage_watch: 0.45 },
    edgeResolver: () => (projectedTotal !== null && totalLine !== null) ? Number(Math.abs(projectedTotal - totalLine).toFixed(2)) : null,
    fairPriceResolver: null,
    lineResolver: () => totalLine,
    priceResolver: null,
    riskFlags: totalFragilityPenalty > 0 ? ['KEY_NUMBER'] : []
  });

  // SPREAD market drivers
  const homeNetRating = avgPtsHome !== null && avgPtsAllowedHome !== null ? avgPtsHome - avgPtsAllowedHome : null;
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
    edgeResolver: () => (projectedMargin !== null && spreadHome !== null) ? Number(Math.abs(Math.abs(projectedMargin) - Math.abs(spreadHome)).toFixed(2)) : null,
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
  if (!expressionChoice) return {};
  const chosen = expressionChoice.chosen;
  return {
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
