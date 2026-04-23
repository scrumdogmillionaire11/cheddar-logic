---
quick_task: 171
work_item: WI-1135
description: "WI-1135: Decompose API Results Route And Isolate Reporting Workloads"
date: 2026-04-23
status: in_progress
---

# Plan

1. Claim WI-1135 and keep edits within the scoped route/results modules plus GSD bookkeeping.
2. Extract `/api/results` cache, SQL/query, and transform responsibilities into the scoped `web/src/lib/results/*` modules while preserving the public response shape and diagnostic `_diag` gating.
3. Run the WI test commands, update the quick-task summary/state, and commit the scoped change set.

# Verification

- `npm --prefix web run test:api:results:decision-segmentation`
- `npm --prefix web run test:api:results:flags`
- `npm --prefix web run test:ui:results`
