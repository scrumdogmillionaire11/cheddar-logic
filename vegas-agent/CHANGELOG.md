# Changelog

## 0.2.0 - 2026-04-21

- Added `core/verification_contract.md` with blocker/action/state taxonomy and LEAN + `verification_state` semantics.
- Added `workflows/pre_flight.md` to formalize `GATE_CHECK` pre-flight checks and output contract.
- Added `workflows/verification_resolver.md` with resolver loop and terminal-state emit rules.
- Updated `workflows/bet_review.md` with named audit levels: `GATE_CHECK` and `STANDARD_AUDIT`.
- Updated `.claude/agents/vegas-auditor.md` context and verdict contract for verification-state-aware LEAN semantics.
- Updated `scripts/doctor.sh` to require the new verification markdown files.

## 0.1.0 - 2026-03-21

- Initial VEGAS agent package scaffolding
- Added core philosophy, edge framework, and risk docs
- Added workflows for bet review, card validation, and model output audit
- Added guardrails, prompts, and portable `.claude` agent definition
- Added install/update/doctor/link-integrity scripts
