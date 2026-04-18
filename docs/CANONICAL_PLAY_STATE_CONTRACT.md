# Canonical Play-State Contract

**Status**: Active  
**Introduced**: 2026-04-17  
**Owner**: Core decision pipeline (`packages/models/src/decision-policy.js`)

---

## Problem This Solves

Before this contract, play status was re-derived independently by Discord, /wedge, POTD, and the card transform layer. This caused:

- Discord showing "Slight Edge" for market-unavailable candidates (should be WATCH)
- /wedge displaying verification-pending plays as if they were actionable leans
- POTD ranking "considered" nominees when no fireable candidates existed
- Conditional / unavailable-market cases treated the same as true leans

**The fix**: one resolver runs once, upstream. Every downstream surface reads from its output.

---

## Canonical States

| State | Meaning | Is a Play? | POTD Eligible? |
|---|---|---|---|
| `OFFICIAL_PLAY` | Cleared model threshold + all guardrails + watchdog + official tier gate | YES | YES |
| `LEAN` | Positive opinion, below official threshold, clean market | NO | NO |
| `WATCH` | Positive signal but market is in a waiting/unavailable state | NO | NO |
| `NO_PLAY` | Evaluated; insufficient edge | NO | NO |
| `BLOCKED` | Hard gate or watchdog veto — terminal | NO | NO |

---

## Canonical Contract Fields (per candidate payload)

| Field | Type | Description |
|---|---|---|
| `final_play_state` | `string` | One of the 5 canonical states above. Set once by `finalizeDecisionFields()`. |
| `official_eligible` | `boolean` | True only when `final_play_state === 'OFFICIAL_PLAY'`. |
| `potd_eligible` | `boolean` | True only when `final_play_state === 'OFFICIAL_PLAY'`. |
| `decision_v2.official_status` | `'PLAY' \| 'LEAN' \| 'PASS'` | Model-layer classification. Input to the resolver. |
| `decision_v2.watchdog_status` | `string` | Watchdog verdict. `'BLOCKED'` is terminal. |
| `reason_codes` | `string[]` | Normalized reason codes used by the resolver. |

---

## Resolver: `resolveCanonicalPlayState(payload)`

**Location**: `packages/models/src/decision-policy.js`  
**Exported via**: `@cheddar-logic/models`

### Order of Operations

```
1. BLOCKED check (terminal — no downstream override)
   └─ watchdog_status === 'BLOCKED'  → BLOCKED
   └─ official_eligible === false    → BLOCKED
   └─ any HARD_GATE_CODE in reason_codes  → BLOCKED

2. WATCH check (applies only when official_status is PLAY or LEAN)
   └─ sharp_price_status === 'PENDING_VERIFICATION'  → WATCH
   └─ any WATCH_REASON_CODE in reason_codes  → WATCH

3. official_status === 'PLAY'  → OFFICIAL_PLAY

4. official_status === 'LEAN'  → LEAN

5. Default  → NO_PLAY
```

### HARD_GATE_CODES (trigger BLOCKED)

```
HEAVY_FAVORITE_PRICE_CAP, FIRST_PERIOD_NO_PROJECTION, EXACT_WAGER_MISMATCH,
NO_PRIMARY_SUPPORT, MODEL_PROB_MISSING, PROXY_EDGE_BLOCKED
```

### WATCH_REASON_CODES (trigger WATCH when official_status is PLAY or LEAN)

```
LINE_NOT_CONFIRMED, EDGE_RECHECK_PENDING, PRICE_SYNC_PENDING,
MARKET_DATA_STALE, BLOCKED_BET_VERIFICATION_REQUIRED, GATE_LINE_MOVEMENT,
MISSING_DATA_NO_ODDS, MARKET_PRICE_MISSING, MARKET_EDGE_UNAVAILABLE,
GOALIE_UNCONFIRMED, GOALIE_CONFLICTING, INJURY_UNCERTAIN,
WATCHDOG_STALE_SNAPSHOT, STALE_MARKET_INPUT, PROJECTION_INPUTS_STALE_FALLBACK,
TEAM_METRICS_FALLBACK_PREV_DAY, MISSING_DATA_PROJECTION_INPUTS,
MISSING_DATA_DRIVERS, MISSING_DATA_TEAM_MAPPING, PASS_MISSING_DRIVER_INPUTS,
PASS_DATA_ERROR
```

---

## When the Resolver Runs

The resolver runs inside `finalizeDecisionFields()` in `apps/worker/src/utils/decision-publisher.js`, after:

1. Model classification (`buildDecisionV2` / pipeline)
2. Consistency checks (`syncCanonicalDecisionEnvelope`)
3. Watchdog / hard gates (`applyDecisionVeto`, `official_eligible` check)

and before any card is published, sent to Discord, rendered in /wedge, or considered for POTD.

`applyDecisionVeto()` stamps `final_play_state = 'BLOCKED'` directly (always terminal).

---

## Downstream Rendering Rules

### Discord (`deriveWebhookBucket` in `decision-policy.js`)

| `final_play_state` | Discord bucket | Discord label |
|---|---|---|
| `OFFICIAL_PLAY` | `official` | PLAY |
| `LEAN` | `lean` | Slight Edge |
| `WATCH` | `pass_blocked` | (watch reason — NOT Slight Edge) |
| `NO_PLAY` | `pass_blocked` | (pass reason) |
| `BLOCKED` | `pass_blocked` | (block reason) |

**Critical**: WATCH goes to `pass_blocked`, never to `lean`. A market-unavailable candidate must not appear as "Slight Edge."

The NHL-specials paths (`isNhlTotal`, `is1P`) continue to use their own surface status fields (`nhl_totals_status.status`, `nhl_1p_decision.surfaced_status`) since those surfaces compute their own state. For all other cards, `final_play_state` takes precedence over the legacy `action`/`classification`/`official_status` multi-source lookup.

### /wedge

/wedge renders via `CardsPageClient` which reads `final_market_decision` built server-side. Payloads published to the DB include `final_play_state`. No local re-classification is permitted.

### POTD

POTD eligibility requires `final_play_state === 'OFFICIAL_PLAY'` (equivalently: `potd_eligible === true`).

- If no fireable nominees exist (`edgePct > POTD_MIN_EDGE`, `totalScore >= POTD_MIN_TOTAL_SCORE`, positive edge), POTD returns `bestCandidate = null` → NO_PICK.
- `diagnosticNominees` (sub-threshold, possibly negative-edge) are returned for internal diagnostics only and must never be written to `potd_nominees` or used to select a POTD.
- POTD cards (`buildCardPayloadData`) stamp `final_play_state = 'OFFICIAL_PLAY'`, `official_eligible = true`, `potd_eligible = true` explicitly.

---

## POTD Eligibility Contract

Hard rules — non-negotiable:

1. Negative edge → `final_play_state = 'NO_PLAY'` → not POTD eligible.
2. `WATCH` → not POTD eligible.
3. `BLOCKED` → not POTD eligible.
4. `LEAN` → not POTD eligible.
5. Zero `OFFICIAL_PLAY` candidates → POTD must return NO_PICK; do not fall back to `LEAN` or `diagnosticNominees`.

---

## Invariants

1. There is exactly one canonical `final_play_state` per candidate payload.
2. That state is assigned once, upstream, in `finalizeDecisionFields()` or `applyDecisionVeto()`.
3. Downstream surfaces only render from it; they do not re-decide.
4. `OFFICIAL_PLAY` is the only state that counts as a play.
5. `LEAN` is never an official play.
6. `WATCH` is not a play.
7. `BLOCKED` is not a play.
8. POTD can only be chosen from `OFFICIAL_PLAY` candidates.
9. If zero `OFFICIAL_PLAY` candidates exist, POTD must be NO_PICK.
10. A negative-edge candidate can never become POTD or `OFFICIAL_PLAY`.
11. A watchdog veto is terminal — no downstream surface may override it.

---

## Failure Modes & Guards

| Risk | Guard |
|---|---|
| Silent upgrade: surface re-derives status from `action`/`classification` instead of `final_play_state` | `deriveWebhookBucket` reads `final_play_state` first; legacy path only for payloads that pre-date the field |
| Enum drift: new reason code added that should be WATCH but isn't in `WATCH_REASON_CODES` | Add to `WATCH_REASON_CODES` set in `decision-policy.js`; update tests |
| Legacy fields still consumed: `action='HOLD'` conflated with LEAN in Discord | Legacy fallback in `deriveWebhookBucket` applies only when `final_play_state` is absent |
| UI label mismatch: WATCH shown as "Slight Edge" | `WATCH → pass_blocked` bucket; Discord bucket never maps WATCH to 'lean' |
| POTD ranking from raw pool: `diagnosticNominees` written as nominees | `rankedNominees = fireableNominees` (no fallback); `diagnosticNominees` never written to `potd_nominees` |
| Market-unavailable candidate masquerading as lean | `WATCH_REASON_CODES` triggers `WATCH`, not `LEAN`; `deriveWebhookBucket` routes to `pass_blocked` |

---

## Tests

`packages/models/src/__tests__/decision-policy.test.js` — `describe('resolveCanonicalPlayState')` block covers all 10 required scenarios:

1. Positive edge + hard gate failure → `BLOCKED`
2. Positive edge + market unavailable → `WATCH`
3. Positive edge below official threshold → `LEAN`
4. Official candidate passes all gates → `OFFICIAL_PLAY`
5. No OFFICIAL_PLAY candidates → resolver returns `LEAN`, not `OFFICIAL_PLAY`
6. Negative-edge / PASS status → `NO_PLAY`
7. Discord renders PLAY/Slight Edge/WATCH strictly from `final_play_state`
8. LEAN with blocking reason codes → `WATCH`, not `LEAN`
9. Watchdog veto overrides `PLAY` → `BLOCKED`
10. PASS status cannot manufacture a play; `official_eligible=false` → `BLOCKED`
