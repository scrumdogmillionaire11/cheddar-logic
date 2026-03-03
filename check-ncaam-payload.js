const {initDb,getDatabase,closeDatabase}=require('./packages/data/src/db.js');

(async()=>{
  await initDb();
  const db=getDatabase();
  const row=db.prepare("SELECT payload_data FROM card_payloads WHERE sport='NCAAM' AND card_type='ncaam-base-projection' ORDER BY created_at DESC LIMIT 1").get();
  const p=JSON.parse(row.payload_data);
  console.log('kind:', p.kind);
  console.log('market_type:', p.market_type);
  console.log('has driver:',!!p.driver);
  console.log('driver.key:', p.driver?.key);
  console.log('game:', p.matchup);
  console.log('generated_at:', p.generated_at);
  closeDatabase();
})().catch(e=>{console.error(e);process.exit(1);});
