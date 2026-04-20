'use strict';

const { DateTime } = require('luxon');

function makeEtDateTime(hour, minute = 0) {
  return DateTime.now().setZone('America/New_York').set({ hour, minute, second: 0, millisecond: 0 });
}

module.exports = { makeEtDateTime };
