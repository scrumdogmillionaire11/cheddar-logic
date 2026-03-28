const {getDatabase,closeDatabase}=require('../../packages/data/src/db.js');

(async()=>{
  const db=getDatabase();
  const row=db.prepare("SELECT raw_data FROM odds_snapshots WHERE game_id='fd0885d45c58793ffda72c543d20ae16' ORDER BY captured_at DESC LIMIT 1").get();
  const raw=JSON.parse(row.raw_data);
  console.log('spread_home:', raw.spread_home);
  console.log('spread_away:', raw.spread_away);
  console.log('total:', raw.total);
  console.log('has espn_metrics:', !!raw.espn_metrics);
  if (raw.espn_metrics) {
    console.log('home metrics:', !!raw.espn_metrics.home);
    console.log('away metrics:', !!raw.espn_metrics.away);
  }
  closeDatabase();
})().catch(e=>{console.error(e);process.exit(1);});
