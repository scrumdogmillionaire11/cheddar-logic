# MIGRATION.md — Repo Migration Plan to `cheddar-logic` Monorepo

## Status
- [ ] Not started
- [ ] In progress
- [ ] Blocked
- [ ] Completed

## Repo Role (one sentence)
Describe what this repo currently does in production.

## Target Location in Monorepo
Choose exactly one:
- `apps/web`
- `apps/worker`
- `packages/core`
- `packages/data`
- `packages/adapters`

Target path:
`cheddarlogic/<path>`

## What Must Be Preserved
List the invariants that cannot change:
- API routes and response JSON shapes
- CLI commands
- scheduled job behavior (frequency, idempotency)
- output file formats (if any)
- environment variable names (or mapping)

## Migration Checklist (must be checked in order)
### A) Baseline
- [ ] Document current run commands
- [ ] Capture 1–3 sample outputs (JSON, HTML, logs) as fixtures
- [ ] Add or verify a minimal test that asserts output shape

### B) Isolation
- [ ] Extract external dependencies behind adapter interfaces
- [ ] Replace hardcoded paths with config/env
- [ ] Ensure deterministic behavior for time (inject clock or store timestamps)

### C) Move
- [ ] Copy code into monorepo target path
- [ ] Replace cross-repo imports with monorepo package imports
- [ ] Update CI/test commands

### D) Verify
- [ ] Run tests in monorepo
- [ ] Compare outputs against baseline fixtures
- [ ] Confirm scheduler/job behavior unchanged

### E) Cutover
- [ ] Deploy monorepo version in parallel (if applicable)
- [ ] Switch traffic / cron / systemd to monorepo
- [ ] Monitor logs for errors
- [ ] Freeze old repo to maintenance-only

## Known Risks / Gaps
List anything unclear, brittle, or untested.

## Owners
- Primary: <you>
- Agent: <agent name>