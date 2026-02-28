/**
 * @cheddar-logic/adapters
 * 
 * Adapters for external data sources that persist to cheddar-logic DB
 */

const oddsAdapter = require('./odds-fetcher');
const normalize = require('./normalize');

module.exports = {
  odds: oddsAdapter,
  normalize
};
