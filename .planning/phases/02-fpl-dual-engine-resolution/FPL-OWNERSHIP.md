# FPL Ownership & Maintenance Guide

## Responsibility Matrix

| Component | Owner | Contact | Maintenance |
|-----------|-------|---------|-------------|
| Worker FPL Types | Worker Team | apps/worker/src/models/ | Update when Sage schema changes |
| Sage API | Sage Team | cheddar-fpl-sage/ | Maintain backward compatibility |
| Integration Tests | Shared | apps/worker/src/models/__tests__/ | Run on every deploy |
| Contract Docs | Shared | .planning/phases/02-fpl-dual-engine-resolution/ | Review quarterly |

## When Sage Changes

1. **Minor update?** (bug fix, optimization)
   - Sage team: just deploy
   - Worker team: no action needed

2. **Schema change?** (new field, type change)
   - Sage team: bump API version
   - Worker team: update FPL-CONTRACT.md and fpl-types.js
   - Both: run integration tests

3. **Breaking change?** (field removal, rename)
   - **Not allowed without 30-day deprecation notice**
   - Sage team: notify Worker team
   - Plan coordinated rollout

## Testing Before Deploy

```bash
# Run Worker tests
npm --prefix apps/worker test

# Run integration tests
npm --prefix apps/worker test -- fpl-integration

# Validate Sage API (manual)
curl http://localhost:5000/fpl/predictions/1

Quick Reference
Sage API location: cheddar-fpl-sage/backend/api/
Worker consumer: apps/worker/src/models/fpl.js
Contract: .planning/phases/02-fpl-dual-engine-resolution/FPL-CONTRACT.md
Types: apps/worker/src/models/fpl-types.js

