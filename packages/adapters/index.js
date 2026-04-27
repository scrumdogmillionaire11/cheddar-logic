/**
 * @cheddar-logic/adapters
 * 
 * Adapters for external data sources that persist to cheddar-logic DB
 */

const normalize = require('./normalize');
const actionNetwork = require('./src/action-network');

module.exports = {
  normalize,
  actionNetwork,
};
