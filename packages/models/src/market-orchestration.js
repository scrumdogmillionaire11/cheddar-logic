const Market = Object.freeze({
  TOTAL: 'TOTAL',
  SPREAD: 'SPREAD',
  ML: 'ML'
});

const DecisionStatus = Object.freeze({
  FIRE: 'FIRE',
  WATCH: 'WATCH',
  PASS: 'PASS'
});

/**
 * @typedef {object} DriverSignal
 * @property {string} driverKey
 * @property {number} weight
 * @property {boolean} eligible
 * @property {number} signal
 * @property {number} contrib
 * @property {'ok'|'partial'|'missing'} status
 * @property {string=} note
 */

/**
 * @typedef {object} MarketDecision
 * @property {'TOTAL'|'SPREAD'|'ML'} market
 * @property {{side: 'OVER'|'UNDER'|'HOME'|'AWAY', line?: number, price?: number}} best_candidate
 * @property {'FIRE'|'WATCH'|'PASS'} status
 * @property {number} score
 * @property {number} net
 * @property {number} conflict
 * @property {number} coverage
 * @property {number=} edge
 * @property {number=} fair_price
 * @property {DriverSignal[]} drivers
 * @property {string[]} risk_flags
 * @property {string} reasoning
 */

/**
 * @typedef {object} ExpressionChoice
 * @property {'TOTAL'|'SPREAD'|'ML'} chosen_market
 * @property {MarketDecision} chosen
 * @property {Array<{market: 'TOTAL'|'SPREAD'|'ML', decision: MarketDecision, rejection_reason: string}>} rejected
 * @property {string} why_this_market
 * @property {{chosen_narrative: string, alternatives: Record<string, string>}} story
 */

function renormalizeDriverWeights(drivers) {
  const eligible = drivers.filter((driver) => driver.eligible);
  const totalWeight = eligible.reduce((sum, driver) => sum + driver.weight, 0);
  if (totalWeight <= 0) return drivers;
  return drivers.map((driver) => {
    if (!driver.eligible) return driver;
    return { ...driver, weight: driver.weight / totalWeight };
  });
}

function computeConflict(drivers) {
  let support = 0;
  let oppose = 0;
  for (const driver of drivers.filter((item) => item.eligible)) {
    if (driver.signal > 0.10) support += driver.weight;
    if (driver.signal < -0.10) oppose += driver.weight;
  }
  return Math.min(support, oppose);
}

function computeCoverage(drivers) {
  const eligible = drivers.filter((driver) => driver.eligible);
  const totalWeight = eligible.reduce((sum, driver) => sum + driver.weight, 0);
  if (totalWeight <= 0) return 0;
  const coverageWeight = eligible.reduce((sum, driver) => {
    if (driver.status === 'ok') return sum + driver.weight;
    if (driver.status === 'partial') return sum + driver.weight * 0.5;
    return sum;
  }, 0);
  return Number((coverageWeight / totalWeight).toFixed(3));
}

module.exports = {
  Market,
  DecisionStatus,
  renormalizeDriverWeights,
  computeConflict,
  computeCoverage
};
