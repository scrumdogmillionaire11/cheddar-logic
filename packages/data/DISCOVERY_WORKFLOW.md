# Team Variant Discovery Workflow

## Overview

The text normalization system uses **Option C: Hybrid Discovery** for team names:

1. **Exact matching** against known variants in `TEAM_VARIANTS`
2. **Automatic logging** of unknown variants with frequency counts
3. **Discovery utility** to review unknowns periodically and add new mappings

This approach balances strictness (no guessing) with pragmatism (discover real-world variants over time).

---

## How It Works

### Phase 1: At Ingestion

When a team name arrives from an API:

```javascript
normalizeTeamName("bostonceltics")  // lowercase, no space
  ↓
// Check reverse TEAM_VARIANTS map
// Not found in map: "boston celtics", "bos celtics", "celtics"
  ↓
// Log warning and track unknown variant
[NORMALIZE] Unknown team "bostonceltics" in upsertGame.
  Add to TEAM_VARIANTS map if this becomes a recurring variant.
  ↓
// Return the cleaned input (preserved as-is)
"bostonceltics"
```

The tracking system records:

- The variant text
- First time seen
- Last time seen
- Total count of occurrences

### Phase 2: Discovery Review

Run the discovery utility to see what unknowns have been encountered:

```bash
cd packages/data
npm run normalize:review
```

Output shows discovered variants sorted by frequency:

```text
DISCOVERED TEAM NAME VARIANTS
================================================================================

Found 7 unique unknown variant(s) (34 total occurrences)

📋 VARIANTS BY FREQUENCY:

1. "bostonceltics"
   Count: 12 occurrences (35.3%)
   First Seen: Mar 3, 2026, 10:30:45 AM
   Last Seen:  Mar 3, 2026, 02:15:22 PM

2. "lal"
   Count: 8 occurrences (23.5%)
   First Seen: Mar 2, 2026, 06:12:00 PM
   Last Seen:  Mar 3, 2026, 11:45:30 AM

3. "ny knicks"
   Count: 5 occurrences (14.7%)
   ...
```

### Phase 3: Manual Update

For each recurring variant, decide if it should be added to `TEAM_VARIANTS`:

**File**: `packages/data/src/normalize.js`

**Current entry** (example):

```javascript
const TEAM_VARIANTS = {
  'BOSTON CELTICS': ['boston celtics', 'bos celtics', 'celtics'],
  ...
};
```

**Add discovered variants**:

```javascript
const TEAM_VARIANTS = {
  'BOSTON CELTICS': ['boston celtics', 'bos celtics', 'celtics', 'bostonceltics'],
  'LOS ANGELES LAKERS': ['los angeles lakers', 'la lakers', 'lakers', 'lal'],
  'NEW YORK KNICKS': ['new york knicks', 'ny knicks', 'knicks', 'ny knicks'],
  ...
};
```

## Phase 4: Clear Discovery Cache

After updating, clear the discovery cache to start fresh:

```bash
npm run normalize:review-clear
```


This resets the `discoveredTeamVariants` map for the next iteration.

---

## Workflow Cadence

**Recommended Schedule**:

| Frequency | Action | Command |
| --------- | ------ | ------- |
| Ongoing | Auto-track unknowns | (automatic) |
| Weekly/Daily* | Review discoveries | `npm run normalize:review` |
| After update | Clear cache | `npm run normalize:review-clear` |

*Frequency depends on data volume and variance in your odds APIs.

---

## Example Discovery Cycle

### Day 1: Initial Run

```bash
$ npm run normalize:review
Found 15 unique unknown variant(s) (142 total occurrences)
```

### Review + Update

1. Read the output
2. Identify high-frequency unknowns (>5 occurrences)
3. Edit `TEAM_VARIANTS` to add them
4. Commit changes

### Clear for Next Cycle

```bash
$ npm run normalize:review-clear
✅ Clearing discovered variants for next iteration...
```

### Day 8: Next Review

```bash
$ npm run normalize:review
Found 3 unique unknown variant(s) (7 total occurrences)
```

As you discover and add variants, unknowns diminish. Eventually you'll see "No unknown team variants discovered."

---

## Tips & Best Practices

### Prioritize by Frequency

- Focus on high-count unknowns first
- Ignore one-offs until you see a pattern

### Canonical Names

- Canonical form should match official team name
- E.g., "Boston Celtics" (not "celtics" in all-caps)

### Comprehensive Variants

- Add all known abbreviations, shorthand, common misspellings
- Example for Lakers:

```javascript
'LOS ANGELES LAKERS': [
  'los angeles lakers',
  'la lakers',
  'lakers',
  'lal',           // Common abbreviation
  'los angeles',   // Partial match from some APIs
],
```

### Case Handling

- Store canonical form in title case
- Variant list is all lowercase (lookup is case-insensitive)

### Audit Before Clearing

- Before running `normalize:review-clear`, ensure you've:
  - Reviewed all high-frequency unknowns
  - Updated TEAM_VARIANTS
  - Tested the changes

---

## Exporting Discovered Variants

For programmatic access (e.g., in logs or monitoring dashboards):

```javascript
const { getDiscoveredTeamVariants } = require('@cheddar-logic/data/src/normalize');

const discoveries = getDiscoveredTeamVariants();
// Returns array sorted by frequency:
// [
//   { variant: "bostonceltics", count: 12, firstSeen: "...", lastSeen: "..." },
//   { variant: "lal", count: 8, ... },
//   ...
// ]
```

---

## Integration with Monitoring

Consider adding periodic alerts:

```javascript
// In a monitoring/reporting job
const { getDiscoveredTeamVariants } = require(...);

const unknowns = getDiscoveredTeamVariants();
if (unknowns.length > 10) {
  alertSlack(`⚠️ ${unknowns.length} unknown team variants discovered`);
}
```

---

## FAQ

**Q: What if I don't want to update TEAM_VARIANTS immediately?**
A: That's fine! Unknown variants are still returned (cleaned), and you'll see them every time you run `normalize:review`. Just keep track of recurring ones.

**Q: Can I clear discovered variants manually?**
A: Yes: `clearDiscoveredTeamVariants()` or `npm run normalize:review-clear`

**Q: Will this slow down production?**
A: No. Discovery tracking is in-memory only (Map). No database writes or external calls.

**Q: How do I know if normalization is working?**
A: Check logs for `[NORMALIZE]` warnings. If you see mostly known variants being normalized, you're good. High volume of warnings = time to review.

---

## See Also

- [Text Normalization Strategy](./TEXT_NORMALIZATION.md) - Overall strategy
- [normalize.js](./src/normalize.js) - Implementation
- [review-discovered-variants.js](./src/review-discovered-variants.js) - Discovery tool
