---
phase: pass-reason-integrity
verified: 2026-04-18T19:55:00Z
status: passed-after-adversarial-follow-up
score: 8/8 adversarial findings addressed or documented
---

# pass-reason-integrity Re-verification

The original verification report is superseded by this re-verification for the
stored payload truth-surface requirement. The prior report correctly verified
the first three implementation plans but overclaimed final card payload
provenance.

## Adversarial Findings

| Finding | Resolution |
|---------|------------|
| Production `PASS + ev_threshold_passed=false` cards bypassed blocker provenance | Fixed in `market-eval.js`; tests cover `PASS_CONFIDENCE_GATE` with raw edge and threshold fields |
| `assertLegalPassNoEdge` ignored `pass_reason_code` | Fixed; test G4 covers empty `reason_codes` plus `pass_reason_code=PASS_NO_EDGE` |
| Stored payloads lacked truth surface | Fixed in model cards and `run_mlb_model.js` final `payloadData` assembly |
| Verification only checked in-memory model driver cards | Added stored payload tests through `insertCardPayload` mocks |
| Full-game ML card builder could fabricate `PASS_NO_EDGE` via fallback | Replaced fallback with `PASS_UNKNOWN`; stored raw/threshold fields now propagate |
| `PASS_MODEL_DEGRADED` was likely unreachable for MLB full-game ML | Documented in ADR-0016 as reserved; MLB full-game ML follows ADR-0015 degraded-positive-edge WATCH behavior |
| Projection-floor coverage was source-only | Added stored payload behavior test proving `PASS_SYNTHETIC_FALLBACK` excludes `PASS_NO_EDGE` and records `NO_EVALUATION` |
| Contract docs were stale/missing | Added ADR-0016 and updated `docs/market_evaluation_contract.md` |

## Verification Command

```bash
npx jest --testPathPattern="market-eval.test|mlb-model.test|run-mlb-model.dual-run.test|run_mlb_model.test|post_discord_cards" --no-coverage
```

Result: 6 suites passed, 321 tests passed.

