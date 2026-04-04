# ActionNetwork Fixture Capture Instructions

## Why this is needed

The ActionNetwork API endpoint is blocked from server/datacenter IPs via
Cloudfront. The endpoint **is** accessible from a real browser session. Raw
JSON responses must be captured manually via browser DevTools.

---

## Endpoint URL Format

```
https://api.actionnetwork.com/web/v1/{sport_lowercase}?bookIds=BOOK_IDS&date={YYYYMMDD}&periods=event
```

| Sport | `league` value |
|-------|---------------|
| NBA   | `NBA`         |
| MLB   | `MLB`         |
| NHL   | `NHL`         |
| NFL   | `NFL`         |

**Example (NBA, April 3 2026):**
```
https://api.actionnetwork.com/web/v1/nba?bookIds=15,30,1665,2028,2400,2029,1971,2031,2030,2127,79,2988&date=20260403&periods=event
```

---

## Capture Steps

1. Visit [ActionNetwork](https://www.actionnetwork.com) and log in (or ensure
   you have a session cookie — the API may return 404 without one).

2. Open **DevTools → Network** tab. Filter by `XHR` or `Fetch`.

3. Navigate to the public splits page for the target sport on a **live game
   day** (a day with games scheduled):
   - NBA: `https://www.actionnetwork.com/nba/game-splits`
   - MLB: `https://www.actionnetwork.com/mlb/game-splits`
   - NHL: `https://www.actionnetwork.com/nhl/game-splits`

4. In the Network tab, find the request matching
   `v1/{sport_lowercase}?bookIds=...&date=...&periods=event`.

5. Right-click the request → **Copy → Copy Response**.

6. Paste the raw JSON into a new file in this directory using the naming
   convention:
   ```
   {sport_lower}.{YYYYMMDD}.raw.json
   ```
   Example: `nba.20260403.raw.json`

7. Do **not** transform or redact the response — save it verbatim.

---

## Confirming Fixture Quality

A valid fixture should contain:
- A `games` top-level array with at least one entry
- Each game has a `bets` array with at least one entry
- `bets` entries have a `bet_type` field and percentage fields

**Spot check** — open the fixture and confirm these fields are present:
- `bet_type` string (e.g. `"money_line"`, `"spread"`, `"total"`)
- Percentage fields (e.g. `home_bets`, `away_bets`, `over_bets`, `under_bets`)
- A line field for spread/total entries (e.g. `"spread"`, `"total"`, `"line"`)

---

## After Capture

1. Replace the synthetic seed fixture with the real one:
   ```
   # Remove synthetic seed
   rm packages/adapters/fixtures/action_network/{sport}.synthetic-seed.raw.json
   # The real file is already named correctly: {sport}.{YYYYMMDD}.raw.json
   ```

2. Update `docs/parsers/action_network_public_splits.md`:
   - Fill in the "Confirmed field names" section
   - Note any discrepancies vs. the hypothesis in `action-network.js`
   - Update MARKET_KEY_MAP if `bet_type` values differ from hypothesis

3. Update `packages/adapters/src/action-network.js`:
   - Change the header STATUS from "SYNTHETIC_SEED" to "CONFIRMED"
   - Update `MARKET_KEY_MAP` if needed
   - Update field-alias arrays in `parseMarketEntry` if needed

4. Update fixture-driven tests in
   `packages/adapters/src/__tests__/action-network.test.js`:
   - Change the fixture path from `synthetic-seed` to the real filename

5. Run `npm test` in `packages/adapters/` — all tests must pass.

---

## Current Fixture Status

| Sport | File                            | Status          |
|-------|---------------------------------|-----------------|
| NBA   | `nba.synthetic-seed.raw.json`   | SYNTHETIC_SEED  |
| MLB   | `mlb.synthetic-seed.raw.json`   | SYNTHETIC_SEED  |
| NHL   | `nhl.synthetic-seed.raw.json`   | SYNTHETIC_SEED  |
