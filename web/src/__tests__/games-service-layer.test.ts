import assert from 'node:assert/strict';

import { prepareGamesServiceRows } from '../lib/games/service-layer.ts';

function buildRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    game_id: 'game-1',
    sport: 'NHL',
    home_team: 'Colorado Avalanche',
    away_team: 'Los Angeles Kings',
    game_time_utc: '2026-05-04 04:00:00',
    status: 'scheduled',
    created_at: '2026-05-03T03:00:00.000Z',
    h2h_home: null,
    h2h_away: null,
    h2h_book: null,
    h2h_home_book: null,
    h2h_away_book: null,
    total: null,
    total_book: null,
    total_line_over: null,
    total_line_over_book: null,
    total_line_under: null,
    total_line_under_book: null,
    spread_home: null,
    spread_away: null,
    spread_home_book: null,
    spread_away_book: null,
    spread_price_home: null,
    spread_price_home_book: null,
    spread_price_away: null,
    spread_price_away_book: null,
    total_price_over: null,
    total_price_over_book: null,
    total_price_under: null,
    total_price_under_book: null,
    spread_is_mispriced: null,
    spread_misprice_type: null,
    spread_misprice_strength: null,
    spread_outlier_book: null,
    spread_outlier_delta: null,
    spread_review_flag: null,
    spread_consensus_line: null,
    spread_consensus_confidence: null,
    spread_dispersion_stddev: null,
    spread_source_book_count: null,
    total_is_mispriced: null,
    total_misprice_type: null,
    total_misprice_strength: null,
    total_outlier_book: null,
    total_outlier_delta: null,
    total_review_flag: null,
    total_consensus_line: null,
    total_consensus_confidence: null,
    total_dispersion_stddev: null,
    total_source_book_count: null,
    h2h_consensus_home: null,
    h2h_consensus_away: null,
    h2h_consensus_confidence: null,
    public_bets_pct_home: null,
    public_bets_pct_away: null,
    public_handle_pct_home: null,
    public_handle_pct_away: null,
    splits_source: null,
    odds_captured_at: null,
    projection_inputs_complete: null,
    projection_missing_inputs: [],
    source_mapping_ok: null,
    source_mapping_failures: [],
    ingest_failure_reason_code: null,
    ingest_failure_reason_detail: null,
    ...overrides,
  };
}

function buildPlay(overrides: Record<string, unknown> = {}) {
  return {
    cardType: 'nhl-player-shots',
    cardTitle: 'Player prop',
    prediction: 'OVER',
    confidence: 0.57,
    tier: null,
    reasoning: '',
    evPassed: false,
    driverKey: '',
    projectedTotal: 2.8,
    edge: null,
    status: 'PASS',
    action: 'PASS',
    kind: 'PLAY',
    market_type: 'PROP',
    execution_status: 'PROJECTION_ONLY',
    selection: { side: 'OVER', team: 'Player Name' },
    line: 2.5,
    price: null,
    reason_codes: ['MISSING_PRICE'],
    tags: [],
    ...overrides,
  };
}

console.log('🧪 games service-layer tests');

{
  const row = buildRow();
  const playsMap = new Map([[row.game_id, [buildPlay()]]]);
  const result = prepareGamesServiceRows({
    rows: [row],
    lifecycleMode: 'pregame',
    playsMap,
  });

  assert.equal(
    result.responseRows.length,
    0,
    'projection-only NHL prop rows without odds should not surface in pregame response rows',
  );
  assert.equal(
    result.pregameRowsDroppedNoOddsNoPlays,
    1,
    'projection-only NHL prop rows without odds should count as dropped pregame rows',
  );
}

{
  const row = buildRow();
  const playsMap = new Map([
    [
      row.game_id,
      [
        buildPlay({
          status: 'WATCH',
          action: 'HOLD',
          execution_status: 'EXECUTABLE',
          price: -110,
        }),
      ],
    ],
  ]);
  const result = prepareGamesServiceRows({
    rows: [row],
    lifecycleMode: 'pregame',
    playsMap,
  });

  assert.equal(
    result.responseRows.length,
    1,
    'bettable NHL prop rows should remain eligible for pregame surfacing',
  );
}

{
  const row = buildRow({
    ingest_failure_reason_code: 'ODDS_PROVIDER_TIMEOUT',
  });
  const playsMap = new Map([[row.game_id, [buildPlay()]]]);
  const result = prepareGamesServiceRows({
    rows: [row],
    lifecycleMode: 'pregame',
    playsMap,
  });

  assert.equal(
    result.responseRows.length,
    1,
    'ingest-failure rows should stay visible even when only projection-only props exist',
  );
}

{
  const row = buildRow();
  const playsMap = new Map([
    [
      row.game_id,
      [
        buildPlay({
          cardType: 'nhl-moneyline-call',
          market_type: 'INFO',
          execution_status: 'EXECUTABLE',
          status: 'WATCH',
          action: 'HOLD',
        }),
      ],
    ],
  ]);
  const result = prepareGamesServiceRows({
    rows: [row],
    lifecycleMode: 'pregame',
    playsMap,
  });

  assert.equal(
    result.responseRows.length,
    0,
    'INFO-only rows should not satisfy /api/games coverage',
  );
}

{
  const row = buildRow();
  const playsMap = new Map([
    [
      row.game_id,
      [
        buildPlay({
          cardType: 'nhl-goalie',
          market_type: 'MONEYLINE',
          execution_status: 'EXECUTABLE',
          status: 'WATCH',
          action: 'HOLD',
        }),
      ],
    ],
  ]);
  const result = prepareGamesServiceRows({
    rows: [row],
    lifecycleMode: 'pregame',
    playsMap,
  });

  assert.equal(
    result.responseRows.length,
    0,
    'evidence-only or unsupported rows should not satisfy /api/games coverage',
  );
}

{
  const row = buildRow({
    sport: 'MLB',
  });
  const playsMap = new Map([
    [
      row.game_id,
      [
        buildPlay({
          cardType: 'mlb-f5',
          market_type: 'FIRST_5_INNINGS',
          execution_status: 'EXECUTABLE',
          status: 'WATCH',
          action: 'HOLD',
          selection: { side: 'OVER' },
          line: 4.5,
        }),
      ],
    ],
  ]);
  const result = prepareGamesServiceRows({
    rows: [row],
    lifecycleMode: 'pregame',
    playsMap,
  });

  assert.equal(
    result.responseRows.length,
    0,
    'MLB F5-only rows should not count as main-surface coverage',
  );
}

{
  const row = buildRow({
    sport: 'MLB',
  });
  const playsMap = new Map([
    [
      row.game_id,
      [
        buildPlay({
          cardType: 'mlb-full-game',
          market_type: 'TOTAL',
          execution_status: 'EXECUTABLE',
          status: 'WATCH',
          action: 'HOLD',
          selection: { side: 'OVER' },
          line: 8.5,
        }),
      ],
    ],
  ]);
  const result = prepareGamesServiceRows({
    rows: [row],
    lifecycleMode: 'pregame',
    playsMap,
  });

  assert.equal(
    result.responseRows.length,
    1,
    'supported full-game rows should continue to satisfy /api/games coverage',
  );
}

{
  const row = buildRow({
    sport: 'MLB',
  });
  const playsMap = new Map([
    [
      row.game_id,
      [
        buildPlay({
          cardType: 'mlb-model-output',
          market_type: 'INFO',
          execution_status: 'EXECUTABLE',
          status: 'WATCH',
          action: 'HOLD',
          kind: 'EVIDENCE',
        }),
        buildPlay({
          cardType: 'mlb-full-game-ml',
          market_type: 'MONEYLINE',
          execution_status: 'EXECUTABLE',
          status: 'WATCH',
          action: 'HOLD',
          prediction: 'HOME',
          selection: { side: 'HOME', team: 'Colorado Avalanche' },
          price: -120,
        }),
      ],
    ],
  ]);
  const result = prepareGamesServiceRows({
    rows: [row],
    lifecycleMode: 'pregame',
    playsMap,
  });

  assert.equal(
    result.responseRows.length,
    1,
    'mixed diagnostic and valid rows should stay covered via the valid main-surface row',
  );
  assert.equal(
    result.pregameRowsDroppedNoOddsNoPlays,
    0,
    'mixed diagnostic and valid rows should not be counted as uncovered',
  );
}

console.log('✅ games service-layer tests passed');
