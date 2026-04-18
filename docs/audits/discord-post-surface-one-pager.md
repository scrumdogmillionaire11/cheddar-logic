# Discord Post Surface One-Pager

## Purpose

This is the reviewable reference for how Discord card posts are assembled today in `apps/worker/src/jobs/post_discord_cards.js`.

It is meant to be edited. If product wording changes, this file should be updated alongside the snapshot tests.

## What Actually Gets Posted

Discord posts are game-grouped snapshots. A game is posted only if it has at least one rendered `PLAY` or `Slight Edge` item.

High-signal blocked items can now create a `WATCH (Would be PLAY)` section.

Pure `PASS` / no-edge items still do not create a post by themselves.

## Top-Level Layout

Each posted game renders in this order:

1. Divider line
2. Sport + ET start time
3. Abbreviated matchup
4. Snapshot timestamp in ET
5. `PLAY` section if at least one official card renders
6. `WATCH (Would be PLAY)` section if a high-signal play is blocked by a gating reason
7. `Slight Edge (Lean)` section if at least one lean card renders
8. Closing divider line

Actual shape:

```text
─────────────────
🏒 NHL | 7:00 PM ET
WSH Capitals @ CBJ Blue Jackets
Snapshot: 10:00 AM ET

🟢 PLAY
ML | HOME (-115)
Why: Model edge confirmed at current number.

⚠️ WATCH (Would be PLAY)
ML | HOME (+100)
Edge: +0.21
Why: Would be PLAY, but line unstable — waiting for confirmation

🟡 Slight Edge (Lean)
TOTAL | UNDER 6.5 (-108)
5.8 | Edge: +0.70 (strong lean)
Why: Projection still favors the under, but not enough for PLAY.
─────────────────
```

## Section Semantics

### `🟢 PLAY`

Shown when a card lands in the canonical `official` bucket.

Current sources:

- `payloadData.webhook_bucket = official`
- Legacy fallback: action `FIRE` or classification `BASE`
- NHL 1P fallback: canonical `nhl_1p_decision.surfaced_status = PLAY`

### `🟡 Slight Edge`

Shown when a card lands in the canonical `lean` bucket and clears the lean-edge filter.

Current sources:

- `payloadData.webhook_bucket = lean`
- Legacy fallback: action `WATCH` / `LEAN` / `HOLD`, or classification `LEAN`
- NHL 1P fallback: canonical `nhl_1p_decision.surfaced_status = SLIGHT EDGE`

Lean cards can still be suppressed before posting:

- if `projection_only = true`
- if required selection/direction is missing
- if a total has neither projection nor edge
- if the lean fails `DISCORD_MIN_LEAN_EDGE`

Lean strength is now shown inline when edge is available:

- `Edge: +0.70 (strong lean)` for higher-signal leans
- `Edge: +0.20 (thin lean)` for thinner but still postable leans

### `⚠️ WATCH (Would be PLAY)`

Shown for cards in the `pass_blocked` bucket when they still carry meaningful bettor signal.

Current requirements:

- blocking/gating reason present (`BLOCK_*`, `GATE_*`, `*_VERIFICATION_*`, goalie or line-movement gates)
- and signal still exists via edge, projection, or `BEST` / `GOOD` tier

This section exists to answer the user question:

> "What would I care about soon, even if I cannot bet it yet?"

### `⚪ PASS`

Pure `PASS` items are tracked but are not rendered inline when a game already has actionable content.

Current behavior:

- `PASS`-only no-edge games are skipped entirely
- blocked high-signal games can render under `⚠️ WATCH (Would be PLAY)`
- mixed games do not show a `PASS` block
- internal pass reason codes should never appear in Discord text

There is a helper for collapsed pass summaries, but the current snapshot flow does not emit a standalone `PASS` post for dead games.

## Line-Level Layout

### Standard markets

Standard market rows render as:

```text
{MARKET} | {SELECTION} {LINE} ({PRICE})
{PROJECTION} | Edge: {SIGNED_EDGE}
Why: {FREE_TEXT_REASON}
```

Notes:

- The middle line appears only when projection and/or edge exist.
- The `Why:` line appears only when a free-text field such as `why`, `reason`, or `notes` exists.
- `line` is embedded in the first line, not repeated in the metrics line.

Examples:

```text
ML | HOME (-115)

TOTAL | OVER 6.0 (-110)
6.8 | Edge: +1.10
Why: Market still short of the model total.

1P | UNDER 1.5 (-112)
1.1 | Edge: +0.80
```

### Player props

Prop rows render slightly differently:

```text
PROP | {PICK_STRING_OR_SELECTION} ({PRICE})
{PROJECTION} | Edge: {SIGNED_EDGE}
Why: {FREE_TEXT_REASON}
```

## Truthfulness Rules

These are the review points that matter most:

1. Bucket truth comes from canonical webhook fields first.
2. A game is only posted when there is bettor-usable content.
3. `PASS` reasons do not leak as raw tokens into posted text.
4. `Slight Edge` means a real lean, not a blocked play.
5. Projection-only cards are suppressed from Discord even if they look directional.
6. High-signal blocked plays should be visible as `WATCH (Would be PLAY)`.

## Current Phrase Inventory

Humanized pass or block reasons used by Discord:

| Internal code | Discord phrase |
| --- | --- |
| `LINE_NOT_CONFIRMED` | `Line not confirmed` |
| `MODEL_PROB_MISSING` | `Model incomplete — no play` |
| `PASS_NO_EDGE` | `No edge` |
| `NO_EDGE_AT_PRICE` | `Price too sharp` |
| `PASS_LOW_CONFIDENCE` | `Low confidence` |
| `PASS_SHARP_MONEY_OPPOSITE` | `Sharp money against — no play` |
| `GATE_GOALIE_UNCONFIRMED` | `Goalie not confirmed` |
| `GATE_LINE_MOVEMENT` | `Line moved — re-evaluating` |
| `BLOCK_INJURY_RISK` | `Injury risk flag` |
| `MARKET_DATA_STALE` | `Market data stale` |

If a code is not mapped, Discord falls back to `No edge`.

## What Never Should Appear

These should be treated as bugs if they appear in a Discord post:

- raw tokens like `PASS_NO_EDGE` or `LINE_NOT_CONFIRMED`
- incomplete rows like `1P | 1.5`
- price junk like `(@ null)`
- projection-only cards shown as actionable plays
- a `PASS` block shown under a game that already has a `PLAY` or `Slight Edge`
- blocked plays with real signal silently disappearing

## Tests That Lock This Down

- `apps/worker/src/jobs/__tests__/post_discord_cards.test.js`
- `web/src/__tests__/game-card-pass-surface-contract.test.js`
- `docs/audits/human-truthfulness-audit.md`

---
Adversarial Feedback

Alright, I’m gonna be your actual Discord user here—not a dev, not a spec reader.

I’m scrolling the channel at 7pm trying to decide what to bet.

---

# 🧠 What this Discord post is doing WELL

## ✅ 1. Clean, scannable structure

This is strong.

* Game grouped ✔️
* Clear sections ✔️
* PLAY vs Slight Edge separation ✔️

As a user:

> I can instantly find the game + actionable stuff

That’s exactly what you want.

---

## ✅ 2. “PLAY” vs “Slight Edge” is intuitive

This works.

* 🟢 = bet it
* 🟡 = maybe / watch

No explanation needed. That’s good product.

---

## ✅ 3. The “Why” line is valuable

When it’s good, it’s really good.

Example:

> “Model edge confirmed at current number”

That’s simple and useful.

---

## ✅ 4. It avoids clutter (mostly)

* No PASS spam ✔️
* No raw codes ✔️

That’s a big win compared to most betting feeds.

---

# 🚨 Now the real stuff — what needs to be FIXED

## ❌ 1. It lies by omission (biggest issue)

You are hiding **why something is NOT a play**

Example from earlier:

* 21% edge
* BEST tier
* shows as PASS in app
* Discord shows nothing

As a user I think:

> “Guess there was nothing there”

Reality:

> There was a massive edge but something blocked it

That’s a problem.

---

## ❌ 2. “Slight Edge” is doing too much work

Right now 🟡 Slight Edge means:

* small edge
* OR medium edge
* OR blocked play
* OR waiting on confirmation
* OR maybe just noise

That’s 5 different meanings.

As a user:

> I don’t know if I should care or ignore it

---

## ❌ 3. No visibility into blocked plays (HUGE miss)

This is the sharpest feedback I can give you:

👉 The most valuable info is often:

> “This WOULD be a play but…”

And you’re hiding that.

You already have great reasons:

* Line unstable
* Goalie not confirmed
* Injury risk

But those never show unless it’s downgraded into a Slight Edge (and even then it’s unclear)

---

## ❌ 4. No hierarchy within Slight Edge

Right now:

```text
🟡 Slight Edge
TOTAL | UNDER 6.5 (-108)
5.8 | Edge: +0.70
```

and

```text
🟡 Slight Edge
TOTAL | OVER 6.5 (-110)
6.6 | Edge: +0.10
```

look the same.

That’s bad.

---

## ❌ 5. The “Why” is often too generic

Stuff like:

> “Projection still favors the under”

That tells me nothing.

Compare that to:

> “Line moved against model — waiting for confirmation”

WAY better.

---

## ❌ 6. Missing urgency / timing context

You already track:

* line movement
* verification
* goalie status

But the post doesn’t tell me:

* wait?
* bet now?
* monitor?

Everything looks static.

---

# 🎯 What I would change (as a user)

## 1. Add a “⚠️ Blocked Play” concept (this is HUGE)

Example:

```text
⚠️ WATCH (Would be PLAY)
ML | WSH +100
Why: Line unstable — waiting for confirmation
```

This is gold.

Now I know:

> “Oh shit, this might be something soon”

---

## 2. Split Slight Edge into two meanings

Keep label the same, but clarify:

### Option A (better copy)

```text
🟡 Slight Edge (Lean)
🟡 Slight Edge (Gated)
```

OR

### Option B (cleaner UX)

* Slight Edge → real lean
* Watch → blocked play

---

## 3. Show strength inside Slight Edge

Add a tiny signal:

```text
Edge: +0.70 (strong lean)
Edge: +0.20 (thin)
```

or even just:

* strong lean
* thin lean

---

## 4. Upgrade the “Why” line

Force it to answer:

> “Why is this not a PLAY?”

Examples:

Bad:

> Projection favors the under

Good:

> Not a PLAY — edge below threshold

Better:

> Would be PLAY, but goalie not confirmed

Best:

> Would be PLAY — waiting on goalie confirmation (expected in 30–60 min)

---

## 5. Add one line of context at top (optional but strong)

Something like:

```text
Note: Plays require confirmed lines + goalies
```

Sets expectations immediately.

---

# 🧀 Final blunt user take

Right now:

> This is a clean feed of bets

What it COULD be:

> A sharp decision feed that tells me:
>
> * what to bet
> * what to watch
> * what’s about to become a bet

---

# 🔥 The one thing I’d fix first

If you only do ONE thing:

👉 Surface **“Would be PLAY but blocked”**

That’s where your edge actually lives.

Everything else is polish.
