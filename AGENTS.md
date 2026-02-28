# AGENTS.md — Operating Contract (Read First)

## Mission
This repository is part of a migration into a single monorepo named `cheddar-logic`.
Your job is to:
1) keep current production behavior stable
2) extract code into monorepo-compatible modules
3) standardize contracts (data schemas, job interfaces)
4) leave behind test coverage and runnable scripts

## Non-Negotiables
- Do not introduce new features unrelated to migration.
- Do not change business logic unless explicitly required for correctness.
- Any refactor must preserve output shape and meaning.
- No long-running servers are created just to “match” old repo structure.
- Anything “shared data” becomes DB schema + shared package in monorepo, not its own service.

## Definition of Done (DoD)
A task is DONE only if:
- It runs locally with documented commands.
- It has at least one automated test (unit or integration) validating behavior.
- It produces the same outputs (or same API responses) as before.
- It is wired into the monorepo plan (paths, ownership, boundaries).
- It includes an updated MIGRATION.md checklist item.

## Allowed Changes
✅ Move files/folders, rename modules, add adapters/wrappers  
✅ Add tests, add typing, add schema validation  
✅ Replace hardcoded config with env vars  
✅ Add idempotency + job_run logging (recommended)

## Forbidden Changes
❌ Breaking API contracts or output JSON structure  
❌ Introducing new external dependencies without justification  
❌ Adding new microservices / repos  
❌ “Big bang” rewrites

## Required Outputs for Any PR
- What changed (1–3 bullets)
- Why it changed (1–2 bullets)
- How to run/test locally
- Evidence (test output, sample payload, screenshot if UI)

## Repo Boundary Rules
- Ingestion pulls external data → worker jobs
- Web app renders UI → reads from DB or internal API
- Shared data lives in database + shared package (schema/types)
- Card payloads are persisted and served (web never recomputes heavy logic)

## Escalation Rules
If you detect:
- schema ambiguity
- multiple competing sources of truth
- missing tests on critical logic
You must:
1) document the risk in MIGRATION.md
2) propose the smallest safe patch
3) avoid guessing

## Working Style
- small PRs
- predictable commits
- deterministic outputs
- explicit time-based behavior (timestamps stored, staleness computed)

