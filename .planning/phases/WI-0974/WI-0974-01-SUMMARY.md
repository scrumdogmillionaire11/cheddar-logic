---
phase: WI-0974
plan: 01
status: complete
---

# WI-0974: Immutable artifact per commit — branch deploy

## What was built

`.github/workflows/deploy-branch.yml` — a `workflow_dispatch` workflow with two jobs:

**build-artifact**
- Checks out the specified branch (or triggering branch)
- Installs + tests the worker
- Packs a tarball excluding node_modules, .git, .next, and DB files
- Uploads it as `worker-${sha}` via `actions/upload-artifact@v4` (14-day retention)
- The artifact name is immutable per commit SHA

**deploy-worker-pi**
- Connects to Tailscale
- SSHs to Pi, does `git fetch + reset --hard origin/<branch>` (not main)
- Installs prod deps, runs migrations, restarts `cheddar-worker`
- Verifies the worker is active after restart

## Key decisions

- `workflow_dispatch` only (not auto-triggered on every push) — prevents accidental deploys
- `worker_only: true` input exists for future web-build path
- Worker test gate runs in CI before artifact upload — immutable artifact is always test-passing
- No web build in this workflow; production deploys via `deploy-production.yml` on main
