---
phase: WI-1179
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/data/src/db/cards.js
  - packages/data/__tests__/card-payload-sport.test.js
autonomous: true
requirements:
  - WI-1179-MLB-01
  - WI-1179-MLB-02
  - WI-1179-NHL-01
  - WI-1179-NHL-02
  - WI-1179-REG-01
must_haves:
  truths:
    - "MLB extractor resolves modern top-level payload fields and still supports legacy drivers[0] payloads"
    - "MLB extractor prefers modern actionable values over legacy values when both are present"
    - "NHL extractor treats PASS and evidence-only rows as non-actionable and returns null for incomplete probability inputs"
    - "Extractor contract remains stable for POTD consumer paths with regression coverage"
  artifacts:
    - path: "packages/data/src/db/cards.js"
      provides: "Modern+legacy MLB extraction and actionable-only NHL extraction"
    - path: "packages/data/__tests__/card-payload-sport.test.js"
      provides: "Regression coverage for modern MLB schema, legacy fallback, and NHL PASS/evidence filtering"
  key_links:
    - from: "packages/data/src/db/cards.js"
      to: "packages/data/__tests__/card-payload-sport.test.js"
      via: "Schema-path and actionability assertions for both sports"
      pattern: "getLatestMlbModelOutput|getLatestNhlModelOutput|PASS|evidence|drivers"
---

<objective>
Implement WI-1179 with canonical extractor compatibility guarantees: modern MLB payload support, legacy MLB fallback, and NHL non-actionable PASS/evidence filtering that protects POTD from incomplete model signal reads.

Output: Updated extractor logic in cards.js and deterministic regression coverage in card-payload-sport.test.js.
</objective>

<context>
@.planning/ROADMAP.md
@WORK_QUEUE/WI-1179.md
@packages/data/src/db/cards.js
@packages/data/__tests__/card-payload-sport.test.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add modern MLB payload path with legacy fallback and modern-first precedence</name>
  <files>packages/data/src/db/cards.js</files>
  <action>Update getLatestMlbModelOutput to evaluate modern top-level fields first (model_prob or p_fair, edge, selection.side), support optional price/line/market_type passthrough, and fall back to legacy drivers[0] only when the modern path is incomplete or invalid. Keep return shape compatible with POTD consumers and return null when neither schema yields actionable values.</action>
  <verify>
    <automated>npm --prefix packages/data test -- card-payload-sport.test.js -t "MLB"</automated>
  </verify>
  <done>Modern MLB payloads parse successfully, legacy payloads still parse, and modern values win when both schemas are present.</done>
</task>

<task type="auto">
  <name>Task 2: Enforce actionable-only NHL extraction for PASS and evidence rows</name>
  <files>packages/data/src/db/cards.js, packages/data/__tests__/card-payload-sport.test.js</files>
  <action>Update getLatestNhlModelOutput to return null for non-actionable PASS/evidence rows and for payloads missing finite model probability inputs required by POTD. Preserve valid legacy nested field support for actionable rows. Add tests for PASS, evidence, incomplete probabilities, and valid actionable NHL payloads.</action>
  <verify>
    <automated>npm --prefix packages/data test -- card-payload-sport.test.js -t "NHL"</automated>
  </verify>
  <done>NHL PASS/evidence rows are rejected as non-actionable while valid actionable payloads remain consumable.</done>
</task>

<task type="auto">
  <name>Task 3: Run integration regression checks for extractor consumers</name>
  <files>packages/data/__tests__/card-payload-sport.test.js</files>
  <action>Run the full WI-required extractor and consumer tests from repo root, confirm no regressions in existing extractor behavior, and verify all acceptance criteria are represented by passing automated checks.</action>
  <verify>
    <automated>npm --prefix packages/data test -- card-payload-sport.test.js && npm --prefix apps/worker run test -- src/jobs/potd/__tests__/signal-engine.test.js --runInBand</automated>
  </verify>
  <done>Data-layer extractor tests and POTD signal-engine consumer tests pass with no contract regressions.</done>
</task>

</tasks>

<success_criteria>
- Modern MLB schema is supported and preferred over legacy when both are available.
- Legacy MLB schema remains supported for backward compatibility.
- NHL PASS/evidence and incomplete model rows are non-actionable and return null.
- Regression tests demonstrate compatibility and non-regression for POTD consumer behavior.
</success_criteria>
