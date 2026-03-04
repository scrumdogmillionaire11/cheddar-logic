const {initDb,getDatabase,closeDatabase}=require('../../packages/data/src/db.js');

(async()=>{
  await initDb();
  const db=getDatabase();
  
  // Check all recent cards by sport and action/status
  const summary = db.prepare(`
    SELECT 
      sport,
      json_extract(payload_data, '$.action') as action,
      json_extract(payload_data, '$.status') as status,
      json_extract(payload_data, '$.tier') as tier,
      json_extract(payload_data, '$.kind') as kind,
      json_extract(payload_data, '$.market_type') as market_type,
      COUNT(*) as count
    FROM card_payloads
    WHERE created_at > datetime('now', '-1 hour')
    GROUP BY sport, action, status, tier, kind, market_type
    ORDER BY sport, count DESC
  `).all();
  
  console.log('\n=== Card Summary (Last Hour) ===\n');
  console.table(summary);
  
  // Check for FIRE tier specifically
  const fireCards = db.prepare(`
    SELECT 
      sport,
      game_id,
      json_extract(payload_data, '$.matchup') as matchup,
      json_extract(payload_data, '$.tier') as tier,
      json_extract(payload_data, '$.action') as action,
      json_extract(payload_data, '$.status') as status,
      json_extract(payload_data, '$.market_type') as market_type,
      json_extract(payload_data, '$.edge') as edge
    FROM card_payloads
    WHERE created_at > datetime('now', '-1 hour')
      AND json_extract(payload_data, '$.tier') = 'FIRE'
    LIMIT 10
  `).all();
  
  console.log('\n=== FIRE Tier Cards (Last Hour) ===\n');
  if (fireCards.length === 0) {
    console.log('NO FIRE TIER CARDS FOUND');
  } else {
    console.table(fireCards);
  }
  
  // Check NHL specifically
  const nhlCards = db.prepare(`
    SELECT 
      card_type,
      json_extract(payload_data, '$.matchup') as matchup,
      json_extract(payload_data, '$.kind') as kind,
      json_extract(payload_data, '$.market_type') as market_type,
      json_extract(payload_data, '$.action') as action,
      json_extract(payload_data, '$.status') as status,
      json_extract(payload_data, '$.tier') as tier,
      created_at
    FROM card_payloads
    WHERE sport = 'NHL'
      AND created_at > datetime('now', '-1 hour')
    ORDER BY created_at DESC
    LIMIT 10
  `).all();
  
  console.log('\n=== NHL Cards (Last Hour) ===\n');
  if (nhlCards.length === 0) {
    console.log('NO NHL CARDS FOUND IN LAST HOUR');
    
    // Check when NHL last ran
    const lastNhl = db.prepare(`
      SELECT MAX(created_at) as last_run
      FROM card_payloads
      WHERE sport = 'NHL'
    `).get();
    
    console.log('Last NHL card created:', lastNhl.last_run || 'NEVER');
  } else {
    console.table(nhlCards);
  }
  
  closeDatabase();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
