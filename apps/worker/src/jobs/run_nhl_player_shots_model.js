/**
 * NHL Player Shots Model Runner Job
 * 
 * Reads player shot logs from DB, runs nhl-player-shots model,
 * and generates PROP card payloads for shots on goal markets.
 * 
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

const { v4: uuidV4 } = require('uuid');
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  insertCardPayload,
  validateCardPayload,
  withDb
} = require('@cheddar-logic/data');
const { calcMu, calcMu1p, classifyEdge } = require('../models/nhl-player-shots');

const JOB_NAME = 'run-nhl-player-shots-model';

// Map NHL abbreviations to full team names
const TEAM_ABBREV_TO_NAME = {
  'EDM': 'Edmonton Oilers',
  'TOR': 'Toronto Maple Leafs',
  'VGK': 'Vegas Golden Knights',
  'TBL': 'Tampa Bay Lightning',
  'VAN': 'Vancouver Canucks',
  // Add more as needed
};

/**
 * Main entry point
 */
async function runNHLPlayerShotsModel() {
  return withDb(async () => {
    const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;
    const db = getDatabase();
  
    console.log(`[${JOB_NAME}] Starting job run: ${jobRunId}`);
    
    try {
      insertJobRun(JOB_NAME, jobRunId, null);
      
      // Step 1: Get active NHL games
      const gamesStmt = db.prepare(`
        SELECT game_id, home_team, away_team, game_time_utc, sport
        FROM games
        WHERE LOWER(sport) = 'nhl'
          AND status = 'scheduled'
          AND game_time_utc > datetime('now')
        ORDER BY game_time_utc ASC
      `);
      const games = gamesStmt.all();
    
    if (!games || games.length === 0) {
      console.log(`[${JOB_NAME}] No upcoming NHL games found`);
      markJobRunSuccess(jobRunId, { gamesProcessed: 0, cardsCreated: 0 });
      return { success: true, gamesProcessed: 0, cardsCreated: 0 };
    }
    
    console.log(`[${JOB_NAME}] Found ${games.length} upcoming NHL games`);
    
    // Step 2: Get unique players with recent data (within last 7 days)
    const uniquePlayersStmt = db.prepare(`
      SELECT DISTINCT
        player_id,
        player_name,
        json_extract(raw_data, '$.teamAbbrev') as team_abbrev
      FROM player_shot_logs
      WHERE fetched_at > datetime('now', '-7 days')
      ORDER BY player_id ASC
    `);
    const uniquePlayers = uniquePlayersStmt.all();
    
    if (!uniquePlayers || uniquePlayers.length === 0) {
      console.log(`[${JOB_NAME}] No player shot logs found. Run 'npm run job:pull-nhl-player-shots' first.`);
      markJobRunFailure(jobRunId, { error: 'No player shot logs available' });
      return { success: false, error: 'No player shot logs available' };
    }
    
    console.log(`[${JOB_NAME}] Found ${uniquePlayers.length} players with recent data`);
    
    // Step 4: Generate cards for each player in upcoming games
    let cardsCreated = 0;
    const timestamp = new Date().toISOString();
    
    for (const game of games) {
      const gameId = game.game_id;
      const homeTeam = game.home_team;
      const awayTeam = game.away_team;
      
      // Find players for this game (case-insensitive match against abbreviations)
      const gamePlayers = uniquePlayers.filter(p => {
        const playerTeamAbbrev = p.team_abbrev?.toUpperCase();
        // Match against both the full team names AND abbreviations
        return homeTeam.toUpperCase().includes(playerTeamAbbrev) || 
               awayTeam.toUpperCase().includes(playerTeamAbbrev) ||
               TEAM_ABBREV_TO_NAME[playerTeamAbbrev]?.toUpperCase() === homeTeam.toUpperCase() ||
               TEAM_ABBREV_TO_NAME[playerTeamAbbrev]?.toUpperCase() === awayTeam.toUpperCase();
      });
      
      if (gamePlayers.length === 0) {
        continue;
      }
      
      console.log(`[${JOB_NAME}] Processing ${gamePlayers.length} players for game ${gameId}`);
      
      for (const player of gamePlayers) {
        try {
          // Get L5 games for this player (prepare fresh to avoid statement closure issues)
          const getPlayerL5Stmt = db.prepare(`
            SELECT 
              game_id,
              game_date,
              opponent,
              is_home,
              shots,
              toi_minutes,
              raw_data
            FROM player_shot_logs
            WHERE player_id = ?
            ORDER BY game_date DESC
            LIMIT 5
          `);
          const l5Games = getPlayerL5Stmt.all(player.player_id);
          
          if (l5Games.length < 5) {
            continue;
          }
          
          // Prefer stored player name from pull job; fallback to stable placeholder
          const hasValidName = typeof player.player_name === 'string'
            && player.player_name.trim().length > 0
            && !player.player_name.includes('[object Object]');
          const playerName = hasValidName ? player.player_name.trim() : `Player #${player.player_id}`;
          
          // Build L5 SOG array (most recent first)
          const l5Sog = l5Games.map(g => g.shots || 0);
          
          // Extract season stats from most recent game's raw_data if available
          let shotsPer60 = null;
          let projToi = null;
          if (l5Games[0]?.raw_data) {
            try {
              const rawData = JSON.parse(l5Games[0].raw_data);
              shotsPer60 = rawData.shotsPer60 || null;
              projToi = rawData.projToi || l5Games[0].toi_minutes || null;
            } catch {
              // Ignore parse errors
            }
          }
          
          const isHome = player.team_abbrev?.toUpperCase() === homeTeam.toUpperCase();
          
          // Run model for full game
          const mu = calcMu({
            l5Sog,
            shotsPer60: shotsPer60,
            projToi: projToi,
            opponentFactor: 1.0, // Could enhance with opponent defense stats
            paceFactor: 1.0,     // Could enhance with team pace stats
            isHome
          });
          
          // Run model for 1st period
          const mu1p = calcMu1p({
            l5Sog,
            shotsPer60: shotsPer60,
            projToi: projToi,
            opponentFactor: 1.0,
            paceFactor: 1.0,
            isHome
          });
          
          // For dev/testing, use synthetic market lines (model projection ± random offset)
          // In production, these would come from odds API
          const syntheticLine = Math.round((mu + (Math.random() - 0.5) * 1.0) * 2) / 2; // Round to nearest 0.5
          const syntheticLine1p = Math.round((mu1p + (Math.random() - 0.5) * 0.5) * 2) / 2;
          
          // Confidence based on data recency (could be enhanced)
          const confidence = 0.75;
          
          // Classify edges
          const fullGameEdge = classifyEdge(mu, syntheticLine, confidence);
          const firstPeriodEdge = classifyEdge(mu1p, syntheticLine1p, confidence);
          
          // Only create cards for HOT or WATCH tiers
          if (fullGameEdge.tier === 'HOT' || fullGameEdge.tier === 'WATCH') {
            const cardId = `nhl-player-sog-${player.player_id}-${gameId}-full-${uuidV4().slice(0, 8)}`;
            
            // For PROP cards, don't set market_type to 'PROP' in the root; keep it implied
            // and let the data layer treat it as a PROP without trying to lock it via deriveLockedMarketContext
            const payloadData = {
              sport: 'NHL',
              home_team: homeTeam,
              away_team: awayTeam,
              game_time_utc: game.game_time_utc,
              card_type: 'nhl-player-shots',
              tier: fullGameEdge.tier,
              card_status: 'active',
              model_name: 'nhl-player-shots-v1',
              model_version: '1.0.0',
              // Required by basePayloadSchema
              prediction: `${playerName} ${fullGameEdge.direction === 'OVER' ? 'Over' : 'Under'} ${syntheticLine} SOG`,
              confidence: confidence,
              recommended_bet_type: 'unknown',
              generated_at: timestamp,
              // PROP-specific
              play: {
                pick_string: `${playerName} ${fullGameEdge.direction === 'OVER' ? 'Over' : 'Under'} ${syntheticLine} SOG`,
                market_type: 'PROP',
                player_name: playerName,
                player_id: player.player_id.toString(),
                prop_type: 'shots_on_goal',
                period: 'full_game',
                selection: {
                  side: fullGameEdge.direction === 'OVER' ? 'over' : 'under',
                  line: syntheticLine,
                  price: -110,
                  team: player.team_abbrev,
                  player_name: playerName,
                  player_id: player.player_id.toString()
                }
              },
              decision: {
                edge_pct: Math.round(((mu - syntheticLine) / syntheticLine) * 100 * 10) / 10,
                model_projection: mu,
                market_line: syntheticLine,
                direction: fullGameEdge.direction,
                confidence: confidence
              },
              drivers: {
                l5_avg: l5Sog.reduce((a, b) => a + b, 0) / 5,
                l5_sog: l5Sog,
                shots_per_60: shotsPer60,
                proj_toi: projToi,
                is_home: isHome
              }
            };
            
            const card = {
              id: cardId,
              gameId: gameId,
              sport: 'NHL',
              cardType: 'nhl-player-shots',
              cardTitle: `${playerName} Shots on Goal`,
              createdAt: timestamp,
              payloadData: payloadData
            };
            
            try {
              insertCardPayload(card);
              cardsCreated++;
              console.log(`[${JOB_NAME}] ✓ Created ${fullGameEdge.tier} card: ${playerName} ${fullGameEdge.direction} ${syntheticLine}`);
            } catch (insertErr) {
              console.error(`[${JOB_NAME}] Failed to insert card: ${insertErr.message}`);
            }
          }
          
          // Create 1P card if applicable
          if (firstPeriodEdge.tier === 'HOT' || firstPeriodEdge.tier === 'WATCH') {
            const cardId1p = `nhl-player-sog-${player.player_id}-${gameId}-1p-${uuidV4().slice(0, 8)}`;
            
            const payloadData1p = {
              sport: 'NHL',
              home_team: homeTeam,
              away_team: awayTeam,
              game_time_utc: game.game_time_utc,
              card_type: 'nhl-player-shots-1p',
              tier: firstPeriodEdge.tier,
              card_status: 'active',
              model_name: 'nhl-player-shots-v1',
              model_version: '1.0.0',
              // Required by basePayloadSchema
              prediction: `${playerName} ${firstPeriodEdge.direction === 'OVER' ? 'Over' : 'Under'} ${syntheticLine1p} SOG (1P)`,
              confidence: confidence,
              recommended_bet_type: 'unknown',
              generated_at: timestamp,
              // PROP-specific
              play: {
                pick_string: `${playerName} ${firstPeriodEdge.direction === 'OVER' ? 'Over' : 'Under'} ${syntheticLine1p} SOG (1P)`,
                market_type: 'PROP',
                player_name: playerName,
                player_id: player.player_id.toString(),
                prop_type: 'shots_on_goal',
                period: 'first_period',
                selection: {
                  side: firstPeriodEdge.direction === 'OVER' ? 'over' : 'under',
                  line: syntheticLine1p,
                  price: -110,
                  team: player.team_abbrev,
                  player_name: playerName,
                  player_id: player.player_id.toString()
                }
              },
              decision: {
                edge_pct: Math.round(((mu1p - syntheticLine1p) / syntheticLine1p) * 100 * 10) / 10,
                model_projection: mu1p,
                market_line: syntheticLine1p,
                direction: firstPeriodEdge.direction,
                confidence: confidence
              },
              drivers: {
                l5_avg_1p: l5Sog.reduce((a, b) => a + b, 0) / 5 * 0.32,
                l5_sog: l5Sog,
                shots_per_60: shotsPer60,
                proj_toi: projToi,
                is_home: isHome
              }
            };
            
            const card1p = {
              id: cardId1p,
              gameId: gameId,
              sport: 'NHL',
              cardType: 'nhl-player-shots-1p',
              cardTitle: `${playerName} Shots on Goal (1P)`,
              createdAt: timestamp,
              payloadData: payloadData1p
            };
            
            try {
              insertCardPayload(card1p);
              cardsCreated++;
              console.log(`[${JOB_NAME}] ✓ Created ${firstPeriodEdge.tier} 1P card: ${playerName} ${firstPeriodEdge.direction} ${syntheticLine1p}`);
            } catch (insertErr) {
              console.error(`[${JOB_NAME}] Failed to insert 1P card: ${insertErr.message}`);
            }
          }
          
        } catch (err) {
          console.error(`[${JOB_NAME}] Error processing ${player.player_name}: ${err.message}`);
        }
      }
    }
    
    const result = {
      gamesProcessed: games.length,
      cardsCreated
    };
    
    markJobRunSuccess(jobRunId, result);
    console.log(`[${JOB_NAME}] ✅ Job complete: ${cardsCreated} cards created from ${games.length} games`);
    
    return { success: true, ...result };
    
  } catch (err) {
    console.error(`[${JOB_NAME}] Job failed:`, err);
    markJobRunFailure(jobRunId, { error: err.message, stack: err.stack });
    return { success: false, error: err.message };
  }
  });
}

// Run if called directly
if (require.main === module) {
  runNHLPlayerShotsModel()
    .then(result => {
      console.log('[run_nhl_player_shots_model] Result:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch(err => {
      console.error('[run_nhl_player_shots_model] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { runNHLPlayerShotsModel };
