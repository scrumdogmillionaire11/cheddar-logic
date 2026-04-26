---
phase: WI-0975
plan: 01
status: complete
---

# WI-0975: Block deploy unless SHA matches intent

## What was built

Added to `.github/workflows/deploy-branch.yml`:

1. **`target_sha` required input** — caller must supply the expected commit SHA when dispatching the workflow
2. **"Assert SHA matches intent" step** — immediately after checkout, compares `git rev-parse HEAD` against `inputs.target_sha`; fails with a human-readable error if they diverge

## Error output on mismatch

```
ERROR: SHA mismatch — branch has moved since you triggered this deploy.
  intended: abc123...
  actual:   def456...
Re-trigger with target_sha=def456... or push no new commits first.
```

## Key decisions

- `required: true` on `target_sha` — no silent bypass; caller must always be explicit about intent
- Strict block (exit 1), not a warning — the immutable artifact guarantee from WI-0974 is only meaningful if the SHA you built is the SHA you deployed
- Gate runs before any installs or tests — fast fail, no wasted runner time on a mismatched deploy
