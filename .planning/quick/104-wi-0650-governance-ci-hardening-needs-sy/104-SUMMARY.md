---
phase: 104-wi-0650-governance-ci-hardening-needs-sy
plan: "01"
type: quick
subsystem: governance/ci
tags: [governance, import-boundaries, ci, ownership, data-platform]
dependency_graph:
  requires: [WI-0620]
  provides: [WI-0650]
  affects: [packages/data/src/db/, .github/workflows/ci.yml]
tech_stack:
  added: []
  patterns: [import-boundary-enforcement, ci-gate, ownership-documentation]
key_files:
  created:
    - scripts/check-db-imports.js
  modified:
    - OWNERSHIP.md
    - .github/workflows/ci.yml
key_decisions:
  - "Script uses path.resolve(__dirname, '..') as repo root to support invocation from any directory"
  - "packages/data/ is excluded from scan (permitted internal consumers); all other paths are checked"
  - "Regex matches both require() and import patterns with optional .js suffix"
metrics:
  duration: "~8 minutes"
  completed: "2026-03-30"
  tasks_completed: 3
  tasks_total: 3
  files_created: 1
  files_modified: 2
---

# Phase 104 Plan 01: WI-0650 Governance + CI Import Boundary Hardening Summary

**One-liner:** Codified db domain module ownership in OWNERSHIP.md and enforced it via a zero-dependency Node.js CI script that exits non-zero when files outside `packages/data/` bypass the public index.

## Tasks Completed

| Task | Name | Commit | Files |
| --- | --- | --- | --- |
| 1 | Add DB Domain Modules section to OWNERSHIP.md | cab5689 | OWNERSHIP.md |
| 2 | Create scripts/check-db-imports.js import boundary validator | bfe3880 | scripts/check-db-imports.js |
| 3 | Add check-db-import-boundaries step to CI workflow | c2ef9b6 | .github/workflows/ci.yml |

## What Was Built

**OWNERSHIP.md** now has a `## DB Domain Modules` section between the Path Ownership Matrix table and the Escalation Rule. It declares all 13 modules (index.js + 12 non-public) with owner `lane/data-platform` and permitted consumers column.

**scripts/check-db-imports.js** is a zero-external-dependency Node.js script that:
- Recursively scans `.js`, `.ts`, `.tsx`, `.mjs` files in the repo
- Skips `node_modules/`, `.git/`, `dist/`, `.next/`, and `packages/data/` (permitted consumers)
- Matches lines with `require(` or `import` patterns referencing non-public db module names under a `db/` path
- Exits 0 with "OK (0 violations)" or exits 1 with per-violation details

**ci.yml** has a new `check-db-import-boundaries` step after the smoke gate that runs `node scripts/check-db-imports.js`.

## Verification Results

```
grep "## DB Domain Modules" OWNERSHIP.md     -> ## DB Domain Modules (PASS)
node scripts/check-db-imports.js             -> check-db-import-boundaries: OK (0 violations) (PASS)
grep "check-db-import-boundaries" ci.yml     -> - name: check-db-import-boundaries (PASS)
```

Synthetic violation test: creating a file in `scripts/` with `require('../packages/data/src/db/cards')` triggered exit code 1 with correct violation output.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- [x] OWNERSHIP.md exists and contains `## DB Domain Modules` section with all 13 modules
- [x] scripts/check-db-imports.js exists and exits 0 on current codebase
- [x] .github/workflows/ci.yml contains `check-db-import-boundaries` step
- [x] All three task commits exist: cab5689, bfe3880, c2ef9b6
