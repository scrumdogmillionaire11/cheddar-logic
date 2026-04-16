import assert from 'node:assert';

import { applyFilters, DEFAULT_GAME_FILTERS } from '../lib/game-card/filters';
import { transformToGameCard } from '../lib/game-card/transform/index';

type OfficialStatus = 'PLAY' | 'LEAN' | 'PASS';
type ExecutionStatus = 'EXECUTABLE' | 'BLOCKED' | 'PROJECTION_ONLY';

function buildMoneylineGame(params: {
  sport: 'MLB' | 'NHL';
  officialStatus: OfficialStatus;
  executionStatus: ExecutionStatus;
}) {
  const play = {
    cardType: params.sport === 'NHL' ? 'nhl-moneyline-call' : 'mlb-full-game-ml',
    cardTitle: 'Model moneyline',
    prediction: 'HOME' as const,
    confidence: 0.72,
    tier: 'BEST' as const,
    reasoning: 'Moneyline edge.',
    evPassed: true,
    driverKey: `driver-${params.sport}-${params.executionStatus}`,
    edge: 0.06,
    model_prob: 0.56,
    market_type: 'MONEYLINE' as const,
    selection: { side: 'HOME' as const, team: 'Home Team' },
    kind: 'PLAY' as const,
    price: -110,
    status: 'WATCH' as const,
    classification: 'LEAN' as const,
    action: 'HOLD' as const,
    execution_status: params.executionStatus,
    pass_reason_code:
      params.executionStatus === 'BLOCKED'
        ? 'PASS_EXECUTION_GATE_BLOCKED'
        : params.executionStatus === 'PROJECTION_ONLY'
          ? 'PASS_PROJECTION_ONLY'
          : null,
    created_at: '2026-04-11T14:00:00.000Z',
    decision_v2: {
      official_status: params.officialStatus,
      direction: 'HOME' as const,
      fair_prob: 0.56,
      implied_prob: 0.52,
      edge_pct: 0.06,
      edge_delta_pct: 0.06,
      play_tier: 'OK' as const,
      support_score: 0.67,
      conflict_score: 0.12,
      drivers_used: ['projection'],
      driver_reasons: ['edge'],
      primary_reason_code: 'EDGE_CLEAR',
      watchdog_status: 'OK' as const,
      watchdog_reason_codes: [],
      sharp_price_status: 'CHEDDAR' as const,
      price_reason_codes: [],
      missing_data: { missing_fields: [], source_attempts: [], severity: 'INFO' as const },
      consistency: {
        pace_tier: 'NORMAL',
        event_env: 'NORMAL',
        event_direction_tag: 'NEUTRAL',
        vol_env: 'NORMAL',
        total_bias: 'OK',
      },
      pricing_trace: { line_source: 'odds_snapshot', price_source: 'odds_snapshot' },
      pipeline_version: 'v2' as const,
      decided_at: '2026-04-11T14:00:00.000Z',
    },
  };

  return {
    id: `game-${params.sport}-${params.executionStatus}`,
    gameId: `game-${params.sport}-${params.executionStatus}`,
    sport: params.sport,
    homeTeam: 'Home Team',
    awayTeam: 'Away Team',
    gameTimeUtc: '2026-04-11T19:00:00.000Z',
    status: 'scheduled',
    createdAt: '2026-04-11T14:00:00.000Z',
    odds: {
      h2hHome: -120,
      h2hAway: 105,
      total: 8.5,
      spreadHome: -1.5,
      spreadAway: 1.5,
      spreadPriceHome: -110,
      spreadPriceAway: -110,
      totalPriceOver: -110,
      totalPriceUnder: -110,
      capturedAt: '2026-04-11T14:05:00.000Z',
    },
    plays: [play],
    true_play: play,
  };
}

for (const sport of ['MLB', 'NHL'] as const) {
  const executableCard = transformToGameCard(
    buildMoneylineGame({ sport, officialStatus: 'LEAN', executionStatus: 'EXECUTABLE' }) as never,
  );
  assert.strictEqual(executableCard.play?.execution_status, 'EXECUTABLE');
  assert.strictEqual(executableCard.play?.action, 'HOLD');
  assert.strictEqual(applyFilters([executableCard], DEFAULT_GAME_FILTERS, 'game').length, 1);

  for (const blockedStatus of ['BLOCKED', 'PROJECTION_ONLY'] as const) {
    const blockedCard = transformToGameCard(
      buildMoneylineGame({ sport, officialStatus: 'LEAN', executionStatus: blockedStatus }) as never,
    );
    assert.strictEqual(blockedCard.play?.execution_status, blockedStatus);
    assert.strictEqual(blockedCard.play?.action, 'PASS');
    assert.strictEqual(applyFilters([blockedCard], DEFAULT_GAME_FILTERS, 'game').length, 0);

    const fullSlate = {
      ...DEFAULT_GAME_FILTERS,
      statuses: ['FIRE', 'WATCH', 'PASS'],
    };
    assert.strictEqual(
      applyFilters([blockedCard], fullSlate as typeof DEFAULT_GAME_FILTERS, 'game').length,
      1,
    );
  }
}

console.log('Game card decision authority tests passed');
