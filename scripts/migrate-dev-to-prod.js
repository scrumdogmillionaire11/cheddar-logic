#!/usr/bin/env node

/**
 * One-Time Database Migration Script
 * 
 * Migrates dev database to production:
 * 1. Backs up prod DB (safety measure)
 * 2. Copies all tables from dev → prod
 * 3. Validates migration integrity
 * 4. Shows migration summary
 * 
 * Usage: node scripts/migrate-dev-to-prod.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DEV_DB = path.resolve(__dirname, '..', 'packages/data/cheddar.db');
const PROD_DB = '/opt/cheddar-logic/packages/data/cheddar.db';
const PROD_BACKUP = `/opt/cheddar-logic/packages/data/cheddar-pre-migration-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

async function migrate() {
  console.log(`\n${BLUE}╔═════════════════════════════════════════════╗${RESET}`);
  console.log(`${BLUE}║   Database Migration: Dev → Prod            ║${RESET}`);
  console.log(`${BLUE}╚═════════════════════════════════════════════╝${RESET}\n`);

  try {
    // Step 1: Verify dev DB exists
    if (!fs.existsSync(DEV_DB)) {
      fail(`Dev DB not found: ${DEV_DB}`);
      process.exit(1);
    }
    ok(`Dev DB found: ${DEV_DB}`);

    // Step 2: Check if prod DB exists and back it up
    if (fs.existsSync(PROD_DB)) {
      console.log(`\n${YELLOW}Backing up existing prod DB...${RESET}`);
      try {
        execSync(`cp "${PROD_DB}" "${PROD_BACKUP}"`);
        ok(`Backed up to: ${PROD_BACKUP}`);
      } catch (e) {
        fail(`Could not back up prod DB: ${e.message}`);
        process.exit(1);
      }
    } else {
      warn(`Prod DB does not exist (will be created)`);
    }

    // Step 3: Check prod directory exists
    const prodDir = path.dirname(PROD_DB);
    if (!fs.existsSync(prodDir)) {
      console.log(`Creating prod directory: ${prodDir}`);
      execSync(`mkdir -p "${prodDir}"`);
    }

    // Step 4: Copy dev DB to prod
    console.log(`\n${YELLOW}Copying dev DB to prod...${RESET}`);
    execSync(`cp "${DEV_DB}" "${PROD_DB}"`);
    ok(`Copied dev DB to prod`);

    // Step 5: Verify prod DB is readable
    try {
      execSync(`sqlite3 "${PROD_DB}" "SELECT COUNT(*) FROM sqlite_master;" >/dev/null 2>&1`);
      ok(`Prod DB is readable`);
    } catch (e) {
      fail(`Prod DB copy is corrupted: ${e.message}`);
      process.exit(1);
    }

    // Step 6: Get migration summary
    console.log(`\n${YELLOW}Validating migration...${RESET}`);
    await showMigrationSummary();

    console.log(`\n${GREEN}✓ Migration complete!${RESET}\n`);
    console.log(`${BLUE}Next steps:${RESET}`);
    console.log(`  1. Verify prod data: sqlite3 "${PROD_DB}" "SELECT COUNT(*) FROM games;"`);
    console.log(`  2. Run settlement pipeline: cd /opt/cheddar-logic && npm run job:backfill-card-results`);
    console.log(`  3. Check results: npm run deployment:verify\n`);

  } catch (e) {
    fail(`Migration failed: ${e.message}`);
    process.exit(1);
  }
}

async function showMigrationSummary() {
  const tables = [
    'games',
    'odds_snapshots',
    'card_payloads',
    'card_results',
    'game_results',
    'tracking_stats',
    'job_runs'
  ];

  console.log(`\n${BLUE}Table Summary:${RESET}`);

  for (const table of tables) {
    try {
      const count = execSync(
        `sqlite3 "${PROD_DB}" "SELECT COUNT(*) FROM ${table};"`,
        { encoding: 'utf8' }
      ).trim();

      console.log(`  ${table.padEnd(20)} → ${count} rows`);
    } catch (e) {
      warn(`  ${table.padEnd(20)} → (table not found)`);
    }
  }

  // Show sample data
  console.log(`\n${BLUE}Sample Data:${RESET}`);
  try {
    const games = execSync(
      `sqlite3 "${PROD_DB}" "SELECT COUNT(DISTINCT sport) as sports, COUNT(*) as total FROM games;"`,
      { encoding: 'utf8' }
    ).trim();
    console.log(`  Games: ${games}`);
  } catch (e) {
    // ignore
  }

  try {
    const odds = execSync(
      `sqlite3 "${PROD_DB}" "SELECT COUNT(*) as snapshots FROM odds_snapshots;"`,
      { encoding: 'utf8' }
    ).trim();
    console.log(`  Odds Snapshots: ${odds}`);
  } catch (e) {
    // ignore
  }

  try {
    const cards = execSync(
      `sqlite3 "${PROD_DB}" "SELECT COUNT(*) as payloads FROM card_payloads;"`,
      { encoding: 'utf8' }
    ).trim();
    console.log(`  Card Payloads: ${cards}`);
  } catch (e) {
    // ignore
  }

  try {
    const stats = execSync(
      `sqlite3 "${PROD_DB}" "SELECT sport, wins, losses, pushes, pnl FROM tracking_stats ORDER BY sport;"`,
      { encoding: 'utf8' }
    ).trim();
    if (stats) {
      console.log(`\n${BLUE}Tracking Stats:${RESET}`);
      stats.split('\n').forEach(line => {
        if (line) console.log(`  ${line}`);
      });
    }
  } catch (e) {
    // ignore
  }
}

function ok(msg) {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}

function fail(msg) {
  console.error(`${RED}✗${RESET} ${msg}`);
}

function warn(msg) {
  console.warn(`${YELLOW}⚠${RESET} ${msg}`);
}

migrate().catch(console.error);
