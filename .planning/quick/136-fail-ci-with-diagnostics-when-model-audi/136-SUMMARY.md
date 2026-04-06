---
phase: quick-136
plan: "01"
subsystem: ci
tags: [ci, audit, diagnostics, github-actions]
dependency_graph:
  requires: []
  provides: [structured-audit-failure-diagnostics]
  affects: [.github/workflows/audit.yml]
tech_stack:
  added: []
  patterns: [bash-associative-array, artifact-ownership-map]
key_files:
  created: []
  modified:
    - .github/workflows/audit.yml
decisions:
  - "Use bash declare -A associative array to map artifact names to owning step names — avoids repeated if/elif chains and keeps ownership table explicit and auditable"
  - "head -30 preview is printed only for artifacts that ARE present — gives context when a partial run succeeded and helps distinguish 'nothing ran' from 'scorecard step crashed'"
metrics:
  duration: "5 minutes"
  completed: "2026-04-05"
  tasks_completed: 1
  tasks_total: 1
  files_modified: 1
---

# Phase quick-136 Plan 01: Audit CI Diagnostics Summary

**One-liner:** Replace bare missing-file list in audit.yml guard step with ARTIFACT_OWNER map, [OK]/[MISSING] per-artifact reporting, head-30 previews, and a structured summary block before exit 1.

## What Was Built

Enhanced the "Ensure audit artifacts exist" step in `.github/workflows/audit.yml` to produce structured diagnostic output when required audit artifacts are absent. The old implementation printed a bare list of missing paths with no ownership context. The new implementation:

1. Declares a bash associative array (`ARTIFACT_OWNER`) mapping each of the four required artifacts to the CI step that produces it.
2. For each artifact, prints `[OK]` + a `head -30` content preview (if present) or `[MISSING]` + the responsible step name (if absent).
3. After iterating all four artifacts, if any are missing: prints a "=== Missing artifact summary ===" block re-listing each missing artifact with its owner, then exits 1.
4. Exits 0 only when all four artifacts are present.

The `if: always()` condition was preserved. No other steps in the workflow were modified.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Enhance "Ensure audit artifacts exist" step with structured diagnostics | 749b84d | .github/workflows/audit.yml |

## Verification

- `grep -c "ARTIFACT_OWNER" .github/workflows/audit.yml` returns `2` (declaration + per-artifact loop use)
- `grep "Run audit gate\|Generate scorecard" .github/workflows/audit.yml` returns hits inside ARTIFACT_OWNER map
- All other step names unchanged: Checkout, Setup Node, Install audit dependencies, Collect changed audit fixtures, Run audit gate, Generate scorecard, Upload audit artifacts
- `python3 -c "import yaml,sys; yaml.safe_load(open(...))"` reports no parse errors

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `.github/workflows/audit.yml` exists and contains ARTIFACT_OWNER
- Commit 749b84d verified present in git log
