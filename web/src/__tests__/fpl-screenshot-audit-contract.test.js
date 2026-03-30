/**
 * WI-0660: FPL Screenshot Audit Contract Tests
 *
 * Verifies that:
 * 1. Screenshot uploader and parse review component files exist
 * 2. fpl-api.ts exports parseScreenshot
 * 3. fpl-parse-review.tsx contains the hard gate reference (unresolved_slots)
 * 4. fpl-parse-review.tsx exposes the onResolved callback prop
 * 5. fpl-screenshot-uploader.tsx contains base64 encoding step
 *
 * Source-text tests — no bundler or Next.js runtime required.
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

// ─── 1. Component files exist ─────────────────────────────────────────────────

console.log('\n[1] Screenshot audit component files');

const screenshotUploaderPath = 'components/fpl-screenshot-uploader.tsx';
const parseReviewPath = 'components/fpl-parse-review.tsx';

check(
  fs.existsSync(path.join(SRC, screenshotUploaderPath)),
  'fpl-screenshot-uploader.tsx exists',
);
check(
  fs.existsSync(path.join(SRC, parseReviewPath)),
  'fpl-parse-review.tsx exists',
);

// ─── 2. fpl-api.ts exports parseScreenshot ───────────────────────────────────

console.log('\n[2] fpl-api.ts parseScreenshot export');

let apiSrc;
try {
  apiSrc = readSrc('lib/fpl-api.ts');
} catch (e) {
  fail('fpl-api.ts readable', e.message);
  apiSrc = '';
}

check(
  /export (async )?function parseScreenshot\b/.test(apiSrc),
  'fpl-api exports: parseScreenshot',
);

// ─── 3. fpl-parse-review.tsx hard gate reference ─────────────────────────────

console.log('\n[3] fpl-parse-review.tsx hard gate');

let parseReviewSrc;
try {
  parseReviewSrc = readSrc(parseReviewPath);
} catch (e) {
  fail('fpl-parse-review.tsx readable', e.message);
  parseReviewSrc = '';
}

check(
  /unresolved_slots/.test(parseReviewSrc),
  'fpl-parse-review.tsx contains unresolved_slots (hard gate reference)',
);

check(
  /onResolved/.test(parseReviewSrc),
  'fpl-parse-review.tsx contains onResolved (callback prop)',
);

// ─── 4. fpl-screenshot-uploader.tsx base64 encoding ─────────────────────────

console.log('\n[4] fpl-screenshot-uploader.tsx base64 encoding');

let uploaderSrc;
try {
  uploaderSrc = readSrc(screenshotUploaderPath);
} catch (e) {
  fail('fpl-screenshot-uploader.tsx readable', e.message);
  uploaderSrc = '';
}

check(
  /base64/.test(uploaderSrc),
  'fpl-screenshot-uploader.tsx contains base64 (encoding step)',
);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`${passed + failed} checks: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50));

if (failed > 0) {
  process.exit(1);
}
