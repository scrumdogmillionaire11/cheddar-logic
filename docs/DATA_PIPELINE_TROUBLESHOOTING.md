# Data Pipeline Troubleshooting Guide

## Quick Health Check

Run these commands to diagnose data issues:

```bash
# Inspect database contents
cd packages/data && npm run db:inspect

# Check game dates
cd packages/data && npm run db:check-dates

# Check card coverage
cd packages/data && npm run db:check-coverage

# Test API query logic
cd packages/data && npm run db:test-query

# Run integration tests
cd packages/data && npm run test:integration
```

## Common Issues

### Issue: No games or cards showing on /cards page

**Symptoms:**
- `/cards` page loads but shows no games
- API returns empty arrays

**Diagnosis:**
```bash
cd packages/data
npm run db:check-coverage
```

**Fixes:**

1. **No games in database:**
   ```bash
   cd packages/data
   npm run seed:test-odds  # Seeds realistic test games
   ```

2. **Games exist but no future games:**
   - Check game dates: `npm run db:check-dates`
   - If all games are in the past, seed new games: `npm run seed:test-odds`

3. **Future games exist but no card payloads:**
   ```bash
   cd packages/data
   npm run seed:cards  # Creates cards for games without them
   ```

4. **Verify API endpoints are working:**
   ```bash
   # Make sure Next.js dev server is running first: cd web && npm run dev
   ./scripts/test-api-endpoints.sh
   ```

### Issue: No results showing on /results page

**Symptoms:**
- `/results` page shows "N/A" for all metrics
- No ledger entries

**Diagnosis:**
```bash
cd packages/data
npm run db:inspect
# Check "Card Results" count - should be > 0
```

**Fixes:**

1. **No settled results:**
   ```bash
   cd packages/data
   npm run seed:test-results  # Seeds settled results with outcomes
   ```

2. **Results exist but filtered out:**
   - Check the filters on the /results page UI
   - Try clicking "Clear" button to reset filters

### Issue: Stale data (old games from previous tests)

**Symptoms:**
- Games from many days/weeks ago showing up
- Unrealistic game times

**Fix:**
```bash
cd packages/data

# Option 1: Purge only seed data (keeps real API data)
npm run seed:purge

# Option 2: Full database reset (WARNING: deletes ALL data)
npm run db:reset
npm run migrate
npm run seed:test-odds
npm run seed:cards
```

## Data Pipeline Flow

```
1. Games → Seeded via seed:test-odds OR pulled from real odds API
   ↓
2. Odds Snapshots → Associated with games, captured_at timestamps
   ↓
3. Card Payloads → Model predictions for each game
   ↓
4. Card Results → Settlement tracking (pending → settled)
   ↓
5. Game Results → Final scores and grades
```

## Prevention: Integration Tests

Run tests before pushing changes:

```bash
cd packages/data
npm run test:integration
```

These tests verify:
- Database schema is valid
- Games have valid data
- Future games exist
- All future games have card payloads
- Card payloads reference existing games
- JSON payloads are valid

## Manual API Testing

While Next.js dev server is running (`cd web && npm run dev`):

```bash
# Test games endpoint
curl http://localhost:3000/api/games | jq '.data | length'

# Test results endpoint  
curl http://localhost:3000/api/results | jq '.data.summary'

# Test cards endpoint
curl http://localhost:3000/api/cards | jq '.data | length'
```

## Quick Fix Script

If pages are empty, run this one-liner:

```bash
cd packages/data && \
  npm run db:check-coverage && \
  npm run seed:cards && \
  npm run db:check-coverage
```

This will:
1. Check current card coverage
2. Seed cards for games without them
3. Verify cards were added

## Database Location

- **Development:** `packages/data/cheddar.db`
- **Vercel:** `packages/data/cheddar.db` (build artifact, included in deployment)
- **Migrations:** `packages/data/migrations/*.sql`

## Environment Variables

None required for SQLite (file-based DB). 

For production Postgres/PlanetScale (future):
- `DATABASE_URL` - Connection string
- `CHEDDAR_DATA_DIR` - Override data directory

## Need More Help?

1. Check logs: Look in terminal where `npm run dev` is running
2. Run health checks above
3. Check this troubleshooting guide
4. Review integration test failures for specific issues
