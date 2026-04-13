/**
 * @cheddar-logic/adapters
 * 
 * Adapters for external data sources that persist to cheddar-logic DB
 */

const normalize = require('./normalize');
const actionNetwork = require('./src/action-network');
const f5LineFetcher = require('./src/f5-line-fetcher');

module.exports = {
  normalize,
  actionNetwork,
  f5LineFetcher,
};
