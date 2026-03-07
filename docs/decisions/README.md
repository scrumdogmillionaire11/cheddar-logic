# Architecture Decision Records

This directory stores repo-level decisions that affect architecture, public interfaces, or cross-agent conventions.

## Naming
- `ADR-####-short-title.md`

## Status Labels
- `Accepted`
- `Superseded`
- `Deprecated`
- `Proposed`

## Current ADRs
- `ADR-0001-agent-collaboration-contract.md` — establishes work-item scope ownership, ownership precedence, and shared touchpoint serialization.
- `ADR-0002-single-writer-db-contract.md` — worker is sole DB writer; web server is strictly read-only; use `closeDatabaseReadOnly()` for all web-side teardown.
