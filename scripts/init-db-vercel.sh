#!/usr/bin/bash
# Initialize database for Vercel deployment
# This runs during the build phase to populate the SQLite database with test data

set -e

echo "🗄️  Initializing SQLite database for Vercel..."
echo "Current directory: $(pwd)"

if [[ "${VERCEL_ENV:-}" == "production" ]]; then
  echo "Skipping init-db seeding for production build."
  exit 0
fi

# Set database path to be within the build (not /tmp)
# Use ONLY CHEDDAR_DB_PATH to avoid conflicts
export CHEDDAR_DB_PATH="$(pwd)/packages/data/cheddar.db"
export CHEDDAR_DATA_DIR="$(pwd)/packages/data"

echo "CHEDDAR_DB_PATH: ${CHEDDAR_DB_PATH}"
echo "CHEDDAR_DATA_DIR: ${CHEDDAR_DATA_DIR}"

cd packages/data

# Run migrations to create schema
echo "Creating schema..."
npm run migrate

# Seed test games and odds
echo "Seeding test games and odds..."
npm run seed:test-odds

# Seed cards
echo "Seeding card predictions..."
npm run seed:cards

# Verify database was populated
echo "Verifying database..."
node <<'NODE'
const { initDb, getDatabase, closeDatabase } = require('./src/db.js');

async function verifyDb() {
  await initDb();
  const db = getDatabase();

  const stats = {
    games: db.prepare('SELECT COUNT(*) as c FROM games').get().c,
    cards: db.prepare('SELECT COUNT(*) as c FROM card_payloads').get().c,
    odds: db.prepare('SELECT COUNT(*) as c FROM odds_snapshots').get().c,
  };

  console.log(`[verify] games=${stats.games} cards=${stats.cards} odds=${stats.odds}`);

  if (stats.games === 0 || stats.cards === 0 || stats.odds === 0) {
    throw new Error('Database verification failed: missing seeded data');
  }

  closeDatabase();
}

verifyDb().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
NODE

echo "✅ Database initialization complete"
ls -lh cheddar.db

exit 0
