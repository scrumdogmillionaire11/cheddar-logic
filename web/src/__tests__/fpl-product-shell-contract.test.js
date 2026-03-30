/**
 * WI-0659: FPL Product Shell Contract Tests
 *
 * Verifies that:
 * 1. fpl-api.ts exports all required endpoint functions (existing + new)
 * 2. fpl-product-shell.tsx exists and contains all five sections
 * 3. fpl-page-client.tsx retains the existing weekly analysis flow
 * 4. fpl/page.tsx uses FPLProductShell as the root render
 *
 * These tests operate on source text so they run without a bundler or
 * Next.js runtime, making them fast and stable in CI.
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

// ─── 1. fpl-api.ts: required exports ─────────────────────────────────────────

console.log('\n[1] fpl-api.ts required exports');

const apiSrc = readSrc('lib/fpl-api.ts');

const REQUIRED_EXPORTS = [
  // Pre-existing weekly analysis functions
  'triggerAnalysis',
  'getAnalysisStatus',
  'getDashboardData',
  'getDetailedProjections',
  'pollForDashboard',
  'pollForDetailedProjections',
  // WI-0653: Profile endpoints
  'createProfile',
  'getProfile',
  'patchProfile',
  // WI-0654: Draft session endpoints
  'createDraftSession',
  'getDraftSession',
  'generateDraft',
  // WI-0655: Screenshot parse
  'parseScreenshot',
  // WI-0656: Draft audit & compare
  'auditDraft',
  'compareDrafts',
  // WI-0658: Decision receipts & memory
  'submitDecisionReceipt',
  'getUserAnalytics',
  'getUserMemory',
];

for (const fn of REQUIRED_EXPORTS) {
  const pattern = new RegExp(`export (async )?function ${fn}\\b`);
  check(pattern.test(apiSrc), `fpl-api exports: ${fn}`);
}

// ─── 2. fpl-api.ts: required interfaces ──────────────────────────────────────

console.log('\n[2] fpl-api.ts required interfaces');

const REQUIRED_INTERFACES = [
  // Pre-existing
  'AnalyzeRequest',
  'AnalyzeResponse',
  'DetailedAnalysisResponse',
  // New
  'OnboardingAnswers',
  'ManagerProfile',
  'ProfileCreateRequest',
  'ProfilePatchRequest',
  'DraftSession',
  'DraftSessionCreateRequest',
  'ParsedSlot',
  'ParsedSquad',
  'ScreenshotParseRequest',
  'ScreenshotParseResponse',
  'DraftAuditResponse',
  'CompareDraftsRequest',
  'CompareDraftsResponse',
  'DecisionReceiptRequest',
  'DecisionReceiptResponse',
  'UserAnalyticsResponse',
  'DecisionMemorySummary',
];

for (const iface of REQUIRED_INTERFACES) {
  check(
    new RegExp(`export interface ${iface}\\b`).test(apiSrc),
    `fpl-api interface: ${iface}`,
  );
}

// ─── 3. fpl-product-shell.tsx: exists and has all sections ───────────────────

console.log('\n[3] fpl-product-shell.tsx');

const shellPath = 'components/fpl-product-shell.tsx';
let shellSrc;
try {
  shellSrc = readSrc(shellPath);
  ok('fpl-product-shell.tsx exists');
} catch (e) {
  fail('fpl-product-shell.tsx exists', e.message);
  shellSrc = '';
}

check(
  /export default function FPLProductShell/.test(shellSrc),
  'shell exports FPLProductShell as default',
);

const REQUIRED_SECTIONS = [
  { label: 'onboarding', pattern: /onboarding/i },
  { label: 'build lab', pattern: /build/i },
  { label: 'screenshot/audit', pattern: /screenshot/i },
  { label: 'compare', pattern: /compare/i },
  { label: 'weekly', pattern: /weekly/i },
];

for (const { label, pattern } of REQUIRED_SECTIONS) {
  check(pattern.test(shellSrc), `shell contains section: ${label}`);
}

check(
  /FPLPageClient/.test(shellSrc),
  'shell uses FPLPageClient for weekly analysis',
);

check(
  /embedded/.test(shellSrc),
  'shell passes embedded prop to FPLPageClient',
);

// ─── 4. fpl-page-client.tsx: weekly flow preserved and supports embedded ─────

console.log('\n[4] fpl-page-client.tsx');

const clientSrc = readSrc('components/fpl-page-client.tsx');

check(
  /handleAnalysis|triggerAnalysis/.test(clientSrc),
  'fpl-page-client retains weekly analysis flow',
);

check(
  /embedded/.test(clientSrc),
  'fpl-page-client accepts embedded prop',
);

check(
  /pollForDetailedProjections/.test(clientSrc),
  'fpl-page-client uses pollForDetailedProjections',
);

check(
  /FPLDashboard/.test(clientSrc),
  'fpl-page-client renders FPLDashboard for results',
);

// ─── 5. fpl/page.tsx: uses FPLProductShell ───────────────────────────────────

console.log('\n[5] fpl/page.tsx');

const pageSrc = readSrc('app/fpl/page.tsx');

check(
  /FPLProductShell/.test(pageSrc),
  'fpl/page.tsx imports FPLProductShell',
);

check(
  /<FPLProductShell/.test(pageSrc),
  'fpl/page.tsx renders <FPLProductShell />',
);

check(
  !/FPLPageClient/.test(pageSrc),
  'fpl/page.tsx no longer directly renders FPLPageClient',
);

check(
  /closeDatabaseReadOnly/.test(pageSrc),
  'fpl/page.tsx retains closeDatabaseReadOnly teardown',
);

// ─── 6. Additive: no regressions on existing exports ─────────────────────────

console.log('\n[6] Non-regression checks');

// API base URL resolution strategy preserved
check(
  /FPL_API_BASE_URL/.test(apiSrc),
  'fpl-api.ts preserves FPL_API_BASE_URL routing strategy',
);

check(
  /NEXT_PUBLIC_FPL_API_DIRECT/.test(apiSrc),
  'fpl-api.ts preserves direct-API opt-in env var',
);

// extractErrorMessage still present (used by new functions)
check(
  /const extractErrorMessage/.test(apiSrc),
  'fpl-api.ts extractErrorMessage helper still present',
);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`${passed + failed} checks: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50));

if (failed > 0) {
  process.exit(1);
}
