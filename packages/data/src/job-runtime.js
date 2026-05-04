/**
 * Job Runtime Helpers
 * 
 * Ensures DB is initialized, migrations are run, and connections are closed.
 */

const {getDatabase, closeDatabase } = require('./db');
const { runMigrations } = require('./migrate');

function resolveJobExitCode(result) {
  if (result && Number.isFinite(Number(result.exitCode))) {
    return Number(result.exitCode);
  }
  if (result && result.ok === false) {
    return 1;
  }
  if (result && result.success === false) {
    return 1;
  }

  const jobStatus = String(result?.jobStatus || '').trim().toLowerCase();
  if (jobStatus === 'failed' || jobStatus === 'degraded') {
    return 1;
  }

  return 0;
}

/**
 * Run a function with an initialized DB and guaranteed cleanup.
 * @param {function} fn - async function that receives db client
 * @returns {Promise<any>} Result of fn
 */
async function withDb(fn) {
  await runMigrations();
  const db = getDatabase();

  try {
    return await fn(db);
  } finally {
    closeDatabase();
  }
}

/**
 * Wrap a job's main entry-point with standardized lifecycle handling.
 *
 * - Reads dryRun from DRY_RUN env var OR --dry-run CLI arg
 * - Logs [name] Starting (dryRun=…) before calling run
 * - Logs [name] Complete on success, [name] Fatal: {msg} on error
 * - Exits 0 on success (unless result.ok === false → exit 1)
 * - Exits 1 on thrown error
 *
 * @param {string} name - Job key used in log lines (e.g. 'check_odds_health')
 * @param {function({ dryRun: boolean }): Promise<any>} run - Async job function
 * @returns {void} — calls process.exit; never resolves
 */
async function createJob(name, run) {
  const dryRun =
    process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
  console.log(`[${name}] Starting (dryRun=${dryRun})`);
 try {
    const result = await run({ dryRun });
    console.log(`[${name}] Complete`);
    const exitCode = resolveJobExitCode(result);
    process.exit(exitCode);
  } catch (err) {
    console.error(`[${name}] Fatal:`, err.message);
    process.exit(1);
  }
}

module.exports = {
  withDb,
  createJob,
  resolveJobExitCode,
};
