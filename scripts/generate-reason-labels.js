#!/usr/bin/env node
// Generates web/src/lib/game-card/reason-labels.ts from the canonical
// REASON_CODE_LABELS map in packages/data/src/reason-codes.js.
//
// Run: node scripts/generate-reason-labels.js
// Wired into web build via "prebuild" npm script.

'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'packages/data/src/reason-codes.js');
const OUTPUT = path.join(ROOT, 'web/src/lib/game-card/reason-labels.ts');

const { REASON_CODE_LABELS } = require(SOURCE);

if (!REASON_CODE_LABELS || typeof REASON_CODE_LABELS !== 'object') {
  console.error('[generate-reason-labels] REASON_CODE_LABELS not found in', SOURCE);
  process.exit(1);
}

function escapeForTs(str) {
  return str.replace(/[\\]/g, '\\\\').replace(/'/g, "\\'").replace(/—/g, '\\u2014');
}

const entries = Object.entries(REASON_CODE_LABELS)
  .map(([code, label]) => `  ${code}: '${escapeForTs(label)}',`)
  .join('\n');

const output = `// AUTO-GENERATED — do not edit manually.
// Source: packages/data/src/reason-codes.js
// Regenerate: node scripts/generate-reason-labels.js
// Inlined here to avoid pulling the server-only @cheddar-logic/data package
// (which depends on better-sqlite3) into the client bundle.

export const REASON_CODE_LABELS: Record<string, string> = Object.freeze({
${entries}
});

export function getReasonCodeLabel(code?: string | null): string | null {
  if (!code) return null;
  const token = String(code)
    .trim()
    .toUpperCase()
    .replace(/[\\s-]+/g, '_');
  if (!token) return null;
  if (REASON_CODE_LABELS[token]) return REASON_CODE_LABELS[token];
  if (token.includes('GOALIE')) return 'Waiting on goalie confirmation';
  return null;
}
`;

fs.writeFileSync(OUTPUT, output, 'utf8');
console.log('[generate-reason-labels] Written to', path.relative(ROOT, OUTPUT));
