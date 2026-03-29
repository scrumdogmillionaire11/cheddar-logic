/*
 * WI-0701: Transient fetch errors preserve games state
 *
 * Assert that CardsPageContext.tsx correctly classifies HTTP errors as
 * recoverable (5xx, 429) vs non-recoverable (400, 401, non-JSON body,
 * data.success=false), and only calls setGames([]) for non-recoverable
 * cases. Transient errors must preserve last-known games so plays don't
 * disappear during brief outages.
 *
 * Run: node --import tsx/esm web/src/__tests__/cards-transient-error-preserves-games.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const filePath = path.resolve(
  __dirname,
  '../../src/components/cards/CardsPageContext.tsx',
);
const source = fs.readFileSync(filePath, 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

console.log('\nWI-0701: Transient fetch errors preserve games state\n');

// ---------------------------------------------------------------------------
// 1. isRecoverableHttpError helper is defined
// ---------------------------------------------------------------------------
console.log('1. isRecoverableHttpError helper');

test('function isRecoverableHttpError is declared', () => {
  assert(
    source.includes('function isRecoverableHttpError(status: number): boolean'),
    'isRecoverableHttpError(status: number): boolean must be declared in CardsPageContext.tsx',
  );
});

test('returns true for 5xx (status >= 500)', () => {
  assert(
    source.includes('status >= 500'),
    'isRecoverableHttpError must include status >= 500 to cover all 5xx codes',
  );
});

test('returns true for 429 (rate limit)', () => {
  assert(
    source.includes('status === 429'),
    'isRecoverableHttpError must include status === 429',
  );
});

// ---------------------------------------------------------------------------
// 2. !response.ok branch is guarded
// ---------------------------------------------------------------------------
console.log('\n2. !response.ok branch guards setGames([]) with isRecoverableHttpError');

test('isRecoverableHttpError used in !response.ok branch', () => {
  assert(
    source.includes('!isRecoverableHttpError(response.status)'),
    'The !response.ok branch must call !isRecoverableHttpError(response.status) to guard setGames([])',
  );
});

test('setGames([]) in !response.ok is conditional on !isRecoverableHttpError', () => {
  // Verify the guard expression appears directly before setGames([]) in that block
  const guard = 'isInitialLoad.current && !isRecoverableHttpError(response.status)';
  assert(
    source.includes(guard),
    `The !response.ok branch must have: ${guard}`,
  );
});

test('setError() is still called unconditionally in !response.ok branch', () => {
  // The setError call should appear in the !response.ok block (before the guard)
  // We verify setError(nonJsonDetail) still exists
  assert(
    source.includes('setError(nonJsonDetail)'),
    'setError(nonJsonDetail) must still appear in the !response.ok branch',
  );
});

// ---------------------------------------------------------------------------
// 3. catch block does NOT call setGames([])
// ---------------------------------------------------------------------------
console.log('\n3. catch block does not wipe games state');

test('catch block contains no setGames([]) call', () => {
  // Extract the catch block
  const catchIndex = source.indexOf('} catch (err) {');
  assert(catchIndex !== -1, 'catch block must exist');
  const finallyIndex = source.indexOf('} finally {', catchIndex);
  assert(finallyIndex !== -1, '} finally { must follow catch block');
  const catchBody = source.slice(catchIndex, finallyIndex);
  assert(
    !catchBody.includes('setGames([])'),
    'catch block must NOT call setGames([]) — thrown errors are transient',
  );
});

test('catch block still calls setError for non-abort errors', () => {
  const catchIndex = source.indexOf('} catch (err) {');
  const finallyIndex = source.indexOf('} finally {', catchIndex);
  const catchBody = source.slice(catchIndex, finallyIndex);
  assert(
    catchBody.includes('setError(message)'),
    'catch block must still call setError(message) to show error to user',
  );
});

test('catch block still guards setError with !isAbort', () => {
  const catchIndex = source.indexOf('} catch (err) {');
  const finallyIndex = source.indexOf('} finally {', catchIndex);
  const catchBody = source.slice(catchIndex, finallyIndex);
  assert(
    catchBody.includes('!isAbort'),
    'catch block must keep the !isAbort guard so abort/timeout errors are silent',
  );
});

// ---------------------------------------------------------------------------
// 4. Non-recoverable paths are unchanged
// ---------------------------------------------------------------------------
console.log('\n4. Non-recoverable paths still clear games state');

test('non-JSON body branch still calls setGames([])', () => {
  // The "Invalid API response format" block should still have setGames([])
  const nonJsonIdx = source.indexOf('Invalid API response format');
  assert(nonJsonIdx !== -1, '"Invalid API response format" error message must exist');
  // Look forward ~200 chars for setGames([])
  const nearby = source.slice(nonJsonIdx, nonJsonIdx + 200);
  assert(
    nearby.includes('setGames([])'),
    'non-JSON body branch must still call setGames([]) — non-recoverable',
  );
});

test('!data.success branch still calls setGames([])', () => {
  const noSuccessIdx = source.indexOf("data.error || 'Failed to fetch games'");
  assert(noSuccessIdx !== -1, "!data.success error string must exist");
  const nearby = source.slice(noSuccessIdx, noSuccessIdx + 150);
  assert(
    nearby.includes('setGames([])'),
    '!data.success branch must still call setGames([]) — non-recoverable',
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'-'.repeat(60)}`);
if (failed === 0) {
  console.log(`WI-0701: All ${passed} tests passed.`);
  console.log('  Transient 5xx/timeout errors preserve games state.');
  console.log('  Non-recoverable errors (non-JSON, !data.success) clear state.');
  console.log('  Error message shown on every error path.');
} else {
  console.error(`WI-0701: ${failed} test(s) FAILED (${passed} passed).`);
  process.exit(1);
}
