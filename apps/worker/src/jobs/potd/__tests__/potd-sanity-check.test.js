'use strict';

const {
  buildShadowEligibilityReport,
  dynamicEdgeFloorForScore,
  formatShadowEligibilityReport,
  getEligibilityThresholds,
} = require('../../../scripts/potd-sanity-check');

function nominee({
  playDate = '2026-04-17',
  rank = 1,
  sport = 'NHL',
  market = 'MONEYLINE',
  selection = 'Rangers',
  winnerStatus = 'NO_PICK',
  edgePct,
  totalScore,
}) {
  return {
    play_date: playDate,
    nominee_rank: rank,
    sport,
    game_id: `${sport}-${rank}`,
    market_type: market,
    selection_label: selection,
    winner_status: winnerStatus,
    edge_pct: edgePct,
    total_score: totalScore,
    confidence_label: totalScore >= 0.75 ? 'ELITE' : totalScore >= 0.5 ? 'HIGH' : 'LOW',
  };
}

function shadow({
  playDate = '2026-04-17',
  sport = 'MLB',
  market = 'MONEYLINE',
  selection = 'Mets',
  identityKey = null,
  edgePct,
  totalScore,
}) {
  const key = identityKey || `${playDate}|${sport}|${market}|${selection}`;
  return {
    play_date: playDate,
    sport,
    game_id: `${sport}-${selection}`,
    market_type: market,
    selection: market === 'TOTAL'
      ? (selection.toUpperCase().startsWith('UNDER') ? 'UNDER' : 'OVER')
      : selection.toUpperCase().includes('HOME') ? 'HOME' : 'AWAY',
    selection_label: selection,
    candidate_identity_key: key,
    edge_pct: edgePct,
    total_score: totalScore,
  };
}

function shadowResult({
  playDate = '2026-04-17',
  identityKey,
  status = 'settled',
  result = 'win',
  pnlUnits = 0.9,
  stakeUnits = 1.0,
}) {
  return {
    play_date: playDate,
    candidate_identity_key: identityKey,
    status,
    result,
    pnl_units: pnlUnits,
    virtual_stake_units: stakeUnits,
  };
}

describe('potd sanity shadow eligibility report', () => {
  test('reports daily strict/soft/dynamic rows with best strict and dynamic-only values', () => {
    const report = buildShadowEligibilityReport({
      nomineeRows: [
        nominee({ playDate: '2026-04-17', rank: 1, winnerStatus: 'FIRED', edgePct: 0.021, totalScore: 0.55, selection: 'strict pick' }),
        nominee({ playDate: '2026-04-17', rank: 2, edgePct: 0.012, totalScore: 0.40, selection: 'soft pick' }),
        nominee({ playDate: '2026-04-16', rank: 1, winnerStatus: 'NO_PICK', edgePct: 0.018, totalScore: 0.80, selection: 'old dynamic' }),
      ],
      shadowRows: [
        shadow({ playDate: '2026-04-17', market: 'TOTAL', selection: 'OVER 5.5', edgePct: 0.006, totalScore: 0.80, identityKey: 'dyn-a' }),
      ],
      thresholds: { minEdgePct: 0.02, softScoreFloor: 0.30 },
    });

    expect(report.latestDate).toBe('2026-04-17');
    expect(report.dailyComparisonRows[0]).toMatchObject({
      date: '2026-04-17',
      strictCount: 1,
      softCount: 3,
      dynamicCount: 2,
      officialPotdFired: 1,
      bestStrictEdge: 0.021,
      bestDynamicOnlyEdge: 0.006,
      bestDynamicOnlyScore: 0.8,
    });
  });

  test('summarizes sport breakdown and bucket boundaries', () => {
    const report = buildShadowEligibilityReport({
      nomineeRows: [],
      shadowRows: [
        shadow({ sport: 'NHL', selection: 'edge<0', edgePct: -0.001, totalScore: 0.60 }),
        shadow({ sport: 'NHL', selection: 'edge0', edgePct: 0.001, totalScore: 0.70 }),
        shadow({ sport: 'NBA', selection: 'edge05', edgePct: 0.006, totalScore: 0.72 }),
        shadow({ sport: 'NBA', selection: 'edge10', edgePct: 0.011, totalScore: 0.749 }),
        shadow({ sport: 'MLB', selection: 'edge15', edgePct: 0.016, totalScore: 0.80 }),
        shadow({ sport: 'MLB', selection: 'edge20', edgePct: 0.025, totalScore: 0.76 }),
      ],
      thresholds: { minEdgePct: 0.02, softScoreFloor: 0.30 },
    });

    expect(report.bucketSummary.edgeBuckets).toMatchObject({
      '<0%': 1,
      '0-0.5%': 1,
      '0.5-1.0%': 1,
      '1.0-1.5%': 1,
      '1.5-2.0%': 1,
      '2.0%+': 1,
    });
    expect(report.bucketSummary.highScoreBuckets).toMatchObject({
      '0.70-0.72': 1,
      '0.72-0.75': 2,
      '0.75+': 2,
    });
    const sports = Object.fromEntries(report.sportBreakdown.map((row) => [row.sport, row]));
    expect(sports.NHL.softQualified).toBe(1);
    expect(sports.MLB.dynamicQualified).toBe(2);
  });

  test('includes candidates that qualify under score-based dynamic floor', () => {
    const thresholds = getEligibilityThresholds({ minEdgePct: 0.02, softScoreFloor: 0.30 });

    expect(dynamicEdgeFloorForScore(0.80, thresholds)).toBe(0.005);
    expect(dynamicEdgeFloorForScore(0.64, thresholds)).toBe(0.01);
    expect(dynamicEdgeFloorForScore(0.55, thresholds)).toBe(0.015);

    const report = buildShadowEligibilityReport({
      nomineeRows: [],
      shadowRows: [
        shadow({ selection: 'dynamic only', edgePct: 0.006, totalScore: 0.80, identityKey: 'dyn-only' }),
        shadow({ selection: 'too low score', edgePct: 0.018, totalScore: 0.45, identityKey: 'too-low' }),
        shadow({ selection: 'strict', edgePct: 0.022, totalScore: 0.60, identityKey: 'strict-one' }),
      ],
      shadowResultRows: [
        shadowResult({ identityKey: 'dyn-only', result: 'win', pnlUnits: 0.9, stakeUnits: 1.0 }),
      ],
      thresholds: { minEdgePct: 0.02, softScoreFloor: 0.30 },
    });

    const selections = report.dynamicFloorCandidates.map((row) => row.selectionLabel);
    expect(selections).toContain('dynamic only');
    expect(selections).toContain('strict');
    expect(selections).not.toContain('too low score');
    expect(report.dynamicFloorCandidates.find((row) => row.selectionLabel === 'dynamic only').dynamicShadowOnly).toBe(true);
    expect(report.dynamicOnlySettlement).toMatchObject({
      settledCount: 1,
      wins: 1,
      losses: 0,
      pushes: 0,
      pnlUnits: 0.9,
      roi: 0.9,
    });
  });

  test('formatted report includes new WI-0999 sections without mutating input rows', () => {
    const nomineeRows = [];
    const shadowRows = [
      shadow({ selection: 'dynamic only', edgePct: 0.006, totalScore: 0.80, identityKey: 'dyn-only-format' }),
    ];
    const shadowResultRows = [
      shadowResult({ identityKey: 'dyn-only-format', result: 'loss', pnlUnits: -1.0, stakeUnits: 1.0 }),
    ];

    const report = buildShadowEligibilityReport({
      nomineeRows,
      shadowRows,
      shadowResultRows,
      thresholds: { minEdgePct: 0.02, softScoreFloor: 0.30 },
    });

    const output = formatShadowEligibilityReport(report).join('\n');
    expect(output).toContain('POTD Shadow Eligibility Report');
    expect(output).toContain('strict=edge>=2.00% & score>=0.500');
    expect(output).toContain('Daily strict/soft/dynamic comparison');
    expect(output).toContain('Dynamic-only settlement performance');
    expect(output).toContain('Sport breakdown (strict/soft/dynamic/dynamic_only)');
    expect(output).toContain('Edge buckets');
    expect(output).toContain('High-score buckets');
    expect(output).toContain('Dynamic-only candidate rows');
    expect(output).toContain('shadow*');
    expect(output).toContain('dynamic only');
    expect(output).toContain('loss');
    expect(output).toContain('-1.000');
    expect(output).toContain('dynamic_only: qualifies under dynamic floor');

    expect(shadowRows[0].selection_label).toBe('dynamic only');
    expect(shadowResultRows[0].result).toBe('loss');
  });
});
