const cardModel = require('./card-model');
const marketOrchestration = require('./market-orchestration');
const edgeCalculator = require('./edge-calculator');
const decisionGate = require('./decision-gate');
const decisionPipelineV2 = require('./decision-pipeline-v2');
const decisionPipelineV2Patch = require('./decision-pipeline-v2.patch');
const nhlSog = require('./nhl-sog/projection');
const { generateCard, buildMarketCallCard } = require('./card-factory');

module.exports = {
  ...cardModel,
  ...marketOrchestration,
  edgeCalculator,
  ...decisionGate,
  ...decisionPipelineV2,
  ...decisionPipelineV2Patch,
  ...nhlSog,
  generateCard,
  buildMarketCallCard,
};

// Consolidated card utilities (2026-03-04)
const { computeWinProbHome, buildDriverSummary } = require('./card-utilities');
module.exports.computeWinProbHome = computeWinProbHome;
module.exports.buildDriverSummary = buildDriverSummary;
