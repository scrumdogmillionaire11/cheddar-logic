'use strict';

const data = require('@cheddar-logic/data');

async function withDbSafe(fn) {
  if (typeof data.withDb === 'function') {
    return data.withDb(fn);
  }

  const db = typeof data.getDatabase === 'function' ? data.getDatabase() : null;
  return fn(db);
}

module.exports = {
  withDbSafe,
};
