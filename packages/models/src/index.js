const cardModel = require('./card-model');
const marketOrchestration = require('./market-orchestration');
const edgeCalculator = require('./edge-calculator');
const decisionGate = require('./decision-gate');
const decisionPipelineV2 = require('./decision-pipeline-v2');
const decisionPipelineV2Patch = require('./decision-pipeline-v2-edge-config');
const decisionPolicy = require('./decision-policy');
const nhlSog = require('./nhl-sog/projection');
const marketStructure = require('./market-structure');
const { generateCard, buildMarketCallCard } = require('./card-factory');

module.exports = {
  ...cardModel,
  ...marketOrchestration,
  edgeCalculator,
  ...decisionGate,
  ...decisionPipelineV2,
  ...decisionPipelineV2Patch,
  ...decisionPolicy,
  ...nhlSog,
  ...marketStructure,
  generateCard,
  buildMarketCallCard,
};

// Consolidated card utilities (2026-03-04)
const { computeWinProbHome, buildDriverSummary } = require('./card-utilities');
module.exports.computeWinProbHome = computeWinProbHome;
module.exports.buildDriverSummary = buildDriverSummary;

// Decision basis helpers (used by model runners in Without Odds Mode)
const { buildDecisionBasisMeta, DECISION_BASIS, MARKET_LINE_SOURCE } = require('./decision-basis.types');
module.exports.buildDecisionBasisMeta = buildDecisionBasisMeta;
module.exports.DECISION_BASIS = DECISION_BASIS;
module.exports.MARKET_LINE_SOURCE = MARKET_LINE_SOURCE;
