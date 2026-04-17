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
  edgePct,
  totalScore,
}) {
  return {
    play_date: playDate,
    sport,
    game_id: `${sport}-${selection}`,
    market_type: market,
    selection_label: selection,
    edge_pct: edgePct,
    total_score: totalScore,
  };
}

describe('potd sanity shadow eligibility report', () => {
  test('reports current strict eligibility separately from soft eligibility', () => {
    const report = buildShadowEligibilityReport({
      nomineeRows: [
        nominee({ rank: 1, edgePct: 0.021, totalScore: 0.55, selection: 'strict pick' }),
        nominee({ rank: 2, edgePct: 0.012, totalScore: 0.40, selection: 'soft pick' }),
        nominee({ playDate: '2026-04-16', edgePct: 0.025, totalScore: 0.80, selection: 'old pick' }),
      ],
      shadowRows: [],
      thresholds: { minEdgePct: 0.02, softScoreFloor: 0.30 },
    });

    expect(report.latestDate).toBe('2026-04-17');
    expect(report.current).toMatchObject({
      total: 2,
      strictEligible: 1,
      softEligible: 2,
    });
  });

  test('summarizes nominee score and edge distribution', () => {
    const report = buildShadowEligibilityReport({
      nomineeRows: [
        nominee({ edgePct: 0.01, totalScore: 0.40 }),
        nominee({ edgePct: 0.02, totalScore: 0.60 }),
        nominee({ edgePct: 0.03, totalScore: 0.80 }),
      ],
      shadowRows: [],
      thresholds: { minEdgePct: 0.02, softScoreFloor: 0.30 },
    });

    expect(report.nominees.distribution.count).toBe(3);
    expect(report.nominees.distribution.edgePct.median).toBe(0.02);
    expect(report.nominees.distribution.totalScore.median).toBe(0.6);
  });

  test('includes candidates that qualify under score-based dynamic floor', () => {
    const thresholds = getEligibilityThresholds({ minEdgePct: 0.02, softScoreFloor: 0.30 });

    expect(dynamicEdgeFloorForScore(0.80, thresholds)).toBe(0.005);
    expect(dynamicEdgeFloorForScore(0.64, thresholds)).toBe(0.01);
    expect(dynamicEdgeFloorForScore(0.55, thresholds)).toBe(0.015);

    const report = buildShadowEligibilityReport({
      nomineeRows: [],
      shadowRows: [
        shadow({ selection: 'dynamic only', edgePct: 0.006, totalScore: 0.80 }),
        shadow({ selection: 'too low score', edgePct: 0.018, totalScore: 0.45 }),
        shadow({ selection: 'strict', edgePct: 0.022, totalScore: 0.60 }),
      ],
      thresholds: { minEdgePct: 0.02, softScoreFloor: 0.30 },
    });

    const selections = report.dynamicFloorCandidates.map((row) => row.selectionLabel);
    expect(selections).toContain('dynamic only');
    expect(selections).toContain('strict');
    expect(selections).not.toContain('too low score');
    expect(report.dynamicFloorCandidates.find((row) => row.selectionLabel === 'dynamic only').dynamicShadowOnly).toBe(true);
  });

  test('formatted report labels dynamic-only qualifiers', () => {
    const report = buildShadowEligibilityReport({
      nomineeRows: [],
      shadowRows: [
        shadow({ selection: 'dynamic only', edgePct: 0.006, totalScore: 0.80 }),
      ],
      thresholds: { minEdgePct: 0.02, softScoreFloor: 0.30 },
    });

    const output = formatShadowEligibilityReport(report).join('\n');
    expect(output).toContain('POTD Shadow Eligibility Report');
    expect(output).toContain('strict=edge>=2.00% & score>=0.500');
    expect(output).toContain('shadow*');
    expect(output).toContain('dynamic only');
    expect(output).toContain('dynamic_only: qualifies under dynamic floor');
  });
});
