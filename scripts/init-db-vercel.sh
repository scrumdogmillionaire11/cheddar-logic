#!/usr/bin/bash
# Initialize database for Vercel deployment
# This runs during the build phase to populate the SQLite database with test data

set -e

echo "🗄️  Initializing SQLite database for Vercel..."
echo "Current directory: $(pwd)"

# Set database path to be within the build (not /tmp)
export RECORD_DATABASE_PATH="$(pwd)/packages/data/cheddar.db"
export DATABASE_PATH="${DATABASE_PATH:-$RECORD_DATABASE_PATH}"
export CHEDDAR_DATA_DIR="$(pwd)/packages/data"

echo "RECORD_DATABASE_PATH: ${RECORD_DATABASE_PATH}"
echo "DATABASE_PATH: ${DATABASE_PATH}"
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
node src/verify-db.js || {
  echo "❌ Database verification failed!"
  exit 1
}

echo "✅ Database initialization complete"
ls -lh cheddar.db

exit 0
