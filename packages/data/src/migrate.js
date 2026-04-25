/**
 * Database Migration Runner
 * Executes SQL migration files in order to initialize schema
 * 
 * Path resolution strategy:
 * 1. CHEDDAR_MIGRATIONS_DIR env var (deploy-time override)
 * 2. process.cwd() + packages/data/db/migrations (monorepo root)
 * 3. __dirname + ../db/migrations (dev/source)
 * 4. Fallback search from package root
 * 
 * This handles both bundled (Next.js) and development environments.
 */

const {getDatabase } = require('./db');
const fs = require('fs');
const path = require('path');

/**
 * Resolve migrations directory with bundler resilience
 * Tries multiple strategies and fails loudly with diagnostics
 */
function resolveMigrationsDir() {
  const candidates = [];
  const attempted = [];

  // Strategy 1: Explicit env var override (highest priority)
  if (process.env.CHEDDAR_MIGRATIONS_DIR) {
    candidates.push(process.env.CHEDDAR_MIGRATIONS_DIR);
  }

  // Strategy 2: Project-relative from working directory (monorepo)
  const cwdBased = path.join(process.cwd(), 'packages', 'data', 'db', 'migrations');
  candidates.push(cwdBased);

  // Strategy 3: Source-relative via __dirname (dev)
  const srcBased = path.join(__dirname, '..', 'db', 'migrations');
  candidates.push(srcBased);

  // Strategy 4: Fallback: try from package root parent
  if (path.basename(__dirname) === 'src') {
    const parentSrc = path.join(__dirname, '..', '..', 'db', 'migrations');
    candidates.push(parentSrc);
  }

  // Try each candidate
  for (const candidate of candidates) {
    attempted.push(candidate);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        const files = fs.readdirSync(candidate).filter(f => f.endsWith('.sql'));
        if (files.length > 0) {
          console.log(`[Migrations] Resolved directory: ${candidate} (${files.length} files)`);
          return candidate;
        }
      }
    } catch (error) {
      // Not found, continue to next candidate
    }
  }

  // All failed: provide detailed diagnostics
  const diagnostics = [
    `[Migrations] Failed to resolve migrations directory`,
    `Current working directory: ${process.cwd()}`,
    `Module directory (__dirname): ${__dirname}`,
    `Node environment: ${process.env.NODE_ENV || 'not set'}`,
    `Runtime: ${process.env.NEXT_PUBLIC_APP_NAME ? 'Next.js (bundled)' : 'Node.js'}`,
    ``,
    `Attempted paths (in order):`,
    ...attempted.map((p, i) => `  ${i + 1}. ${p}`),
    ``,
    `To fix: Set CHEDDAR_MIGRATIONS_DIR to the absolute path to migrations directory`,
    `Example: export CHEDDAR_MIGRATIONS_DIR=/opt/cheddar-logic/packages/data/db/migrations`,
  ];

  const message = diagnostics.join('\n');
  console.error(message);
  throw new Error(`[Migrations] Could not resolve migrations directory. See diagnostics above.`);
}

async function runMigrations() {
  // Initialize SQL.js first
  
  const db = getDatabase();

  // Create migrations table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Resolve migrations directory with fallback strategy
  let migrationsDir;
  try {
    migrationsDir = resolveMigrationsDir();
  } catch (error) {
    console.error(error.message);
    db.close();
    throw error;
  }

  // Get migration files
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`[Migrations] Found ${files.length} migration files`);

  let alreadyAppliedCount = 0;
  for (const file of files) {
    // Check if already executed
    const checkStmt = db.prepare(`
      SELECT id FROM migrations WHERE name = ?
    `);
    const existing = checkStmt.get(file);

    if (existing) {
      alreadyAppliedCount++;
      continue;
    }

    // Read and execute migration
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    try {
      db.exec(sql);
      
      // Record migration
      const insertStmt = db.prepare(`
        INSERT INTO migrations (name) VALUES (?)
      `);
      insertStmt.run(file);
      
      console.log(`[Migrations] ✓ ${file}`);
    } catch (error) {
      const message = error?.message || '';
      const isRunIdMigration = file === '020_add_card_payloads_run_id.sql';
      const isDuplicateRunId = message.includes('duplicate column name: run_id');

      const isPrimaryMigration = file === '068_add_card_results_is_primary.sql';
      const isDuplicatePrimary = message.includes('duplicate column name: is_primary');

      if (isPrimaryMigration && isDuplicatePrimary) {
        try {
          const fallbackSql = sql.replace(
            /ALTER TABLE card_results ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 1;\s*/i,
            '',
          );
          db.exec(fallbackSql);
          const insertStmt = db.prepare(`
            INSERT INTO migrations (name) VALUES (?)
          `);
          insertStmt.run(file);
          console.log(`[Migrations] ✓ ${file} (column already existed)`);
          continue;
        } catch (fallbackError) {
          console.error(`[Migrations] ✗ ${file}:`);
          console.error(`  ${fallbackError.message}`);
          db.close();
          process.exit(1);
        }
      }

      if (isRunIdMigration && isDuplicateRunId) {
        try {
          const fallbackSql = sql.replace(
            /ALTER TABLE card_payloads ADD COLUMN run_id TEXT;\s*/i,
            '',
          );
          db.exec(fallbackSql);
          const insertStmt = db.prepare(`
            INSERT INTO migrations (name) VALUES (?)
          `);
          insertStmt.run(file);
          console.log(`[Migrations] ✓ ${file} (column already existed)`);
          continue;
        } catch (fallbackError) {
          console.error(`[Migrations] ✗ ${file}:`);
          console.error(`  ${fallbackError.message}`);
          db.close();
          process.exit(1);
        }
      }

      console.error(`[Migrations] ✗ ${file}:`);
      console.error(`  ${message}`);
      db.close();
      process.exit(1);
    }
  }

  if (alreadyAppliedCount > 0) {
    console.log(`[Migrations] ${alreadyAppliedCount}/${files.length} already applied`);
  }
  db.close();
  console.log(`[Migrations] Complete`);
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('[Migrations] Done');
      process.exit(0);
    })
    .catch(err => {
      console.error('[Migrations] Failed:', err.message);
      process.exit(1);
    });
}

module.exports = { runMigrations };
