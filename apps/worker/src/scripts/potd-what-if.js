'use strict';

require('dotenv').config();

const { buildCandidates, scoreCandidate, selectBestPlay } = require('../jobs/potd/signal-engine');
const { fetchOdds } = require('@cheddar-logic/odds');

const MIN_EDGE = Number(process.argv[2] || 0.005);
const MIN_SCORE = 0.30;

(async () => {
  const sports = ['MLB', 'NHL', 'NBA'];
  const all = [];
  for (const sport of sports) {
    const result = await fetchOdds({ sport, hoursAhead: 24 });
    for (const game of result?.games || []) {
      const candidates = buildCandidates(game);
      for (const c of candidates) {
        const scored = scoreCandidate(c);
        if (scored) all.push(scored);
      }
    }
  }

  const best = selectBestPlay(all, { minConfidence: MIN_SCORE, minEdgePct: MIN_EDGE });

  if (!best) {
    console.log('No pick at minEdge=' + (MIN_EDGE * 100).toFixed(1) + '%');
    return;
  }

  console.log('--- BEST PICK (minEdge=' + (MIN_EDGE * 100).toFixed(1) + '%) ---');
  console.log('Sport:', best.sport);
  console.log('Game:', best.away_team + ' @ ' + best.home_team);
  console.log('Market:', best.marketType, '|', best.selectionLabel);
  console.log('Price:', best.price);
  console.log('Edge:', (best.edgePct * 100).toFixed(3) + '%');
  console.log('Total Score:', best.totalScore.toFixed(3));
  console.log('Confidence:', best.confidenceLabel);
  console.log('Model Win Prob:', best.modelWinProb ? (best.modelWinProb * 100).toFixed(2) + '%' : 'n/a');
  console.log('Implied Prob:', best.impliedProb ? (best.impliedProb * 100).toFixed(2) + '%' : 'n/a');
  console.log('Line Value:', best.lineValue != null ? best.lineValue.toFixed(3) : 'n/a');
  console.log('Market Consensus:', best.marketConsensus != null ? best.marketConsensus.toFixed(3) : 'n/a');
  console.log('Score Breakdown:', JSON.stringify(best.scoreBreakdown));
  console.log('Reasoning:', best.reasoning);
  console.log('');
  console.log('--- TOP 5 VIABLE ---');
  const viable = all
    .filter((c) => c.edgePct > MIN_EDGE && c.totalScore >= MIN_SCORE)
    .sort((a, b) => b.totalScore - a.totalScore || b.edgePct - a.edgePct)
    .slice(0, 5);
  for (const c of viable) {
    console.log(
      c.sport.padEnd(5),
      (c.away_team + ' @ ' + c.home_team).padEnd(45),
      c.marketType.padEnd(10),
      c.selectionLabel.padEnd(25),
      'edge=' + (c.edgePct * 100).toFixed(3) + '%',
      'score=' + c.totalScore.toFixed(3),
    );
  }
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
