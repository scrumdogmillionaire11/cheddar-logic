#!/usr/bin/env node
/**
 * Migration preflight — scans pending migrations for destructive SQL operations.
 *
 * Queries the migrations table to identify which files haven't run yet, then
 * flags any that contain DROP TABLE, DELETE FROM, RENAME, DROP COLUMN, or TRUNCATE.
 *
 * Exits 0 if all pending migrations are safe.
 * Exits 1 if destructive operations are found or setup fails.
 *
 * Usage: CHEDDAR_DB_PATH=/path/to.db node scripts/migration-preflight.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DESTRUCTIVE_PATTERNS = [
  { pattern: /\bDROP\s+TABLE\b(?!\s+IF\s+EXISTS\s+\w+_new\b)/i, label: 'DROP TABLE (non-temp)' },
  { pattern: /\bDROP\s+TABLE\s+IF\s+EXISTS\s+(?!\w+_new\b)/i,   label: 'DROP TABLE IF EXISTS (non-temp)' },
  { pattern: /\bDELETE\s+FROM\b/i,                               label: 'DELETE FROM' },
  { pattern: /\bALTER\s+TABLE\s+\w+\s+RENAME\s+TO\b/i,          label: 'RENAME TABLE' },
  { pattern: /\bALTER\s+TABLE\s+\w+\s+RENAME\s+COLUMN\b/i,      label: 'RENAME COLUMN' },
  { pattern: /\bDROP\s+COLUMN\b/i,                               label: 'DROP COLUMN' },
  { pattern: /\bTRUNCATE\b/i,                                    label: 'TRUNCATE' },
];

function getAppliedMigrations(dbPath) {
  try {
    const out = execSync(
      `sqlite3 "${dbPath}" "SELECT name FROM migrations ORDER BY name;"`,
      { encoding: 'utf8', timeout: 5000 },
    );
    return new Set(out.trim().split('\n').filter(Boolean));
  } catch (err) {
    const msg = (err.message || '').split('\n')[0];
    console.warn(`[preflight] warn: could not query migrations table (${msg}) — scanning all files`);
    return null;
  }
}

function resolveMigrationsDir() {
  const candidates = [
    process.env.CHEDDAR_MIGRATIONS_DIR,
    path.join(process.cwd(), 'packages', 'data', 'db', 'migrations'),
    path.join(__dirname, '..', 'packages', 'data', 'db', 'migrations'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(
    `Could not resolve migrations directory. Tried:\n${candidates.map(d => `  ${d}`).join('\n')}`,
  );
}

function findDestructiveOps(sql) {
  const findings = [];
  const lines = sql.split('\n');
  for (const { pattern, label } of DESTRUCTIVE_PATTERNS) {
    const lineIdx = lines.findIndex(l => pattern.test(l));
    if (lineIdx !== -1) {
      findings.push({ label, lineNo: lineIdx + 1, snippet: lines[lineIdx].trim() });
    }
  }
  return findings;
}

function main() {
  const dbPath = process.env.CHEDDAR_DB_PATH;
  if (!dbPath) {
    console.error('[preflight] ERROR: CHEDDAR_DB_PATH is not set');
    process.exit(1);
  }

  let migrationsDir;
  try {
    migrationsDir = resolveMigrationsDir();
  } catch (err) {
    console.error(`[preflight] ERROR: ${err.message}`);
    process.exit(1);
  }

  const applied = getAppliedMigrations(dbPath);
  const allFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const pending = applied ? allFiles.filter(f => !applied.has(f)) : allFiles;

  if (pending.length === 0) {
    console.log('[preflight] ✓ No pending migrations');
    process.exit(0);
  }

  console.log(`[preflight] Checking ${pending.length} pending migration(s) for destructive operations...`);

  let flagged = 0;
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const findings = findDestructiveOps(sql);
    if (findings.length > 0) {
      flagged++;
      console.error(`[preflight] DESTRUCTIVE: ${file}`);
      for (const { label, lineNo, snippet } of findings) {
        console.error(`  line ${lineNo}: [${label}] ${snippet}`);
      }
    } else {
      console.log(`[preflight] ok: ${file}`);
    }
  }

  if (flagged > 0) {
    console.error('');
    console.error(`[preflight] ✗ ${flagged} pending migration(s) contain destructive operations.`);
    console.error('[preflight]   Review the flagged files and confirm data loss is intentional.');
    console.error('[preflight]   To proceed anyway: set MIGRATION_PREFLIGHT_BYPASS=1 (not recommended).');
    if (process.env.MIGRATION_PREFLIGHT_BYPASS === '1') {
      console.warn('[preflight] ⚠ BYPASS active — proceeding despite destructive operations');
      process.exit(0);
    }
    process.exit(1);
  }

  console.log('[preflight] ✓ All pending migrations are forward-compatible');
  process.exit(0);
}

main();
