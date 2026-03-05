# ADR-0001: Agent Collaboration Contract

- Status: Accepted
- Date: 2026-03-05
- Decision Makers: lane/agent-governance

## Context
The repository has multiple agent entry points (Codex, Claude/PAX, Copilot) and partially divergent docs about canonical paths and project phase state. Without a strict scope protocol, concurrent edits risk collisions, hidden contract drift, and untraceable changes.

`.planning/STATE.md` indicates the project is entering Phase 3 (documentation and handoff), so governance consistency is now a blocker for safe parallel execution.

## Decision
Adopt a mandatory work-item operating model with these rules:
1. Every change maps to one `WORK_QUEUE/WI-####.md`.
2. Only one claimed owner edits a work item's scoped files.
3. Scope expansion must be recorded in the work item before edits.
4. `OWNERSHIP.md` defines default path owners and backup owners.
5. Shared touchpoints are serialized and require `needs-sync`.
6. Cross-agent conventions are documented through ADRs in `docs/decisions/`.

We also define source-of-truth precedence:
1. Active work item scope
2. `.planning/STATE.md`
3. `OWNERSHIP.md`
4. ADRs
5. Other docs

## Consequences
### Positive
- Deterministic ownership prevents co-edit collisions.
- Every PR can be audited against explicit scope.
- Multi-agent contributions converge on one authoritative project state.

### Negative
- Slightly higher process overhead for small fixes.
- Work-item maintenance is required before expanding scope.

## Implementation Notes
- Contract published in `AGENTS.md`.
- Ownership published in `OWNERSHIP.md`.
- Queue bootstrapped in `WORK_QUEUE/`.
- Scratch telemetry allowed in `CHANGES/`, but non-authoritative.
