#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const {getDatabase, closeDatabase } = require('../../packages/data/src/db.js');

async function checkMismatch() {
  const db = getDatabase();

  // Check NBA games - do they have NBA card types?
  const nbaCards = db.prepare(`
    SELECT cp.game_id, cp.sport, cp.card_type
    FROM card_payloads cp
    INNER JOIN games g ON cp.game_id = g.game_id
    WHERE g.sport = 'NBA'
      AND g.game_time_utc >= datetime('now')
    LIMIT 15
  `).all();

  console.log('\nNBA games - card types:');
  let nbaCorrect = 0;
  let nbaWrong = 0;
  nbaCards.forEach((c) => {
    const isCorrect = c.card_type.toLowerCase().includes('nba');
    if (isCorrect) nbaCorrect += 1;
    else nbaWrong += 1;
    console.log(`  ${c.card_type} ${isCorrect ? '✓' : '❌ MISMATCH'}`);
  });
  console.log(`  Summary: ${nbaCorrect} correct, ${nbaWrong} mismatched`);

  // Check all sports
  console.log('\n\nAll sports - mismatched cards:');
  const allMismatches = db
    .prepare(`
    SELECT g.sport, cp.card_type, COUNT(*) as count
    FROM card_payloads cp
    INNER JOIN games g ON cp.game_id = g.game_id
    WHERE g.game_time_utc >= datetime('now')
      AND (cp.expires_at IS NULL OR cp.expires_at > datetime('now'))
    GROUP BY g.sport, cp.card_type
    ORDER BY g.sport, count DESC
  `)
    .all();

  const sportGroups = {};
  allMismatches.forEach((row) => {
    if (!sportGroups[row.sport]) {
      sportGroups[row.sport] = { correct: 0, wrong: 0, types: [] };
    }
    const cardTypeLower = row.card_type.toLowerCase();
    const sportLower = row.sport.toLowerCase();
    const isMatch = cardTypeLower.includes(sportLower);
    sportGroups[row.sport].types.push({
      type: row.card_type,
      count: row.count,
      match: isMatch,
    });
    if (isMatch) {
      sportGroups[row.sport].correct += row.count;
    } else {
      sportGroups[row.sport].wrong += row.count;
    }
  });

  Object.keys(sportGroups).forEach((sport) => {
    const stats = sportGroups[sport];
    console.log(`\n${sport}: ${stats.correct} correct, ${stats.wrong} mismatched`);
    stats.types.slice(0, 5).forEach((t) => {
      console.log(`  ${t.type}: ${t.count} ${t.match ? '✓' : '❌'}`);
    });
  });

  closeDatabase();
}

checkMismatch().catch(console.error);
