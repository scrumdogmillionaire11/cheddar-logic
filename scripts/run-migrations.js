#!/usr/bin/env node
/**
 * Run database migrations
 * 
 * Usage: node scripts/run-migrations.js
 * 
 * This script runs all pending SQL migrations against the database.
 * Safe to run multiple times - migrations are idempotent and tracked.
 */

const { runMigrations } = require('../packages/data');

async function main() {
  console.log('[Migrations] Starting database migrations...');
  
  try {
    await runMigrations();
    console.log('[Migrations] ✅ All migrations completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('[Migrations] ❌ Migration failed:', error);
    process.exit(1);
  }
}

main();
