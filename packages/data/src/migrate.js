/**
 * Database Migration Runner
 * Executes SQL migration files in order to initialize schema
 */

const { initDb, getDatabase } = require('./db');
const fs = require('fs');
const path = require('path');

async function runMigrations() {
  // Initialize SQL.js first
  await initDb();
  
  const db = getDatabase();

  // Create migrations table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Get migration files
  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`[Migrations] Found ${files.length} migration files`);

  for (const file of files) {
    // Check if already executed
    const checkStmt = db.prepare(`
      SELECT id FROM migrations WHERE name = ?
    `);
    const existing = checkStmt.get(file);

    if (existing) {
      console.log(`[Migrations] ✓ ${file} (already applied)`);
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
      console.error(`[Migrations] ✗ ${file}:`);
      console.error(`  ${error.message}`);
      db.close();
      process.exit(1);
    }
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
