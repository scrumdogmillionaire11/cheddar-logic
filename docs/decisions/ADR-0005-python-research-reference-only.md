# ADR-0005: Python Research Artifacts Retained as Reference-Only

**Status:** Decided  
**Date:** 2026-03-19  
**Owner:** Architecture  
**Relates to:** [research-gap-closure-checklist.md](../Claude-research/research-gap-closure-checklist.md), WI-0507  

---

## Decision

**Retain Python research artifacts (`Claude-research/files/`) as reference material. Do NOT promote to production sidecar architecture.**

The betting-model research prototypes (edge_engine.py, play_schema.py, projection_engine.py, kelly.py, etc.) will remain in the repo as documentation and algorithmic reference, but will not be wired into the production Cheddar worker runtime.

---

## Context

Research prototypes exist under `Claude-research/files/` but are not integrated into production:

- Full Python sidecar architecture with odds_api_client, market_router, python_client bridge
- Fractional Kelly staking engine
- Projection and edge-case analysis tools

The production runtime is Node/JS (Cheddar worker + web pipeline), with proven track record and stable operations.

### The Question

Should these Python artifacts be promoted into production (Path A), or kept as reference-only (Path B)?

---

## Why Path B (Reference-Only)

### 1. Production Node/JS Architecture Works

- Proven track record: Node/JS worker has been running sports models (NBA, NHL, NCAAM, Soccer, FPL) successfully for months
- Stable settlement pipeline: CLV telemetry, decision basis tagging, and threshold routing all implemented in JavaScript
- Active work queue (Soccer xG foundation, MLB A/B tranches, NFL expansion) are scoped and executable within current Node/JS runtime


### 2. Separation Already Proven (FPL Sage)

ARCHITECTURE_SEPARATION.md explicitly establishes that **two separate applications with their own databases** is the right pattern:

- **Cheddar (Node/JS):** owns `cheddar.db`, runs worker scheduler, generalist sports models
- **FPL Sage (Python):** owns `fpl_snapshots.sqlite`, runs standalone analysis, no Cheddar coupling


This separation principle validates that Python *can* work in the system, but as a **separate concern**, not as a replacement for the core betting pipeline.

### 3. Sidecar Adoption Would Require Massive Rewrite

Promoting Python sidecar would entail:

- **Deployment infrastructure redesign:** Two runtime versions in production (Node.js + Python)
- **Consumer code rewrite:** Web API, scheduler, settlement jobs would all need Python integration points
- **Cross-service reliability:** Network failures, timeouts, version mismatches all become operational burden
- **Migration strategy:** Historical `cheddar.db` data would need transformation or dual-write during transition
- **Testing matrix explosion:** More surface area, more failure modes, more on-call complexity


### 4. Research Models Have Clear Optional Status

From research-gap-closure-checklist.md:

- Fractional Kelly staking: "Optional future WI (if staking output is desired)"
- Full Python sidecar: "Decide whether to adopt sidecar or retire this path"


There is no evidence that Python is *required* for correctness or competitive necessity.

### 5. Phased Sport Expansion Works in Node/JS

The active work queue shows a clear sequencing path (Soccer → MLB → NFL) all within the current architecture:

- Soccer xG foundation (WI-0491): SQL table for FBref ingest, Poisson in JavaScript
- Soccer edge repair (WI-0492): Model prob - implied prob, JavaScript logic
- MLB A/B tranches (WI-0487, WI-0488): Odds-backed markets, projection props in Node/JS
- NFL expansion (WI-0489): Defer for operational safety


None of these require Python to be viable.

---

## What This Means

### Artifacts Retained

- `Claude-research/files/edge_engine.py`, `projection_engine.py`, `play_schema.py`, etc. remain in repo
- Value: Algorithm documentation, prototyping reference for future optimization
- Life cycle: Non-executed code; may rot if not periodically validated against repo schema changes


### Research Artifacts NOT Adopted

- No production wiring of Python models
- No sidecar deployment in production
- No Cheddar worker → Python bridge
- No scaling of Python runtime


### Active Work Continues

- Soccer, MLB, NHL, NFL expansion all proceed in Node/JS
- No architectural change required
- No double-booking of Python vs JavaScript implementations


### Tests Remain Executable

- `npm --prefix web run test:api:games:market` (Node/JS)
- `npm --prefix web run test:decision:canonical` (Node/JS)
- No Python-specific test suites are required for production mission


---

## Future Reversibility

**If conditions change**, a future ADR can reverse this decision:

- Evidence: Massive performance gains only possible in Python (e.g., 10x faster model evaluation)
- Evidence: New sport or market requires Python-specific capabilities
- Process: New work item, scoped ADR, explicit follow-on tasks for sidecar infrastructure


**Rollback would be:**

1. Retire Python integration layer from Node/JS workers
2. Revert consumer code to pure JavaScript
3. Keep `Claude-research/files/` archived in repo indefinitely
4. Document lessons learned


**Owner for future reversals:** Architecture team. Any request to reverse requires explicit ADR with evidence.

---

## Records Affected

1. **research-gap-closure-checklist.md:** Mark Python sidecar as "Decided → Reference-only, no adoption"
2. **ARCHITECTURE_SEPARATION.md:** Add note: Python research is reference material; production uses Node/JS runtime
3. **WORK_QUEUE/README.md:** Document decision; update active sport priorities


---

## Related ADRs

- None currently (first architectural decision about Python integration)

## Related Issues

- WI-0507: Research Closure Decision — Python Sidecar Adoption vs Reference-Only Archive

