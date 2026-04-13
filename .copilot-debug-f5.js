const Database = require('better-sqlite3');
const db = new Database('./packages/data/cheddar.db');

console.log('=== F5 Card Diagnostic ===\n');

const latestRun = db.prepare("SELECT DISTINCT run_id FROM card_payloads WHERE sport = 'MLB' ORDER BY created_at DESC LIMIT 1").get();
if (latestRun) {
  console.log('Latest MLB run:', latestRun.run_id);
  
  const f5Cards = db.prepare("SELECT COUNT(*) as cnt FROM card_payloads WHERE run_id = ? AND (card_type LIKE '%f5%' OR card_type = 'mlb-f5')").get(latestRun.run_id);
  console.log('F5 cards generated:', f5Cards.cnt);
  
  // List all card types
  const cardTypes = db.prepare("SELECT DISTINCT card_type, COUNT(*) as cnt FROM card_payloads WHERE run_id = ? GROUP BY card_type ORDER BY cnt DESC").all(latestRun.run_id);
  console.log('\nAll card types in this run:');
  cardTypes.forEach(t => console.log(`  ${t.card_type}: ${t.cnt}`));
  
  // Check a sample game's data
  const sample = db.prepare("SELECT game_id, card_type, json_extract(payload_data, '$.odds_snapshot.total_f5') as f5_line FROM card_payloads WHERE run_id = ? AND card_type != 'mlb-pitcher-k' LIMIT 1").get(latestRun.run_id);
  if (sample) {
    console.log('\nSample card game:', sample.game_id);
    console.log('  Card type:', sample.card_type);
    console.log('  F5 line in odds snapshot:', sample.f5_line);
  }
}

db.close();
