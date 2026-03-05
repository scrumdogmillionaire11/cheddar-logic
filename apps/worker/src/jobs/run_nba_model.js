/**
 * NBA Model Runner Job
 *
 * Reads latest NBA odds from DB, runs per-driver inference, and stores
 * card_payloads (one per active driver: rest-advantage, travel, lineup,
 * matchup-style, blowout-risk). Drivers only emit when their signal is
 * actionable — neutral/missing data produces no card.
 *
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/run_nba_model.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:run-nba-model)
 *
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  getOddsWithUpcomingGames,
  insertCardPayload,
  prepareModelAndCardWrite,
  validateCardPayload,
  shouldRunJobKey,
  withDb,
  enrichOddsSnapshotWithEspnMetrics,
  getDatabase
} = require('@cheddar-logic/data');

const { computeNBADriverCards, generateCard, computeNBAMarketDecisions, selectExpressionChoice, buildMarketPayload, determineTier } = require('../models');
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds,
  edgeCalculator,
  marginToWinProbability
} = require('@cheddar-logic/models');
const { publishDecisionForCard, applyUiActionFields } = require('../utils/decision-publisher');

const ENABLE_WELCOME_HOME = process.env.ENABLE_WELCOME_HOME === 'true';

const NBA_DRIVER_WEIGHTS = {
  baseProjection: 0.35,
  restAdvantage: 0.15,
  welcomeHomeV2: 0.10,
  matchupStyle: 0.20,
  blowoutRisk: 0.07,
  totalProjection: 0.13
};

const NBA_DRIVER_CARD_TYPES = [
  'nba-base-projection',
  'nba-rest-advantage',
  'welcome-home-v2',
  'nba-matchup-style',
  'nba-blowout-risk',
  'nba-total-projection',
];

/**
 * Get recent road games for a team from schedule
 * @param {string} teamName - Team display name
 * @param {string} sport - Sport code (lowercase)
 * @param {string} currentGameTime - Current game time in UTC
 * @param {number} limit - Max games to retrieve
 * @returns {Array<{isHome: boolean, date: string}>}
 */
function getRecentRoadGames(teamName, sport, currentGameTime, limit = 10) {
  if (!teamName || !currentGameTime) return [];
  
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT game_id, game_time_utc, home_team, away_team, status
    FROM games
    WHERE LOWER(sport) = ?
      AND UPPER(away_team) = UPPER(?)
      AND game_time_utc < ?
    ORDER BY game_time_utc DESC
    LIMIT ?
  `);
  
  try {
    const results = stmt.all(sport.toLowerCase(), teamName, currentGameTime, limit);
    return results
      .filter(g => g.status === 'final' || g.status === 'STATUS_FINAL' || g.status === 'in_progress')
      .map(g => ({
        isHome: false,
        date: g.game_time_utc,
        opponent: g.home_team
      }))
      .reverse(); // Chronological order (oldest to newest)
  } catch (error) {
    console.error(`[Schedule] Failed to query road games for ${teamName}:`, error.message);
    return [];
  }
}

/**
 * Get home team's recent road trip (consecutive away games)
 * Returns if the team JUST COMPLETED a road trip and is now playing at home
 * Welcome Home Fade: Home team's first game after returning from road trip
 *
 * @param {string} teamName - Team display name  
 * @param {string} sport - Sport code (lowercase)
 * @param {string} currentGameTime - Current game time in UTC
 * @param {number} limit - Max games to retrieve
 * @returns {Array<{isHome: boolean, date: string}>} Recent road games if just returning home, else []
 */
function getHomeTeamRecentRoadTrip(teamName, sport, currentGameTime, limit = 10) {
  if (!teamName || !currentGameTime) return [];
  
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT game_id, game_time_utc, home_team, away_team, status
    FROM games
    WHERE LOWER(sport) = ?
      AND (UPPER(away_team) = UPPER(?) OR UPPER(home_team) = UPPER(?))
      AND game_time_utc < ?
    ORDER BY game_time_utc DESC
    LIMIT ?
  `);
  
  try {
    const results = stmt.all(sport.toLowerCase(), teamName, teamName, currentGameTime, limit);
    const completedGames = results
      .filter(g => g.status === 'final' || g.status === 'STATUS_FINAL')
      .reverse(); // Chronological order (oldest to newest)
    
    if (!completedGames.length) return [];
    
    // Find the most recent game to see if it started a change pattern
    // Pattern: if recent games are [away, away, away, ...]
    // and we're now at a home game, that's Welcome Home Fade
    
    const roadTrip = [];
    
    // Start from most recent game and work backwards
    // Collect consecutive AWAY games
    for (let i = completedGames.length - 1; i >= 0; i--) {
      const game = completedGames[i];
      const isAway = game.away_team && game.away_team.toUpperCase() === teamName.toUpperCase();
      const isHome = game.home_team && game.home_team.toUpperCase() === teamName.toUpperCase();
      
      if (isAway) {
        // Team was away in this game - part of road trip
        roadTrip.unshift({
          isHome: false,
          date: game.game_time_utc,
          opponent: game.home_team,
          location: 'away'
        });
      } else if (isHome) {
        // Team was home - this breaks the road trip
        // If we have a road trip, return it (the next game is home after road trip)
        break;
      }
    }
    
    // Need at least 2 away games to be a meaningful road trip
    return roadTrip.length >= 2 ? roadTrip : [];
  } catch (error) {
    console.error(`[WhF] Failed to query road trip for ${teamName}:`, error.message);
    return [];
  }
}

/**
 * Generate insertable card objects from NBA driver descriptors.
 *
 * @param {string} gameId
 * @param {Array<object>} driverDescriptors - Output of computeNBADriverCards()
 * @param {object} oddsSnapshot
 * @returns {Array<object>} Array of card objects ready for insertCardPayload()
 */


/**
 * Generate standalone market call cards (nba-totals-call, nba-spread-call)
 * from cross-market decisions. Only emits for FIRE or WATCH status.
 */
function generateNBAMarketCallCards(gameId, marketDecisions, oddsSnapshot) {
  const now = new Date().toISOString();
  let expiresAt = null;
  if (oddsSnapshot?.game_time_utc) {
    const gameTime = new Date(oddsSnapshot.game_time_utc);
    expiresAt = new Date(gameTime.getTime() - 60 * 60 * 1000).toISOString();
  }

  const matchup = buildMatchup(oddsSnapshot?.home_team, oddsSnapshot?.away_team);
  const { start_time_local: startTimeLocal, timezone } = formatStartTimeLocal(oddsSnapshot?.game_time_utc);
  const countdown = formatCountdown(oddsSnapshot?.game_time_utc);
  const market = buildMarketFromOdds(oddsSnapshot);

  const cards = [];
  const CONFIDENCE_MAP = { FIRE: 0.74, WATCH: 0.61 };

  // TOTAL decision → nba-totals-call
  const totalDecision = marketDecisions?.TOTAL;
  const totalBias =
    totalDecision &&
    totalDecision.status !== 'PASS' &&
    typeof totalDecision.edge === 'number' &&
    totalDecision.best_candidate?.line != null
      ? 'OK'
      : 'INSUFFICIENT_DATA';
  if (totalDecision && (totalDecision.status === 'FIRE' || totalDecision.status === 'WATCH')) {
    const status = totalDecision.status || 'PASS';
    const confidence = CONFIDENCE_MAP[status] ?? 0.5;
    const tier = determineTier(confidence);
    const { side, line } = totalDecision.best_candidate;
    const totalPrice = side === 'OVER'
      ? oddsSnapshot?.total_price_over ?? null
      : oddsSnapshot?.total_price_under ?? null;
    const hasLine = line != null;
    const hasPrice = totalPrice != null;
    if (hasLine && hasPrice) {
      const lineText = line != null ? ` ${line}` : '';
      const pickText = `${side === 'OVER' ? 'OVER' : 'UNDER'}${lineText}`;
      const reasonCodes = [];
      if (totalBias !== 'OK') reasonCodes.push('PASS_TOTAL_INSUFFICIENT_DATA');
      const activeDrivers = (totalDecision.drivers || [])
        .filter(d => d.eligible)
        .map(d => d.driverKey);
      const topDrivers = (totalDecision.drivers || [])
        .filter(d => d.eligible)
        .sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal))
        .slice(0, 3)
        .map(d => ({ driver: d.driverKey, weight: d.weight, score: Number(((d.signal + 1) / 2).toFixed(3)) }));

      const cardId = `card-nba-totals-call-${gameId}-${uuidV4().slice(0, 8)}`;
      cards.push({
        id: cardId,
        gameId,
        sport: 'NBA',
        cardType: 'nba-totals-call',
        cardTitle: `NBA Totals: ${pickText}`,
        createdAt: now,
        expiresAt,
        payloadData: {
          game_id: gameId,
          sport: 'NBA',
          model_version: 'nba-cross-market-v1',
          home_team: oddsSnapshot?.home_team ?? null,
          away_team: oddsSnapshot?.away_team ?? null,
          matchup,
          start_time_utc: oddsSnapshot?.game_time_utc ?? null,
          start_time_local: startTimeLocal,
          timezone,
          countdown,
          prediction: side,
          confidence,
          tier,
          status,
          recommended_bet_type: 'total',
          kind: 'PLAY',
          market_type: 'TOTAL',
          selection: {
            side,
          },
          line,
          price: totalPrice,
          reason_codes: reasonCodes,
          tags: [],
          consistency: {
            total_bias: totalBias,
          },
          reasoning: `${pickText}: ${totalDecision.reasoning}`,
          edge: totalDecision.edge ?? null,
          projection: {
            total: line ?? null,
            margin_home: null,
            win_prob_home: null
          },
          market,
          drivers_active: activeDrivers,
          driver_summary: { weights: topDrivers, impact_note: 'Cross-market totals decision.' },
          ev_passed: totalDecision.status === 'FIRE',
          odds_context: {
            h2h_home: oddsSnapshot?.h2h_home,
            h2h_away: oddsSnapshot?.h2h_away,
            spread_home: oddsSnapshot?.spread_home,
            spread_away: oddsSnapshot?.spread_away,
            total: oddsSnapshot?.total,
            spread_price_home: oddsSnapshot?.spread_price_home,
            spread_price_away: oddsSnapshot?.spread_price_away,
            total_price_over: oddsSnapshot?.total_price_over,
            total_price_under: oddsSnapshot?.total_price_under,
            captured_at: oddsSnapshot?.captured_at
          },
          confidence_pct: Math.round(confidence * 100),
          driver: {
            key: 'cross_market_total',
            score: totalDecision.score,
            status: totalDecision.status,
            inputs: { net: totalDecision.net, conflict: totalDecision.conflict, coverage: totalDecision.coverage }
          },
          disclaimer: 'Analysis provided for educational purposes. Not a recommendation.',
          generated_at: now
        },
        modelOutputIds: null
      });
    }
  }

  // SPREAD decision → nba-spread-call
  const spreadDecision = marketDecisions?.SPREAD;
  if (spreadDecision && (spreadDecision.status === 'FIRE' || spreadDecision.status === 'WATCH')) {
    const confidence = CONFIDENCE_MAP[spreadDecision.status];
    const tier = determineTier(confidence);
    const { side, line } = spreadDecision.best_candidate;
    const spreadPrice = side === 'HOME'
      ? oddsSnapshot?.spread_price_home ?? null
      : oddsSnapshot?.spread_price_away ?? null;
    if (spreadPrice != null) {
      const lineText = line != null ? ` ${line > 0 ? '+' + line : line}` : '';
      const pickText = `${side === 'HOME' ? 'Home' : 'Away'}${lineText}`;
      const activeDrivers = (spreadDecision.drivers || [])
        .filter(d => d.eligible)
        .map(d => d.driverKey);
      const topDrivers = (spreadDecision.drivers || [])
        .filter(d => d.eligible)
        .sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal))
        .slice(0, 3)
        .map(d => ({ driver: d.driverKey, weight: d.weight, score: Number(((d.signal + 1) / 2).toFixed(3)) }));

      const cardId = `card-nba-spread-call-${gameId}-${uuidV4().slice(0, 8)}`;
      cards.push({
        id: cardId,
        gameId,
        sport: 'NBA',
        cardType: 'nba-spread-call',
        cardTitle: `NBA Spread: ${pickText}`,
        createdAt: now,
        expiresAt,
        payloadData: {
          game_id: gameId,
          sport: 'NBA',
          model_version: 'nba-cross-market-v1',
          home_team: oddsSnapshot?.home_team ?? null,
          away_team: oddsSnapshot?.away_team ?? null,
          matchup,
          start_time_utc: oddsSnapshot?.game_time_utc ?? null,
          start_time_local: startTimeLocal,
          timezone,
          countdown,
          prediction: side,
          confidence,
          tier,
          recommended_bet_type: 'spread',
          kind: 'PLAY',
          market_type: 'SPREAD',
          selection: {
            side,
            team: side === 'HOME' ? oddsSnapshot?.home_team ?? undefined : oddsSnapshot?.away_team ?? undefined,
          },
          line: line ?? null,
          price: spreadPrice,
          reason_codes: [],
          tags: [],
          consistency: {
            total_bias: totalBias,
          },
          reasoning: `${pickText}: ${spreadDecision.reasoning}`,
          edge: spreadDecision.edge ?? null,
          projection: {
            total: null,
            margin_home: line ?? null,
            win_prob_home: null
          },
          market,
          drivers_active: activeDrivers,
          driver_summary: { weights: topDrivers, impact_note: 'Cross-market spread decision.' },
          ev_passed: spreadDecision.status === 'FIRE',
          odds_context: {
            h2h_home: oddsSnapshot?.h2h_home,
            h2h_away: oddsSnapshot?.h2h_away,
            spread_home: oddsSnapshot?.spread_home,
            spread_away: oddsSnapshot?.spread_away,
            total: oddsSnapshot?.total,
            spread_price_home: oddsSnapshot?.spread_price_home,
            spread_price_away: oddsSnapshot?.spread_price_away,
            total_price_over: oddsSnapshot?.total_price_over,
            total_price_under: oddsSnapshot?.total_price_under,
            captured_at: oddsSnapshot?.captured_at
          },
          confidence_pct: Math.round(confidence * 100),
          driver: {
            key: 'cross_market_spread',
            score: spreadDecision.score,
            status: spreadDecision.status,
            inputs: { net: spreadDecision.net, conflict: spreadDecision.conflict, coverage: spreadDecision.coverage }
          },
          disclaimer: 'Analysis provided for educational purposes. Not a recommendation.',
          generated_at: now
        },
        modelOutputIds: null
      });
    }
  }

  return cards;
}

/**
 * Main job entrypoint
 * @param {object} options
 * @param {string|null} options.jobKey - Deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 */
async function runNBAModel({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-nba-model-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[NBAModel] Starting job run: ${jobRunId}`);
  if (jobKey) console.log(`[NBAModel] Job key: ${jobKey}`);
  console.log(`[NBAModel] Time: ${new Date().toISOString()}`);

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[NBAModel] ⏭️  Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    if (dryRun) {
      console.log(`[NBAModel] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`);
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      insertJobRun('run_nba_model', jobRunId, jobKey);

      const { DateTime } = require('luxon');
      const nowUtc = DateTime.utc();
      const horizonUtc = nowUtc.plus({ hours: 36 }).toISO();
      console.log('[NBAModel] Fetching odds for upcoming NBA games...');
      const oddsSnapshots = getOddsWithUpcomingGames('NBA', nowUtc.toISO(), horizonUtc);

      if (oddsSnapshots.length === 0) {
        console.log('[NBAModel] No upcoming NBA games found, exiting.');
        markJobRunSuccess(jobRunId);
        return { success: true, jobRunId, cardsGenerated: 0 };
      }

      console.log(`[NBAModel] Found ${oddsSnapshots.length} odds snapshots`);
      if (!ENABLE_WELCOME_HOME) {
        console.log('[NBAModel] Welcome Home driver disabled (ENABLE_WELCOME_HOME=false)');
      }

      // Dedupe: latest snapshot per game
      const gameOdds = {};
      oddsSnapshots.forEach(snap => {
        if (!gameOdds[snap.game_id] || snap.captured_at > gameOdds[snap.game_id].captured_at) {
          gameOdds[snap.game_id] = snap;
        }
      });

      const gameIds = Object.keys(gameOdds);
      console.log(`[NBAModel] Running NBA driver inference on ${gameIds.length} games...`);

      let cardsGenerated = 0;
      let cardsFailed = 0;
      let gatedCount = 0;
      let blockedCount = 0;
      const errors = [];

      for (const gameId of gameIds) {
        try {
          let oddsSnapshot = gameOdds[gameId];

          // Enrich with ESPN team metrics
          oddsSnapshot = await enrichOddsSnapshotWithEspnMetrics(oddsSnapshot);

          // Query schedule for Welcome Home Fade
          // Welcome Home Fade: Home team coming back from a road trip (first game back)
          const homeTeamRoadTrip = ENABLE_WELCOME_HOME
            ? getHomeTeamRecentRoadTrip(
                oddsSnapshot.home_team,
                'nba',
                oddsSnapshot.game_time_utc,
                10
              )
            : [];

          const driverCards = computeNBADriverCards(gameId, oddsSnapshot, {
            recentRoadGames: homeTeamRoadTrip
          });

          if (driverCards.length === 0) {
            console.log(`  [skip] ${gameId}: No actionable NBA driver signals`);
            continue;
          }

          // Only clear/write when we have actionable output; avoids wiping prior cards on transient data gaps.
          const driverCardTypesToClear = [...new Set([
            ...NBA_DRIVER_CARD_TYPES,
            ...driverCards.map((card) => card.cardType),
          ])];
          for (const ct of driverCardTypesToClear) {
            prepareModelAndCardWrite(gameId, 'nba-drivers-v1', ct);
          }

          const nbaMarketDecisions = computeNBAMarketDecisions(oddsSnapshot);
          const nbaExpressionChoice = selectExpressionChoice(nbaMarketDecisions);
          const nbaMarketPayload = buildMarketPayload({
            decisions: nbaMarketDecisions,
            expressionChoice: nbaExpressionChoice,
          });

          const cards = driverCards.map(descriptor => generateCard({
            sport: 'NBA',
            gameId,
            descriptor,
            oddsSnapshot,
            marketPayload: nbaMarketPayload,
            now: new Date().toISOString(),
            expiresAt: null,
            driverWeights: NBA_DRIVER_WEIGHTS
          }));
          
          // Set expiresAt for all cards
          if (oddsSnapshot?.game_time_utc) {
            const gameTime = new Date(oddsSnapshot.game_time_utc);
            const expiresAt = new Date(gameTime.getTime() - 60 * 60 * 1000).toISOString();
            cards.forEach(card => { card.expiresAt = expiresAt; });
          }

          for (const card of cards) {
            const validation = validateCardPayload(card.cardType, card.payloadData);
            if (!validation.success) {
              throw new Error(`Invalid card payload for ${card.cardType}: ${validation.errors.join('; ')}`);
            }
            const decisionOutcome = publishDecisionForCard({ card, oddsSnapshot });
            if (decisionOutcome.gated) gatedCount++;
            if (decisionOutcome.gated && !decisionOutcome.allow) {
              blockedCount++;
              console.log(`  [gate] ${gameId} [${card.cardType}]: ${decisionOutcome.reasonCode}`);
            }
            applyUiActionFields(card.payloadData);
            insertCardPayload(card);
            cardsGenerated++;
            const tierLabel = card.payloadData.tier ? ` [${card.payloadData.tier}]` : '';
            console.log(`  [ok] ${gameId} [${card.cardType}]${tierLabel}: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`);
          }

          // Generate and insert NBA market call cards (nba-totals-call, nba-spread-call)
          const nbaMarketCallCards = generateNBAMarketCallCards(gameId, nbaMarketDecisions, oddsSnapshot);
          if (nbaMarketCallCards.length > 0) {
            for (const ct of ['nba-totals-call', 'nba-spread-call']) {
              prepareModelAndCardWrite(gameId, 'nba-cross-market-v1', ct);
            }
          }
          for (const card of nbaMarketCallCards) {
            const validation = validateCardPayload(card.cardType, card.payloadData);
            if (!validation.success) {
              throw new Error(`Invalid card payload for ${card.cardType}: ${validation.errors.join('; ')}`);
            }
            const decisionOutcome = publishDecisionForCard({ card, oddsSnapshot });
            if (decisionOutcome.gated) gatedCount++;
            if (decisionOutcome.gated && !decisionOutcome.allow) {
              blockedCount++;
              console.log(`  [gate] ${gameId} [${card.cardType}]: ${decisionOutcome.reasonCode}`);
            }
            applyUiActionFields(card.payloadData);
            insertCardPayload(card);
            cardsGenerated++;
            const tierLabel = card.payloadData.tier ? ` [${card.payloadData.tier}]` : '';
            console.log(`  [ok] ${gameId} [${card.cardType}]${tierLabel}: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`);
          }
        } catch (gameError) {
          if (gameError.message.startsWith('Invalid card payload')) throw gameError;
          cardsFailed++;
          errors.push(`${gameId}: ${gameError.message}`);
          console.error(`  [err] ${gameId}: ${gameError.message}`);
        }
      }

      markJobRunSuccess(jobRunId);
      console.log(`[NBAModel] ✅ Job complete: ${cardsGenerated} cards generated, ${cardsFailed} failed`);
      console.log(`[NBAModel] Decision gate: ${gatedCount} gated, ${blockedCount} blocked`);
      if (errors.length > 0) errors.forEach(err => console.error(`  - ${err}`));

      return { success: true, jobRunId, cardsGenerated, cardsFailed, errors };

    } catch (error) {
      console.error(`[NBAModel] ❌ Job failed:`, error.message);
      console.error(error.stack);
      try { markJobRunFailure(jobRunId, error.message); } catch (_) {}
      return { success: false, jobRunId, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  runNBAModel()
    .then(result => process.exit(result.success ? 0 : 1))
    .catch(error => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = { runNBAModel };
