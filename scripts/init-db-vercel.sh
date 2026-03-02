#!/bin/bash
# Initialize database for Vercel deployment
# This runs during the build phase to populate the SQLite database with test data

set -e

echo "🗄️  Initializing SQLite database for Vercel..."

cd packages/data

# Run migrations to create schema
echo "Creating schema..."
npm run migrate > /dev/null 2>&1

# Seed test games and odds
echo "Seeding test games and odds..."
npm run seed:test-odds > /dev/null 2>&1

# Seed cards
echo "Seeding card predictions..."
npm run seed:cards > /dev/null 2>&1

echo "✅ Database initialization complete"
ls -lh cheddar.db

exit 0
