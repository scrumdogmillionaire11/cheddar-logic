---
phase: WI-0976
status: deferred
---

# WI-0976: Branch protections + required checks — DEFERRED

## Reason

Solo repo. Branch protections are a collaboration safety tool; they add friction without value when one person owns all pushes:

- Required status checks block hotfixes to main until CI passes
- Required reviews block self-merges without an admin bypass (which defeats the purpose)
- SHA gate + test suite in WI-0974/WI-0975 already enforce deploy integrity without repo-level restrictions

## Revisit when

Team grows beyond one active pusher to main.
