'use strict';
require('dotenv').config();
const { getDatabase } = require('@cheddar-logic/data');
const db = getDatabase();
const rows = db.prepare(`
  SELECT game_id, raw_data FROM odds_snapshots
  WHERE sport = 'nhl' AND captured_at > datetime('now', '-48 hours')
  ORDER BY captured_at DESC LIMIT 10
`).all();

if (rows.length === 0) {
  console.log('No NHL snapshots found in the last 48 hours.');
  process.exit(0);
}

rows.forEach(r => {
  let raw = {};
  try { raw = JSON.parse(r.raw_data || '{}'); } catch {}
  const direct = raw?.seriesStatus;
  const nested = raw?.season?.seriesStatus;
  const event = raw?.event?.seriesStatus;
  console.log(r.game_id, {
    'raw_data.seriesStatus': direct ?? 'MISSING',
    'raw_data.season.seriesStatus': nested ?? 'MISSING',
    'raw_data.event.seriesStatus': event ?? 'MISSING',
  });
});
