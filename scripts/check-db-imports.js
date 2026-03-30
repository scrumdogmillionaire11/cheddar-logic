'use strict';

/**
 * check-db-imports.js
 *
 * Import boundary validator for packages/data/src/db/ domain modules.
 *
 * Enforces: files outside packages/data/ must NOT import non-public db modules
 * directly. The only public entry point is packages/data/src/db/index.js.
 *
 * Usage: node scripts/check-db-imports.js
 * Exits 0 if no violations found, exits 1 if violations detected.
 */

const fs = require('fs');
const path = require('path');

const NON_PUBLIC_MODULES = [
  'auth-store.js', 'cards.js', 'connection.js', 'games.js',
  'job-runs.js', 'models.js', 'odds.js', 'players.js',
  'quota.js', 'results.js', 'scheduler.js', 'tracking.js',
];

// Build the regex pattern from module names (strip .js for bare require variants)
const moduleNames = NON_PUBLIC_MODULES.map((m) => m.replace(/\.js$/, ''));
const pattern = new RegExp(
  `['"](\\.\\.\?/[^'"]*\\/db\\/(${moduleNames.join('|')}))(\\.js)?['"]`,
);

const REPO_ROOT = path.resolve(__dirname, '..');

// Directories to skip entirely
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next']);
// Directory that is permitted to import db modules internally
const PERMITTED_ROOT = path.join(REPO_ROOT, 'packages', 'data');

const SCAN_EXTENSIONS = new Set(['.js', '.ts', '.tsx', '.mjs']);

/**
 * Recursively collect files to scan under a directory.
 */
function collectFiles(dir, results = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // Skip packages/data/ — permitted consumers are internal
      if (fullPath === PERMITTED_ROOT || fullPath.startsWith(PERMITTED_ROOT + path.sep)) continue;
      collectFiles(fullPath, results);
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      results.push(fullPath);
    }
  }

  return results;
}

function main() {
  const files = collectFiles(REPO_ROOT);
  const violations = [];

  for (const filePath of files) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(pattern);
      if (match) {
        violations.push({
          file: path.relative(REPO_ROOT, filePath),
          lineNumber: i + 1,
          line: line.trim(),
          match: match[0],
        });
      }
    }
  }

  if (violations.length === 0) {
    console.log('check-db-import-boundaries: OK (0 violations)');
    process.exit(0);
  }

  for (const v of violations) {
    console.error(`VIOLATION  ${v.file}:${v.lineNumber}  ${v.match}`);
    console.error(`           ${v.line}`);
  }
  console.error(`\ncheck-db-import-boundaries: FAIL (${violations.length} violation(s))`);
  process.exit(1);
}

main();
