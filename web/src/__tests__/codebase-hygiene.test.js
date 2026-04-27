/*
 * WI-1154: Codebase Hygiene Test (Test 6)
 *
 * Verifies that no hardcoded hour offsets (36h, 24h, 48h) appear in scoped files
 * as horizon/window computations. All horizon logic must use the ET-boundary contract.
 *
 * Run: node web/src/__tests__/codebase-hygiene.test.js
 */

import fs from 'node:fs';
import path from 'node:path';

const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

console.log('🧪 WI-1154: Codebase Hygiene Tests\n');

// Files to scan (relative to web/ directory, which is CWD when run correctly)
const SCOPED_FILES = [
  path.resolve(__dirname, '../lib/games/query-layer.ts'),
  path.resolve(__dirname, '../lib/games/route-handler.ts'),
  path.resolve(__dirname, '../../../apps/worker/src/jobs/run_mlb_model.js'),
];

// Forbidden patterns: hardcoded horizon/window hour offsets
// These indicate a fixed-offset rule instead of the ET-boundary contract.
const FORBIDDEN_PATTERNS = [
  // hour offset computations using literal 36, 24, or 48
  /\bplus\(\s*\{\s*hours\s*:\s*(36|24|48)\s*\}\s*\)/,          // luxon: .plus({ hours: 36 })
  /getTime\(\)\s*\+\s*(36|24|48)\s*\*\s*60\s*\*\s*60\s*\*\s*1000/, // JS: + 36 * 60 * 60 * 1000
  /getTime\(\)\s*-\s*(36|24|48)\s*\*\s*60\s*\*\s*60\s*\*\s*1000/, // JS: - 36 * 60 * 60 * 1000
  // Env var reads for horizon-overriding offsets (removed in WI-1154)
  /process\.env\.ACTIVE_GAMES_LOOKBACK_HOURS/,
  /process\.env\.API_GAMES_HORIZON_HOURS/,
];

// Whitelisted strings — these are OK even if they contain suspicious numbers
const WHITELIST = [
  'API_GAMES_INGEST_FAILURE_LOOKBACK_HOURS',  // 12h ingest failure window, unrelated to visibility
  'DEV_GAMES_FALLBACK_HOURS',                  // dev-only fallback for empty local DB
  'horizon-contract',                           // the contract reference itself
  'HORIZON_CONTRACT_VERSION',
  // Calendar arithmetic from ET midnight boundaries (not rolling offsets from now)
  'localMidnight.getTime()',
  // Test fixture values
  '2026-04-26 03:59:59',
  '2026-04-26 04:00:00',
];

let passed = 0;
let failed = 0;

function checkAssert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

for (const filePath of SCOPED_FILES) {
  const relPath = path.relative(path.resolve(__dirname, '../../..'), filePath);
  console.log(`Scanning: ${relPath}`);

  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch {
    console.error(`  ✗ File not found: ${filePath}`);
    failed++;
    continue;
  }

  const lines = source.split('\n');
  let fileClean = true;

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];

    // Skip whitelisted lines
    const isWhitelisted = WHITELIST.some(w => line.includes(w));
    if (isWhitelisted) continue;

    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(line)) {
        console.error(`  ✗ Forbidden pattern "${pattern}" found at line ${lineNo + 1}: ${line.trim()}`);
        fileClean = false;
        failed++;
      }
    }
  }

  if (fileClean) {
    checkAssert(true, `${relPath} — no forbidden hardcoded hour offsets`);
  }
  console.log();
}

// Additional structural checks
console.log('Structural contract checks:');

// query-layer.ts must reference ET-boundary logic
const queryLayerPath = path.resolve(__dirname, '../lib/games/query-layer.ts');
const queryLayerSource = fs.readFileSync(queryLayerPath, 'utf8');
checkAssert(
  queryLayerSource.includes('yesterdayUtc') && queryLayerSource.includes('gamesEndUtc'),
  'query-layer uses ET-boundary gamesEndUtc and yesterdayUtc for activeStartUtc',
);
checkAssert(
  !queryLayerSource.includes('shouldUseDevLookback') && !queryLayerSource.includes('lookbackUtc'),
  'query-layer: shouldUseDevLookback and lookbackUtc removed',
);

// route-handler.ts must not define horizon hour constants
const routeHandlerPath = path.resolve(__dirname, '../lib/games/route-handler.ts');
const routeHandlerSource = fs.readFileSync(routeHandlerPath, 'utf8');
checkAssert(
  !routeHandlerSource.includes('RAW_API_GAMES_HORIZON_HOURS') &&
    !routeHandlerSource.includes('HAS_API_GAMES_HORIZON') &&
    !routeHandlerSource.includes('API_GAMES_HORIZON_HOURS'),
  'route-handler: RAW_API_GAMES_HORIZON_HOURS / HAS_API_GAMES_HORIZON constants removed',
);
checkAssert(
  routeHandlerSource.includes('horizon_contract') && routeHandlerSource.includes('v1-et-boundary-aware'),
  'route-handler diagnostics reference horizon-contract version string',
);
checkAssert(
  routeHandlerSource.includes('emptyStateDiagnostics'),
  'route-handler emits empty_state diagnostics for active lifecycle',
);

// worker must use contract
const workerPath = path.resolve(__dirname, '../../../apps/worker/src/jobs/run_mlb_model.js');
const workerSource = fs.readFileSync(workerPath, 'utf8');
checkAssert(
  workerSource.includes('computeMLBHorizonEndUtc'),
  'worker imports and calls computeMLBHorizonEndUtc from @cheddar-logic/data',
);
checkAssert(
  !workerSource.includes("plus({ hours: 36 })"),
  'worker: hardcoded .plus({ hours: 36 }) removed from horizon computation',
);
console.log();

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\n❌ Codebase hygiene checks failed');
  process.exit(1);
} else {
  console.log('\n✅ All hygiene checks passed');
}
