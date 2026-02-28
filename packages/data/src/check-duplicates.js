/**
 * Check for duplicate records in database
 * Used to verify idempotency of job runs
 */

const { withDb } = require('./job-runtime');

async function checkDuplicates() {
  try {
    return await withDb(async (client) => {
      console.log('🔍 DUPLICATION CHECK\n');
      
      // Count model_outputs per game
      const modelDupes = client.prepare(`
        SELECT game_id, model_name, COUNT(*) as count
        FROM model_outputs
        GROUP BY game_id, model_name
        HAVING COUNT(*) > 1
      `).all();
      
      console.log('📊 model_outputs duplicates:');
      if (modelDupes.length > 0) {
        modelDupes.forEach(d => console.log(`  ${d.game_id} (${d.model_name}): ${d.count} copies`));
      } else {
        console.log('  NONE');
      }
      
      // Count card_payloads per game
      const cardDupes = client.prepare(`
        SELECT game_id, card_type, COUNT(*) as count
        FROM card_payloads
        GROUP BY game_id, card_type
        HAVING COUNT(*) > 1
      `).all();
      
      console.log('\n🃏 card_payloads duplicates:');
      if (cardDupes.length > 0) {
        cardDupes.forEach(d => console.log(`  ${d.game_id} (${d.card_type}): ${d.count} copies`));
      } else {
        console.log('  NONE');
      }
      
      // Total counts
      const totals = {
        model_outputs: client.prepare('SELECT COUNT(*) as n FROM model_outputs').get().n,
        card_payloads: client.prepare('SELECT COUNT(*) as n FROM card_payloads').get().n,
        job_runs: client.prepare('SELECT COUNT(*) as n FROM job_runs').get().n
      };
      
      console.log('\n📈 Total counts:');
      console.log(`  model_outputs: ${totals.model_outputs}`);
      console.log(`  card_payloads: ${totals.card_payloads}`);
      console.log(`  job_runs: ${totals.job_runs}`);
      
      // Show job runs
      const jobRuns = client.prepare(`
        SELECT job_name, status, started_at
        FROM job_runs
        ORDER BY started_at DESC
        LIMIT 5
      `).all();
      
      console.log('\n📋 Recent job runs:');
      jobRuns.forEach(j => console.log(`  ${j.job_name} (${j.status}) - ${j.started_at}`));
      
      return {
        success: true,
        hasDuplicates: modelDupes.length > 0 || cardDupes.length > 0
      };
    });
  } catch (error) {
    console.error('❌ Check failed:', error.message);
    return { success: false, error: error.message };
  }
}

if (require.main === module) {
  checkDuplicates()
    .then(result => {
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = { checkDuplicates };
