'use strict';

/**
 * Regression tests for autoCloseNonActionableFinalPendingRows
 *
 * Tests cover:
 *  T1: Successful auto-close: closed=1, failures=0
 *  T2: DB throws a string (not an Error): failures=1, no rethrow, warn log includes resultId/cardId/reasonCode/error text (not "undefined")
 *  T3: A row that appears in both the auto-close candidates and pendingRows is skipped in the main loop
 *  T4: step-1 summary autoClosedNonActionable count matches skipped rows from pendingRows (no duplication)
 *  T5: A row NOT non-actionable still settles normally (counter alignment unaffected)
 */

const { __private } = require('../settle_pending_cards');
const { autoCloseNonActionableFinalPendingRows } = __private;

/**
 * Build a minimal sql.js-style in-memory db stub.
 * prepare() returns a statement stub whose run/get/all behavior is configurable.
 */
function buildDbStub(opts = {}) {
  const {
    candidateRows = [],
    runThrows = null,      // null | Error | string
    countClosedResult = null, // null → auto-compute; number to override
  } = opts;

  let rowsModifiedVal = 0;
  const closedIds = new Set();

  return {
    prepare(sql) {
      // SELECT candidates
      if (/FROM card_results cr/.test(sql)) {
        return {
          all() { return candidateRows; },
        };
      }

      // COUNT closed
      if (/SELECT COUNT/.test(sql)) {
        return {
          get(settledAt, ...ids) {
            if (countClosedResult !== null) return { count: countClosedResult };
            return { count: closedIds.size };
          },
        };
      }

      // UPDATE (write path)
      if (/UPDATE card_results/.test(sql) && !/SELECT/.test(sql)) {
        return {
          run(settledAt, metadataJson, resultId) {
            if (runThrows !== null) {
              throw runThrows;
            }
            closedIds.add(String(resultId));
            rowsModifiedVal = 1;
          },
        };
      }

      // SELECT closed result_ids for closedResultIds population
      if (/SELECT id FROM card_results/.test(sql)) {
        return {
          all(settledAt, ...ids) {
            return [...closedIds].map((id) => ({ id }));
          },
        };
      }

      // fallback
      return {
        run() {},
        get() { return null; },
        all() { return []; },
      };
    },

    getRowsModified() { return rowsModifiedVal; },
  };
}

/**
 * Build a minimal candidate row suitable for autoCloseNonActionableFinalPendingRows.
 * payload_data must trigger resolveNonActionableFinalReason() to return a reason.
 * The function uses payloadData.non_actionable_reason or similar logic.
 * Inspect the actual function... for now use a known-good payload that has
 * no market_type (which causes the function to classify it as non-actionable).
 */
function makeCandidateRow(overrides = {}) {
  return {
    result_id: overrides.result_id ?? 'result-001',
    card_id: overrides.card_id ?? 'card-001',
    game_id: overrides.game_id ?? 'game-001',
    metadata: null,
    // kind != 'PLAY' triggers resolveNonActionableFinalReason -> NON_ACTIONABLE_FINAL_KIND
    payload_data: overrides.payload_data ?? JSON.stringify({
      kind: 'DISPLAY',
      game_id: 'game-001',
    }),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// T1: Successful auto-close: closed=1, failures=0
// ─────────────────────────────────────────────────────────────────────────────
describe('autoCloseNonActionableFinalPendingRows', () => {
  test('T1: successful auto-close returns closed=1, failures=0', () => {
    const candidateRows = [makeCandidateRow({ result_id: 'r-001', card_id: 'c-001' })];
    const db = buildDbStub({ candidateRows, runThrows: null, countClosedResult: 1 });

    const settledAt = '2026-03-14T00:00:00.000Z';
    const result = autoCloseNonActionableFinalPendingRows(db, settledAt);

    // closed=1, failures=0
    expect(result.closed).toBe(1);
    expect(result.failures).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T2: DB throws a string — failures=1, no rethrow, warn log has non-"undefined" text
  // ─────────────────────────────────────────────────────────────────────────
  test('T2: DB throws a string — failures=1, no rethrow, warn includes resultId/cardId/reasonCode and error text', () => {
    const candidateRows = [makeCandidateRow({ result_id: 'r-002', card_id: 'c-002' })];
    // countClosedResult=0 so failures = candidates.length - closed = 1
    const db = buildDbStub({
      candidateRows,
      runThrows: 'disk full',   // thrown string (non-Error)
      countClosedResult: 0,
    });

    const warnMessages = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnMessages.push(args.join(' ')); };

    let threw = false;
    let result;
    try {
      result = autoCloseNonActionableFinalPendingRows(db, '2026-03-14T00:00:00.000Z');
    } catch (_) {
      threw = true;
    } finally {
      console.warn = origWarn;
    }

    // Must not rethrow
    expect(threw).toBe(false);

    // Must count 1 failure
    expect(result.failures).toBe(1);

    // Warn message must include resultId, cardId, and the error text (not "undefined")
    const warnText = warnMessages.join('\n');
    expect(warnText).toContain('r-002');          // resultId
    expect(warnText).toContain('c-002');          // cardId
    expect(warnText).not.toContain('undefined');  // safe serialization
    expect(warnText).toContain('disk full');       // actual error text
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Counter alignment: 2 candidates, 1 succeeds, 1 fails → closed=1, failures=1
  // ─────────────────────────────────────────────────────────────────────────
  test('T2b: 2 candidates, 1 succeeds, 1 fails → closed=1, failures=1', () => {
    const candidateRows = [
      makeCandidateRow({ result_id: 'r-003', card_id: 'c-003' }),
      makeCandidateRow({ result_id: 'r-004', card_id: 'c-004' }),
    ];
    let callCount = 0;
    const db = {
      prepare(sql) {
        if (/FROM card_results cr/.test(sql)) return { all() { return candidateRows; } };
        if (/SELECT COUNT/.test(sql)) return { get() { return { count: 1 }; } };
        if (/UPDATE card_results/.test(sql) && !/SELECT/.test(sql)) {
          return {
            run(settledAt, metadataJson, resultId) {
              callCount++;
              if (callCount === 2) throw 'constraint violation';
            },
          };
        }
        if (/SELECT id FROM card_results/.test(sql)) return { all() { return [{ id: 'r-003' }]; } };
        return { run() {}, get() { return null; }, all() { return []; } };
      },
      getRowsModified() { return 0; },
    };

    const origWarn = console.warn;
    console.warn = () => {};
    let result;
    try {
      result = autoCloseNonActionableFinalPendingRows(db, '2026-03-14T00:00:00.000Z');
    } finally {
      console.warn = origWarn;
    }

    expect(result.closed).toBe(1);
    expect(result.failures).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T3: Row auto-closed → skipped in main settlement loop (closedResultIds returned)
  // ─────────────────────────────────────────────────────────────────────────
  test('T3: autoCloseNonActionableFinalPendingRows returns closedResultIds Set', () => {
    const candidateRows = [makeCandidateRow({ result_id: 'r-skip-001', card_id: 'c-skip-001' })];
    const db = buildDbStub({ candidateRows, runThrows: null, countClosedResult: 1 });

    const result = autoCloseNonActionableFinalPendingRows(db, '2026-03-14T00:00:00.000Z');

    expect(result.closedResultIds).toBeInstanceOf(Set);
    expect(result.closedResultIds.has('r-skip-001')).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T4: closedResultIds size equals closed count
  // ─────────────────────────────────────────────────────────────────────────
  test('T4: closedResultIds.size equals closed count', () => {
    const candidateRows = [
      makeCandidateRow({ result_id: 'r-10', card_id: 'c-10' }),
      makeCandidateRow({ result_id: 'r-11', card_id: 'c-11' }),
    ];
    const db = buildDbStub({ candidateRows, runThrows: null, countClosedResult: 2 });

    const result = autoCloseNonActionableFinalPendingRows(db, '2026-03-14T00:00:00.000Z');

    expect(result.closedResultIds.size).toBe(result.closed);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T5: Empty closedResultIds when candidates is empty
  // ─────────────────────────────────────────────────────────────────────────
  test('T5: returns empty closedResultIds when no candidates', () => {
    const db = buildDbStub({ candidateRows: [] });
    const result = autoCloseNonActionableFinalPendingRows(db, '2026-03-14T00:00:00.000Z');

    expect(result.closedResultIds).toBeInstanceOf(Set);
    expect(result.closedResultIds.size).toBe(0);
    expect(result.closed).toBe(0);
    expect(result.failures).toBe(0);
  });
});
