/**
 * FPL single-surface contract checks.
 *
 * Ensures /fpl remains the single canonical entrypoint and supports strict dev
 * env validation + query-param bootstrap behavior.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC = path.resolve(__dirname, '..');

function readSrc(relPath) {
  const full = path.join(SRC, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Required file missing: ${relPath}`);
  }
  return fs.readFileSync(full, 'utf8');
}

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, detail = '') {
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  failed++;
}

function check(condition, label, detail = '') {
  if (condition) {
    ok(label);
  } else {
    fail(label, detail);
  }
}

console.log('\n[1] /fpl route single-surface contract');
const pageSrc = readSrc('app/fpl/page.tsx');

check(/import FPLPageClient/.test(pageSrc), 'fpl/page imports FPLPageClient');
check(/<FPLPageClient/.test(pageSrc), 'fpl/page renders FPLPageClient');
check(!/FPLProductShell/.test(pageSrc), 'fpl/page has no FPLProductShell references');
check(/closeDatabaseReadOnly/.test(pageSrc), 'fpl/page keeps read-only DB teardown');

console.log('\n[2] FPL API strict env contract');
const apiSrc = readSrc('lib/fpl-api.ts');

check(
  /NEXT_PUBLIC_FPL_STRICT_ENV/.test(apiSrc),
  'strict env toggle exists (NEXT_PUBLIC_FPL_STRICT_ENV)',
);
check(
  /NEXT_PUBLIC_FPL_API_DIRECT/.test(apiSrc),
  'direct API opt-in exists (NEXT_PUBLIC_FPL_API_DIRECT)',
);
check(
  /NEXT_PUBLIC_FPL_API_URL/.test(apiSrc),
  'strict mode checks for NEXT_PUBLIC_FPL_API_URL',
);

console.log('\n[3] /fpl?team bootstrap contract');
const clientSrc = readSrc('components/fpl-page-client.tsx');

check(/searchParams\.get\('team'\)/.test(clientSrc), 'reads team query param on load');
check(/void handleAnalysis\(teamFromQuery\)/.test(clientSrc), 'auto-runs analysis from team query param');
check(/window\.history\.pushState/.test(clientSrc), 'persists team query param in URL after analyze');

console.log(`\n${'─'.repeat(50)}`);
console.log(`${passed + failed} checks: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50));

if (failed > 0) {
  process.exit(1);
}
