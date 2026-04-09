const {
  Market,
  DecisionStatus,
  renormalizeDriverWeights,
  computeConflict,
  computeCoverage,
  marginToWinProbability,
  oddsToProbability,
  edgeCalculator,
} = require('@cheddar-logic/models');

const { projectNHL, projectNBACanonical } = require('./projections');
const { DEGRADED_CONSTRAINTS, buildNoBetResult } = require('./input-gate');
const { analyzePaceSynergy } = require('./nba-pace-synergy');
const { resolveGoalieComposite } = require('./nhl-pace-model');
const { compareProjection } = require('../../../../packages/odds/src/market_evaluator.js');

const ENABLE_WELCOME_HOME = process.env.ENABLE_WELCOME_HOME === 'true';

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
  const present = values.filter(
    (value) => value !== null && value !== undefined,
  ).length;
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
    note,
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
      contrib: adjustedSignal * driver.weight,
    };
  });
}

function computeNet(drivers) {
  return Number(
    drivers
      .reduce((sum, driver) => sum + (driver.eligible ? driver.contrib : 0), 0)
      .toFixed(3),
  );
}

function selectStatus({ score, conflict, coverage, thresholds }) {
  const {
    t_fire,
    t_watch,
    conflict_cap,
    min_coverage_fire,
    min_coverage_watch,
  } = thresholds;
  let maxStatus = DecisionStatus.FIRE;
  if (conflict > 0.3) {
    maxStatus = DecisionStatus.PASS;
  } else if (conflict > conflict_cap) {
    maxStatus = DecisionStatus.WATCH;
  }

  if (
    score >= t_fire &&
    conflict <= conflict_cap &&
    coverage >= min_coverage_fire
  ) {
    return maxStatus === DecisionStatus.FIRE ? DecisionStatus.FIRE : maxStatus;
  }
  if (score >= t_watch && coverage >= min_coverage_watch) {
    return maxStatus === DecisionStatus.PASS
      ? DecisionStatus.PASS
      : DecisionStatus.WATCH;
  }
  return DecisionStatus.PASS;
}

function buildReasoning({ status, score, conflict, coverage, topDrivers }) {
  const driverNote = topDrivers.length
    ? ` Drivers: ${topDrivers.join(', ')}.`
    : '';
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
  projectionResolver,
  riskFlags,
}) {
  const normalized = renormalizeDriverWeights(drivers);
  const baseNet = computeNet(applyDirection(normalized, 1));
  const direction = baseNet >= 0 ? 1 : -1;
  const candidateSide =
    direction === 1 ? defaultSide : oppositeSide(defaultSide);
  const directed = applyDirection(normalized, direction);
  const net = Math.abs(computeNet(directed));
  const conflict = computeConflict(directed);
  const coverage = computeCoverage(directed);
  const sumPenalties = penalties.reduce(
    (sum, penalty) => sum + penalty.value,
    0,
  );
  const score = Number((net - sumPenalties).toFixed(3));

  const status =
    net < thresholds.t_dir
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

  const edgeRaw = edgeResolver ? edgeResolver(candidateSide) : null;
  const edgeData =
    typeof edgeRaw === 'number'
      ? { edge: edgeRaw }
      : edgeRaw && typeof edgeRaw === 'object'
        ? edgeRaw
        : null;
  const fairPrice = fairPriceResolver ? fairPriceResolver(candidateSide) : null;
  const line = lineResolver ? lineResolver(candidateSide) : null;
  const price = priceResolver ? priceResolver(candidateSide) : null;
  const projection = projectionResolver
    ? projectionResolver(candidateSide)
    : null;

  return {
    market,
    best_candidate: {
      side: candidateSide,
      line: line ?? undefined,
      price: price ?? undefined,
    },
    status,
    score,
    net,
    conflict,
    coverage,
    edge: edgeData?.edge ?? undefined,
    p_fair: edgeData?.p_fair ?? undefined,
    p_implied: edgeData?.p_implied ?? undefined,
    edge_points: edgeData?.edge_points ?? undefined,
    fair_price: fairPrice ?? undefined,
    projection: projection ?? undefined,
    line_source: 'odds_snapshot',
    price_source: 'odds_snapshot',
    pricing_trace: {
      called_market_type: market,
      called_side: candidateSide,
      called_line: line ?? null,
      called_price: price ?? null,
      line_source: 'odds_snapshot',
      price_source: 'odds_snapshot',
      proxy_used: false,
    },
    drivers: directed,
    risk_flags: flags,
    reasoning: buildReasoning({
      status,
      score,
      conflict,
      coverage,
      topDrivers,
    }),
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

function buildExpressionChoiceSnapshot(expressionChoice) {
  const chosen = expressionChoice?.chosen;
  if (!chosen) return null;

  return {
    market: chosen.market,
    side: chosen?.best_candidate?.side ?? null,
    line: chosen?.best_candidate?.line ?? null,
    price: chosen?.best_candidate?.price ?? null,
    status: chosen.status,
    score: chosen.score,
    net: chosen.net,
    conflict: chosen.conflict,
    edge: chosen.edge ?? null,
  };
}

function computeNHLMarketDecisions(oddsSnapshot) {
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const totalLine = toNumber(oddsSnapshot?.total);
  const spreadHome = toNumber(oddsSnapshot?.spread_home);
  const moneylineHome = toNumber(oddsSnapshot?.h2h_home);
  const moneylineAway = toNumber(oddsSnapshot?.h2h_away);

  const goalsForHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.avgGoalsFor ??
      raw?.goals_for_home ??
      null,
  );
  const goalsForAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.avgGoalsFor ??
      raw?.goals_for_away ??
      null,
  );
  const goalsAgainstHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.avgGoalsAgainst ??
      raw?.goals_against_home ??
      null,
  );
  const goalsAgainstAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.avgGoalsAgainst ??
      raw?.goals_against_away ??
      null,
  );

  const restDaysHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.restDays ?? raw?.rest_days_home ?? null,
  );
  const restDaysAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.restDays ?? raw?.rest_days_away ?? null,
  );

  const goalieHomeGsax = toNumber(
    raw?.goalie_home_gsax ??
      raw?.goalie?.home?.gsax ??
      raw?.goalies?.home?.gsax,
  );
  const goalieAwayGsax = toNumber(
    raw?.goalie_away_gsax ??
      raw?.goalie?.away?.gsax ??
      raw?.goalies?.away?.gsax,
  );
  const homeGoalieSavePct = toNumber(
    raw?.espn_metrics?.home?.metrics?.goalieSavePct ??
      raw?.goalie_home_save_pct ??
      raw?.goalie?.home?.save_pct ??
      raw?.goalies?.home?.save_pct ??
      null,
  );
  const awayGoalieSavePct = toNumber(
    raw?.espn_metrics?.away?.metrics?.goalieSavePct ??
      raw?.goalie_away_save_pct ??
      raw?.goalie?.away?.save_pct ??
      raw?.goalies?.away?.save_pct ??
      null,
  );
  const homeGoalieComposite = resolveGoalieComposite(
    homeGoalieSavePct,
    goalieHomeGsax,
  );
  const awayGoalieComposite = resolveGoalieComposite(
    awayGoalieSavePct,
    goalieAwayGsax,
  );
  const goalieCompositeValues = [homeGoalieComposite, awayGoalieComposite]
    .filter((entry) => entry.source !== 'NEUTRAL')
    .map((entry) => entry.composite);
  const goalieCompositeAverage =
    goalieCompositeValues.length > 0
      ? goalieCompositeValues.reduce((sum, value) => sum + value, 0) /
        goalieCompositeValues.length
      : null;

  const pulledHomeSec = toNumber(
    raw?.empty_net_pull_home_sec ?? raw?.empty_net?.home_pull_seconds_remaining,
  );
  const pulledAwaySec = toNumber(
    raw?.empty_net_pull_away_sec ?? raw?.empty_net?.away_pull_seconds_remaining,
  );
  const pullAvg =
    pulledHomeSec !== null && pulledAwaySec !== null
      ? (pulledHomeSec + pulledAwaySec) / 2
      : null;

  const ppHome = toNumber(raw?.pp_home_pct ?? raw?.special_teams?.home?.pp_pct);
  const pkHome = toNumber(raw?.pk_home_pct ?? raw?.special_teams?.home?.pk_pct);
  const ppAway = toNumber(raw?.pp_away_pct ?? raw?.special_teams?.away?.pp_pct);
  const pkAway = toNumber(raw?.pk_away_pct ?? raw?.special_teams?.away?.pk_pct);

  const pdoHome = toNumber(raw?.pdo_home ?? raw?.teams?.home?.pdo);
  const pdoAway = toNumber(raw?.pdo_away ?? raw?.teams?.away?.pdo);

  const xgfHome = toNumber(
    raw?.xgf_home_pct ?? raw?.teams?.home?.xgf_pct ?? raw?.xgf?.home_pct,
  );
  const xgfAway = toNumber(
    raw?.xgf_away_pct ?? raw?.teams?.away?.xgf_pct ?? raw?.xgf?.away_pct,
  );

  // WI-0820: Double-UNKNOWN goalie → hard NO_BET (not just confidence cap)
  const homeGoalieCertaintyRaw = String(
    raw?.goalie?.home?.certainty ?? raw?.goalie_home_certainty ?? '',
  ).toUpperCase();
  const awayGoalieCertaintyRaw = String(
    raw?.goalie?.away?.certainty ?? raw?.goalie_away_certainty ?? '',
  ).toUpperCase();
  if (homeGoalieCertaintyRaw === 'UNKNOWN' && awayGoalieCertaintyRaw === 'UNKNOWN') {
    console.log('[input-gate] sport=nhl market=total status=NO_BET');
    return buildNoBetResult(
      ['homeGoalieCertainty', 'awayGoalieCertainty'],
      { projection_source: 'NO_BET', reason_detail: 'DOUBLE_UNKNOWN_GOALIE', sport: 'nhl' },
    );
  }

  const projection = projectNHL(
    goalsForHome,
    goalsAgainstHome,
    goalsForAway,
    goalsAgainstAway,
    goalieHomeGsax !== null,
    goalieAwayGsax !== null,
    restDaysHome ?? 1,
    restDaysAway ?? 1,
  );
  const projectedMargin =
    projection.homeProjected != null && projection.awayProjected != null
      ? projection.homeProjected - projection.awayProjected
      : null;
  const projectedTotal = projection.totalProjected ?? null;
  // Market anchor: blend model projection 60% with market line 40%.
  // Prevents pure model drift from inflating edge when projection runs hot.
  const anchoredProjectedTotal =
    projectedTotal !== null && totalLine !== null
      ? 0.6 * projectedTotal + 0.4 * totalLine
      : projectedTotal;

  const restGap =
    restDaysHome !== null && restDaysAway !== null
      ? restDaysHome - restDaysAway
      : null;
  const restAvg =
    restDaysHome !== null && restDaysAway !== null
      ? (restDaysHome + restDaysAway) / 2
      : null;

  const goalieSignal =
    goalieCompositeAverage === null
      ? 0
      : clamp(-goalieCompositeAverage / 2, -1, 1);
  const emptyNetSignal =
    pullAvg === null ? 0 : clamp((pullAvg - 60) / 60, -1, 1);
  const powerPlayEnvSignal = [ppHome, pkHome, ppAway, pkAway].every(
    (value) => value !== null,
  )
    ? clamp((ppHome + ppAway - (pkHome + pkAway)) / 40, -1, 1)
    : 0;
  const pdoAvg =
    pdoHome !== null && pdoAway !== null ? (pdoHome + pdoAway) / 2 : null;
  const pdoSignal = pdoAvg === null ? 0 : clamp((1 - pdoAvg) / 0.04, -1, 1);
  const shotQualitySignal =
    xgfHome !== null && xgfAway !== null
      ? clamp((xgfHome + xgfAway - 100) / 20, -1, 1)
      : 0;
  const restSignalTotal =
    restAvg === null ? 0 : clamp((1.5 - restAvg) / 3, -1, 1);

  const paceValue = toNumber(raw?.pace ?? raw?.shot_pace ?? null);
  const paceSignal =
    paceValue === null ? 0 : clamp((paceValue - 100) / 15, -1, 1);

  const totalDrivers = [
    buildDriver({
      driverKey: 'goalie_quality',
      weight: 0.18,
      eligible: goalieCompositeAverage !== null,
      signal: goalieSignal,
      status: statusFromNumbers([
        goalieHomeGsax,
        goalieAwayGsax,
        homeGoalieSavePct,
        awayGoalieSavePct,
      ]),
      note: 'Combined goalie quality signal (higher quality favors UNDER).',
    }),
    buildDriver({
      driverKey: 'empty_net_propensity',
      weight: 0.08,
      eligible: pullAvg !== null,
      signal: emptyNetSignal,
      status: statusFromNumbers([pulledHomeSec, pulledAwaySec]),
      note: 'Earlier pull behavior increases late scoring (OVER bias).',
    }),
    buildDriver({
      driverKey: 'pace',
      weight: 0.18,
      eligible: paceValue !== null,
      signal: paceSignal,
      status: statusFromNumbers([paceValue]),
      note: 'Higher pace increases total scoring.',
    }),
    buildDriver({
      driverKey: 'powerPlayEnv',
      weight: 0.16,
      eligible: [ppHome, pkHome, ppAway, pkAway].every(
        (value) => value !== null,
      ),
      signal: powerPlayEnvSignal,
      status: statusFromNumbers([ppHome, pkHome, ppAway, pkAway]),
      note: 'Combined PP/PK environment for total scoring.',
    }),
    buildDriver({
      driverKey: 'pdoRegression',
      weight: 0.12,
      eligible: pdoAvg !== null,
      signal: pdoSignal,
      status: statusFromNumbers([pdoHome, pdoAway]),
      note: 'PDO regression pressure toward mean (UNDER when PDO is high).',
    }),
    buildDriver({
      driverKey: 'shotQuality',
      weight: 0.2,
      eligible: xgfHome !== null && xgfAway !== null,
      signal: shotQualitySignal,
      status: statusFromNumbers([xgfHome, xgfAway]),
      note: 'Shot quality environment for total scoring.',
    }),
    buildDriver({
      driverKey: 'rest',
      weight: 0.08,
      eligible: restAvg !== null,
      signal: restSignalTotal,
      status: statusFromNumbers([restDaysHome, restDaysAway]),
      note: 'Rest affects pace and defensive execution (more rest, lower totals).',
    }),
    buildDriver({
      driverKey: 'totalFragility',
      weight: 0,
      eligible: false,
      signal: 0,
      status: statusFromNumbers([totalLine]),
      note: 'Risk-only: key number sensitivity.',
    }),
  ];

  const totalFragilityDistance =
    totalLine === null
      ? null
      : Math.min(Math.abs(totalLine - 5.5), Math.abs(totalLine - 6.5));
  const totalFragilityPenalty =
    totalFragilityDistance !== null && totalFragilityDistance <= 0.2 ? 0.08 : 0;

  const totalPenalties = [
    { key: 'total_fragility', value: totalFragilityPenalty },
    { key: 'line_move', value: 0 },
    { key: 'coverage', value: 0 },
  ];

  const totalDecision = buildMarketDecision({
    market: Market.TOTAL,
    defaultSide: 'OVER',
    drivers: totalDrivers,
    penalties: totalPenalties,
    thresholds: {
      t_dir: 0.1,
      t_fire: 0.4,
      t_watch: 0.2,
      conflict_cap: 0.25,
      min_coverage_fire: 0.6,
      min_coverage_watch: 0.5,
    },
    edgeResolver: (side) => {
      if (totalLine === null || anchoredProjectedTotal === null) return null;
      const totalEdge = edgeCalculator.computeTotalEdge({
        projectionTotal: anchoredProjectedTotal,
        totalLine,
        totalPriceOver: toNumber(oddsSnapshot?.total_price_over),
        totalPriceUnder: toNumber(oddsSnapshot?.total_price_under),
        sigmaTotal: edgeCalculator.getSigmaDefaults('NHL')?.total ?? 1.8,
        isPredictionOver: side === 'OVER',
      });
      return {
        edge: totalEdge.edge ?? null,
        p_fair: totalEdge.p_fair ?? null,
        p_implied: totalEdge.p_implied ?? null,
        edge_points: totalEdge.edgePoints ?? null,
      };
    },
    fairPriceResolver: null,
    lineResolver: () => totalLine,
    priceResolver: (side) =>
      side === 'OVER'
        ? toNumber(oddsSnapshot?.total_price_over)
        : toNumber(oddsSnapshot?.total_price_under),
    projectionResolver: () => ({
      projected_total: anchoredProjectedTotal,
      model_projected_total: projectedTotal,
      total_line: totalLine,
    }),
    riskFlags: totalFragilityPenalty > 0 ? ['KEY_NUMBER'] : [],
  });

  const powerRatingSignal =
    projectedMargin !== null ? clamp(projectedMargin / 3, -1, 1) : 0;
  const restSignalSide = restGap !== null ? clamp(restGap / 3, -1, 1) : 0;
  const matchupSignal =
    xgfHome !== null && xgfAway !== null
      ? clamp((xgfHome - xgfAway) / 20, -1, 1)
      : 0;
  const recentTrendValue = toNumber(
    raw?.recent_trend_home ?? raw?.recent_form_home ?? null,
  );
  const recentTrendAway = toNumber(
    raw?.recent_trend_away ?? raw?.recent_form_away ?? null,
  );
  const recentTrendSignal =
    recentTrendValue !== null && recentTrendAway !== null
      ? clamp((recentTrendValue - recentTrendAway) / 20, -1, 1)
      : 0;

  const welcomeHomeActive =
    ENABLE_WELCOME_HOME && Boolean(raw?.welcome_home_fade_active);
  const welcomeHomeSignal = welcomeHomeActive ? -0.4 : 0;

  const spreadDrivers = [
    buildDriver({
      driverKey: 'powerRating',
      weight: 0.35,
      eligible: projectedMargin !== null,
      signal: powerRatingSignal,
      status: statusFromNumbers([projectedMargin]),
      note: 'Projected margin favors HOME when positive.',
    }),
    buildDriver({
      driverKey: 'rest',
      weight: 0.15,
      eligible: restGap !== null,
      signal: restSignalSide,
      status: statusFromNumbers([restDaysHome, restDaysAway]),
      note: 'Rest advantage favors the more rested team.',
    }),
    buildDriver({
      driverKey: 'matchupStyle',
      weight: 0.2,
      eligible: xgfHome !== null && xgfAway !== null,
      signal: matchupSignal,
      status: statusFromNumbers([xgfHome, xgfAway]),
      note: 'Matchup style via shot-quality differential.',
    }),
    buildDriver({
      driverKey: 'welcomeHomeFade',
      weight: 0.1,
      eligible: welcomeHomeActive,
      signal: welcomeHomeSignal,
      status: welcomeHomeActive ? 'ok' : 'missing',
      note: 'Visitor edge on road-trip return.',
    }),
    buildDriver({
      driverKey: 'recentTrend',
      weight: 0.2,
      eligible: recentTrendValue !== null && recentTrendAway !== null,
      signal: recentTrendSignal,
      status: statusFromNumbers([recentTrendValue, recentTrendAway]),
      note: 'Recent form differential.',
    }),
    buildDriver({
      driverKey: 'spreadFragility',
      weight: 0,
      eligible: false,
      signal: 0,
      status: statusFromNumbers([spreadHome]),
      note: 'Risk-only: bad number exposure.',
    }),
    buildDriver({
      driverKey: 'pace',
      weight: 0,
      eligible: false,
      signal: 0,
      status: statusFromNumbers([paceValue]),
      note: 'Risk-only: variance overlay.',
    }),
    buildDriver({
      driverKey: 'pdoRegression',
      weight: 0,
      eligible: false,
      signal: 0,
      status: statusFromNumbers([pdoHome, pdoAway]),
      note: 'Risk-only: variance overlay.',
    }),
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
      { key: 'line_quality', value: spreadQualityPenalty },
    ],
    thresholds: {
      t_dir: 0.12,
      t_fire: 0.45,
      t_watch: 0.25,
      conflict_cap: 0.2,
      min_coverage_fire: 0.6,
      min_coverage_watch: 0.5,
    },
    edgeResolver: (side) => {
      if (projectedMargin === null || spreadHome === null) return null;
      const spreadEdge = edgeCalculator.computeSpreadEdge({
        projectionMarginHome: projectedMargin,
        spreadLine: spreadHome,
        spreadPriceHome: toNumber(oddsSnapshot?.spread_price_home),
        spreadPriceAway: toNumber(oddsSnapshot?.spread_price_away),
        sigmaMargin: edgeCalculator.getSigmaDefaults('NHL')?.margin ?? 1.8,
        isPredictionHome: side === 'HOME',
      });
      return {
        edge: spreadEdge.edge ?? null,
        p_fair: spreadEdge.p_fair ?? null,
        p_implied: spreadEdge.p_implied ?? null,
        edge_points: spreadEdge.edgePoints ?? null,
      };
    },
    fairPriceResolver: null,
    lineResolver: (side) => {
      if (spreadHome === null) return null;
      return side === 'HOME' ? spreadHome : -spreadHome;
    },
    priceResolver: (side) =>
      side === 'HOME'
        ? toNumber(oddsSnapshot?.spread_price_home)
        : toNumber(oddsSnapshot?.spread_price_away),
    projectionResolver: () => ({
      projected_margin: projectedMargin,
      spread_home_line: spreadHome,
    }),
    riskFlags: spreadBadNumber ? ['BAD_NUMBER'] : [],
  });

  // WI-0571: projection comparison (edge vs consensus vs best available)
  const nhlTotalSide = totalDecision.best_candidate.side;
  const nhlTotalConsensusLine = totalLine; // oddsSnapshot.total IS the consensus line
  const nhlTotalBestLine = nhlTotalSide === 'OVER'
    ? toNumber(oddsSnapshot?.total_line_over)
    : toNumber(oddsSnapshot?.total_line_under);
  totalDecision.projection_comparison = compareProjection({
    fairLine: projectedTotal,
    consensusLine: nhlTotalConsensusLine,
    bestLine: nhlTotalBestLine,
    consensusPrice: null,
    bestPrice: nhlTotalSide === 'OVER'
      ? toNumber(oddsSnapshot?.total_price_over)
      : toNumber(oddsSnapshot?.total_price_under),
  });

  const nhlSpreadSide = spreadDecision.best_candidate.side;
  const nhlRawConsensusLine = toNumber(oddsSnapshot?.spread_consensus_line);
  spreadDecision.projection_comparison = compareProjection({
    fairLine: nhlSpreadSide === 'HOME' ? projectedMargin : (projectedMargin !== null ? -projectedMargin : null),
    consensusLine: nhlSpreadSide === 'HOME'
      ? (nhlRawConsensusLine !== null ? -nhlRawConsensusLine : null)
      : nhlRawConsensusLine,
    bestLine: nhlSpreadSide === 'HOME'
      ? (spreadHome !== null ? -spreadHome : null)
      : (toNumber(oddsSnapshot?.spread_away) !== null ? -toNumber(oddsSnapshot?.spread_away) : null),
    consensusPrice: null,
    bestPrice: nhlSpreadSide === 'HOME'
      ? toNumber(oddsSnapshot?.spread_price_home)
      : toNumber(oddsSnapshot?.spread_price_away),
  });

  const modelWinProb =
    projectedMargin !== null
      ? marginToWinProbability(
          projectedMargin,
          // WI-0538: use NHL-specific margin sigma (2.0 goals) instead of NBA
          // default (12 pts). Calibration basis: NHL regular-season goal margins
          // have std-dev ~1.8–2.2 across ~82-game samples; sigma=2.0 is the
          // central estimate matching empirical reliability bins and producing
          // Brier scores competitive with a flat-50 baseline on 1+-goal margins.
          // Do not substitute σ without metric-based validation (see AGENTS.md
          // Guard: calibration_risk).
          edgeCalculator.getSigmaDefaults('NHL').margin,
        )
      : null;
  const mlNoVig = edgeCalculator.noVigImplied(moneylineHome, moneylineAway);
  const impliedHome = mlNoVig != null
    ? mlNoVig.home
    : (moneylineHome !== null ? oddsToProbability(moneylineHome) : null);
  const impliedAway = mlNoVig != null
    ? mlNoVig.away
    : (moneylineAway !== null ? oddsToProbability(moneylineAway) : null);

  const mlBaseNet = computeNet(
    applyDirection(renormalizeDriverWeights(spreadDrivers), 1),
  );
  const mlCandidate = mlBaseNet >= 0 ? 'HOME' : 'AWAY';
  const impliedCandidate = mlCandidate === 'HOME' ? impliedHome : impliedAway;
  const modelProbCandidate =
    modelWinProb !== null
      ? mlCandidate === 'HOME'
        ? modelWinProb
        : 1 - modelWinProb
      : null;
  const mlEdge =
    impliedCandidate !== null && modelProbCandidate !== null
      ? modelProbCandidate - impliedCandidate
      : null;
  const mlCoinflip =
    impliedCandidate !== null &&
    impliedCandidate >= 0.45 &&
    impliedCandidate <= 0.55;
  const mlPenalty =
    mlEdge !== null && mlEdge > 0.015
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
      { key: 'line_move', value: 0.03 },
    ],
    thresholds: {
      t_dir: 0.08,
      t_fire: 0.35,
      t_watch: 0.15,
      conflict_cap: 0.2,
      min_coverage_fire: 0.6,
      min_coverage_watch: 0.5,
    },
    edgeResolver: (side) => {
      const implied = side === 'HOME' ? impliedHome : impliedAway;
      const modelProb =
        modelWinProb !== null
          ? side === 'HOME'
            ? modelWinProb
            : 1 - modelWinProb
          : null;
      if (implied === null || modelProb === null) return null;
      return {
        edge: Number((modelProb - implied).toFixed(3)),
        p_fair: Number(modelProb.toFixed(4)),
        p_implied: Number(implied.toFixed(4)),
      };
    },
    fairPriceResolver: (side) => {
      const implied = side === 'HOME' ? impliedHome : impliedAway;
      return implied !== null ? Number(implied.toFixed(3)) : null;
    },
    lineResolver: () => null,
    priceResolver: (side) => (side === 'HOME' ? moneylineHome : moneylineAway),
    projectionResolver: () => ({
      projected_margin: projectedMargin,
      win_prob_home:
        modelWinProb !== null ? Number(modelWinProb.toFixed(4)) : null,
    }),
    riskFlags: mlCoinflip ? ['COINFLIP_ZONE'] : [],
  });

  // WI-0820: DEGRADED enforcement for NHL (single-UNKNOWN goalie → cap + no PLAY)
  const nhlDegraded = projection?.model_status === 'DEGRADED';
  if (nhlDegraded) {
    for (const dec of [totalDecision, spreadDecision, mlDecision].filter(Boolean)) {
      if (dec.best_candidate && DEGRADED_CONSTRAINTS.FORBIDDEN_TIERS.includes(dec.best_candidate.tier)) {
        dec.best_candidate.tier = 'WATCH';
      }
      if (dec.best_candidate?.confidence != null) {
        dec.best_candidate.confidence = Math.min(dec.best_candidate.confidence, DEGRADED_CONSTRAINTS.MAX_CONFIDENCE);
      }
      dec.model_status = 'DEGRADED';
    }
  }
  const nhlModelStatusLog = nhlDegraded ? 'DEGRADED'
    : (homeGoalieCertaintyRaw === 'UNKNOWN' || awayGoalieCertaintyRaw === 'UNKNOWN' ? 'DEGRADED' : 'MODEL_OK');
  console.log(`[input-gate] sport=nhl market=multi status=${nhlModelStatusLog}`);

  return {
    TOTAL: totalDecision,
    SPREAD: spreadDecision,
    ML: mlDecision,
  };
}

function computeNBAMarketDecisions(oddsSnapshot) {
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const totalLine = toNumber(oddsSnapshot?.total);
  const spreadHome = toNumber(oddsSnapshot?.spread_home);

  const avgPtsHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.avgPtsHome ??
      raw?.espn_metrics?.home?.metrics?.avgPoints ??
      null,
  );
  const avgPtsAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.avgPtsAway ??
      raw?.espn_metrics?.away?.metrics?.avgPoints ??
      null,
  );
  const avgPtsAllowedHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.avgPtsAllowedHome ??
      raw?.espn_metrics?.home?.metrics?.avgPointsAllowed ??
      null,
  );
  const avgPtsAllowedAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.avgPtsAllowedAway ??
      raw?.espn_metrics?.away?.metrics?.avgPointsAllowed ??
      null,
  );
  const paceHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.paceHome ??
      raw?.espn_metrics?.home?.metrics?.pace ??
      null,
  );
  const paceAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.paceAway ??
      raw?.espn_metrics?.away?.metrics?.pace ??
      null,
  );
  const restDaysHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.restDays ?? raw?.rest_days_home ?? null,
  );
  const restDaysAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.restDays ?? raw?.rest_days_away ?? null,
  );

  // analyzePaceSynergy MUST run before projectNBACanonical so paceAdjustment is available.
  const synergy =
    paceHome !== null && paceAway !== null
      ? analyzePaceSynergy(paceHome, paceAway, avgPtsHome, avgPtsAway)
      : null;
  const projection = projectNBACanonical(
    avgPtsHome,
    avgPtsAllowedHome,
    paceHome,
    avgPtsAway,
    avgPtsAllowedAway,
    paceAway,
    synergy?.paceAdjustment ?? 0,
  );

  // Hard block: NO_BET from model means no card can emit
  const nbaModelStatus = projection?.status ?? projection?.model_status ?? 'MODEL_OK';
  if (nbaModelStatus === 'NO_BET') {
    console.log('[input-gate] sport=nba market=total status=NO_BET');
    return {
      status: 'NO_BET',
      reason: projection.reason ?? 'MISSING_CORE_INPUTS',
      missingCritical: projection.missingCritical ?? [],
      drivers: [],
      decision: null,
      confidence: 0,
    };
  }
  const nbaDegraded = nbaModelStatus === 'DEGRADED';

  const projectedHome = projection.homeProjected;
  const projectedAway = projection.awayProjected;
  const projectedTotal =
    projectedHome !== null && projectedAway !== null
      ? projectedHome + projectedAway
      : null;
  const projectedMargin =
    projectedHome !== null && projectedAway !== null
      ? projectedHome - projectedAway
      : null;
  // Reuse synergy computed above (called before projectNBACanonical to supply paceAdjustment)
  const paceSignalData = synergy;

  const restGap =
    restDaysHome !== null && restDaysAway !== null
      ? restDaysHome - restDaysAway
      : null;

  // TOTAL market drivers
  const paceEnvSignalMap = {
    ELITE_OVER: 0.6,
    ATTACK_OVER: 0.6,
    LEAN_OVER: 0.4,
    BEST_UNDER: -0.6,
    STRONG_UNDER: -0.4,
  };
  const paceEnvRawSignal = paceSignalData
    ? (paceEnvSignalMap[paceSignalData.bettingSignal] ?? 0)
    : 0;

  const defensiveShellSignal =
    avgPtsAllowedHome !== null && avgPtsAllowedAway !== null
      ? avgPtsAllowedHome < 108 && avgPtsAllowedAway < 108
        ? -0.5
        : avgPtsAllowedHome > 115 && avgPtsAllowedAway > 115
          ? 0.4
          : 0
      : 0;

  const totalDrivers = [
    buildDriver({
      driverKey: 'totalProjection',
      weight: 0.45,
      eligible: projectedTotal !== null && totalLine !== null,
      signal:
        projectedTotal !== null && totalLine !== null
          ? clamp((projectedTotal - totalLine) / 10, -1, 1)
          : 0,
      status: statusFromNumbers([projectedTotal, totalLine]),
      note: 'Projected total vs. line — positive favors OVER.',
    }),
    buildDriver({
      driverKey: 'paceEnvironment',
      weight: 0.35,
      eligible: paceSignalData !== null,
      signal: paceEnvRawSignal,
      status: paceSignalData !== null ? 'ok' : 'missing',
      note: 'Pace synergy environment signal.',
    }),
    buildDriver({
      driverKey: 'defensiveShell',
      weight: 0.2,
      eligible: avgPtsAllowedHome !== null && avgPtsAllowedAway !== null,
      signal: defensiveShellSignal,
      status: statusFromNumbers([avgPtsAllowedHome, avgPtsAllowedAway]),
      note: 'Both teams allow low/high points — defensive shell or open game.',
    }),
  ];

  const totalFragilityPenalty =
    totalLine !== null &&
    Math.min(
      Math.abs(totalLine - 224),
      Math.abs(totalLine - 225),
      Math.abs(totalLine - 226),
    ) <= 0.5
      ? 0.06
      : 0;

  const totalDecision = buildMarketDecision({
    market: 'TOTAL',
    defaultSide: 'OVER',
    drivers: totalDrivers,
    penalties: [{ key: 'total_fragility', value: totalFragilityPenalty }],
    thresholds: {
      t_dir: 0.12,
      t_fire: 0.38,
      t_watch: 0.2,
      conflict_cap: 0.25,
      min_coverage_fire: 0.55,
      min_coverage_watch: 0.45,
    },
    edgeResolver: (side) => {
      if (projectedTotal === null || totalLine === null) return null;
      const totalEdge = edgeCalculator.computeTotalEdge({
        projectionTotal: projectedTotal,
        totalLine,
        totalPriceOver: toNumber(oddsSnapshot?.total_price_over),
        totalPriceUnder: toNumber(oddsSnapshot?.total_price_under),
        sigmaTotal: edgeCalculator.getSigmaDefaults('NBA')?.total ?? 14,
        isPredictionOver: side === 'OVER',
      });
      return {
        edge: totalEdge.edge ?? null,
        p_fair: totalEdge.p_fair ?? null,
        p_implied: totalEdge.p_implied ?? null,
        edge_points: totalEdge.edgePoints ?? null,
      };
    },
    fairPriceResolver: null,
    lineResolver: () => totalLine,
    priceResolver: (side) =>
      side === 'OVER'
        ? toNumber(oddsSnapshot?.total_price_over)
        : toNumber(oddsSnapshot?.total_price_under),
    projectionResolver: () => ({
      projected_total: projectedTotal,
      total_line: totalLine,
    }),
    riskFlags: totalFragilityPenalty > 0 ? ['KEY_NUMBER'] : [],
  });

  // SPREAD market drivers
  const homeNetRating =
    avgPtsHome !== null && avgPtsAllowedHome !== null
      ? avgPtsHome - avgPtsAllowedHome
      : null;
  const awayNetRating =
    avgPtsAway !== null && avgPtsAllowedAway !== null
      ? avgPtsAway - avgPtsAllowedAway
      : null;

  const spreadBadNumber = spreadHome !== null && Math.abs(spreadHome) >= 8;

  const spreadDrivers = [
    buildDriver({
      driverKey: 'powerRating',
      weight: 0.4,
      eligible: projectedMargin !== null,
      signal: projectedMargin !== null ? clamp(projectedMargin / 15, -1, 1) : 0,
      status: statusFromNumbers([projectedMargin]),
      note: 'Projected margin favors HOME when positive.',
    }),
    buildDriver({
      driverKey: 'restAdvantage',
      weight: 0.2,
      eligible: restGap !== null,
      signal: restGap !== null ? clamp(restGap / 3, -1, 1) : 0,
      status: statusFromNumbers([restDaysHome, restDaysAway]),
      note: 'Rest gap favors the more rested team.',
    }),
    buildDriver({
      driverKey: 'matchupStyle',
      weight: 0.25,
      eligible: homeNetRating !== null && awayNetRating !== null,
      signal:
        homeNetRating !== null && awayNetRating !== null
          ? clamp((homeNetRating - awayNetRating) / 10, -1, 1)
          : 0,
      status: statusFromNumbers([
        avgPtsHome,
        avgPtsAllowedHome,
        avgPtsAway,
        avgPtsAllowedAway,
      ]),
      note: 'Net rating differential favors HOME when positive.',
    }),
    buildDriver({
      driverKey: 'blowoutRisk',
      weight: spreadBadNumber ? 0.15 : 0,
      eligible: spreadBadNumber,
      signal: -0.3,
      status: statusFromNumbers([spreadHome]),
      note: 'Risk-only: large spread reduces confidence toward favored side.',
    }),
  ];

  const spreadBadNumberPenalty = spreadBadNumber ? 0.06 : 0;

  const spreadDecision = buildMarketDecision({
    market: 'SPREAD',
    defaultSide: 'HOME',
    drivers: spreadDrivers,
    penalties: [{ key: 'bad_number', value: spreadBadNumberPenalty }],
    thresholds: {
      t_dir: 0.12,
      t_fire: 0.42,
      t_watch: 0.22,
      conflict_cap: 0.22,
      min_coverage_fire: 0.55,
      min_coverage_watch: 0.45,
    },
    edgeResolver: (side) => {
      if (projectedMargin === null || spreadHome === null) return null;
      const spreadEdge = edgeCalculator.computeSpreadEdge({
        projectionMarginHome: projectedMargin,
        spreadLine: spreadHome,
        spreadPriceHome: toNumber(oddsSnapshot?.spread_price_home),
        spreadPriceAway: toNumber(oddsSnapshot?.spread_price_away),
        sigmaMargin: edgeCalculator.getSigmaDefaults('NBA')?.margin ?? 12,
        isPredictionHome: side === 'HOME',
      });
      return {
        edge: spreadEdge.edge ?? null,
        p_fair: spreadEdge.p_fair ?? null,
        p_implied: spreadEdge.p_implied ?? null,
        edge_points: spreadEdge.edgePoints ?? null,
      };
    },
    fairPriceResolver: null,
    lineResolver: (side) =>
      spreadHome !== null ? (side === 'HOME' ? spreadHome : -spreadHome) : null,
    priceResolver: (side) =>
      side === 'HOME'
        ? toNumber(oddsSnapshot?.spread_price_home)
        : toNumber(oddsSnapshot?.spread_price_away),
    projectionResolver: () => ({
      projected_margin: projectedMargin,
      spread_home_line: spreadHome,
    }),
    riskFlags: spreadBadNumber ? ['BAD_NUMBER'] : [],
  });

  // WI-0571: projection comparison (edge vs consensus vs best available)
  const nbaTotalSide = totalDecision.best_candidate.side;
  const nbaTotalConsensusLine = totalLine; // oddsSnapshot.total IS the consensus line
  const nbaTotalBestLine = nbaTotalSide === 'OVER'
    ? toNumber(oddsSnapshot?.total_line_over)
    : toNumber(oddsSnapshot?.total_line_under);
  totalDecision.projection_comparison = compareProjection({
    fairLine: projectedTotal,
    consensusLine: nbaTotalConsensusLine,
    bestLine: nbaTotalBestLine,
    consensusPrice: null,
    bestPrice: nbaTotalSide === 'OVER'
      ? toNumber(oddsSnapshot?.total_price_over)
      : toNumber(oddsSnapshot?.total_price_under),
  });

  const nbaSpreadSide = spreadDecision.best_candidate.side;
  const nbaRawConsensusLine = toNumber(oddsSnapshot?.spread_consensus_line);
  spreadDecision.projection_comparison = compareProjection({
    fairLine: nbaSpreadSide === 'HOME' ? projectedMargin : (projectedMargin !== null ? -projectedMargin : null),
    consensusLine: nbaSpreadSide === 'HOME'
      ? (nbaRawConsensusLine !== null ? -nbaRawConsensusLine : null)
      : nbaRawConsensusLine,
    bestLine: nbaSpreadSide === 'HOME'
      ? (spreadHome !== null ? -spreadHome : null)
      : (toNumber(oddsSnapshot?.spread_away) !== null ? -toNumber(oddsSnapshot?.spread_away) : null),
    consensusPrice: null,
    bestPrice: nbaSpreadSide === 'HOME'
      ? toNumber(oddsSnapshot?.spread_price_home)
      : toNumber(oddsSnapshot?.spread_price_away),
  });

  // DEGRADED enforcement: cap confidence + forbid PLAY tier
  if (nbaDegraded) {
    for (const dec of [totalDecision, spreadDecision]) {
      if (dec.status && DEGRADED_CONSTRAINTS.FORBIDDEN_TIERS.includes(dec.status)) {
        dec.status = 'WATCH';
      }
      if (dec.best_candidate) {
        dec.best_candidate.confidence = Math.min(
          dec.best_candidate.confidence ?? 1,
          DEGRADED_CONSTRAINTS.MAX_CONFIDENCE,
        );
      }
      dec.model_status = 'DEGRADED';
    }
  }

  console.log(`[input-gate] sport=nba market=multi status=${nbaDegraded ? 'DEGRADED' : 'MODEL_OK'}`);

  return { TOTAL: totalDecision, SPREAD: spreadDecision };
}

function selectExpressionChoice(decisions) {
  const orderedMarkets = [Market.TOTAL, Market.SPREAD, Market.ML];
  const available = orderedMarkets
    .map((market) => {
      const decision = decisions[market];
      if (!decision) return null;
      return {
        ...decision,
        market: decision.market ?? market,
      };
    })
    .filter(Boolean);

  if (available.length === 0) {
    return null;
  }

  const statusRank = {
    [DecisionStatus.FIRE]: 2,
    [DecisionStatus.WATCH]: 1,
    [DecisionStatus.PASS]: 0,
  };

  const byStatus = [...available].sort(
    (a, b) => statusRank[b.status] - statusRank[a.status],
  );
  const topStatus = byStatus[0].status;
  const sameStatus = byStatus.filter(
    (decision) => decision.status === topStatus,
  );

  let chosen = sameStatus[0];
  let rule = 'Rule 1: status';

  if (sameStatus.length > 1) {
    const sortedByScore = [...sameStatus].sort((a, b) => b.score - a.score);
    const scoreDiff = sortedByScore[0].score - sortedByScore[1].score;
    if (scoreDiff > 0.1) {
      chosen = sortedByScore[0];
      rule = 'Rule 2: score gap';
    } else {
      const spreadDecision = decisions[Market.SPREAD];
      const mlDecision = decisions[Market.ML];
      const inTie = [spreadDecision, mlDecision].every(
        (decision) => decision && decision.status === topStatus,
      );
      const tightGap =
        spreadDecision && mlDecision
          ? Math.abs(spreadDecision.score - mlDecision.score) <= 0.05
          : false;

      if (inTie && tightGap) {
        const spreadBadNumber =
          spreadDecision.risk_flags.includes('BAD_NUMBER');
        const mlCoinflip = mlDecision.risk_flags.includes('COINFLIP_ZONE');
        if (spreadBadNumber && mlCoinflip && (mlDecision.edge ?? 0) > 0) {
          chosen = mlDecision;
          rule = 'Rule 4: ML value realism';
        } else {
          chosen = sortedByScore[0];
          rule = 'Rule 2: score tie';
        }
      } else {
        chosen = orderedMarkets
          .map((market) => decisions[market])
          .find((decision) => decision && decision.status === topStatus);
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
      else if (statusRank[decision.status] < statusRank[chosen.status])
        reason = 'LOWER_STATUS';
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
      alternatives,
    },
  };
}

/**
 * WI-0382: Returns true if either goalie state is UNKNOWN or CONFLICTING,
 * blocking totals computation. EXPECTED does NOT trigger escalation.
 * Null-safe: null/undefined inputs return false.
 */
function goalieUncertaintyBlocks(homeGoalieState, awayGoalieState) {
  const blocking = ['UNKNOWN', 'CONFLICTING'];
  return (
    blocking.includes(homeGoalieState?.starter_state) ||
    blocking.includes(awayGoalieState?.starter_state)
  );
}

function computeTotalBias(totalDecision, homeGoalieState, awayGoalieState) {
  // WI-0382: Force INSUFFICIENT_DATA when goalie identity is UNKNOWN or CONFLICTING
  if (goalieUncertaintyBlocks(homeGoalieState, awayGoalieState)) {
    return 'INSUFFICIENT_DATA';
  }

  const hasTotalLine = totalDecision?.best_candidate?.line != null;
  const hasTotalEdge = typeof totalDecision?.edge === 'number';
  const isPlayableTotalStatus =
    totalDecision && totalDecision.status !== DecisionStatus.PASS;

  return isPlayableTotalStatus && hasTotalLine && hasTotalEdge
    ? 'OK'
    : 'INSUFFICIENT_DATA';
}

function buildMarketPayload({ decisions, expressionChoice, homeGoalieState, awayGoalieState }) {
  const totalDecision = decisions?.TOTAL;
  const totalBias = computeTotalBias(totalDecision, homeGoalieState, awayGoalieState);

  if (!expressionChoice) {
    return {
      consistency: {
        total_bias: totalBias,
      },
    };
  }
  const chosen = expressionChoice.chosen;
  return {
    consistency: {
      total_bias: totalBias,
    },
    expression_choice: {
      chosen_market: expressionChoice.chosen_market,
      pick: formatPick(chosen),
      status: chosen.status,
      score: chosen.score,
      net: chosen.net,
      edge: chosen.edge ?? null,
      chosen: buildExpressionChoiceSnapshot(expressionChoice),
    },
    market_narrative: {
      chosen_story: expressionChoice.story.chosen_narrative,
      alternatives: expressionChoice.story.alternatives,
      orchestration: expressionChoice.why_this_market,
    },
    all_markets: decisions,
  };
}

module.exports = {
  computeNHLMarketDecisions,
  computeNBAMarketDecisions,
  selectExpressionChoice,
  goalieUncertaintyBlocks,
  computeTotalBias,
  buildMarketPayload,
};
