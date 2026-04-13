'use strict';

const { __private } = require('../settle_pending_cards');

function buildMockDb() {
  const state = {
    closedIds: new Set(),
    updateAttempts: [],
  };

  return {
    prepare(sql) {
      const normalized = String(sql || '');

      if (normalized.includes('FROM card_results cr') && normalized.includes('WHERE cr.status = \'pending\'')) {
        return {
          all() {
            return [
              {
                result_id: 'result-closeable',
                card_id: 'card-closeable',
                game_id: 'game-a',
                card_type: 'nba-moneyline',
                market_key: 'game-a:moneyline',
                metadata: JSON.stringify({}),
                payload_data: JSON.stringify({
                  kind: 'PLAY',
                  decision_v2: { official_status: 'PASS' },
                }),
              },
              {
                result_id: 'result-live-truth',
                card_id: 'card-live-truth',
                game_id: 'game-b',
                card_type: 'nba-moneyline',
                market_key: 'game-b:moneyline',
                metadata: JSON.stringify({}),
                payload_data: JSON.stringify({
                  kind: 'PLAY',
                  decision_v2: { official_status: 'PASS' },
                }),
              },
            ];
          },
        };
      }

      if (normalized.includes('SELECT COUNT(*) AS count')) {
        return {
          get() {
            return { count: state.closedIds.size };
          },
        };
      }

      if (normalized.includes('UPDATE card_results') && normalized.includes("WHERE id = ? AND status = 'pending'")) {
        return {
          run(_settledAt, _metadata, resultId) {
            state.updateAttempts.push(String(resultId));
            // Simulate one row that can still transition from pending and one row
            // that already reflects live truth and must not be rewritten.
            if (String(resultId) === 'result-live-truth') {
              return { changes: 0 };
            }
            state.closedIds.add(String(resultId));
            return { changes: 1 };
          },
        };
      }

      if (normalized.includes("SELECT id FROM card_results WHERE status = 'error' AND result = 'void'")) {
        return {
          all() {
            return Array.from(state.closedIds).map((id) => ({ id }));
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

describe('negative-path settlement live-truth invariants', () => {
  test('auto-close flow does not rewrite rows that no longer satisfy pending guard', () => {
    const db = buildMockDb();
    const settledAt = '2026-04-12T12:00:00.000Z';

    const result = __private.autoCloseNonActionableFinalPendingRows(db, settledAt);

    expect(result.closed).toBe(1);
    expect(result.failures).toBe(1);
    expect(result.reasonCounts.NON_ACTIONABLE_FINAL_PASS).toBe(2);
    expect(db.__state.updateAttempts).toEqual([
      'result-closeable',
      'result-live-truth',
    ]);
    expect(result.closedResultIds.has('result-closeable')).toBe(true);
    expect(result.closedResultIds.has('result-live-truth')).toBe(false);
  });
});
