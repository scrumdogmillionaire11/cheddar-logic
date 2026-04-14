'use strict';

require('dotenv').config();

const { fetchOdds } = require('@cheddar-logic/odds');
const { buildCandidates, scoreCandidate } = require('../jobs/potd/signal-engine');

const MIN_EDGE = 0.02;
const MIN_SCORE = 0.30;

(async () => {
  const sports = ['MLB', 'NHL', 'NBA'];
  const edgeValues = [];
  const scoreValues = [];
  let total = 0;
  let passingEdge = 0;
  let passingBoth = 0;

  for (const sport of sports) {
    const result = await fetchOdds({ sport, hoursAhead: 24 });
    for (const game of result?.games || []) {
      const candidates = buildCandidates(game);
      for (const c of candidates) {
        const scored = scoreCandidate(c);
        if (!scored) continue;
        total++;
        edgeValues.push(scored.edgePct);
        scoreValues.push(scored.totalScore);
        if (scored.edgePct > MIN_EDGE) passingEdge++;
        if (scored.edgePct > MIN_EDGE && scored.totalScore >= MIN_SCORE) passingBoth++;
      }
    }
  }

  edgeValues.sort((a, b) => b - a);
  scoreValues.sort((a, b) => b - a);
  const positiveEdge = edgeValues.filter((e) => e > 0);

  console.log('=== POTD Edge Distribution Probe ===');
  console.log('Total scored candidates:', total);
  console.log('Passing edge >' + (MIN_EDGE * 100).toFixed(1) + '%:', passingEdge);
  console.log('Passing edge + score (viable):', passingBoth);
  console.log('Positive edge count:', positiveEdge.length);
  if (positiveEdge.length > 0) {
    const sum = positiveEdge.reduce((s, e) => s + e, 0);
    console.log('Mean positive edge:', ((sum / positiveEdge.length) * 100).toFixed(3) + '%');
  }
  console.log('Top 10 edges:', edgeValues.slice(0, 10).map((e) => (e * 100).toFixed(3) + '%').join(', '));
  console.log('Top 10 scores:', scoreValues.slice(0, 10).map((s) => s.toFixed(3)).join(', '));
  console.log('Min edge:', edgeValues.length ? (Math.min(...edgeValues) * 100).toFixed(3) + '%' : 'n/a');
  console.log('Max edge:', edgeValues.length ? (edgeValues[0] * 100).toFixed(3) + '%' : 'n/a');
  console.log('Top score:', scoreValues.length ? scoreValues[0].toFixed(3) : 'n/a');
})().catch((err) => {
  console.error('Probe error:', err.message);
  process.exit(1);
});
