/*
 * POTD near-miss market/match dedup smoke test.
 *
 * Run: node web/src/__tests__/potd-near-miss-best-edge.test.js
 */

import assert from 'node:assert/strict';
import db from '../../../packages/data/src/db.js';
import {
  setupIsolatedTestDb,
  startIsolatedNextServer,
} from './db-test-runtime.js';

function insertShadowCandidate(client, row) {
  client
    .prepare(
      `INSERT INTO potd_shadow_candidates (
        play_date, captured_at, sport, market_type, selection_label,
        home_team, away_team, game_id, price, line, edge_pct, total_score,
        line_value, market_consensus, model_win_prob, implied_prob,
        projection_source, gap_to_min_edge, selection, game_time_utc,
        candidate_identity_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.playDate,
      row.capturedAt,
      row.sport,
      row.marketType,
      row.selectionLabel,
      row.homeTeam,
      row.awayTeam,
      row.gameId,
      row.price,
      row.line,
      row.edgePct,
      row.totalScore,
      row.lineValue,
      row.marketConsensus,
      row.modelWinProb,
      row.impliedProb,
      row.projectionSource,
      row.gapToMinEdge,
      row.selection,
      row.gameTimeUtc,
      row.candidateIdentityKey,
    );
  return client.prepare(`SELECT id FROM potd_shadow_candidates WHERE candidate_identity_key = ?`).get(row.candidateIdentityKey).id;
}

function insertShadowResult(client, row) {
  client
    .prepare(
      `INSERT INTO potd_shadow_results (
        play_date, candidate_identity_key, shadow_candidate_id, game_id, sport,
        market_type, selection, selection_label, line, price, game_time_utc,
        status, result, virtual_stake_units, pnl_units, settled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.playDate,
      row.candidateIdentityKey,
      row.shadowCandidateId,
      row.gameId,
      row.sport,
      row.marketType,
      row.selection,
      row.selectionLabel,
      row.line,
      row.price,
      row.gameTimeUtc,
      row.status,
      row.result,
      row.virtualStakeUnits,
      row.pnlUnits,
      row.settledAt,
    );
}

async function run() {
  const testRuntime = await setupIsolatedTestDb('potd-near-miss-best-edge');
  let server = null;

  try {
    const client = db.getDatabase();
    const playDate = '2026-04-23';
    const capturedAt = '2026-04-23T15:00:00.000Z';
    const gameTimeUtc = '2026-04-24T00:00:00.000Z';

    const overId = insertShadowCandidate(client, {
      playDate,
      capturedAt,
      sport: 'NHL',
      marketType: 'TOTAL',
      selectionLabel: 'Over 5.5 legacy duplicate',
      homeTeam: 'Boston Bruins',
      awayTeam: 'Toronto Maple Leafs',
      gameId: 'near-miss-total-1',
      price: -110,
      line: 5.5,
      edgePct: 0.021,
      totalScore: 0.71,
      lineValue: 0.7,
      marketConsensus: 0.6,
      modelWinProb: 0.54,
      impliedProb: 0.519,
      projectionSource: 'FULL_MODEL',
      gapToMinEdge: 0.001,
      selection: 'OVER',
      gameTimeUtc,
      candidateIdentityKey: 'NHL|near-miss-total-1|TOTAL|OVER|5.500',
    });
    const underId = insertShadowCandidate(client, {
      playDate,
      capturedAt,
      sport: 'NHL',
      marketType: 'TOTAL',
      selectionLabel: 'Under 5.5 best edge',
      homeTeam: 'Boston Bruins',
      awayTeam: 'Toronto Maple Leafs',
      gameId: 'near-miss-total-1',
      price: -105,
      line: 5.5,
      edgePct: 0.039,
      totalScore: 0.69,
      lineValue: 0.68,
      marketConsensus: 0.61,
      modelWinProb: 0.551,
      impliedProb: 0.512,
      projectionSource: 'FULL_MODEL',
      gapToMinEdge: 0.019,
      selection: 'UNDER',
      gameTimeUtc,
      candidateIdentityKey: 'NHL|near-miss-total-1|TOTAL|UNDER|5.500',
    });
    const moneylineId = insertShadowCandidate(client, {
      playDate,
      capturedAt,
      sport: 'NBA',
      marketType: 'MONEYLINE',
      selectionLabel: 'Fixture Home ML',
      homeTeam: 'Fixture Home',
      awayTeam: 'Fixture Away',
      gameId: 'near-miss-ml-1',
      price: 120,
      line: null,
      edgePct: 0.026,
      totalScore: 0.74,
      lineValue: 0.7,
      marketConsensus: 0.65,
      modelWinProb: 0.481,
      impliedProb: 0.455,
      projectionSource: 'FULL_MODEL',
      gapToMinEdge: 0.006,
      selection: 'HOME',
      gameTimeUtc,
      candidateIdentityKey: 'NBA|near-miss-ml-1|MONEYLINE|HOME|NA',
    });
    const olderHighEdgeId = insertShadowCandidate(client, {
      playDate: '2026-04-22',
      capturedAt: '2026-04-22T15:00:00.000Z',
      sport: 'NHL',
      marketType: 'TOTAL',
      selectionLabel: 'Older High Edge Over 6.5',
      homeTeam: 'Older Home',
      awayTeam: 'Older Away',
      gameId: 'near-miss-older-total',
      price: 100,
      line: 6.5,
      edgePct: 0.12,
      totalScore: 0.81,
      lineValue: 0.8,
      marketConsensus: 0.7,
      modelWinProb: 0.62,
      impliedProb: 0.5,
      projectionSource: 'FULL_MODEL',
      gapToMinEdge: 0.10,
      selection: 'OVER',
      gameTimeUtc: '2026-04-23T00:00:00.000Z',
      candidateIdentityKey: 'NHL|near-miss-older-total|TOTAL|OVER|6.500',
    });

    insertShadowResult(client, {
      playDate,
      candidateIdentityKey: 'NHL|near-miss-total-1|TOTAL|OVER|5.500',
      shadowCandidateId: overId,
      gameId: 'near-miss-total-1',
      sport: 'NHL',
      marketType: 'TOTAL',
      selection: 'OVER',
      selectionLabel: 'Over 5.5 legacy duplicate',
      line: 5.5,
      price: -110,
      gameTimeUtc,
      status: 'settled',
      result: 'loss',
      virtualStakeUnits: 1,
      pnlUnits: -1,
      settledAt: '2026-04-24T03:00:00.000Z',
    });
    insertShadowResult(client, {
      playDate,
      candidateIdentityKey: 'NHL|near-miss-total-1|TOTAL|UNDER|5.500',
      shadowCandidateId: underId,
      gameId: 'near-miss-total-1',
      sport: 'NHL',
      marketType: 'TOTAL',
      selection: 'UNDER',
      selectionLabel: 'Under 5.5 best edge',
      line: 5.5,
      price: -105,
      gameTimeUtc,
      status: 'settled',
      result: 'win',
      virtualStakeUnits: 1,
      pnlUnits: 0.95,
      settledAt: '2026-04-24T03:01:00.000Z',
    });
    insertShadowResult(client, {
      playDate,
      candidateIdentityKey: 'NBA|near-miss-ml-1|MONEYLINE|HOME|NA',
      shadowCandidateId: moneylineId,
      gameId: 'near-miss-ml-1',
      sport: 'NBA',
      marketType: 'MONEYLINE',
      selection: 'HOME',
      selectionLabel: 'Fixture Home ML',
      line: null,
      price: 120,
      gameTimeUtc,
      status: 'pending',
      result: null,
      virtualStakeUnits: 1,
      pnlUnits: null,
      settledAt: null,
    });
    insertShadowResult(client, {
      playDate: '2026-04-22',
      candidateIdentityKey: 'NHL|near-miss-older-total|TOTAL|OVER|6.500',
      shadowCandidateId: olderHighEdgeId,
      gameId: 'near-miss-older-total',
      sport: 'NHL',
      marketType: 'TOTAL',
      selection: 'OVER',
      selectionLabel: 'Older High Edge Over 6.5',
      line: 6.5,
      price: 100,
      gameTimeUtc: '2026-04-23T00:00:00.000Z',
      status: 'settled',
      result: 'loss',
      virtualStakeUnits: 1,
      pnlUnits: -1,
      settledAt: '2026-04-23T03:00:00.000Z',
    });
    insertShadowResult(client, {
      playDate,
      candidateIdentityKey: 'MLB|fallback-game|SPREAD|HOME|1.500',
      shadowCandidateId: null,
      gameId: null,
      sport: 'MLB',
      marketType: 'SPREAD',
      selection: 'HOME',
      selectionLabel: 'Fallback Home -1.5 older',
      line: -1.5,
      price: -110,
      gameTimeUtc,
      status: 'settled',
      result: 'loss',
      virtualStakeUnits: 1,
      pnlUnits: -1,
      settledAt: '2026-04-24T02:00:00.000Z',
    });
    insertShadowResult(client, {
      playDate,
      candidateIdentityKey: 'MLB|fallback-game|SPREAD|AWAY|1.500',
      shadowCandidateId: null,
      gameId: null,
      sport: 'MLB',
      marketType: 'SPREAD',
      selection: 'AWAY',
      selectionLabel: 'Fallback Away +1.5 newer',
      line: 1.5,
      price: -110,
      gameTimeUtc,
      status: 'settled',
      result: 'win',
      virtualStakeUnits: 1,
      pnlUnits: 0.91,
      settledAt: '2026-04-24T02:05:00.000Z',
    });

    server = await startIsolatedNextServer({
      dbPath: testRuntime.dbPath,
      label: 'potd-near-miss-best-edge',
      readinessPath: '/api/potd',
    });

    const apiResponse = await fetch(`${server.baseUrl}/api/potd`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(apiResponse.status, 200, 'POTD API should return 200');
    const payload = await apiResponse.json();
    assert.equal(payload.success, true, 'POTD API success=false');
    assert.deepEqual(payload.data.nearMissSummary, {
      sampleSize: 4,
      settledCount: 3,
      wins: 2,
      losses: 1,
      pushes: 0,
      pending: 1,
      nonGradeable: 0,
      winRate: 0.6666666666666666,
    });

    const settledResponse = await fetch(`${server.baseUrl}/play-of-the-day/settled`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(settledResponse.status, 200, 'settled page should return 200');
    const html = await settledResponse.text();
    assert.match(html, /Under 5\.5 best edge/, 'settled page should keep highest-edge TOTAL side');
    assert.doesNotMatch(html, /Over 5\.5 legacy duplicate/, 'settled page should suppress lower-edge TOTAL side');
    assert.match(html, /Older High Edge Over 6\.5/, 'settled page should include older deduped rows');
    assert.ok(
      html.indexOf('Under 5.5 best edge') < html.indexOf('Older High Edge Over 6.5'),
      'settled page should list newer playDate rows before older high-edge rows',
    );
    assert.match(html, /Fallback Away \+1\.5 newer/, 'settled page should dedupe fallback identity-key SPREAD rows');
    assert.doesNotMatch(html, /Fallback Home -1\.5 older/, 'settled page should suppress fallback duplicate');

    console.log('✅ POTD near-miss best-edge dedup test passed');
  } finally {
    if (server) await server.stop();
    testRuntime.cleanup();
  }
}

run().catch((error) => {
  console.error('❌ POTD near-miss best-edge dedup test failed');
  console.error(error);
  process.exit(1);
});
