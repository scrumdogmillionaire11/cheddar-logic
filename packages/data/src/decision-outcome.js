const builders = require('./decision-outcome.builders');
const { validateDecisionOutcome } = require('./validators/decision-outcome');

module.exports = {
  ...builders,
  validateDecisionOutcome,
};
