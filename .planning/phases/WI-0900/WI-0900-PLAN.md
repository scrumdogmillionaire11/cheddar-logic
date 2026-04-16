---
phase: WI-0900
plan: timestamp-integrity-audit
type: audit
subsystem: data-integrity
autonomous: true
tags:
  - timestamp
  - freshness
  - eligibility
  - settlement
requires:
  - WI-0899
provides:
  - timestamp-field-registry
  - timezone-policy
  - conflict-matrix
  - remediation-proposals
---

# WI-0900: Timestamp Integrity and Freshness Semantics Audit Plan

**Depends on:** WI-0899 (Database Truth Ownership Audit)

**Scope:** Worker models, data layer, web transforms, API routes

**Output:** `docs/audits/timestamp-integrity.md` with field registry, timezone policy, conflict matrix, and remediation proposals

## Objective

Standardize timestamp semantics for eligibility, surfacing, and settlement. Map every decision surface to its controlling timestamp. Identify high-risk disagreement paths and propose guards.

## Success Criteria

1. Field-level registry identifies which timestamp controls each decision (eligibility, surfacing, settlement, stale blocking)
2. Every audited path classified as data-time-first or write-time-first
3. Canonical timezone/UTC policy documented with runtime parsing/storage/comparison rules
4. Disagreement conflict matrix covers: data-new/write-old, write-new/data-stale, missing-data, timezone-ambiguous
5. At least three high-risk paths have concrete remediation proposals (guard type, owner surface, verification command)
6. Automated checks pass; all acceptance bullets map to explicit evidence in audit doc

---

## Task 1: Poll timestamp usage in worker jobs

**Type:** auto

**Goal:** Extract all timestamp fields used in model runs and eligibility gates

**Steps:**

1. Search apps/worker/src/jobs/run_*.js for timestamp reads
2. Record for each job:
   - Timestamp field name(s)
   - Source (payload, DB column, external API)
   - Decision gate (eligibility, surfacing, settlement, stale-blocking)
   - Provider: data-time or write-time
3. Document findings in table format in audit doc

**Verification:**

- Audit doc contains timestamp table for NHL, MLB, NBA models
- Each timestamp has source, field name, and decision gate identified

**Done criteria:**

- Commit: docs(WI-0900): Extract worker job timestamp field registry

---

## Task 2: Build timestamp registry for web transforms and API routes

**Type:** auto

**Goal:** Identify which timestamp controls card surface and API response ordering

**Steps:**

1. Scan web/src/lib/game-card/transform/index.ts and normalize-market.ts
2. Scan web/src/app/api/games/route.ts and web/src/app/api/results/projection-metrics.ts
3. Document for each route:
   - Route path
   - Primary ordering timestamp
   - Secondary/fallback timestamp
   - Classification: data-time-first or write-time-first

**Verification:**

- Web/API section added to timestamp registry table
- Each route explicitly classified

**Done criteria:**

- Commit: docs(WI-0900): Extract web/API timestamp controls

---

## Task 3: Document timezone handling and UTC policy

**Type:** auto

**Goal:** Identify timezone assumptions and document canonical UTC runtime policy

**Steps:**

1. Search worker/data/web code for timezone operations (new Date(), toISOString(), getTime(), setUTC*, momentjs)
2. Identify parsing, storage, and comparison patterns
3. Document canonical policy with parsing/storage/comparison rules
4. Identify any violations or local-time assumptions

**Verification:**

- Timezone policy section with explicit rules documented
- At least two risk points identified

**Done criteria:**

- Commit: docs(WI-0900): Document canonical timezone policy

---

## Task 4: Build timestamp disagreement conflict matrix

**Type:** auto

**Goal:** Map scenarios where timestamps can disagree and their consequences

**Steps:**

1. Create matrix rows for each disagreement scenario
2. For each scenario document: likelihood, impacted surface, current behavior, risk level, example paths
3. Include scenarios for each sport if behavior differs

**Verification:**

- Conflict matrix has at least 4 scenarios with complete rows
- Example paths cited for each medium/high-risk scenario

**Done criteria:**

- Commit: docs(WI-0900): Build timestamp disagreement conflict matrix

---

## Task 5: Identify high-risk paths and propose remediations

**Type:** auto

**Goal:** For three highest-risk paths, propose concrete guards

**Steps:**

1. Identify top three high-risk paths from conflict matrix
2. For each path document:
   - Path name and owner surface (file + line range)
   - Current behavior and risk
   - Remediation proposal with guard type
   - Verification command

**Verification:**

- At least three paths with remediation proposals
- Each proposal has concrete guard type and verification method

**Done criteria:**

- Commit: docs(WI-0900): Propose remediation guards for high-risk timestamp paths

---

## Task 6: Run automated checks and finalize audit

**Type:** auto

**Goal:** Verify all acceptance criteria met and document completeness

**Steps:**

1. Run automated timestamp-detection grep on worker jobs
2. Verify timezone runtime policy with search
3. Manual trace validation: pick one NHL game from worker job through settlement
4. Verify audit doc sections: registry, classification, timezone policy, conflict matrix, remediation proposals, acceptance summary

**Verification:**

- Audit doc contains all required sections
- Manual trace confirms one game path matches registry

**Done criteria:**

- Commit: docs(WI-0900): Complete timestamp integrity audit with all acceptance criteria

---

## Verification Steps

Run acceptance tests:

```bash
npm --prefix apps/worker run test:pipeline:nhl
npm --prefix web run test:transform:truth-price
npm --prefix web run test:api:games:repair-budget
```

Manual validation replay:

- Trace one NHL game from model write through settlement and API response
- Verify ordering/freshness decisions match timestamp registry
- Confirm no timezone-driven disagreement on game ordering

---

## Output

**Deliverables:**

- docs/audits/timestamp-integrity.md (comprehensive audit doc)
  - Timestamp field registry (table format)
  - Classification per path (data-time vs. write-time)
  - Canonical timezone policy
  - Conflict matrix (scenarios, impact, likelihood)
  - Remediation proposals (3+ high-risk paths)
  - Acceptance summary

**Artifacts:**

- One per-task commit (6 total)
- Final summary commit

---

## Notes

- All tasks are independent and can parallelize, but commit sequentially
- Analysis-only in this phase; remediation code changes in follow-up WI if approved
- Timestamp behavior may vary by sport (NHL vs. MLB vs. NBA); document variance explicitly
