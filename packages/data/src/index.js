const decisionStatus = require('./decision-status');
const reasonCodes = require('./reason-codes');

module.exports = {
  ...decisionStatus,
  ...reasonCodes,
};