'use strict';

/**
 * packages/adapters/src — barrel
 *
 * Re-exports all adapter modules so consumers can import from a single path.
 */

const actionNetwork = require('./action-network');
const vsin = require('./vsin');

module.exports = {
  actionNetwork,
  vsin,
};
