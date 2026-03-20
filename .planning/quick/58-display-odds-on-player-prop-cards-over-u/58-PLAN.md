---
phase: 58-display-odds-on-player-prop-cards-over-u
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - web/src/lib/types/game-card.ts
  - web/src/app/api/games/route.ts
  - web/src/lib/game-card/transform.ts
  - web/src/components/prop-game-card.tsx
autonomous: true
requirements: [DISPLAY-ODDS-01]

must_haves:
  truths:
    - "Player prop cards show 'OVER -115 / UNDER +105' (or similar) when real sportsbook odds exist"
    - "No odds line renders when market_price_over/under are both null (projection-only props)"
    - "Odds display uses American format with leading + for positive values"
  artifacts:
    - path: "web/src/lib/types/game-card.ts"
      provides: "priceOver/priceUnder optional fields on PropPlayRow"
      contains: "priceOver"
    - path: "web/src/app/api/games/route.ts"
      provides: "market_price_over/under extracted from payload and emitted on Play"
      contains: "market_price_over"
    - path: "web/src/lib/game-card/transform.ts"
      provides: "priceOver/priceUnder mapped from play into PropPlayRow"
      contains: "priceOver"
    - path: "web/src/components/prop-game-card.tsx"
      provides: "Odds line rendered conditionally in Model Snapshot block"
      contains: "OVER"
  key_links:
    - from: "apps/worker/src/jobs/run_nhl_player_shots_model.js"
      to: "card_payloads.payload_data"
      via: "market_price_over/market_price_under written at lines 1077-1078"
      pattern: "market_price_over"
    - from: "web/src/app/api/games/route.ts"
      to: "Play object emitted into playsMap"
      via: "explicit extraction from payload matching l5_sog/l5_mean pattern"
      pattern: "market_price_over.*firstNumber"
    - from: "web/src/lib/game-card/transform.ts"
      to: "PropPlayRow"
      via: "priceOver: (play as unknown as Record<string,unknown>).market_price_over"
      pattern: "priceOver"
---

<objective>
Surface sportsbook over/under prices on each player prop card in the UI.

Purpose: The model job already captures `market_price_over` and `market_price_under` from the Odds API and stores them in the card payload. They are never plumbed to the frontend. This task wires that existing data through the API route → transform → component chain so users can see the actual odds alongside the model projection.

Output: Three code changes (type → route → transform → component) plus a source-level contract test.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md

Precedent pattern — prop_display_state was added following exactly this chain:
1. Field exists in payload written by model job (already done for market_price_over/under)
2. Play interface in route.ts gets the new field typed
3. Route.ts extracts from payload using firstNumber() and emits on play object (see l5_sog pattern ~line 2268)
4. transform.ts reads from play via type cast `(play as unknown as Record<string,unknown>).market_price_over`
5. PropPlayRow type gets new field, transform maps it
6. Component renders conditionally

Key constants:
- Payload field names (written by model job): `market_price_over`, `market_price_under`
- Model job sets these at lines 1077-1078 in run_nhl_player_shots_model.js
- These are null when no real line exists (projection-only props have isOddsBacked=false)
- formatOdds() helper already exists in prop-game-card.tsx (line 27-29): `americanOdds > 0 ? \`+${americanOdds}\` : String(americanOdds)`

Existing Play interface local to route.ts (Play at line 184): does not yet include market_price_over/under.
Existing PropPlayRow in game-card.ts (line 456): does not yet include priceOver/priceUnder.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Wire market_price_over/under through route.ts Play type and emission</name>
  <files>web/src/app/api/games/route.ts</files>
  <action>
Two changes in route.ts:

1. Add to the local `Play` interface (after the prop-specific fields block around line 336-351, alongside l5_sog/l5_mean):
```typescript
market_price_over?: number | null;
market_price_under?: number | null;
```

2. Extract these fields from the payload and emit them on the play object. Find the block that emits `l5_sog` and `l5_mean` (around lines 2800-2801). Use the same firstNumber() pattern to extract:

```typescript
const normalizedPriceOver = firstNumber(
  (payload as Record<string, unknown>).market_price_over,
  payloadPlay?.market_price_over,
) ?? null;
const normalizedPriceUnder = firstNumber(
  (payload as Record<string, unknown>).market_price_under,
  payloadPlay?.market_price_under,
) ?? null;
```

Then add to the play object literal (adjacent to l5_sog/l5_mean):
```typescript
market_price_over: normalizedPriceOver,
market_price_under: normalizedPriceUnder,
```

Do not modify any other logic. The payload already has these values for odds-backed props and null for projection-only props.
  </action>
  <verify>npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -30</verify>
  <done>TypeScript compiles cleanly; Play interface has market_price_over/market_price_under; play objects emitted to playsMap include those fields</done>
</task>

<task type="auto">
  <name>Task 2: Add priceOver/priceUnder to PropPlayRow and map in transform</name>
  <files>web/src/lib/types/game-card.ts, web/src/lib/game-card/transform.ts</files>
  <action>
**game-card.ts** — Add to PropPlayRow interface (after `l5Mean?: number | null;` around line 481):
```typescript
/** American odds for the OVER side from sportsbook. Null if no real line. */
priceOver?: number | null;
/** American odds for the UNDER side from sportsbook. Null if no real line. */
priceUnder?: number | null;
```

**transform.ts** — In `transformPropGames`, inside the `propPlayRows` map (the return object literal starting around line 3338), add after `l5Mean: play.l5_mean ?? null,`:
```typescript
priceOver: ((play as unknown as Record<string, unknown>).market_price_over as number | null | undefined) ?? null,
priceUnder: ((play as unknown as Record<string, unknown>).market_price_under as number | null | undefined) ?? null,
```

Follow the exact type-cast pattern used for prop_display_state at line 3310 of transform.ts.
  </action>
  <verify>npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -30</verify>
  <done>TypeScript compiles cleanly; PropPlayRow has priceOver/priceUnder; transform maps market_price_over/under into those fields</done>
</task>

<task type="auto">
  <name>Task 3: Render over/under odds in prop-game-card component + contract test</name>
  <files>web/src/components/prop-game-card.tsx, web/src/__tests__/game-card-transform-evidence-contract.test.js</files>
  <action>
**prop-game-card.tsx** — In the "Model Snapshot" block (inside the `div` with class `rounded-md border border-white/5 bg-night/40`), add an odds line after the existing "Conf {formatPercent(prop.confidence)}" line (around line 153). Only render when at least one price is non-null:

```tsx
{(prop.priceOver != null || prop.priceUnder != null) && (
  <div className="mt-1 text-xs font-semibold text-cloud/80">
    {prop.priceOver != null ? `OVER ${formatOdds(prop.priceOver)}` : 'OVER —'}
    {' / '}
    {prop.priceUnder != null ? `UNDER ${formatOdds(prop.priceUnder)}` : 'UNDER —'}
  </div>
)}
```

`formatOdds` is already defined at line 27-29 of prop-game-card.tsx — do not redefine it.

**game-card-transform-evidence-contract.test.js** — Add two assertions at the end (before the final console.log):

```javascript
assert(
  source.includes('priceOver') && source.includes('priceUnder'),
  'transform should map market_price_over/under into PropPlayRow priceOver/priceUnder',
);

assert(
  source.includes('market_price_over') && source.includes('market_price_under'),
  'transform should read market_price_over/under from raw play via type cast',
);
```
  </action>
  <verify>npm --prefix web run test:transform:evidence</verify>
  <done>Test passes; prop cards with real odds show "OVER -115 / UNDER +105" in the Model Snapshot block; prop cards without odds show nothing in that slot</done>
</task>

</tasks>

<verification>
- `npx tsc --noEmit --project web/tsconfig.json` exits 0
- `npm --prefix web run test:transform:evidence` passes
- Manual check: visit /props page, find an NHL player shots card with a real line — odds row "OVER X / UNDER Y" appears below the confidence bar
- Manual check: find a PROJECTION_ONLY card (SYNTHETIC_LINE warning) — no odds row appears
</verification>

<success_criteria>
- PropPlayRow.priceOver / PropPlayRow.priceUnder typed as `number | null | undefined`
- route.ts extracts market_price_over/under from card payload and emits on play object
- transform.ts maps into PropPlayRow in transformPropGames
- Component renders odds conditionally (only when at least one price is non-null)
- TypeScript compiles cleanly
- Contract test passes
</success_criteria>

<output>
After completion, create `.planning/quick/58-display-odds-on-player-prop-cards-over-u/58-SUMMARY.md` using the summary template.
</output>
