const { v4: uuidV4 } = require('uuid');
const { upsertGame, insertCardPayload, upsertGameResult, insertOddsSnapshot } = require('./db.js');
const { withDb } = require('./job-runtime');

const SEED_KEY = 'seed-results-2026-02-27';
const GAME_PREFIX = `${SEED_KEY}`;

function computeResult(prediction, homeScore, awayScore) {
  if (prediction === 'HOME') {
    if (homeScore > awayScore) return { result: 'win' };
    if (homeScore < awayScore) return { result: 'loss' };
    return { result: 'push' };
  }

  if (prediction === 'AWAY') {
    if (awayScore > homeScore) return { result: 'win' };
    if (awayScore < homeScore) return { result: 'loss' };
    return { result: 'push' };
  }

  return { result: 'push' };
}

function computePnlUnits(result, odds) {
  if (result === 'push') return 0.0;
  if (result === 'loss') return -1.0;
  if (result !== 'win') return null;
  if (!Number.isFinite(odds) || odds === 0) return null;

  if (odds > 0) return odds / 100;
  return 100 / Math.abs(odds);
}

async function seedTestResults() {
  const settledAt = new Date().toISOString();
  // Use tomorrow at 7pm ET as base time (future games)
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const baseTime = new Date(`${tomorrow.toISOString().substring(0, 10)}T23:00:00Z`);

  const games = [
    {
      gameId: `seed-nhl-001-${Date.now()}`,
      sport: 'NHL',
      homeTeam: 'Seed Maple Leafs',
      awayTeam: 'Seed Canadiens',
      gameTimeUtc: new Date(baseTime.getTime()).toISOString(),
      prediction: 'HOME',
      oddsHome: -120,
      oddsAway: 110,
      finalScoreHome: 4,
      finalScoreAway: 2,
    },
    {
      gameId: `seed-nba-001-${Date.now()}`,
      sport: 'NBA',
      homeTeam: 'Seed Warriors',
      awayTeam: 'Seed Lakers',
      gameTimeUtc: new Date(baseTime.getTime() + 60 * 60 * 1000).toISOString(),
      prediction: 'AWAY',
      oddsHome: -135,
      oddsAway: 120,
      finalScoreHome: 102,
      finalScoreAway: 109,
    },
    {
      gameId: `seed-nhl-002-${Date.now()}`,
      sport: 'NHL',
      homeTeam: 'Seed Bruins',
      awayTeam: 'Seed Rangers',
      gameTimeUtc: new Date(baseTime.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      prediction: 'HOME',
      oddsHome: -105,
      oddsAway: -105,
      finalScoreHome: 3,
      finalScoreAway: 3,
    },
  ];

  await withDb((db) => {
    games.forEach((game, index) => {
      upsertGame({
        id: `seed-game-${uuidV4()}`,
        gameId: game.gameId,
        sport: game.sport,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        gameTimeUtc: game.gameTimeUtc,
        status: 'scheduled',
      });

      // Insert odds snapshot
      insertOddsSnapshot({
        id: `seed-odds-${uuidV4()}`,
        gameId: game.gameId,
        sport: game.sport,
        capturedAt: settledAt,
        h2hHome: game.oddsHome,
        h2hAway: game.oddsAway,
        total: null,
        spreadHome: null,
        spreadAway: null,
        monelineHome: null,
        monelineAway: null,
        spreadPriceHome: null,
        spreadPriceAway: null,
        totalPriceOver: null,
        totalPriceUnder: null,
        rawData: null,
        jobRunId: null,
      });

      const cardId = `seed-card-${uuidV4().slice(0, 8)}`;
      const payloadData = {
        prediction: game.prediction,
        recommended_bet_type: 'moneyline',
        odds_context: {
          h2h_home: game.oddsHome,
          h2h_away: game.oddsAway,
          captured_at: settledAt
        },
        seed_key: SEED_KEY,
        note: `Seeded result card ${index + 1}`,
        // Add play object with proper structure
        action: 'FIRE',  // Default to FIRE for seeded cards
        market_type: 'MONEYLINE',
        tier: 'BEST',
        confidence: 0.75,
        play: {
          prediction: game.prediction,
          market_type: 'MONEYLINE',
          action: 'FIRE',
          status: 'FIRE',
          tier: 'BEST',
          confidence: 0.75,
          selection: {
            side: game.prediction
          },
          line: null,
          price: game.prediction === 'HOME' ? game.oddsHome : game.oddsAway
        }
      };

      insertCardPayload({
        id: cardId,
        gameId: game.gameId,
        sport: game.sport,
        cardType: 'seed-result',
        cardTitle: 'Seed Result Card',
        createdAt: settledAt,
        expiresAt: null,
        payloadData,
        modelOutputIds: null,
        metadata: { seedKey: SEED_KEY },
      });

      upsertGameResult({
        id: `seed-result-${uuidV4()}`,
        gameId: game.gameId,
        sport: game.sport,
        finalScoreHome: game.finalScoreHome,
        finalScoreAway: game.finalScoreAway,
        status: 'final',
        resultSource: 'manual',
        settledAt,
        metadata: { seedKey: SEED_KEY },
      });

      const { result } = computeResult(
        game.prediction,
        game.finalScoreHome,
        game.finalScoreAway
      );

      const odds = game.prediction === 'HOME' ? game.oddsHome : game.oddsAway;
      const pnl = computePnlUnits(result, odds);

      // Prepare per iteration: sql.js statements can be invalidated after saveDatabase.
      const updateStmt = db.prepare(`
        UPDATE card_results
        SET status = 'settled', result = ?, settled_at = ?, pnl_units = ?, metadata = ?
        WHERE card_id = ?
      `);

      updateStmt.run(
        result,
        settledAt,
        pnl,
        JSON.stringify({ seedKey: SEED_KEY }),
        cardId
      );
    });
  });

  console.log('Seeded test results data.');
}

if (require.main === module) {
  seedTestResults().catch((error) => {
    console.error('Failed to seed test results:', error.message || error);
    process.exit(1);
  });
}

module.exports = { seedTestResults };
