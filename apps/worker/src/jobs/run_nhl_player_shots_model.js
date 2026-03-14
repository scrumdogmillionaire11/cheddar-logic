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

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  setCurrentRunId,
  insertCardPayload,
  validateCardPayload,
  withDb,
  getPlayerPropLine,
} = require('@cheddar-logic/data');
const {
  calcMu,
  calcMu1p,
  classifyEdge,
} = require('../models/nhl-player-shots');

const JOB_NAME = 'run-nhl-player-shots-model';

function attachRunId(card, runId) {
  if (!card) return;
  card.runId = runId;
  if (card.payloadData && typeof card.payloadData === 'object') {
    if (!card.payloadData.run_id) {
      card.payloadData.run_id = runId;
    }
  }
}

// Gap 2: Complete 32-team NHL abbreviation map.
// If a player's team_abbrev is not found here, a startup warning is logged.
const TEAM_ABBREV_TO_NAME = {
  ANA: 'Anaheim Ducks',
  BOS: 'Boston Bruins',
  BUF: 'Buffalo Sabres',
  CGY: 'Calgary Flames',
  CAR: 'Carolina Hurricanes',
  CHI: 'Chicago Blackhawks',
  COL: 'Colorado Avalanche',
  CBJ: 'Columbus Blue Jackets',
  DAL: 'Dallas Stars',
  DET: 'Detroit Red Wings',
  EDM: 'Edmonton Oilers',
  FLA: 'Florida Panthers',
  LAK: 'Los Angeles Kings',
  MIN: 'Minnesota Wild',
  MTL: 'Montreal Canadiens',
  NSH: 'Nashville Predators',
  NJD: 'New Jersey Devils',
  NYI: 'New York Islanders',
  NYR: 'New York Rangers',
  OTT: 'Ottawa Senators',
  PHI: 'Philadelphia Flyers',
  PIT: 'Pittsburgh Penguins',
  SEA: 'Seattle Kraken',
  SJS: 'San Jose Sharks',
  STL: 'St. Louis Blues',
  TBL: 'Tampa Bay Lightning',
  TOR: 'Toronto Maple Leafs',
  UTA: 'Utah Hockey Club',
  VAN: 'Vancouver Canucks',
  VGK: 'Vegas Golden Knights',
  WSH: 'Washington Capitals',
  WPG: 'Winnipeg Jets',
};

/**
 * Gap 6: Resolve a canonical game ID by consulting the game_id_map table first,
 * then falling back to a time+team proximity match in the games table.
 *
 * @param {string} gameId     - The game ID as stored in player_shot_logs
 * @param {string} homeTeam   - Home team full name (from games table)
 * @param {string} awayTeam   - Away team full name (from games table)
 * @param {string} gameTime   - Game time UTC (ISO string)
 * @param {object} db         - better-sqlite3 Database instance
 * @returns {string}          - Canonical game ID (or original gameId on no match)
 */
function resolveCanonicalGameId(gameId, homeTeam, awayTeam, gameTime, db) {
  try {
    // Try game_id_map first (explicit mapping)
    try {
      const mapRow = db.prepare(
        'SELECT canonical_game_id FROM game_id_map WHERE espn_game_id = ? LIMIT 1',
      ).get(gameId);
      if (mapRow && mapRow.canonical_game_id) {
        return mapRow.canonical_game_id;
      }
    } catch {
      // game_id_map may not exist — proceed to fallback
    }

    // Fallback: time + team proximity match (within 15 minutes = 0.010416 julian days)
    const proximityRow = db.prepare(`
      SELECT game_id
      FROM games
      WHERE LOWER(home_team) = LOWER(?)
        AND LOWER(away_team) = LOWER(?)
        AND ABS(julianday(game_time_utc) - julianday(?)) < 0.010416
      ORDER BY game_time_utc
      LIMIT 1
    `).get(homeTeam, awayTeam, gameTime);

    if (proximityRow && proximityRow.game_id) {
      return proximityRow.game_id;
    }
  } catch {
    // Any DB error — return original to avoid crashing the job
  }

  return gameId;
}

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

      // Step 1: Get active NHL games within the display window (36h from now)
      const gamesStmt = db.prepare(`
        SELECT game_id, home_team, away_team, game_time_utc, sport
        FROM games
        WHERE LOWER(sport) = 'nhl'
          AND status = 'scheduled'
          AND game_time_utc > datetime('now')
          AND game_time_utc < datetime('now', '+36 hours')
        ORDER BY game_time_utc ASC
      `);
      const games = gamesStmt.all();

      if (!games || games.length === 0) {
        console.log(`[${JOB_NAME}] No upcoming NHL games found`);
        markJobRunSuccess(jobRunId, { gamesProcessed: 0, cardsCreated: 0 });
        // Gap 7: setCurrentRunId called unconditionally on success path
        try {
          setCurrentRunId(jobRunId, 'nhl_props');
        } catch (runStateError) {
          console.error(
            `[${JOB_NAME}] Failed to update run state: ${runStateError.message}`,
          );
        }
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
        console.log(
          `[${JOB_NAME}] No player shot logs found. Run 'npm run job:pull-nhl-player-shots' first.`,
        );
        markJobRunFailure(jobRunId, { error: 'No player shot logs available' });
        return { success: false, error: 'No player shot logs available' };
      }

      console.log(
        `[${JOB_NAME}] Found ${uniquePlayers.length} players with recent data`,
      );

      // Gap 5: 1P card generation is gated behind NHL_SOG_1P_CARDS_ENABLED env flag (default off).
      // The 1P Odds API market is unreliable — enable only when lines are consistently available.
      const sog1pEnabled = process.env.NHL_SOG_1P_CARDS_ENABLED === 'true';

      // Step 4: Generate cards for each player in upcoming games
      let cardsCreated = 0;
      const timestamp = new Date().toISOString();

      for (const game of games) {
        const gameId = game.game_id;
        const homeTeam = game.home_team;
        const awayTeam = game.away_team;

        // Gap 6: Resolve canonical game ID via game_id_map / proximity match
        const resolvedGameId = resolveCanonicalGameId(gameId, homeTeam, awayTeam, game.game_time_utc, db);

        // Find players for this game (case-insensitive match against abbreviations)
        const gamePlayers = uniquePlayers.filter((p) => {
          const playerTeamAbbrev = p.team_abbrev?.toUpperCase();
          // Gap 2: Warn if team_abbrev is not in the map
          if (playerTeamAbbrev && !(playerTeamAbbrev in TEAM_ABBREV_TO_NAME)) {
            console.log(
              `[${JOB_NAME}] WARN: team_abbrev '${playerTeamAbbrev}' not found in TEAM_ABBREV_TO_NAME map — player ${p.player_name} may not match any game`,
            );
          }
          // Match against both the full team names AND abbreviations
          return (
            homeTeam.toUpperCase().includes(playerTeamAbbrev) ||
            awayTeam.toUpperCase().includes(playerTeamAbbrev) ||
            TEAM_ABBREV_TO_NAME[playerTeamAbbrev]?.toUpperCase() ===
              homeTeam.toUpperCase() ||
            TEAM_ABBREV_TO_NAME[playerTeamAbbrev]?.toUpperCase() ===
              awayTeam.toUpperCase()
          );
        });

        if (gamePlayers.length === 0) {
          continue;
        }

        console.log(
          `[${JOB_NAME}] Processing ${gamePlayers.length} players for game ${resolvedGameId}`,
        );

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
              // Task 1: Log explicit skip reason for players with insufficient recent logs
              console.log(
                `[${JOB_NAME}] Skipping ${player.player_name} (${player.player_id}): fewer than 5 recent game logs (possible injury/absence)`,
              );
              continue;
            }

            // Prefer stored player name from pull job; fallback to stable placeholder
            const hasValidName =
              typeof player.player_name === 'string' &&
              player.player_name.trim().length > 0 &&
              !player.player_name.includes('[object Object]');
            const playerName = hasValidName
              ? player.player_name.trim()
              : `Player #${player.player_id}`;

            // Build L5 SOG array (most recent first)
            const l5Sog = l5Games.map((g) => g.shots || 0);

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

            const isHome =
              player.team_abbrev?.toUpperCase() === homeTeam.toUpperCase() ||
              TEAM_ABBREV_TO_NAME[player.team_abbrev?.toUpperCase()]?.toUpperCase() === homeTeam.toUpperCase();

            // Gap 4: Derive opponentFactor from team_metrics_cache.
            // Opponent is whichever team this player is NOT on.
            // paceFactor: 1.0 — TODO: source from team pace stats when available (e.g. corsi_for_pct from team_metrics_cache)
            let opponentFactor = 1.0;
            try {
              const opponentAbbrev = isHome ? awayTeam : homeTeam;
              const metricsRow = db.prepare(`
                SELECT shots_against_pg, league_avg_shots_against_pg
                FROM team_metrics_cache
                WHERE LOWER(team_abbrev) = LOWER(?) AND LOWER(sport) = 'nhl'
                LIMIT 1
              `).get(opponentAbbrev);
              if (
                metricsRow &&
                metricsRow.league_avg_shots_against_pg > 0
              ) {
                opponentFactor =
                  metricsRow.shots_against_pg /
                  metricsRow.league_avg_shots_against_pg;
              } else {
                console.debug(
                  `[${JOB_NAME}] No team_metrics_cache data for opponent '${opponentAbbrev}' — opponentFactor defaulting to 1.0`,
                );
              }
            } catch {
              // team_metrics_cache may not exist or have different schema
              console.debug(
                `[${JOB_NAME}] Could not query team_metrics_cache for opponentFactor — defaulting to 1.0`,
              );
            }

            // Run model for full game
            const mu = calcMu({
              l5Sog,
              shotsPer60: shotsPer60,
              projToi: projToi,
              opponentFactor,
              paceFactor: 1.0, // TODO: source from team pace stats when available
              isHome,
            });

            // Run model for 1st period
            const mu1p = calcMu1p({
              l5Sog,
              shotsPer60: shotsPer60,
              projToi: projToi,
              opponentFactor,
              paceFactor: 1.0,
              isHome,
            });

            // Fetch real market lines from DB (populated by pull_nhl_player_shots_props job).
            // When no real line exists, use a configurable projection floor (default 2.5 SOG) so
            // projection-mode cards are still generated for the best shooters. A player at 3.3 mu
            // vs a 2.5 floor = 0.8 edge = HOT. Set NHL_SOG_PROJECTION_LINE to adjust the threshold.
            const realPropLine = getPlayerPropLine('NHL', resolvedGameId, playerName, 'shots_on_goal', 'full_game');
            let marketLine;
            if (realPropLine) {
              marketLine = realPropLine.line;
            } else {
              marketLine = parseFloat(process.env.NHL_SOG_PROJECTION_LINE || '2.5');
              console.log(`[projection-mode] line=${marketLine} (no real Odds API line — using projection floor)`);
            }
            const usingRealLine = !!realPropLine;

            const syntheticLine = marketLine; // kept for card payload references below

            // 1P: also use projection floor when no real line (scaled from full-game floor by 1P share)
            const realPropLine1p = getPlayerPropLine('NHL', resolvedGameId, playerName, 'shots_on_goal', 'first_period');
            let syntheticLine1p;
            if (realPropLine1p) {
              syntheticLine1p = realPropLine1p.line;
            } else {
              const floorFull = parseFloat(process.env.NHL_SOG_PROJECTION_LINE || '2.5');
              syntheticLine1p = Math.round(floorFull * 0.32 * 2) / 2;
              if (sog1pEnabled) {
                console.log(`[projection-mode] 1P line=${syntheticLine1p} (no real Odds API line — using projection floor)`);
              }
            }

            if (!usingRealLine) {
              console.warn(`[${JOB_NAME}] No real prop line for ${playerName} game ${resolvedGameId} — using synthetic fallback`);
            }

            // Confidence based on data recency (could be enhanced)
            const confidence = 0.75;

            // Classify edges
            const fullGameEdge = classifyEdge(mu, syntheticLine, confidence);
            const firstPeriodEdge = classifyEdge(
              mu1p,
              syntheticLine1p,
              confidence,
            );

            // Only create cards for HOT or WATCH tiers
            if (fullGameEdge.tier === 'HOT' || fullGameEdge.tier === 'WATCH') {
              const cardId = `nhl-player-sog-${player.player_id}-${resolvedGameId}-full-${uuidV4().slice(0, 8)}`;

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
                    player_id: player.player_id.toString(),
                  },
                },
                decision: {
                  edge_pct:
                    Math.round(
                      ((mu - syntheticLine) / syntheticLine) * 100 * 10,
                    ) / 10,
                  model_projection: mu,
                  market_line: syntheticLine,
                  direction: fullGameEdge.direction,
                  confidence: confidence,
                  market_line_source: usingRealLine ? 'odds_api' : 'projection_floor',
                },
                drivers: {
                  l5_avg: l5Sog.reduce((a, b) => a + b, 0) / 5,
                  l5_sog: l5Sog,
                  shots_per_60: shotsPer60,
                  proj_toi: projToi,
                  is_home: isHome,
                },
              };

              const card = {
                id: cardId,
                gameId: resolvedGameId,
                sport: 'NHL',
                cardType: 'nhl-player-shots',
                cardTitle: `${playerName} Shots on Goal`,
                createdAt: timestamp,
                payloadData: payloadData,
              };
              attachRunId(card, jobRunId);

              try {
                insertCardPayload(card);
                cardsCreated++;
                console.log(
                  `[${JOB_NAME}] ✓ Created ${fullGameEdge.tier} card: ${playerName} ${fullGameEdge.direction} ${syntheticLine}`,
                );
              } catch (insertErr) {
                console.error(
                  `[${JOB_NAME}] Failed to insert card: ${insertErr.message}`,
                );
              }
            }

            // Gap 5: 1P card block gated by NHL_SOG_1P_CARDS_ENABLED flag (default off).
            // The 1P Odds API market (player_shots_on_goal_1p) is unreliable — lines
            // are rarely available, so 1P cards almost always use synthetic fallback.
            // Enable via NHL_SOG_1P_CARDS_ENABLED=true only after confirming line availability.
            if (sog1pEnabled) {
              if (
                firstPeriodEdge.tier === 'HOT' ||
                firstPeriodEdge.tier === 'WATCH'
              ) {
                const cardId1p = `nhl-player-sog-${player.player_id}-${resolvedGameId}-1p-${uuidV4().slice(0, 8)}`;

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
                      side:
                        firstPeriodEdge.direction === 'OVER' ? 'over' : 'under',
                      line: syntheticLine1p,
                      price: -110,
                      team: player.team_abbrev,
                      player_name: playerName,
                      player_id: player.player_id.toString(),
                    },
                  },
                  decision: {
                    edge_pct:
                      Math.round(
                        ((mu1p - syntheticLine1p) / syntheticLine1p) * 100 * 10,
                      ) / 10,
                    model_projection: mu1p,
                    market_line: syntheticLine1p,
                    direction: firstPeriodEdge.direction,
                    confidence: confidence,
                    market_line_source: realPropLine1p ? 'odds_api' : 'projection_floor',
                  },
                  drivers: {
                    l5_avg_1p: (l5Sog.reduce((a, b) => a + b, 0) / 5) * 0.32,
                    l5_sog: l5Sog,
                    shots_per_60: shotsPer60,
                    proj_toi: projToi,
                    is_home: isHome,
                  },
                };

                const card1p = {
                  id: cardId1p,
                  gameId: resolvedGameId,
                  sport: 'NHL',
                  cardType: 'nhl-player-shots-1p',
                  cardTitle: `${playerName} Shots on Goal (1P)`,
                  createdAt: timestamp,
                  payloadData: payloadData1p,
                };
                attachRunId(card1p, jobRunId);

                try {
                  insertCardPayload(card1p);
                  cardsCreated++;
                  console.log(
                    `[${JOB_NAME}] ✓ Created ${firstPeriodEdge.tier} 1P card: ${playerName} ${firstPeriodEdge.direction} ${syntheticLine1p}`,
                  );
                } catch (insertErr) {
                  console.error(
                    `[${JOB_NAME}] Failed to insert 1P card: ${insertErr.message}`,
                  );
                }
              }
            }
          } catch (err) {
            console.error(
              `[${JOB_NAME}] Error processing ${player.player_name}: ${err.message}`,
            );
          }
        }
      }

      const result = {
        gamesProcessed: games.length,
        cardsCreated,
      };

      markJobRunSuccess(jobRunId, result);

      // Gap 7: setCurrentRunId called unconditionally on the success path,
      // regardless of whether any cards were created. This ensures run_state
      // is always updated after a successful model run.
      try {
        setCurrentRunId(jobRunId, 'nhl_props');
      } catch (runStateError) {
        console.error(
          `[${JOB_NAME}] Failed to update run state: ${runStateError.message}`,
        );
      }

      console.log(
        `[${JOB_NAME}] ✅ Job complete: ${cardsCreated} cards created from ${games.length} games`,
      );

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
    .then((result) => {
      console.log('[run_nhl_player_shots_model] Result:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('[run_nhl_player_shots_model] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { runNHLPlayerShotsModel };
