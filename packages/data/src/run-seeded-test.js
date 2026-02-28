const { execSync } = require('child_process');
const path = require('path');
const { purgeSeedOdds } = require('./purge-seed-odds.js');
const { assertNoSeedOdds } = require('./assert-no-seed-odds.js');

async function main() {
  const cmd = process.argv.slice(2).join(' ').trim();
  if (!cmd) {
    console.error('Usage: node src/run-seeded-test.js "<test command>"');
    process.exit(1);
  }

  const rootDir = path.resolve(__dirname, '..', '..', '..');

  let commandError = null;

  try {
    execSync('node packages/data/src/seed-test-odds.js', {
      cwd: rootDir,
      stdio: 'inherit',
      env: process.env,
    });

    execSync(cmd, {
      cwd: rootDir,
      stdio: 'inherit',
      env: process.env,
    });
  } catch (error) {
    commandError = error;
  } finally {
    try {
      await purgeSeedOdds();
      await assertNoSeedOdds();
      console.log('Seed cleanup confirmed.');
    } catch (cleanupError) {
      console.error('Seed cleanup verification failed:', cleanupError.message || cleanupError);
      process.exit(1);
    }
  }

  if (commandError) {
    process.exit(commandError.status || 1);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
