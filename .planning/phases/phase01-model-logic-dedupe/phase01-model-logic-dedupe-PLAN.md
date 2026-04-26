---
phase: 01
plan: 01
title: Model Logic Deduplication
type: execution
autonomous: true
---

# Objective
Remove duplicated model logic and enforce a single source of truth for edge computation, while preserving original behavior.

# Context
- Cross-market owns edge computation.
- Job files must consume cross-market decisions only.
- Preserve intentional sport variance (e.g., NCAAM sigma=11).
- Do not refactor FPL.

# Tasks

1. **Edge ownership enforcement**
   - Update cross-market decisions to include: `edge`, `edge_key`, `edge_source`, `edge_version`, and any needed pricing fields.
   - Ensure `edge_key` is deterministic and follows the contract.
   - Add explicit `edge_source: 'cross-market'`, `edge_version: 'v1'`.

2. **Remove duplicate edge computation from job files**
   - Delete edge calculator calls from NBA/NHL/NCAAM job files.
   - Wire card payloads to read edge fields from decision objects.
   - No fallback computation; throw or fail in test/dev if missing.

3. **Update enforcement + fixtures**
   - Adjust AST ownership enforcement to prevent edge compute helpers in jobs.
   - Update fixtures/hashes if new edge fields are added.
   - Ensure no output changes beyond the new fields.

# Verification
- Ownership enforcement test passes.
- Edge computation test confirms one compute per `edge_key`.
- Golden fixtures match baseline except for added edge fields.
- No behavior change beyond ownership shift.

# Success Criteria
- Single source of truth for edge computation is cross-market.
- Job files contain no edge calculators.
- Card payloads include deterministic edge metadata.
- Changes committed atomically per task.
