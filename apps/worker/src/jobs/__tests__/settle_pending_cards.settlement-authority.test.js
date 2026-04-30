'use strict';

jest.mock('@cheddar-logic/data', () => ({
  buildMarketKey: jest.fn(
    ({ gameId, marketType, selection, line, period }) =>
      `${gameId}:${marketType}:${selection}:${line ?? 'null'}:${period}`,
  ),
  createMarketError: jest.fn((code, message, details = {}) => {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }),
  recomputeTrackingStats: jest.fn(() => ({ rows: 0 })),
  insertProjectionAudit: jest.fn(),
  getDatabase: jest.fn(),
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  normalizeMarketType: jest.fn((value) =>
    value == null ? '' : String(value).trim().toUpperCase(),
  ),
  normalizeSelectionForMarket: jest.fn(({ selection }) =>
    selection == null ? '' : String(selection).trim().toUpperCase(),
  ),
  parseLine: jest.fn((value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }),
  recordClvEntry: jest.fn(),
  settleClvEntry: jest.fn(),
  hasSuccessfulJobRun: jest.fn(() => true),
  shouldRunJobKey: jest.fn(() => true),
  withDb: jest.fn(async (fn) => fn()),
}));

jest.mock('../../utils/db-backup.js', () => ({
  backupDatabase: jest.fn(),
}));

jest.mock('../check_pipeline_health', () => ({
  writePipelineHealth: jest.fn(),
}));

const data = require('@cheddar-logic/data');
const { settlePendingCards, __private } = require('../settle_pending_cards');

function createSettlementDb({ cardResults, cardPayloads, cardDisplayLog, gameResults }) {
  const state = {
    cardResults: new Map(cardResults.map((row) => [row.id, { ...row }])),
    cardPayloads: new Map(cardPayloads.map((row) => [row.id, { ...row }])),
    cardDisplayLog: new Map(cardDisplayLog.map((row) => [row.pick_id, { ...row }])),
    gameResults: new Map(gameResults.map((row) => [row.game_id, { ...row }])),
    settleWrites: [],
    voidWrites: [],
  };

  const getPayload = (cardId) => state.cardPayloads.get(cardId) || null;
  const getDisplay = (cardId) => state.cardDisplayLog.get(cardId) || null;
  const getGame = (gameId) => state.gameResults.get(gameId) || null;

  const allCards = () => Array.from(state.cardResults.values());
  const displayedPendingFinalCards = () =>
    allCards().filter((row) => {
      const game = getGame(row.game_id);
      return row.status === 'pending' && game?.status === 'final' && getDisplay(row.card_id);
    });

  const buildPendingSettlementRow = (row) => {
    const payload = getPayload(row.card_id);
    const display = getDisplay(row.card_id);
    const game = getGame(row.game_id);
    return {
      result_id: row.id,
      card_id: row.card_id,
      game_id: row.game_id,
      sport: row.sport,
      card_type: row.card_type,
      market_key: row.market_key,
      market_type: row.market_type,
      selection: row.selection,
      line: row.line,
      locked_price: row.locked_price,
      metadata: row.metadata,
      pick_id: display?.pick_id || null,
      displayed_at: display?.displayed_at || null,
      api_endpoint: display?.api_endpoint || null,
      payload_data: payload?.payload_data || null,
      actual_result: payload?.actual_result || null,
      first_seen_price: payload?.first_seen_price ?? null,
      final_score_home: game?.final_score_home ?? null,
      final_score_away: game?.final_score_away ?? null,
      game_result_metadata: game?.metadata || null,
    };
  };

  const coverageCounts = () => {
    const cards = allCards();
    const displays = Array.from(state.cardDisplayLog.values());

    const totalPending = cards.filter((row) => row.status === 'pending').length;
    const eligiblePendingFinalDisplayed = cards.filter((row) => {
      const game = getGame(row.game_id);
      return (
        row.status === 'pending' &&
        row.market_key !== null &&
        row.market_key !== undefined &&
        game?.status === 'final' &&
        Boolean(getDisplay(row.card_id))
      );
    }).length;
    const settledDisplayedFinal = cards.filter((row) => {
      const game = getGame(row.game_id);
      return (
        row.status === 'settled' &&
        game?.status === 'final' &&
        Boolean(getDisplay(row.card_id))
      );
    }).length;
    const displayedFinal = displays.filter((row) => {
      const game = getGame(row.game_id);
      return game?.status === 'final';
    }).length;
    const finalDisplayedMissingResults = displays.filter((row) => {
      const game = getGame(row.game_id);
      const card = allCards().find((entry) => entry.card_id === row.pick_id);
      return game?.status === 'final' && !card;
    }).length;
    const finalDisplayedUnsettled = displays.filter((row) => {
      const game = getGame(row.game_id);
      const card = allCards().find((entry) => entry.card_id === row.pick_id);
      return game?.status === 'final' && (!card || card.status !== 'settled');
    }).length;
    const pendingWithFinalNoDisplay = cards.filter((row) => {
      const game = getGame(row.game_id);
      return (
        row.status === 'pending' &&
        row.market_key !== null &&
        row.market_key !== undefined &&
        game?.status === 'final' &&
        !getDisplay(row.card_id)
      );
    }).length;
    const pendingWithFinalMissingMarketKey = cards.filter((row) => {
      const game = getGame(row.game_id);
      return row.status === 'pending' && game?.status === 'final' && !row.market_key;
    }).length;
    const pendingDisplayedWithoutFinal = cards.filter((row) => {
      const game = getGame(row.game_id);
      return row.status === 'pending' && Boolean(getDisplay(row.card_id)) && game?.status !== 'final';
    }).length;

    return {
      totalPending,
      eligiblePendingFinalDisplayed,
      settledDisplayedFinal,
      displayedFinal,
      finalDisplayedMissingResults,
      finalDisplayedUnsettled,
      pendingWithFinalNoDisplay,
      pendingWithFinalMissingMarketKey,
      pendingDisplayedWithoutFinal,
    };
  };

  return {
    prepare(sql) {
      const normalized = String(sql || '');

      if (normalized.includes('PRAGMA table_info(card_payloads)')) {
        return {
          all() {
            return [{ name: 'actual_result' }];
          },
        };
      }

      if (
        normalized.includes('SELECT name FROM sqlite_master') &&
        normalized.includes("name = 'clv_ledger'")
      ) {
        return {
          get() {
            return null;
          },
        };
      }

      if (
        normalized.includes('FROM card_results cr') &&
        normalized.includes('cp.created_at AS card_created_at')
      ) {
        return {
          all() {
            return [];
          },
        };
      }

      if (
        normalized.includes('FROM card_results cr') &&
        normalized.includes('INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id') &&
        normalized.includes('ORDER BY cdl.displayed_at DESC')
      ) {
        return {
          all() {
            return displayedPendingFinalCards().map((row) => {
              const payload = getPayload(row.card_id);
              const display = getDisplay(row.card_id);
              return {
                result_id: row.id,
                card_id: row.card_id,
                game_id: row.game_id,
                sport: row.sport,
                card_type: row.card_type,
                metadata: row.metadata,
                market_key: row.market_key,
                payload_data: payload?.payload_data || null,
                displayed_at: display?.displayed_at || null,
                created_at: payload?.created_at || null,
              };
            });
          },
        };
      }

      if (
        normalized.includes('SELECT COUNT(*) AS count') &&
        normalized.includes("status = 'error'") &&
        normalized.includes("result = 'void'") &&
        normalized.includes('id IN (')
      ) {
        return {
          get(settledAt, ...ids) {
            const count = ids.filter((id) => {
              const row = state.cardResults.get(String(id));
              return (
                row?.status === 'error' &&
                row?.result === 'void' &&
                row?.settled_at === settledAt
              );
            }).length;
            return { count };
          },
        };
      }

      if (
        normalized.includes("SELECT id FROM card_results WHERE status = 'error' AND result = 'void'")
      ) {
        return {
          all(settledAt, ...ids) {
            return ids
              .map((id) => state.cardResults.get(String(id)))
              .filter(
                (row) =>
                  row?.status === 'error' &&
                  row?.result === 'void' &&
                  row?.settled_at === settledAt,
              )
              .map((row) => ({ id: row.id }));
          },
        };
      }

      if (
        normalized.includes('UPDATE card_results') &&
        normalized.includes("SET status = 'error', result = 'void'")
      ) {
        return {
          run(settledAt, metadataJson, resultId) {
            const row = state.cardResults.get(String(resultId));
            if (!row || row.status !== 'pending') return { changes: 0 };
            row.status = 'error';
            row.result = 'void';
            row.settled_at = settledAt;
            row.metadata = metadataJson;
            state.voidWrites.push(String(resultId));
            return { changes: 1 };
          },
        };
      }

      if (
        normalized.includes('FROM card_results cr') &&
        normalized.includes('LEFT JOIN card_display_log cdl ON cr.card_id = cdl.pick_id') &&
        normalized.includes('gr.final_score_home')
      ) {
        return {
          all() {
            expect(normalized).not.toContain(
              "LOWER(COALESCE(cr.card_type, cp.card_type, '')) = 'mlb-pitcher-k'",
            );
            return displayedPendingFinalCards().map(buildPendingSettlementRow);
          },
        };
      }

      if (
        normalized.includes('UPDATE card_results') &&
        normalized.includes("SET status = 'settled'")
      ) {
        return {
          run(
            result,
            settledAt,
            pnlUnits,
            sharpPriceStatus,
            primaryReasonCode,
            edgePct,
            metadataJson,
            resultId,
          ) {
            const row = state.cardResults.get(String(resultId));
            if (!row || row.status !== 'pending') return { changes: 0 };
            row.status = 'settled';
            row.result = result;
            row.settled_at = settledAt;
            row.pnl_units = pnlUnits;
            row.sharp_price_status = sharpPriceStatus;
            row.primary_reason_code = primaryReasonCode;
            row.edge_pct = edgePct;
            row.metadata = metadataJson;
            state.settleWrites.push(String(resultId));
            return { changes: 1 };
          },
        };
      }

      if (
        normalized.includes('SELECT status, result, settled_at') &&
        normalized.includes('FROM card_results')
      ) {
        return {
          get(resultId) {
            const row = state.cardResults.get(String(resultId));
            return row
              ? {
                  status: row.status,
                  result: row.result,
                  settled_at: row.settled_at,
                }
              : null;
          },
        };
      }

      if (
        normalized.includes('SELECT id, sport, market_type, card_type, metadata, result, pnl_units')
      ) {
        return {
          all(jobStartTime) {
            return allCards()
              .filter(
                (row) =>
                  row.status === 'settled' &&
                  row.settled_at &&
                  row.settled_at >= jobStartTime,
              )
              .map((row) => ({
                id: row.id,
                sport: row.sport,
                market_type: row.market_type,
                card_type: row.card_type,
                metadata: row.metadata,
                result: row.result,
                pnl_units: row.pnl_units,
                sharp_price_status: row.sharp_price_status ?? null,
                selection: row.selection,
                locked_price: row.locked_price,
                settled_at: row.settled_at,
              }));
          },
        };
      }

      if (normalized.includes('FROM clv_ledger clv')) {
        return {
          all() {
            return [];
          },
        };
      }

      if (normalized.includes('SELECT *') && normalized.includes('FROM odds_snapshots')) {
        return {
          get() {
            return null;
          },
        };
      }

      if (
        normalized.includes('SELECT COUNT(*) AS count') &&
        normalized.includes('FROM card_results cr') &&
        normalized.includes('LEFT JOIN card_display_log cdl ON cdl.pick_id = cr.card_id') &&
        normalized.includes("WHERE cr.status = 'pending'") &&
        !normalized.includes('INNER JOIN game_results gr') &&
        !normalized.includes('gr.game_id IS NULL')
      ) {
        return {
          get() {
            return { count: coverageCounts().totalPending };
          },
        };
      }

      if (
        normalized.includes('SELECT COUNT(*) AS count') &&
        normalized.includes('FROM card_results cr') &&
        normalized.includes('INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id') &&
        normalized.includes("AND cr.market_key IS NOT NULL") &&
        normalized.includes("AND gr.status = 'final'")
      ) {
        return {
          get() {
            return { count: coverageCounts().eligiblePendingFinalDisplayed };
          },
        };
      }

      if (
        normalized.includes('SELECT COUNT(*) AS count') &&
        normalized.includes('FROM card_results cr') &&
        normalized.includes("WHERE cr.status = 'settled'") &&
        normalized.includes("AND gr.status = 'final'")
      ) {
        return {
          get() {
            return { count: coverageCounts().settledDisplayedFinal };
          },
        };
      }

      if (
        normalized.includes('SELECT COUNT(*) AS count') &&
        normalized.includes('FROM card_display_log cdl') &&
        normalized.includes('INNER JOIN game_results gr ON gr.game_id = cdl.game_id') &&
        !normalized.includes('LEFT JOIN card_results cr')
      ) {
        return {
          get() {
            return { count: coverageCounts().displayedFinal };
          },
        };
      }

      if (
        normalized.includes('SELECT COUNT(*) AS count') &&
        normalized.includes('FROM card_display_log cdl') &&
        normalized.includes('LEFT JOIN card_results cr ON cr.card_id = cdl.pick_id') &&
        normalized.includes('WHERE cr.id IS NULL')
      ) {
        return {
          get() {
            return { count: coverageCounts().finalDisplayedMissingResults };
          },
        };
      }

      if (
        normalized.includes('SELECT COUNT(*) AS count') &&
        normalized.includes('FROM card_display_log cdl') &&
        normalized.includes('LEFT JOIN card_results cr ON cr.card_id = cdl.pick_id') &&
        normalized.includes("AND (cr.id IS NULL OR cr.status != 'settled')")
      ) {
        return {
          get() {
            return { count: coverageCounts().finalDisplayedUnsettled };
          },
        };
      }

      if (
        normalized.includes('SELECT COUNT(*) AS count') &&
        normalized.includes('FROM card_results cr') &&
        normalized.includes('LEFT JOIN card_display_log cdl ON cdl.pick_id = cr.card_id') &&
        normalized.includes('AND cdl.pick_id IS NULL')
      ) {
        return {
          get() {
            return { count: coverageCounts().pendingWithFinalNoDisplay };
          },
        };
      }

      if (
        normalized.includes('SELECT COUNT(*) AS count') &&
        normalized.includes('FROM card_results cr') &&
        normalized.includes('LEFT JOIN card_display_log cdl ON cdl.pick_id = cr.card_id') &&
        normalized.includes('AND cr.market_key IS NULL') &&
        normalized.includes("AND gr.status = 'final'")
      ) {
        return {
          get() {
            return { count: coverageCounts().pendingWithFinalMissingMarketKey };
          },
        };
      }

      if (
        normalized.includes('SELECT COUNT(*) AS count') &&
        normalized.includes('FROM card_results cr') &&
        normalized.includes('INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id') &&
        normalized.includes('gr.game_id IS NULL')
      ) {
        return {
          get() {
            return { count: coverageCounts().pendingDisplayedWithoutFinal };
          },
        };
      }

      return {
        all() {
          return [];
        },
        get() {
          return null;
        },
        run() {
          return { changes: 0 };
        },
      };
    },
    __state: state,
  };
}

describe('settle_pending_cards settlement authority', () => {
  let logSpy;
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('strict mode exposes no unsurfaced settlement exemptions', () => {
    expect(__private.SETTLEMENT_DISPLAY_EXEMPT_CARD_TYPES).toEqual([]);
    expect(__private.isDisplayExemptSettlementCardType('mlb-pitcher-k')).toBe(false);
  });

  test('settles displayed rows and leaves unsurfaced mlb-pitcher-k rows pending', async () => {
    const db = createSettlementDb({
      cardResults: [
        {
          id: 'result-displayed',
          card_id: 'card-displayed',
          game_id: 'game-1',
          sport: 'NBA',
          card_type: 'nba-moneyline',
          market_key: 'game-1:MONEYLINE:HOME:null:FULL_GAME',
          market_type: 'MONEYLINE',
          selection: 'HOME',
          line: null,
          locked_price: -110,
          metadata: '{}',
          status: 'pending',
          result: null,
          settled_at: null,
        },
        {
          id: 'result-unsurfaced-pk',
          card_id: 'card-unsurfaced-pk',
          game_id: 'game-2',
          sport: 'MLB',
          card_type: 'mlb-pitcher-k',
          market_key: null,
          market_type: 'PROP',
          selection: 'OVER',
          line: 6.5,
          locked_price: -118,
          metadata: '{}',
          status: 'pending',
          result: null,
          settled_at: null,
        },
      ],
      cardPayloads: [
        {
          id: 'card-displayed',
          created_at: '2026-04-29T11:55:00.000Z',
          payload_data: JSON.stringify({
            home_team: 'Home Team',
            away_team: 'Away Team',
            decision_v2: { official_status: 'PLAY' },
          }),
          actual_result: null,
          first_seen_price: -110,
        },
        {
          id: 'card-unsurfaced-pk',
          created_at: '2026-04-29T11:56:00.000Z',
          payload_data: JSON.stringify({
            basis: 'ODDS_BACKED',
            player_id: '123',
            player_name: 'Pitcher Example',
            selection: { side: 'OVER' },
            line: 6.5,
            price: -118,
            prop_type: 'strikeouts',
            decision_v2: { official_status: 'PLAY' },
          }),
          actual_result: JSON.stringify({ pitcher_ks: 8 }),
          first_seen_price: -118,
        },
      ],
      cardDisplayLog: [
        {
          pick_id: 'card-displayed',
          game_id: 'game-1',
          displayed_at: '2026-04-29T12:00:00.000Z',
          api_endpoint: '/api/games',
        },
      ],
      gameResults: [
        {
          game_id: 'game-1',
          status: 'final',
          final_score_home: 101,
          final_score_away: 95,
          metadata: '{}',
        },
        {
          game_id: 'game-2',
          status: 'final',
          final_score_home: 4,
          final_score_away: 2,
          metadata: '{}',
        },
      ],
    });

    data.getDatabase.mockReturnValue(db);

    const result = await settlePendingCards({ dryRun: false });

    expect(result.success).toBe(true);
    expect(result.cardsSettled).toBe(1);
    expect(result.coverage.eligible).toBe(1);
    expect(result.coverage.blockedReasons.missingMarketKey).toBe(1);
    expect(db.__state.cardResults.get('result-displayed')).toMatchObject({
      status: 'settled',
      result: 'win',
    });
    expect(db.__state.cardResults.get('result-unsurfaced-pk')).toMatchObject({
      status: 'pending',
      result: null,
      settled_at: null,
    });
    expect(db.__state.settleWrites).toEqual(['result-displayed']);
    expect(db.__state.voidWrites).toEqual([]);
  });

  test('auto-closes superseded displayed duplicates before a second settlement write', async () => {
    const db = createSettlementDb({
      cardResults: [
        {
          id: 'result-old',
          card_id: 'card-old',
          game_id: 'game-dup',
          sport: 'NBA',
          card_type: 'nba-moneyline',
          market_key: 'game-dup:MONEYLINE:HOME:null:FULL_GAME',
          market_type: 'MONEYLINE',
          selection: 'HOME',
          line: null,
          locked_price: -110,
          metadata: '{}',
          status: 'pending',
          result: null,
          settled_at: null,
        },
        {
          id: 'result-new',
          card_id: 'card-new',
          game_id: 'game-dup',
          sport: 'NBA',
          card_type: 'nba-moneyline',
          market_key: 'game-dup:MONEYLINE:HOME:null:FULL_GAME',
          market_type: 'MONEYLINE',
          selection: 'HOME',
          line: null,
          locked_price: -112,
          metadata: '{}',
          status: 'pending',
          result: null,
          settled_at: null,
        },
      ],
      cardPayloads: [
        {
          id: 'card-old',
          created_at: '2026-04-29T11:55:00.000Z',
          payload_data: JSON.stringify({
            home_team: 'Home Team',
            away_team: 'Away Team',
            decision_v2: { official_status: 'PLAY' },
            confidence_pct: 54,
          }),
          actual_result: null,
          first_seen_price: -110,
        },
        {
          id: 'card-new',
          created_at: '2026-04-29T11:58:00.000Z',
          payload_data: JSON.stringify({
            home_team: 'Home Team',
            away_team: 'Away Team',
            decision_v2: { official_status: 'PLAY' },
            confidence_pct: 57,
          }),
          actual_result: null,
          first_seen_price: -112,
        },
      ],
      cardDisplayLog: [
        {
          pick_id: 'card-old',
          game_id: 'game-dup',
          displayed_at: '2026-04-29T11:57:00.000Z',
          api_endpoint: '/api/games',
        },
        {
          pick_id: 'card-new',
          game_id: 'game-dup',
          displayed_at: '2026-04-29T12:00:00.000Z',
          api_endpoint: '/api/games',
        },
      ],
      gameResults: [
        {
          game_id: 'game-dup',
          status: 'final',
          final_score_home: 108,
          final_score_away: 101,
          metadata: '{}',
        },
      ],
    });

    data.getDatabase.mockReturnValue(db);

    const result = await settlePendingCards({ dryRun: false });

    expect(result.success).toBe(true);
    expect(result.cardsSettled).toBe(1);
    expect(result.coverage.duplicateAutoClosedFinal).toBe(1);
    expect(db.__state.cardResults.get('result-new')).toMatchObject({
      status: 'settled',
      result: 'win',
    });
    expect(db.__state.cardResults.get('result-old')).toMatchObject({
      status: 'error',
      result: 'void',
    });
    expect(db.__state.settleWrites).toEqual(['result-new']);
    expect(db.__state.voidWrites).toEqual(['result-old']);
  });
});
