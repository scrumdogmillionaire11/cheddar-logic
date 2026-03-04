/**
 * Seed Test Odds Data
 * 
 * ⚠️  WARNING: FOR TESTING ONLY - DO NOT USE IN PRODUCTION ⚠️
 * 
 * Inserts deterministic test odds snapshots for local testing.
 * Used to validate model runner jobs without external API dependencies.
 * 
 * For production/development, use: npm --prefix apps/worker run job:pull-odds
 * (fetches real games from The Odds API)
 * 
 * Usage (testing only):
 *   npm run seed:test-odds
 *   node src/seed-test-odds.js
 * 
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

const { v4: uuidV4 } = require('uuid');
const {
  insertOddsSnapshot,
  insertJobRun,
  markJobRunSuccess,
  upsertGame,
  insertCardPayload
} = require('./db.js');
const { withDb } = require('./job-runtime');

/**
 * Generate deterministic test odds snapshots AND game records
 */
function generateTestData() {
  const now = new Date();
  const capturedAt = now.toISOString();
  
  // Game times: 2 hours from now (upcoming), 4 hours from now, 6 hours from now
  const gameTime1 = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  const gameTime2 = new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString();
  const gameTime3 = new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString();
  
  // Create a job run for these seeds
  const jobRunId = `job-seed-test-${now.toISOString().split('.')[0]}`;
  
  const games = [
    // NHL
    {
      id: `game-${uuidV4()}`,
      gameId: 'nhl-2026-02-27-tor-mtl',
      sport: 'NHL',
      homeTeam: 'Toronto Maple Leafs',
      awayTeam: 'Montreal Canadiens',
      gameTimeUtc: gameTime1,
      status: 'scheduled'
    },
    {
      id: `game-${uuidV4()}`,
      gameId: 'nhl-2026-02-27-edm-cgy',
      sport: 'NHL',
      homeTeam: 'Edmonton Oilers',
      awayTeam: 'Calgary Flames',
      gameTimeUtc: gameTime2,
      status: 'scheduled'
    },
    {
      id: `game-${uuidV4()}`,
      gameId: 'nhl-2026-02-27-van-sea',
      sport: 'NHL',
      homeTeam: 'Vancouver Canucks',
      awayTeam: 'Seattle Kraken',
      gameTimeUtc: gameTime3,
      status: 'scheduled'
    },
    // NBA
    {
      id: `game-${uuidV4()}`,
      gameId: 'nba-2026-02-27-lal-gsw',
      sport: 'NBA',
      homeTeam: 'Golden State Warriors',
      awayTeam: 'Los Angeles Lakers',
      gameTimeUtc: gameTime1,
      status: 'scheduled'
    },
    {
      id: `game-${uuidV4()}`,
      gameId: 'nba-2026-02-27-bos-mia',
      sport: 'NBA',
      homeTeam: 'Miami Heat',
      awayTeam: 'Boston Celtics',
      gameTimeUtc: gameTime2,
      status: 'scheduled'
    },
    // SOCCER (EPL)
    {
      id: `game-${uuidV4()}`,
      gameId: 'soccer-epl-2026-02-27-mun-liv',
      sport: 'SOCCER',
      league: 'EPL',
      homeTeam: 'Liverpool FC',
      awayTeam: 'Manchester United',
      gameTimeUtc: gameTime1,
      status: 'scheduled'
    },
    // SOCCER (MLS)
    {
      id: `game-${uuidV4()}`,
      gameId: 'soccer-mls-2026-02-27-lafc-vsl',
      sport: 'SOCCER',
      league: 'MLS',
      homeTeam: 'Vancouver Whitecaps',
      awayTeam: 'LAFC',
      gameTimeUtc: gameTime2,
      status: 'scheduled'
    },
    // SOCCER (Champions League)
    {
      id: `game-${uuidV4()}`,
      gameId: 'soccer-ucl-2026-02-27-rm-psg',
      sport: 'SOCCER',
      league: 'UCL',
      homeTeam: 'Paris Saint-Germain',
      awayTeam: 'Real Madrid',
      gameTimeUtc: gameTime3,
      status: 'scheduled'
    },
    // NCAAM
    {
      id: `game-${uuidV4()}`,
      gameId: 'ncaam-2026-02-27-duke-unc',
      sport: 'NCAAM',
      homeTeam: 'UNC Tar Heels',
      awayTeam: 'Duke Blue Devils',
      gameTimeUtc: gameTime1,
      status: 'scheduled'
    },
    {
      id: `game-${uuidV4()}`,
      gameId: 'ncaam-2026-02-27-kansas-baylor',
      sport: 'NCAAM',
      homeTeam: 'Baylor Bears',
      awayTeam: 'Kansas Jayhawks',
      gameTimeUtc: gameTime3,
      status: 'scheduled'
    }
  ];
  
  return {
    jobRunId,
    games,
    snapshots: [
      {
        id: `odds-test-nhl-tor-mtl-${uuidV4().slice(0, 8)}`,
        gameId: 'nhl-2026-02-27-tor-mtl',
        sport: 'NHL',
        capturedAt,
        h2hHome: -118,  // Toronto Maple Leafs (favorite)
        h2hAway: 105,  // Montreal Canadiens
        total: 6.5,
        totalPriceOver: -110,
        totalPriceUnder: -110,
        spreadHome: -1.5,
        spreadAway: 1.5,
        spreadPriceHome: -110,
        spreadPriceAway: -110,
        monelineHome: -118,
        monelineAway: 105,
        jobRunId,
        rawData: {
          bookmaker: 'test-bookmaker',
          market: 'h2h',
          last_update: capturedAt,
          teams: {
            home: 'Toronto Maple Leafs',
            away: 'Montreal Canadiens'
          }
        }
      },
      {
        id: `odds-test-nhl-edm-cgy-${uuidV4().slice(0, 8)}`,
        gameId: 'nhl-2026-02-27-edm-cgy',
        sport: 'NHL',
        capturedAt,
        h2hHome: -133,  // Edmonton Oilers (strong favorite)
        h2hAway: 120,  // Calgary Flames
        total: 6.0,
        totalPriceOver: -110,
        totalPriceUnder: -110,
        spreadHome: -1.5,
        spreadAway: 1.5,
        spreadPriceHome: -110,
        spreadPriceAway: -110,
        monelineHome: -133,
        monelineAway: 120,
        jobRunId,
        rawData: {
          bookmaker: 'test-bookmaker',
          market: 'h2h',
          last_update: capturedAt,
          teams: {
            home: 'Edmonton Oilers',
            away: 'Calgary Flames'
          }
        }
      },
      {
        id: `odds-test-nhl-van-sea-${uuidV4().slice(0, 8)}`,
        gameId: 'nhl-2026-02-27-van-sea',
        sport: 'NHL',
        capturedAt,
        h2hHome: -110,  // Vancouver Canucks (even matchup)
        h2hAway: -110,  // Seattle Kraken
        total: 5.5,
        totalPriceOver: -110,
        totalPriceUnder: -110,
        spreadHome: -0.5,
        spreadAway: 0.5,
        spreadPriceHome: -110,
        spreadPriceAway: -110,
        monelineHome: -110,
        monelineAway: -110,
        jobRunId,
        rawData: {
          bookmaker: 'test-bookmaker',
          market: 'h2h',
          last_update: capturedAt,
          teams: {
            home: 'Vancouver Canucks',
            away: 'Seattle Kraken'
          }
        }
      },
      // NBA
      {
        id: `odds-test-nba-lal-gsw-${uuidV4().slice(0, 8)}`,
        gameId: 'nba-2026-02-27-lal-gsw',
        sport: 'NBA',
        capturedAt,
        h2hHome: -110,  // Golden State Warriors (favorite)
        h2hAway: -110,  // Los Angeles Lakers
        total: 216.5,
        totalPriceOver: -110,
        totalPriceUnder: -110,
        spreadHome: -2.5,
        spreadAway: 2.5,
        spreadPriceHome: -110,
        spreadPriceAway: -110,
        monelineHome: -135,
        monelineAway: 115,
        jobRunId,
        rawData: {
          bookmaker: 'test-bookmaker',
          market: 'h2h',
          last_update: capturedAt,
          teams: {
            home: 'Golden State Warriors',
            away: 'Los Angeles Lakers'
          }
        }
      },
      {
        id: `odds-test-nba-bos-mia-${uuidV4().slice(0, 8)}`,
        gameId: 'nba-2026-02-27-bos-mia',
        sport: 'NBA',
        capturedAt,
        h2hHome: -110,  // Miami Heat (slight underdog)
        h2hAway: -110,  // Boston Celtics (favorite)
        total: 208.0,
        totalPriceOver: -110,
        totalPriceUnder: -110,
        spreadHome: 2.5,
        spreadAway: -2.5,
        spreadPriceHome: -110,
        spreadPriceAway: -110,
        monelineHome: 105,
        monelineAway: -125,
        jobRunId,
        rawData: {
          bookmaker: 'test-bookmaker',
          market: 'h2h',
          last_update: capturedAt,
          teams: {
            home: 'Miami Heat',
            away: 'Boston Celtics'
          }
        }
      },
      // SOCCER (EPL)
      {
        id: `odds-test-soccer-epl-mun-liv-${uuidV4().slice(0, 8)}`,
        gameId: 'soccer-epl-2026-02-27-mun-liv',
        sport: 'SOCCER',
        capturedAt,
        h2hHome: -120,  // Liverpool FC
        h2hAway: 105,  // Manchester United
        total: 2.5,
        totalPriceOver: -110,
        totalPriceUnder: -110,
        monelineHome: -120,
        monelineAway: 105,
        jobRunId,
        rawData: {
          bookmaker: 'test-bookmaker',
          league: 'EPL',
          market: 'h2h',
          last_update: capturedAt,
          teams: {
            home: 'Liverpool FC',
            away: 'Manchester United'
          }
        }
      },
      // SOCCER (MLS)
      {
        id: `odds-test-soccer-mls-lafc-vsl-${uuidV4().slice(0, 8)}`,
        gameId: 'soccer-mls-2026-02-27-lafc-vsl',
        sport: 'SOCCER',
        capturedAt,
        h2hHome: -110,  // Vancouver Whitecaps
        h2hAway: -110,  // LAFC
        total: 2.75,
        totalPriceOver: -110,
        totalPriceUnder: -110,
        monelineHome: -110,
        monelineAway: -110,
        jobRunId,
        rawData: {
          bookmaker: 'test-bookmaker',
          league: 'MLS',
          market: 'h2h',
          last_update: capturedAt,
          teams: {
            home: 'Vancouver Whitecaps',
            away: 'LAFC'
          }
        }
      },
      // SOCCER (Champions League)
      {
        id: `odds-test-soccer-ucl-rm-psg-${uuidV4().slice(0, 8)}`,
        gameId: 'soccer-ucl-2026-02-27-rm-psg',
        sport: 'SOCCER',
        capturedAt,
        h2hHome: -110,  // Paris Saint-Germain
        h2hAway: -110,  // Real Madrid
        total: 2.75,
        totalPriceOver: -110,
        totalPriceUnder: -110,
        monelineHome: -110,
        monelineAway: -110,
        jobRunId,
        rawData: {
          bookmaker: 'test-bookmaker',
          league: 'UCL',
          market: 'h2h',
          last_update: capturedAt,
          teams: {
            home: 'Paris Saint-Germain',
            away: 'Real Madrid'
          }
        }
      },
      // NCAAM
      {
        id: `odds-test-ncaam-duke-unc-${uuidV4().slice(0, 8)}`,
        gameId: 'ncaam-2026-02-27-duke-unc',
        sport: 'NCAAM',
        capturedAt,
        h2hHome: 105,  // UNC Tar Heels
        h2hAway: -125,  // Duke Blue Devils
        total: 155.0,
        totalPriceOver: -110,
        totalPriceUnder: -110,
        spreadHome: 3.5,
        spreadAway: -3.5,
        spreadPriceHome: -110,
        spreadPriceAway: -110,
        monelineHome: 105,
        monelineAway: -125,
        jobRunId,
        rawData: {
          bookmaker: 'test-bookmaker',
          market: 'h2h',
          last_update: capturedAt,
          teams: {
            home: 'UNC Tar Heels',
            away: 'Duke Blue Devils'
          }
        }
      },
      {
        id: `odds-test-ncaam-kansas-baylor-${uuidV4().slice(0, 8)}`,
        gameId: 'ncaam-2026-02-27-kansas-baylor',
        sport: 'NCAAM',
        capturedAt,
        h2hHome: -110,  // Baylor Bears
        h2hAway: -110,  // Kansas Jayhawks
        total: 147.5,
        totalPriceOver: -110,
        totalPriceUnder: -110,
        spreadHome: -2.5,
        spreadAway: 2.5,
        spreadPriceHome: -110,
        spreadPriceAway: -110,
        monelineHome: -110,
        monelineAway: -110,
        jobRunId,
        rawData: {
          bookmaker: 'test-bookmaker',
          market: 'h2h',
          last_update: capturedAt,
          teams: {
            home: 'Baylor Bears',
            away: 'Kansas Jayhawks'
          }
        }
      }
    ]
  };
}

/**
 * Main seeder function
 */
async function seedTestOdds() {
  console.log('[SeedTestOdds] Starting seed script...');
  console.log(`[SeedTestOdds] Time: ${new Date().toISOString()}`);
  
  try {
    return await withDb(async (db) => {
      console.log('[SeedTestOdds] Initializing database...');
      
      // Generate test data
      console.log('[SeedTestOdds] Generating test data...');
      const { jobRunId, games, snapshots } = generateTestData();
      
      // Record seed job run
      console.log(`[SeedTestOdds] Recording seed job: ${jobRunId}`);
      insertJobRun('seed_test_odds', jobRunId);
      
      // Insert games first (odds snapshots reference them)
      console.log(`[SeedTestOdds] Inserting ${games.length} game records...`);
      games.forEach((game, idx) => {
        upsertGame(game);
        console.log(`  ✅ [${idx + 1}/${games.length}] ${game.gameId} @ ${game.gameTimeUtc}`);
      });
      
      // Insert snapshots
      console.log(`[SeedTestOdds] Inserting ${snapshots.length} odds snapshots...`);
      snapshots.forEach((snapshot, idx) => {
        insertOddsSnapshot(snapshot);
        console.log(`  ✅ [${idx + 1}/${snapshots.length}] ${snapshot.gameId} (${snapshot.sport})`);
      });
      
      // Insert mock card payloads (plays) so games display in UI
      console.log(`[SeedTestOdds] Inserting ${games.length} mock card payloads...`);
      const cardPayloads = games.map((game, idx) => {
        // Find corresponding odds snapshot
        const odds = snapshots.find(s => s.gameId === game.gameId);
        const homeTeam = game.homeTeam;
        
        // Create a mock FIRE play on the moneyline (home team to win)
        return {
          id: `card-${uuidV4()}`,
          gameId: game.gameId,
          sport: game.sport,
          cardType: 'test-card-ml',
          cardTitle: `${homeTeam} ML to Win`,
          createdAt: new Date().toISOString(),
          payloadData: {
            pick: homeTeam,
            market: 'ML',
            market_type: 'MONEYLINE',
            selection: { side: 'HOME' },
            confidence: 0.72,
            tier: 'BEST',
            action: 'FIRE',
            status: 'FIRE',
            reasoning: 'Mock test play for UI display',
            ev_passed: true,
            driver_key: 'test-driver',
            projected_total: null,
            edge: 0.05,
            kind: 'PLAY',
            tags: ['TEST_DATA'],
            home_team: game.homeTeam,
            away_team: game.awayTeam,
            reason_codes: [],
            // Required pricing to pass market contract validation
            price: odds?.monelineHome || odds?.h2hHome || -110,
            line: null,
            // Odds context for market locking
            odds_context: {
              sport: game.sport.toLowerCase(),
              home_team: game.homeTeam,
              away_team: game.awayTeam,
              h2h_home: odds?.h2hHome || odds?.monelineHome || -110,
              h2h_away: odds?.h2hAway || odds?.monelineAway || 105,
              spread_home: odds?.spreadHome || null,
              spread_away: odds?.spreadAway || null,
              spread_price_home: odds?.spreadPriceHome || null,
              spread_price_away: odds?.spreadPriceAway || null,
              total: odds?.total || null,
              total_price_over: odds?.totalPriceOver || null,
              total_price_under: odds?.totalPriceUnder || null,
              captured_at: odds?.capturedAt || new Date().toISOString()
            }
          }
        };
      });
      
      cardPayloads.forEach((payload, idx) => {
        try {
          insertCardPayload(payload);
          console.log(`  ✅ [${idx + 1}/${cardPayloads.length}] ${payload.gameId} (${payload.cardTitle})`);
        } catch (err) {
          // Card insertion may fail if market contract issues - log and continue
          console.log(`  ⚠️  [${idx + 1}/${cardPayloads.length}] ${payload.gameId}: ${err.message}`);
        }
      });
      
      // Mark job as success
      markJobRunSuccess(jobRunId);
      
      // Verify insertion
      const count = db.prepare('SELECT COUNT(*) AS n FROM odds_snapshots').get();
      console.log(`[SeedTestOdds] ✅ Total odds_snapshots in DB: ${count.n}`);
      
      const latest = db.prepare(`
        SELECT game_id, sport, captured_at, h2h_home, h2h_away
        FROM odds_snapshots
        ORDER BY captured_at DESC
        LIMIT 5
      `).all();
      
      console.log('[SeedTestOdds] Latest entries:');
      latest.forEach(entry => {
        console.log(`  - ${entry.game_id} (${entry.sport}): ${entry.h2h_home} / ${entry.h2h_away}`);
      });
      
      console.log('[SeedTestOdds] ✅ Seed complete!');
      return { success: true, inserted: snapshots.length, total: count.n };
    });
  } catch (error) {
    console.error(`[SeedTestOdds] ❌ Seed failed:`, error.message);
    console.error(error.stack);
    return { success: false, error: error.message };
  }
}

// CLI execution
if (require.main === module) {
  seedTestOdds()
    .then(result => {
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = { seedTestOdds, generateTestData };
