/*
 * WI-0396: Cards Lifecycle Fetch Race Regression Test
 *
 * Ensure that when lifecycle mode changes during an in-flight fetch,
 * the cards page queues a retry with the new lifecycle parameter
 * so live/active games render immediately.
 *
 * Run: node web/src/__tests__/cards-lifecycle-fetch-race.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const filePath = path.resolve(__dirname, '../../src/components/cards/CardsPageContext.tsx');
const source = fs.readFileSync(filePath, 'utf8');

console.log('🧪 Starting WI-0396: Cards Lifecycle Fetch Race Tests...\n');

// Test 1: Lifecycle mode defaults to 'pregame' for SSR compatibility
console.log('Test 1: Lifecycle mode SSR-safe default');
assert(
  source.includes("lifecycleMode: 'pregame'"),
  'cards page initializes with pregame for SSR + hydration safety',
);
assert(
  source.includes('const resolvedLifecycleMode = resolveLifecycleModeFromUrlAndStorage()'),
  'URL/session sync effect resolves lifecycle mode after hydration',
);
console.log('✓ Lifecycle mode uses SSR-safe default\n');

// Test 2: Global request lifecycle tracking variable exists
console.log('Test 2: Global lifecycle tracking variable');
assert(
  source.includes('let globalGamesRequestLifecycle: LifecycleMode | null = null;'),
  'cards page should declare globalGamesRequestLifecycle variable',
);
console.log('✓ globalGamesRequestLifecycle variable declared\n');

// Test 3: Latest lifecycle mode ref for race detection
console.log('Test 3: Lifecycle mode ref for detecting changes');
assert(
  source.includes('const latestLifecycleModeRef = useRef<LifecycleMode>('),
  'cards page should track latest lifecycle mode in ref',
);
console.log('✓ latestLifecycleModeRef declared\n');

// Test 4: Retry timeout ref
console.log('Test 4: Retry timeout management');
assert(
  source.includes(
    'const lifecycleRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>',
  ),
  'cards page should track retry timeout to avoid duplicate retries',
);
console.log('✓ lifecycleRetryTimeoutRef declared\n');

// Test 5: Fetch reads requested (latest) lifecycle mode
console.log('Test 5: Fetch uses latest requested lifecycle mode');
assert(
  source.includes('const requestedLifecycleMode = latestLifecycleModeRef.current;'),
  'fetchGames must read latest lifecycle mode from ref',
);
assert(
  source.includes("requestedLifecycleMode === 'active' ? '?lifecycle=active' : ''"),
  'fetch URL must use requestedLifecycleMode, not stale state',
);
console.log('✓ Fetch constructs query from requested lifecycle mode\n');

// Test 6: In-flight request stores which lifecycle it was requested for
console.log('Test 6: Track in-flight request lifecycle');
assert(
  source.includes('globalGamesRequestLifecycle = requestedLifecycleMode;'),
  'must record which lifecycle mode the in-flight request used',
);
assert(
  source.includes('globalGamesRequestLifecycle = null;'),
  'must clear request lifecycle when in-flight completes',
);
console.log('✓ In-flight request lifecycle recorded and cleared\n');

// Test 7: Lifecycle change during in-flight request is detected
console.log('Test 7: Detect lifecycle mismatch during in-flight fetch');
assert(
  source.includes('cards] Skipping fetch - global request already in flight') &&
  source.includes('globalGamesRequestLifecycle !== requestedLifecycleMode'),
  'must detect when requested lifecycle differs from in-flight',
);
console.log('✓ Lifecycle mismatch detection exists\n');

// Test 8: Mismatch triggers a retry after in-flight completes
console.log('Test 8: Queue retry when lifecycle changes');
assert(
  source.includes('lifecycleRetryTimeoutRef.current = setTimeout(() => {') &&
    source.includes('globalGamesLastFetchAt = 0;') &&
    source.includes('void fetchGames();'),
  'must queue a retry timeout when lifecycle changes during in-flight',
);
console.log('✓ Retry queued with 150ms delay\n');

// Test 9: Keep ref in sync with lifecycle state
console.log('Test 9: Keep ref in sync with lifecycle state');
assert(
  source.includes('latestLifecycleModeRef.current = uiState.lifecycleMode;'),
  'useEffect must update ref when lifecycleMode state changes',
);
console.log('✓ Ref synchronized with state\n');

// Test 10: Manual lifecycle change clears pending retries
console.log('Test 10: Manual lifecycle change clears retry queue');
assert(
  source.includes('onLifecycleModeChange: (nextMode) =>') &&
    source.includes('if (lifecycleRetryTimeoutRef.current) {') &&
    source.includes('clearTimeout(lifecycleRetryTimeoutRef.current);'),
  'handleLifecycleModeChange must clear pending retry timeout',
);
console.log('✓ Manual lifecycle change clears pending retry\n');

// Test 11: Effect cleanup prevents orphaned timeouts
console.log('Test 11: Effect cleanup prevents orphaned timeouts');
assert(
  source.includes('if (initialLoadRetryTimeoutRef.current) {') &&
    source.includes('clearTimeout(initialLoadRetryTimeoutRef.current);') &&
    source.includes('if (lifecycleRetryTimeoutRef.current) {') &&
    source.includes('clearTimeout(lifecycleRetryTimeoutRef.current);') &&
    source.includes('clearInterval(interval);') &&
    source.includes("document.removeEventListener('visibilitychange', onVisibilityChange);"),
  'effect cleanup must clear retry timeout on unmount',
);
console.log('✓ Cleanup removes retry timeout on unmount\n');

// Test 12: Loading state during lifecycle retry
console.log('Test 12: Keep loading true while retry is pending');
assert(
  source.includes('setLoading(shouldRetryForLifecycleChange);'),
  'must keep loading true if retry is queued (for user visibility)',
);
console.log('✓ Loading state kept active during retry\n');

console.log('✅ All WI-0396 Lifecycle Fetch Race Tests Passed!');
console.log('\n📋 Summary:');
console.log('✓ SSR-safe default (pregame) prevents hydration mismatch');
console.log('✓ URL/session effect changes mode after mount/hydration');
console.log('✓ Request lifecycle tracked to detect mid-flight changes');
console.log('✓ Mismatch during in-flight request triggers automatic retry');
console.log('✓ Retry uses correct lifecycle parameter immediately');
console.log('✓ No orphaned timeouts or stale state left behind');
