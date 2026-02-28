/**
 * Debug: Inspect real odds-fetcher response
 * Shows actual field names from shared-data provider
 */
const sharedDataFetcher = require('/Users/ajcolubiale/projects/shared-data/lib/odds-fetcher');

(async () => {
  console.log('Fetching real NHL odds from shared-data...\n');
  try {
    const result = await sharedDataFetcher.fetchSport('NHL');
    
    console.log('=== RESPONSE STRUCTURE ===');
    console.log('Top-level keys:', Object.keys(result || {}));
    console.log('');
    
    if (result && result.games && result.games.length > 0) {
      console.log(`Found ${result.games.length} games`);
      console.log('\n=== FIRST GAME OBJECT ===');
      const sample = result.games[0];
      console.log(JSON.stringify(sample, null, 2));
      
      console.log('\n=== FIELD NAMES PRESENT ===');
      const keys = Object.keys(sample).sort();
      keys.forEach(k => {
        const val = sample[k];
        const type = Array.isArray(val) ? 'array' : typeof val;
        console.log(`  ${k}: ${type}`);
      });
    } else {
      console.log('No games in response or empty result');
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
  
  process.exit(0);
})();
