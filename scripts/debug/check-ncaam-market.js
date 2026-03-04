const {initDb,getDatabase,closeDatabase}=require('../../packages/data/src/db.js');

(async()=>{
  await initDb();
  const db=getDatabase();
  
  const row=db.prepare(`
    SELECT payload_data 
    FROM card_payloads 
    WHERE sport='NCAAM' 
      AND card_type='ncaam-base-projection' 
    ORDER BY created_at DESC 
    LIMIT 1
  `).get();
  
  const p=JSON.parse(row.payload_data);
  
  console.log('\n=== NCAAM Card Market Analysis ===');
  console.log('Game:', p.matchup);
  console.log('Prediction:', p.prediction);
  console.log('\nCard Fields:');
  console.log('  market_type:', p.market_type);
  console.log('  recommended_bet_type:', p.recommended_bet_type);
  console.log('  selection:', p.selection);
  console.log('  line:', p.line);
  console.log('  price:', p.price);
  
  console.log('\nOdds Context:');
  console.log('  h2h_home:', p.odds_context?.h2h_home);
  console.log('  h2h_away:', p.odds_context?.h2h_away);
  console.log('  spread_home:', p.odds_context?.spread_home);
  console.log('  spread_away:', p.odds_context?.spread_away);
  console.log('  spread_price_home:', p.odds_context?.spread_price_home);
  console.log('  spread_price_away:', p.odds_context?.spread_price_away);
  
  console.log('\nExpected:');
  if (p.market_type === 'MONEYLINE') {
    console.log('  For HOME moneyline: price should be h2h_home');
    console.log('  For AWAY moneyline: price should be h2h_away');
  } else if (p.market_type === 'SPREAD') {
    console.log('  For HOME spread: price should be spread_price_home, line should be spread_home');
    console.log('  For AWAY spread: price should be spread_price_away, line should be spread_away');
  }
  
  closeDatabase();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
