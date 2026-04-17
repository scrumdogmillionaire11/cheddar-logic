# Phase 07 Context - Output Architecture Hardening

## Goal
Stabilize weekly output architecture by enforcing one canonical payload contract, removing duplicate transfer/chip/XI representations, moving business derivation ownership to backend transformer, and introducing retrospective weekly review data.

## Locked Decisions
- This is a contract and ownership cleanup, not an analytical engine rewrite.
- Canonical payload is mandatory and is the only allowed top-level response shape after migration.
- Backend owns derivation logic; frontend maps and renders.
- Retrospective review is a first-class contract, not derived UI copy.
- Preserve analytical engine behavior unless change is required to populate canonical output fields.

## Out of Scope
- Styling redesign and component visual refresh.
- Refactoring `enhanced_decision_framework.py` internals unrelated to output contract.
- Feature expansion beyond retrospective/current/horizon separation.

## Execution Order
1. Lock canonical payload model.
2. Make `result_transformer.py` canonical producer.
3. Thin frontend mapper and remove fallback inference.
4. Populate and surface weekly retrospective outcomes.
5. Move downstream consumers to canonical cards and retire parallel re-derivation.
