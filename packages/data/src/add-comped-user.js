'use strict';

const { initDb, getDatabase, closeDatabase } = require('./db');
const { runMigrations } = require('./migrate');
const { ensureCompedUser } = require('./comped-users');

function printUsage() {
  console.log('Usage: node src/add-comped-user.js [--flag COMPED|AMBASSADOR] email1@example.com [email2@example.com ...]');
}

function parseArgs(argv) {
  const emails = [];
  let flag = 'COMPED';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }

    if (arg === '--flag') {
      flag = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--flag=')) {
      flag = arg.split('=')[1];
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    emails.push(arg);
  }

  return { emails, flag };
}

async function main() {
  const { emails, flag, help } = parseArgs(process.argv.slice(2));

  if (help) {
    printUsage();
    process.exit(0);
  }

  if (!emails || emails.length === 0) {
    printUsage();
    process.exit(1);
  }

  await initDb();
  await runMigrations();

  const db = getDatabase();
  const results = [];

  for (const email of emails) {
    try {
      const result = ensureCompedUser(db, { email, flag });
      results.push(result);
    } catch (error) {
      console.error(`[Comped Users] ${email}: ${error.message}`);
      closeDatabase();
      process.exitCode = 1;
      return;
    }
  }

  closeDatabase();

  for (const result of results) {
    const parts = [];
    if (result.createdUser) parts.push('created user');
    if (result.updatedFlags) parts.push(`added ${result.flag}`);
    if (result.createdSubscription) parts.push('created subscription');
    if (parts.length === 0) parts.push('no changes');

    console.log(`[Comped Users] ${result.email}: ${parts.join(', ')}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[Comped Users] Failed: ${error.message}`);
    process.exit(1);
  });
}
