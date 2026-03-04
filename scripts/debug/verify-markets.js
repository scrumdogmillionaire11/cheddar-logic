const {initDb,getDatabase,closeDatabase}=require('../../packages/data/src/db.js');

(async()=>{
  await initDb();
  const db=getDatabase();
  
  // Get the latest 2 cards for one game (should be one ML, one spread)
  const rows=db.prepare(`
    SELECT payload_data 
    FROM card_payloads 
    WHERE sport='NCAAM' 
      AND game_id='fd0885d45c58793ffda72c543d20ae16'
      AND card_type='ncaam-base-projection'
    ORDER BY created_at DESC 
    LIMIT 2
  `).all();
  
  console.log('\n=== NCAAM Cards for Same Game ===\n');
  
  rows.forEach((row, i) => {
    const p=JSON.parse(row.payload_data);
    console.log(`Card ${i + 1}:`);
    console.log('  Game:', p.matchup);
    console.log('  Prediction:', p.prediction);
    console.log('  market_type:', p.market_type);
    console.log('  recommended_bet_type:', p.recommended_bet_type);
    console.log('  selection:', p.selection.side, p.selection.team);
    console.log('  line:', p.line);
    console.log('  price:', p.price);
    
    if (p.market_type === 'MONEYLINE') {
      console.log('  ✓ Expected: price =', p.prediction === 'HOME' ? p.odds_context.h2h_home : p.odds_context.h2h_away);
      console.log('  ✓ Actual: price =', p.price);
      console.log('  Match:', p.price === (p.prediction ===  'HOME' ? p.odds_context.h2h_home : p.odds_context.h2h_away) ? 'YES ✓' : 'NO ✗');
    } else if (p.market_type === 'SPREAD') {
      console.log('  ✓ Expected line =', p.prediction === 'HOME' ? p.odds_context.spread_home : p.odds_context.spread_away);
      console.log('  ✓ Expected price =', p.prediction === 'HOME' ? p.odds_context.spread_price_home : p.odds_context.spread_price_away);
      console.log('  ✓ Actual line =', p.line);
      console.log('  ✓ Actual price =', p.price);
      console.log('  Match:', 
        (p.line === (p.prediction === 'HOME' ? p.odds_context.spread_home : p.odds_context.spread_away) &&
         p.price === (p.prediction === 'HOME' ? p.odds_context.spread_price_home : p.odds_context.spread_price_away)) ? 'YES ✓' : 'NO ✗');
    }
    console.log('');
  });
  
  closeDatabase();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
