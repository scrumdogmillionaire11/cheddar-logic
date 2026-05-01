---
phase: WI-1228
status: ready
work_item: WI-1228
---

# WI-1228 Validation

## Commands

### Wave 1

```bash
npm --prefix packages/models test -- src/__tests__/threshold-registry-completeness.test.js --runInBand
npm --prefix packages/models test -- src/__tests__/decision-pipeline-v2-promotion.test.js --runInBand
```

Expected assertions:

- promotion registry has explicit entries for all six approved sport/market pairs
- helper-level promotion success/failure branches pass
- clean qualifying `LEAN` integrations promote to `PLAY`
- heavy-favorite and NBA-total quarantine post-promotion demoters still apply

### Wave 2

```bash
npm --prefix packages/data test -- src/__tests__/reason-codes.test.js --runInBand
npm --prefix packages/data test -- __tests__/decision-outcome.test.js --runInBand
npx tsc -p web/tsconfig.json --noEmit
```

Expected assertions:

- `HIGH_END_SLIGHT_EDGE_PROMOTION` is registered, labeled, and schema version updated
- additive promotion metadata does not break decision-outcome normalization or validation
- web shared DecisionV2 type accepts the new optional fields

### Wave 3

```bash
npm --prefix apps/worker run test -- src/utils/__tests__/decision-publisher.v2.test.js --runInBand
npm --prefix packages/models test -- src/__tests__/decision-authority-lifecycle.test.js --runInBand
```

Expected assertions:

- promotion metadata survives publish unchanged
- emitted reasons include `HIGH_END_SLIGHT_EDGE_PROMOTION`
- final publish status remains standard `PLAY`
- internal `LEAN` still maps to external `SLIGHT_EDGE`
- existing `PASS` semantics remain unchanged
