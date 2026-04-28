const decisionStatus = require('./decision-status');
const reasonCodes = require('./reason-codes');
const decisionOutcome = require('./decision-outcome');

module.exports = {
  ...decisionStatus,
  ...reasonCodes,
  ...decisionOutcome,
};