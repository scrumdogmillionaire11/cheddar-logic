---
phase: quick-158
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - web/src/__tests__/api-endpoint-parity-fixtures.test.js
  - web/src/app/api/cards/route.ts
  - web/src/app/api/cards/[gameId]/route.ts
  - web/src/lib/games/route-handler.ts
  - web/src/__tests__/api-games-prop-decision-contract.test.js
  - web/src/__tests__/api-cards-lifecycle-regression.test.js
  - docs/audits/endpoint-parity.md
autonomous: true
requirements:
  - R1
  - R2
  - R3
  - R4

must_haves:
  truths:
    - "The same fixture payload drives evaluation through both cards and games paths and returns comparable output."
    - "Differences between cards and games responses are explained by surfaced behavioral fields (status, reason code, visibility, projection markers), not opaque booleans."
    - "A failing parity condition identifies a concrete reason-level mismatch, not just a boolean pass/fail."
    - "Parity suite survives refactors that preserve behavior."
  artifacts:
    - path: "web/src/__tests__/api-endpoint-parity-fixtures.test.js"
      provides: "Shared fixture corpus + parity diff assertions"
    - path: "docs/audits/endpoint-parity.md"
      provides: "Fixture matrix, expected diffs, interpretation rules"
  key_links:
    - from: "web/src/__tests__/api-endpoint-parity-fixtures.test.js"
      to: "web/src/app/api/cards/route.ts"
      via: "request simulation through shared fixture game ids"
    - from: "web/src/__tests__/api-endpoint-parity-fixtures.test.js"
      to: "web/src/lib/games/route-handler.ts"
      via: "response assembly path called with same fixture payload"
    - from: "web/src/__tests__/api-endpoint-parity-fixtures.test.js"
      to: "docs/audits/endpoint-parity.md"
      via: "parity diff output contract documented in audit"
---

<objective>
Add fixture-driven behavioral parity tests proving that identical underlying payloads produce explainable and stable differences between the cards and games endpoints.

Purpose: Prevent silent behavioral drift between /api/cards and /api/games by asserting reason-level explainability on every difference, not just boolean equality.
Output: Shared fixture harness, aligned response contracts, deterministic diff objects, and audit documentation.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@WORK_QUEUE/WI-0902.md

@web/src/__tests__/api-games-prop-decision-contract.test.js
@web/src/__tests__/api-cards-lifecycle-regression.test.js
@web/src/app/api/cards/route.ts
@web/src/lib/games/route-handler.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Build shared fixture harness for cards/games parity inputs</name>
  <files>web/src/__tests__/api-endpoint-parity-fixtures.test.js</files>
  <action>
Create `web/src/__tests__/api-endpoint-parity-fixtures.test.js` as a new file (it does not exist yet).

Define a shared fixture table — an array of fixture objects — that covers at minimum:
- A projection-only row (game where only projection data is available, no settled line)
- A synthetic fallback row (game where odds source falls back to a generated value)
- A standard row (game with a normal PLAY/LEAN/PASS decision and real odds)

Each fixture object must include:
```js
{
  fixtureId: string,        // stable fixture identifier
  gameId: string,           // synthetic game id (use deterministic values like "game-parity-001")
  payload: { ... },         // minimal normalized card payload needed to drive both paths
  expectedParity: {
    status: string,         // expected surfaced status from both paths
    reasonCode: string,     // expected reason code
    visibilityClass: string, // "visible" | "hidden" | "projection_only"
    hasProjectionMarker: boolean
  }
}
```

Wire each fixture through both endpoint evaluation paths using the same technique as existing tests in `api-cards-lifecycle-regression.test.js` (inspect route source strings) and `api-games-prop-decision-contract.test.js` (inspect route-handler source).

For Task 1: focus on creating the fixture table and confirming both paths are invocable per fixture. The parity diff output shape (Task 3) comes later — here just confirm the fixture executes through both paths without error and the fixture fields are structurally valid.

Use `node:assert/strict` and `node:fs`/`node:path` only — no Jest, no test runner dependency beyond node.

Run pattern: the file should be directly runnable with `node web/src/__tests__/api-endpoint-parity-fixtures.test.js`.
  </action>
  <verify>
    <automated>node web/src/__tests__/api-endpoint-parity-fixtures.test.js</automated>
  </verify>
  <done>Shared fixture corpus exists, covers projection-only, synthetic fallback, and standard rows, and executes both endpoint paths per fixture without error.</done>
</task>

<task type="auto">
  <name>Task 2: Align response behavior assertions across cards and games consumers</name>
  <files>
    web/src/app/api/cards/route.ts
    web/src/app/api/cards/[gameId]/route.ts
    web/src/lib/games/route-handler.ts
    web/src/__tests__/api-games-prop-decision-contract.test.js
    web/src/__tests__/api-cards-lifecycle-regression.test.js
  </files>
  <action>
Preflight: confirm baseline tests pass before touching anything:
- `node web/src/__tests__/api-games-prop-decision-contract.test.js`
- `npm --prefix web run test:cards-lifecycle-regression`

If either fails, stop and report — do not proceed to modifications.

Make the following behavioral fields explicitly surfaced and deterministic in both endpoint paths so the parity harness can compare them:
- `status` — surfaced decision status (PLAY / LEAN / PASS / NO_BET / DEGRADED)
- `reason_code` — normalized reason string tied to the gate that produced the status
- `visibility_class` — one of `"visible"` | `"hidden"` | `"projection_only"`
- `has_projection_marker` — boolean, true when the row is derived from a projection source

If any of these fields are already present and consistent in both paths (from WI-0892), confirm and document — do not add redundant new fields.
If any field is missing or inconsistent between cards and games paths, add it in the minimally invasive way: prefer adding to the existing response assembly point in `route-handler.ts` for games and the existing response mapping in `route.ts` for cards.

Update assertions in:
- `api-games-prop-decision-contract.test.js` — add `reason_code` and `visibility_class` to `requiredFields` array if not already present
- `api-cards-lifecycle-regression.test.js` — add equivalent behavioral field assertions for the same fields on card objects

Do NOT change existing passing assertions. Only add new explicit assertions for the parity-required fields.

Verify all three checks pass after changes:
- `node web/src/__tests__/api-games-prop-decision-contract.test.js`
- `npm --prefix web run test:cards-lifecycle-regression`
- `npm --prefix web run test:games-filter`
  </action>
  <verify>
    <automated>node web/src/__tests__/api-games-prop-decision-contract.test.js && npm --prefix web run test:games-filter && npm --prefix web run test:cards-lifecycle-regression</automated>
  </verify>
  <done>Cards and games response contracts explicitly surface status, reason_code, visibility_class, and has_projection_marker. All three existing test suites pass.</done>
</task>

<task type="auto">
  <name>Task 3: Implement deterministic parity diff output and audit documentation</name>
  <files>
    web/src/__tests__/api-endpoint-parity-fixtures.test.js
    docs/audits/endpoint-parity.md
  </files>
  <action>
Extend `api-endpoint-parity-fixtures.test.js` (built in Task 1) to produce a stable diff object per fixture with exactly these keys:
```js
{
  gameId: string,
  fixtureId: string,
  cards: { status, reason_code, visibility_class, has_projection_marker },
  games: { status, reason_code, visibility_class, has_projection_marker },
  field_deltas: string[],       // list of field names that differ between cards and games
  reason_explanation: string,   // human-readable explanation of any delta
  parity_status: "MATCH" | "EXPECTED_DELTA" | "UNEXPECTED_DELTA"
}
```

For each fixture in the table:
- Fixtures designed to match: assert `parity_status === "MATCH"` and `field_deltas.length === 0`
- Fixtures designed to differ: assert `parity_status === "EXPECTED_DELTA"`, assert specific fields in `field_deltas`, assert `reason_explanation` is non-empty and references the field name
- If `parity_status === "UNEXPECTED_DELTA"` the test must FAIL with the diff printed

Create `docs/audits/` directory if it does not exist. Write `docs/audits/endpoint-parity.md` documenting:
- The fixture matrix (one row per fixture: fixtureId, scenario, expected parity_status, expected field_deltas)
- The diff schema (each key defined with type and meaning)
- How to interpret each parity_status value
- How to add a new fixture

Final verification also runs the build to confirm no TypeScript/import errors were introduced:
`npm --prefix web run build`
  </action>
  <verify>
    <automated>node web/src/__tests__/api-endpoint-parity-fixtures.test.js && npm --prefix web run build</automated>
  </verify>
  <done>Parity suite produces deterministic diff objects per fixture, fails on unexpected behavioral drift, and emits reason_explanation on any delta. docs/audits/endpoint-parity.md documents the fixture matrix and diff schema.</done>
</task>

</tasks>

<verification>
All three tasks must pass:
1. `node web/src/__tests__/api-endpoint-parity-fixtures.test.js` — parity fixtures execute without error, diffs deterministic
2. `node web/src/__tests__/api-games-prop-decision-contract.test.js` — games response contract still passes
3. `npm --prefix web run test:games-filter` — games filter regression still passes
4. `npm --prefix web run test:cards-lifecycle-regression` — cards lifecycle regression still passes
5. `npm --prefix web run build` — no compilation errors introduced
</verification>

<success_criteria>
- Shared fixture corpus (projection-only, synthetic fallback, standard rows) drives both cards and games endpoint evaluations
- Each fixture produces a diff object with stable keys: gameId, fixtureId, cards, games, field_deltas, reason_explanation, parity_status
- Unexpected behavioral drift causes the parity suite to FAIL with a printed diff
- All pre-existing test suites remain green
- docs/audits/endpoint-parity.md documents the fixture matrix and interpretation rules
</success_criteria>

<output>
After completion, create `.planning/quick/158-wi-0902-endpoint-behavioral-parity-fixtu/158-SUMMARY.md`
</output>
