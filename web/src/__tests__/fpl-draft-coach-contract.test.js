/**
 * WI-0660: FPL Draft Coach Contract Tests
 *
 * Verifies that:
 * 1. All 5 core draft coach component files exist
 * 2. fpl-api.ts exports all required draft coach functions
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

console.log('\n[1] Draft coach component files');

const COMPONENT_FILES = [
  'components/fpl-onboarding.tsx',
  'components/fpl-draft-lab.tsx',
  'components/fpl-draft-candidate-card.tsx',
  'components/fpl-draft-audit.tsx',
  'components/fpl-draft-compare.tsx',
];

for (const file of COMPONENT_FILES) {
  const full = path.join(SRC, file);
  check(fs.existsSync(full), `${file} exists`);
}

// ─── 2. fpl-api.ts exports required draft coach functions ─────────────────────

console.log('\n[2] fpl-api.ts draft coach exports');

let apiSrc;
try {
  apiSrc = readSrc('lib/fpl-api.ts');
} catch (e) {
  fail('fpl-api.ts readable', e.message);
  apiSrc = '';
}

const REQUIRED_EXPORTS = [
  'createProfile',
  'createDraftSession',
  'generateDraft',
  'auditDraft',
  'compareDrafts',
];

for (const fn of REQUIRED_EXPORTS) {
  const pattern = new RegExp(`export (async )?function ${fn}\\b`);
  check(pattern.test(apiSrc), `fpl-api exports: ${fn}`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`${passed + failed} checks: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50));

if (failed > 0) {
  process.exit(1);
}
