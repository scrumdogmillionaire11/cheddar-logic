'use strict';

/**
 * packages/adapters/src — barrel
 *
 * Re-exports all adapter modules so consumers can import from a single path.
 */

const actionNetwork = require('./action-network');
const vsin = require('./vsin');
const f5LineFetcher = require('./f5-line-fetcher');

module.exports = {
  actionNetwork,
  vsin,
  f5LineFetcher,
};
