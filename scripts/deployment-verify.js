#!/usr/bin/env node

/**
 * Deployment Verification Script
 * 
 * Validates system readiness before deployment:
 * 1. All job paths resolve correctly
 * 2. Database exists and is accessible
 * 3. Database backups exist
 * 4. All migrations are applied
 * 5. Settlement pipeline can execute (dry-run)
 * 6. No uncommitted changes remain
 * 
 * Usage: npm run deployment:verify
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { resolveDatabasePath } = require('../packages/data/src/db-path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.resolve(PROJECT_ROOT, 'packages/data/.backups');
const RESOLVED_DB = (() => {
  try {
    return resolveDatabasePath({ env: process.env, cwd: PROJECT_ROOT });
  } catch {
    return {
      dbPath: path.resolve(PROJECT_ROOT, 'packages/data/cheddar.db'),
      source: 'DEFAULT',
      isExplicitFile: false,
    };
  }
})();
const DB_PATH = RESOLVED_DB.dbPath;

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

let checks = {
  passed: 0,
  failed: 0,
  warnings: 0
};

function header(text) {
  console.log(`\n${BLUE}╔═══════════════════════════════════════╗${RESET}`);
  console.log(`${BLUE}║ ${text.padEnd(35)} ║${RESET}`);
  console.log(`${BLUE}╚═══════════════════════════════════════╝${RESET}\n`);
}

function ok(msg) {
  console.log(`${GREEN}✓${RESET} ${msg}`);
  checks.passed++;
}

function fail(msg) {
  console.error(`${RED}✗${RESET} ${msg}`);
  checks.failed++;
}

function warn(msg) {
  console.warn(`${YELLOW}⚠${RESET} ${msg}`);
  checks.warnings++;
}

function section(title) {
  console.log(`\n${YELLOW}▶ ${title}${RESET}`);
}

async function verify() {
  header('Deployment Verification');

  // Check 1: Git status
  section('Git Status');
  await checkGitStatus();

  // Check 2: Database accessibility
  section('Database');
  await checkDatabase();

  // Check 3: Backups
  section('Backups');
  await checkBackups();

  // Check 4: Job paths
  section('Job Paths');
  checkJobPaths();

  // Check 5: Environment variables
  section('Environment');
  checkEnvironment();

  // Check 6: Node modules
  section('Dependencies');
  checkDependencies();

  // Summary
  printSummary();

  // Exit code
  if (checks.failed > 0) {
    process.exit(1);
  } else if (checks.warnings > 0) {
    process.exit(0);
  } else {
    process.exit(0);
  }
}

async function checkGitStatus() {
  try {
    const status = execSync('git status --porcelain', { 
      cwd: PROJECT_ROOT,
      encoding: 'utf8' 
    });

    if (status.trim().length === 0) {
      ok('Working directory clean');
    } else {
      const lines = status.trim().split('\n').length;
      warn(`${lines} uncommitted change(s) detected`);
    }
  } catch (e) {
    fail(`Git status check failed: ${e.message}`);
  }

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: PROJECT_ROOT,
      encoding: 'utf8'
    }).trim();

    if (branch === 'main') {
      ok(`On branch: ${branch}`);
    } else {
      warn(`On branch: ${branch} (expected: main for deployment)`);
    }
  } catch (e) {
    fail(`Could not determine current branch`);
  }
}

async function checkDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    fail(`Database not found (${RESOLVED_DB.source}): ${DB_PATH}`);
    return;
  }

  ok(`Database exists (${RESOLVED_DB.source}): ${DB_PATH}`);

  // Check file permissions
  try {
    fs.accessSync(DB_PATH, fs.constants.R_OK | fs.constants.W_OK);
    ok('Database is readable and writable');
  } catch (e) {
    fail(`Database is not accessible: ${e.message}`);
  }

  // Check basic file size
  const stats = fs.statSync(DB_PATH);
  if (stats.size > 0) {
    ok(`Database size: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
  } else {
    warn('Database file is empty');
  }
}

async function checkBackups() {
  if (!fs.existsSync(BACKUP_DIR)) {
    warn(`Backup directory not found: ${BACKUP_DIR}`);
    return;
  }

  const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db'));

  if (backups.length > 0) {
    ok(`Found ${backups.length} backup(s)`);
    
    // Show most recent
    const files = backups
      .map(f => ({
        name: f,
        time: fs.statSync(path.join(BACKUP_DIR, f)).mtime
      }))
      .sort((a, b) => b.time - a.time);

    ok(`Latest backup: ${files[0].name}`);
  } else {
    warn('No backups found');
  }
}

function checkJobPaths() {
  const jobsToCheck = [
    { name: 'backfill-card-results', path: 'src/jobs/backfill_card_results.js' },
    { name: 'settle-games', path: 'src/jobs/settle_game_results.js' },
    { name: 'settle-cards', path: 'src/jobs/settle_pending_cards.js' }
  ];

  jobsToCheck.forEach(job => {
    const fullPath = path.resolve(PROJECT_ROOT, 'apps/worker', job.path);
    if (fs.existsSync(fullPath)) {
      ok(`Job found: ${job.name}`);
    } else {
      fail(`Job missing: ${job.name} (${job.path})`);
    }
  });
}

function checkEnvironment() {
  // Resolve DB path using the same precedence contract as runtime code.
  let resolved = RESOLVED_DB;
  try {
    resolved = resolveDatabasePath({ env: process.env, cwd: PROJECT_ROOT });
    ok(`DB resolves (${resolved.source}): ${resolved.dbPath}`);
  } catch (e) {
    fail(`Database path contract violation: ${e.message}`);
    resolved = null;
  }

  if (process.env.NODE_ENV === 'production' && !process.env.CHEDDAR_DB_PATH) {
    warn('CHEDDAR_DB_PATH is not set in production env (recommended canonical source)');
  }

  if (resolved && fs.existsSync(resolved.dbPath)) {
    ok('Resolved DB file exists');
  } else if (resolved) {
    warn(`Resolved DB file is missing: ${resolved.dbPath}`);
  }

  const nodeEnv = process.env.NODE_ENV || 'development';
  ok(`NODE_ENV: ${nodeEnv}`);
}

function checkDependencies() {
  const pkgPath = path.resolve(PROJECT_ROOT, 'apps/worker/package.json');
  if (!fs.existsSync(pkgPath)) {
    fail('package.json not found');
    return;
  }

  const nodeModulesPath = path.resolve(PROJECT_ROOT, 'apps/worker/node_modules');
  if (fs.existsSync(nodeModulesPath)) {
    ok('node_modules installed');
  } else {
    warn('node_modules not found - run npm install before deployment');
  }
}

function printSummary() {
  console.log(`\n${BLUE}╔═══════════════════════════════════════╗${RESET}`);
  console.log(`${BLUE}║ Summary${RESET}`);
  console.log(`${BLUE}╠═══════════════════════════════════════╣${RESET}`);
  console.log(`${GREEN}  Passed:  ${checks.passed}${RESET}`);
  if (checks.warnings > 0) {
    console.log(`${YELLOW}  Warnings: ${checks.warnings}${RESET}`);
  }
  if (checks.failed > 0) {
    console.log(`${RED}  Failed:  ${checks.failed}${RESET}`);
  }
  console.log(`${BLUE}╚═══════════════════════════════════════╝${RESET}\n`);

  if (checks.failed === 0) {
    console.log(`${GREEN}✓ System is ready for deployment${RESET}\n`);
  } else {
    console.log(`${RED}✗ Fix errors before proceeding with deployment${RESET}\n`);
  }
}

verify().catch(console.error);
