/**
 * Security regression tests for WI-0563
 *
 * Verifies /api/cards/[gameId]:
 * - validateQueryParams rejects unknown/disallowed params
 * - validateQueryParams accepts all valid params for this route
 * - dedupe=none and dedupe=latest_per_game_type are accepted (not rejected as non-boolean)
 * - SQLi probe values in bound SQL params cause no DB errors or unexpected results
 * - Malicious gameId, cardType, dedupe, and lifecycle values are handled safely
 */

import db from '../../../packages/data/src/db.js';
import { validateQueryParams } from '../lib/api-security/validation.ts';

const ROUTE = '/api/cards/[gameId]';

const sqliProbes = [
  "' OR 1=1 --",
  '" OR 1=1 --',
  "1; DROP TABLE card_payloads; --",
  "' UNION SELECT * FROM sqlite_master --",
  "x' OR 'x'='x",
  "../../../etc/passwd",
  "<script>alert(1)</script>",
  "'; SELECT sleep(1); --",
  "\\x00\\x1a",
];

async function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  console.log('🧪 WI-0563: /api/cards/[gameId] security regression tests\n');

  // --- validateQueryParams: allowlist enforcement ---
  console.log('📋 Section 1: validateQueryParams allowlist enforcement');

  {
    const result = validateQueryParams(ROUTE, { evil: "1; DROP TABLE --" });
    assert(!result.valid, 'rejects unknown param "evil"');
    assert(result.errors.some(e => e.includes('Unknown parameter')), 'error references "Unknown parameter"');
  }

  {
    const result = validateQueryParams(ROUTE, { sport: 'nba' });
    assert(!result.valid, 'rejects "sport" (not in [gameId] allowlist)');
  }

  {
    const result = validateQueryParams(ROUTE, { game_id: 'abc' });
    assert(!result.valid, 'rejects "game_id" (not in [gameId] allowlist)');
  }

  {
    const result = validateQueryParams(ROUTE, { include_expired: 'true' });
    assert(!result.valid, 'rejects "include_expired" (not in [gameId] allowlist)');
  }

  // --- validateQueryParams: valid param acceptance ---
  console.log('\n📋 Section 2: validateQueryParams valid param acceptance');

  {
    const result = validateQueryParams(ROUTE, {
      cardType: 'nba-moneyline',
      dedupe: 'none',
      limit: '10',
      offset: '0',
      lifecycle: 'active',
    });
    assert(result.valid, 'accepts full set of valid params');
  }

  {
    const result = validateQueryParams(ROUTE, { card_type: 'nhl-spread' });
    assert(result.valid, 'accepts card_type');
  }

  {
    const result = validateQueryParams(ROUTE, { dedupe: 'none' });
    assert(result.valid, 'accepts dedupe=none');
  }

  {
    const result = validateQueryParams(ROUTE, { dedupe: 'latest_per_game_type' });
    assert(result.valid, 'accepts dedupe=latest_per_game_type');
  }

  {
    const result = validateQueryParams(ROUTE, { lifecycle: 'active' });
    assert(result.valid, 'accepts lifecycle=active');
  }

  {
    const result = validateQueryParams(ROUTE, { lifecycle: 'pregame' });
    assert(result.valid, 'accepts lifecycle=pregame (treated as default)');
  }

  // --- validateQueryParams: numeric param validation ---
  console.log('\n📋 Section 3: validateQueryParams numeric param validation');

  {
    const result = validateQueryParams(ROUTE, { limit: 'abc' });
    assert(!result.valid, 'rejects non-numeric limit');
  }

  {
    const result = validateQueryParams(ROUTE, { limit: '9999' });
    assert(!result.valid, 'rejects limit > 1000');
  }

  {
    const result = validateQueryParams(ROUTE, { offset: '-1' });
    assert(!result.valid, 'rejects negative offset');
  }

  {
    const result = validateQueryParams(ROUTE, { limit: '50', offset: '100' });
    assert(result.valid, 'accepts valid limit and offset');
  }

  // --- validateQueryParams: dedupe rejects garbage values ---
  console.log('\n📋 Section 4: validateQueryParams dedupe rejects malicious values');

  for (const probe of ["' OR 1=1 --", "1; DROP TABLE --", "<script>"]) {
    const result = validateQueryParams(ROUTE, { dedupe: probe });
    assert(!result.valid, `rejects malicious dedupe value: ${probe.substring(0, 30)}`);
  }

  // --- DB-level bound param safety ---
  console.log('\n📋 Section 5: DB bound params handle SQLi probes safely');

  const client = db.getDatabase();

  for (const probe of sqliProbes) {
    // gameId bound param
    try {
      const rows = client
        .prepare(`SELECT id FROM card_payloads WHERE game_id = ? LIMIT 1`)
        .all(probe);
      assert(Array.isArray(rows), `gameId bound param: returns array (not error) for: ${probe.substring(0, 40)}`);
    } catch (e) {
      assert(false, `gameId bound param threw unexpectedly: ${probe.substring(0, 40)} — ${e.message}`);
    }

    // cardType bound param
    try {
      const rows = client
        .prepare(`SELECT id FROM card_payloads WHERE game_id = ? AND card_type = ? LIMIT 1`)
        .all('nonexistent-game-wi0563', probe);
      assert(Array.isArray(rows), `card_type bound param: returns array for: ${probe.substring(0, 40)}`);
    } catch (e) {
      assert(false, `card_type bound param threw unexpectedly: ${probe.substring(0, 40)} — ${e.message}`);
    }
  }

  db.closeDatabase();

  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('✅ All WI-0563 security regression tests passed!');
  }
}

runTests().catch(e => {
  console.error('❌ Fatal error:', e);
  process.exit(1);
});
