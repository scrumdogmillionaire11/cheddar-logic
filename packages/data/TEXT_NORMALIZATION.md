# Text Normalization Strategy

Centralized text normalization at API → Database boundary ensures consistent data quality.

## Philosophy

**Normalize Once, Trust Always**: All incoming data is normalized at database insertion. Downstream code trusts the data is clean.

## Implementation

All normalization functions are in `packages/data/src/normalize.js`

Integration points:
- upsertGame() normalizes team names
- insertCardPayload() normalizes card titles

## Normalization Domains

Team Names: Trim, check TEAM_VARIANTS, return canonical (e.g., "Boston Celtics")

Sport Codes: Uppercase with aliases (e.g., "basketball" → "NBA")

Market Types: Uppercase enums (e.g., "h2h" → "MONEYLINE", "o/u" → "TOTAL")

Directions: HOME, AWAY, OVER, UNDER, NEUTRAL, FAV, DOG

Card Titles: Trim, collapse whitespace, preserve case

Player Names: Trim, remove diacritics/suffixes, preserve case

Reasoning Text: Trim, collapse whitespace, preserve case

## Adding New Variants

Edit the maps in normalize.js: TEAM_VARIANTS, MARKET_ALIASES, SPORT_ALIASES

## Debugging

Warnings logged for unrecognized values to identify data quality issues.

**Storage Format**: Uppercase code (e.g., "NHL", "NBA", "NCAAM", "SOCCER", "MLB", "NFL")

**Normalization Process**:
- Convert to uppercase
- Check direct match against valid sports
- If alias exists, map to canonical
- Otherwise, return null and log warning

**Applies To**:
- `games.sport`
- `odds_snapshots.sport`
- `card_payloads.sport`
- `game_results.sport`

**Examples**:
```
Input: "nhl" → Output: "NHL"
Input: "basketball" → Output: "NBA"
Input: "NCAAM" → Output: "NCAAM"
Input: "college basketball" → Output: "NCAAM"
```

**Aliases Defined**:
- "basketball" → "NBA"
- "hockey" → "NHL"
- "football" → "NFL"
- "baseball" → "MLB"
- "college basketball", "mens college basketball", "college hoops" → "NCAAM"

---

### 3. **Market Types**

**Storage Format**: Uppercase enum (e.g., "MONEYLINE", "SPREAD", "TOTAL", "PUCKLINE", "TEAM_TOTAL", "PROP", "INFO")

**Normalization Process**:
- Convert to uppercase
- Check direct match against valid markets
- If alias exists, map to canonical
- Otherwise, return null and log warning

**Applies To**:
- `card_payloads.payload_data -> market_type`
- `odds_snapshots` implicit market context

**Examples**:
```
Input: "moneyline" → Output: "MONEYLINE"
Input: "h2h" → Output: "MONEYLINE"
Input: "SPREAD" → Output: "SPREAD"
Input: "o/u" → Output: "TOTAL"
Input: "puck_line" → Output: "PUCKLINE"
```

**Aliases Defined**:
- "ml", "h2h", "money line" → "MONEYLINE"
- "line", "ats", "point spread" → "SPREAD"
- "over/under", "o/u", "over under" → "TOTAL"
- "puck_line", "puck line" → "PUCKLINE"
- "teamtotal", "team total" → "TEAM_TOTAL"

---

### 4. **Direction / Sides**

**Storage Format**: Uppercase (e.g., "HOME", "AWAY", "OVER", "UNDER", "NEUTRAL", "FAV", "DOG")

**Normalization Process**:
- Convert to uppercase
- Validate against allowed values
- Return null if invalid

**Applies To**:
- `card_payloads.payload_data -> selection.side`
- Play prediction fields

**Examples**:
```
Input: "Over" → Output: "OVER"
Input: "home" → Output: "HOME"
Input: "NEUTRAL" → Output: "NEUTRAL"
```

---

### 5. **Card Titles**

**Storage Format**: Cleaned (trimmed, collapsed whitespace, original case preserved)

**Normalization Process**:
- Trim whitespace
- Collapse multiple spaces to single space
- Remove redundant " Card" suffix
- Preserve original case

**Applies To**:
- `card_payloads.card_title`

**Examples**:
```
Input: "  NBA Total Projection  " → Output: "NBA Total Projection"
Input: "Rest Advantage Card" → Output: "Rest Advantage"
Input: "Total  Over  Under" → Output: "Total Over Under"
```

**Note**: For matching/inference, lowercase the title in code:
```javascript
const titleLower = normalizedTitle.toLowerCase();
if (titleLower.includes('total')) { ... }
```

---

### 6. **Player Names**

**Storage Format**: Cleaned, diacritics removed, original case preserved

**Normalization Process**:
- Trim whitespace
- Remove common suffixes (Jr., Sr., II, III, IV, V)
- Remove diacritics (é → e, ñ → n, etc.)
- Collapse multiple spaces

**Applies To**:
- Props metadata (player names in selections)
- Player-related fields in card payloads

**Examples**:
```
Input: "José García Jr." → Output: "Jose Garcia"
Input: "  LeBron James  " → Output: "LeBron James"
Input: "Müller III" → Output: "Muller"
```

**Why Diacritics Removed**: Ensures consistent matching across different data sources and input methods (keyboard layouts, encoding issues).

---

### 7. **Reasoning Text**

**Storage Format**: Cleaned (trimmed, collapsed whitespace)

**Normalization Process**:
- Trim whitespace
- Collapse multiple spaces
- Preserve original case and punctuation

**Applies To**:
- `card_payloads.payload_data -> reasoning`
- Card description fields

**Examples**:
```
Input: "Model predicts   strong   edge" → Output: "Model predicts strong edge"
```

---

## Implementation

All normalization functions are in [packages/data/src/normalize.js](./normalize.js).

### Using in Node.js Code

```javascript
const {
  normalizeTeamName,
  normalizeMarketType,
  normalizeSportCode,
  nationalizePlayerName,
  normalizeCardTitle,
  teamLookupKey,
  playerLookupKey,
} = require('./normalize');

// Insert a game with normalized teams
const homeTeam = normalizeTeamName("BOSTON CELTICS");  // → "Boston Celtics"
const awayTeam = normalizeTeamName("la lakers");       // → "Los Angeles Lakers"

// Normalize a market type
const market = normalizeMarketType("o/u");  // → "TOTAL"

// Create a lookup key for matching (case-insensitive)
const key = teamLookupKey("GOLDEN STATE WARRIORS");  // → "golden state warriors"

// Check player names with diacritics
const player = normalizePlayerName("José María");  // → "Jose Maria"
```

### Integration Points

**Current Integration**:
1. ✅ `db.js : upsertGame()` - normalizes `homeTeam` and `awayTeam`
2. ✅ `db.js : insertCardPayload()` - normalizes `cardTitle`
3. ✅ `db.js : insertOddsSnapshot()` - uses existing `normalizeSportValue()`

**Future Integration** (recommended):
- `API routes` that ingest odds data
- `Settlement pipeline` for game results
- `Search/filter` logic (case-insensitive by design)

---

## Testing

To test normalization logic:

```bash
cd packages/data
node -e "
  const {
    normalizeTeamName,
    normalizeMarketType,
    teamLookupKey
  } = require('./src/normalize');

  console.log(normalizeTeamName('BOSTON CELTICS'));      // Expected: Boston Celtics
  console.log(normalizeMarketType('h2h'));              // Expected: MONEYLINE
  console.log(teamLookupKey('Los Angeles Lakers'));     // Expected: los angeles lakers
"
```

---

## Adding New Variants

### New Team Variants

Edit [normalize.js](./normalize.js#L110) `TEAM_VARIANTS`:

```javascript
const TEAM_VARIANTS = {
  'BOSTON CELTICS': ['boston celtics', 'bos celtics', 'celtics'],
  'NEW_TEAM_NAME': ['variant1', 'variant2', 'abbreviation'],
};
```

### New Market Aliases

Edit [normalize.js](./normalize.js#L61) `MARKET_ALIASES`:

```javascript
const MARKET_ALIASES = {
  'NEW_ALIAS': 'CANONICAL_MARKET',
};
```

### New Sport Aliases

Edit [normalize.js](./normalize.js#L152) `SPORT_ALIASES`:

```javascript
const SPORT_ALIASES = {
  'NEW_ALIAS': 'CANONICAL_SPORT',
};
```

---

## Logging & Debugging

Normalization functions log warnings when they encounter unknown values:

```
[NORMALIZE] Unknown team "xyz corp" in normalizeTeamName
[NORMALIZE] Unknown market type "xyz" in normalizeMarketType
[NORMALIZE] Invalid enum "xyz" for normalizeDirection
```

To debug normalization issues:
1. Check the database values to see what was actually stored
2. Look at logs for warnings
3. Verify the input data matches expected format

---

## Migration

If existing data has case inconsistencies:

```bash
# To normalize existing data (example):
npm run migrate:normalize-teams
npm run migrate:normalize-markets
```

(Implement migration scripts as needed based on data audit findings.)

---

## FAQ

**Q: Why preserve case for team names instead of all uppercase?**
A: Display purposes. "Boston Celtics" looks better in UI than "BOSTON CELTICS". The canonical form is human-readable.

**Q: What if a team name is not in `TEAM_VARIANTS`?**
A: It's returned as-is (trimmed). This allows for new teams to be added without crashing. Add to the map when you discover the variant.

**Q: Should I lowercase player names?**
A: Only if doing case-insensitive search. Store with diacritics removed, preserving case. For lookups, use `playerLookupKey()`.

**Q: What if someone enters "M. Lebron James" for a player?**
A: The normalization doesn't expand initials. You'd need a separate dedupe/consolidation step if needed. For now, treat "m. lebron james" and "lebron james" as different.

---

## References

- [normalize.js](./normalize.js) - All normalization functions
- [db.js](./db.js#L502) - Integration points in database layer
- Issues/PRs: Link to any related discussions about data quality

