# THE BOARD: Value Proposition & User Impact One-Pager

For WI-0938 Requirements Specification

---

## What is THE BOARD?

THE BOARD is a **market reasoning engine** — it answers one question: **"What's wrong in the market right now, and what should I do about it?"**

It's not a picks feed. It's not a stats page. It's a **decision advantage system** that shows:

1. **Where the market is wrong** (framed as specific errors, not just disagreements)
2. **Whether you should act** (FIRE / WAIT / PASS)
3. **What conditions unlock action** (explicit triggers)
4. **When we're *not* acting** (blocked edges as trust builder)

It's a sibling to THE WEDGE (picks/recommendations), designed to serve traders and analytical learners who want to understand *why* edges exist and whether they're exploitable right now.

---

## Core Value Streams

### 1. **"What's Wrong" Intelligence**

**User Problem:** "Is the market mispriced on this? Should I care?"

**THE BOARD's Value:**

- Surfaces specific **market errors** (not just disagreements): stale pricing, structural misses, behavioral biases, information gaps
- Classifies edge type so user understands *why* the edge exists
- Shows whether edge is stable or fragile with deterministic quality scoring
- Teaches users to recognize repeatable mispricing patterns

### 2. **"What Do I Do" Decisiveness**

**User Problem:** "So what? Am I supposed to bet this or wait or pass?"

**THE BOARD's Value:**

- Every opportunity gets an **action state**: FIRE / WAIT / PASS (unavoidable clarity)
- FIRE = bet now (all conditions met)
- WAIT = conditional (unlock when X confirms)
- PASS = suppressed (not actionable, even with edge)
- Explicit **trigger conditions** so user knows exactly what changes the decision

### 3. **"Why We're Not Betting" Trust**

**User Problem:** "Why didn't you show this? Am I missing something?"

**THE BOARD's Value:**

- **Blocked Edges tab** surfaces strong edges Cheddar is *not* playing with exact unlock conditions
- Builds trust by showing disciplined suppression (no forced plays)
- Teaches users model sensitivity: which unknowns break the edge
- Directly reinforces your "no play is a play" philosophy

### 4. **Pattern Recognition System**

**User Problem:** "How often does this edge type actually work? Should I learn this?"

**THE BOARD's Value:**

- Edge Type Tracker shows historical performance by category (stale, structural, behavioral, timing)
- Users identify repeatable patterns they can act on independently
- Moves user from directive follower → pattern learner → independent operator

---

## How THE BOARD Creates Decision Advantage

| Principle | THE BOARD's Expression | User Outcome |
| --- | --- | --- |
| **Market Error Framing** | Shows specific market mistakes, not just model disagreement | User understands *why* to act |
| **Action State Clarity** | FIRE / WAIT / PASS removes ambiguity | User knows exactly what to do |
| **Trigger Explicitness** | "FIRE if X happens" makes conditions unavoidable | User executes without overthinking |
| **Blocked Edge Trust** | Shows strong suppressed edges with unlock conditions | User trusts model restraint |
| **Quality Determinism** | Edge Quality Score is explainable, not a black box | User understands edge stability |
| **Pattern Repeatability** | Historical performance by edge type | User builds independent judgment |

---

## Target User Profiles

### Profile A: Analytical Capacity Builder

Professionals developing trading/betting judgment. They want to:

- Understand market microstructure by observing real prices and movement
- Learn why Cheddar models diverge from consensus
- Build mental models of market behavior through repeated exposure
- Understand confidence/uncertainty, not eliminate it

**THE BOARD's Value:** Turns market observation into structured learning

### Profile B: Analytical Community Participant

Learners who thrive in collaborative analysis. They want to:

- Discuss methodology in real community conversations
- Participate in post-mortems of predictions vs outcomes
- Contribute critiques and test ideas
- Challenge and refine their own thinking through disagreement

**THE BOARD's Value:** Provides shared reference data for community discussion

### Profile C: Serious Bettors / Traders

Decision-makers needing market context before executing. They want to:

- Fast access to best available prices without line-shopping manually
- Real-time awareness of market movement and arbitrage
- Clarity on where their analysis differs from market pricing
- Liquidity and venue intelligence before committing capital

**THE BOARD's Value:** Reduces friction, surfaces opportunity context, enables faster execution

---

## Why THE BOARD is NOT "Just Another Model Output"

| Typical Picks Service | Cheddar THE BOARD |
| --- | --- |
| "Here's a play" | "Here's what's wrong + what to do" |
| Confidence % only | Confidence % + Quality Score + Action State |
| Shows edges | Shows *why* edges exist |
| Hides uncertainty | Makes uncertainty explicit (TBD = WAIT) |
| One best price | Best prices across books + variation context |
| No when suppressed | Clear PASS reasoning + unlock conditions |
| Static / historical | Real-time current state only |
| Passive delivery | Active trigger system |
| Trust model blindly | Learn patterns independently |

---

## THE BOARD Tabs: MVP Feature Structure

### Tab 1: 🔥 **Opportunities** (Action-Oriented)

**What it shows:**

```
EDGE: +1.8% | QUALITY: 8.2/10 | STATE: WAIT

MARKET ERROR:
Vegas anchored to outdated pace assumptions (pre-report)

EDGE TYPES:
📉 Stale Price (Primary)
🏃 Structural (Secondary)

ACTION:
→ WAIT: Goalie confirmation pending
→ FIRE if: Both starters confirmed + line ≤ 216
→ PASS if: Backup starter confirmed

QUALITY DRIVERS:
✓ Multi-source edge (price + structural)
✓ Confirmed lineup data available
✗ Goalie still TBD

PATTERN:
Back-to-back unders w/ stale pace (58-87 | +8.4% ROI)
```

**Why it matters:**
- User knows exactly what to do (no overthinking)
- Conditions are explicit (no ambiguity)
- Quality is explainable (not a black box)
- Pattern context accelerates learning

---

### Tab 2: 🚫 **Blocked Edges** (Trust Builder)

**What it shows:**

```
NBA: NYK @ BOS | Total 208.0
Our model: 205.2 (+1.3% edge)

STATE: PASS (currently blocked)

WHY BLOCKED:
Starting lineup not confirmed until 6:30pm
Model assumes full strength → edge breaks with key injury

UNBLOCK CONDITIONS:
→ Roster confirmed + line ≤ 208.5 → FIRE
→ Key player ruled out → RECALCULATE (edge reverses)
```

**Why it matters:**
- Shows disciplined suppression (no forced plays)
- Builds trust: "They're not gambling with unknowns"
- Teaches model sensitivity
- Directly aligns with "no play is a play" philosophy

---

### Tab 3: 🧠 **Edge Type Tracker** (Learning/Power Users)

**What it shows:**

```
📉 STALE PRICE EDGES
Sample: 34 | Hit Rate: 62% | ROI: +5.1%
Trend: ↑ (sharp books catching up faster)

🧠 INFORMATION EDGES  
Sample: 8 | Hit Rate: 75% | ROI: +12.3%
Trend: ↑ (available more frequently now)

🏃 STRUCTURAL EDGES
Sample: 12 | Hit Rate: 58% | ROI: +2.1%
Trend: → (stable, hard to time)

🧠 BEHAVIORAL (Fade Public)
Sample: 19 | Hit Rate: 53% | ROI: -1.2%
Trend: ↓ (public sharper than ever)

⏱ TIMING EDGES
Sample: 4 | Hit Rate: 75% | ROI: +14.2%
Trend: ↑ (rare but high conviction)
```

**Why it matters:**
- Users identify repeatable patterns
- Historical performance by edge type
- Users build independent judgment
- Retention through pattern learning

---

## Success Criteria for THE BOARD MVP

### Action Clarity
- Every opportunity has clear FIRE / WAIT / PASS state (no ambiguity)
- Trigger conditions are explicit (users know what changes the action)
- Blocked edges are visible (trust in suppression logic)

### User Engagement
- Users return daily to check action states (not just pick publication)
- Users reference blocked edge reasoning in Discord ("this teaches me model sensitivity")
- Users interact with Edge Type Tracker ("which pattern should I learn?")

### Learning Outcomes
- Users understand why edges exist (market error framing)
- Users can identify repeatable patterns (stale price vs structural vs timing)
- Users build independent betting judgment (transition from directive → pattern learner)

### Business Traction
- Reduced churn from "no pick published" (blocked edge context shows discipline)
- Increased retention from pattern learning (users build habits around edge types)
- Community becomes reference point for methodology ("did you see the timing edge tracker?")

---

## Key Differentiation: Current State Over Cached History

**Non-Negotiable Requirement:**
THE BOARD displays **latest deterministic scan output only**, preventing users from:
- Acting on outdated odds that have since moved significantly
- Building false confidence in stale disagreement signals
- Missing real-time arbitrage/mover context

This means:
- Market Pulse data is live, not cached
- Each refresh shows current price reality
- No user confusion between "what was true yesterday" vs "what's true now"

---

## Integration with THE WEDGE

**THE WEDGE** (picks surface): "Here's our model recommendation with confidence."  
**THE BOARD** (intelligence surface): "Here's what the market is doing right now."

Users navigate between them based on their goal:
- Want our pick? → THE WEDGE
- Want to understand market dynamics? → THE BOARD
- Want community discussion of methodology? → Share a BOARD observation in Discord

---

## Onboarding / User Orientation

1. **Introduction:** "THE BOARD answers one question: what's wrong in the market and what should you do?"
2. **Opportunity Card:** Show FIRE example (action is immediate, triggers are clear)
3. **Blocked Edge:** Show PASS example with unlock conditions ("see how we prevent forced plays?")
4. **Pattern Learning:** Show one Edge Type tracker ("spot patterns you can act on independently")
5. **Community Bridge:** "Share blocked edge reasoning or pattern wins in Discord"

---

## Summary: THE BOARD as a Decision Advantage System

THE BOARD converts edge reasoning into clear action.

**THE WEDGE** = "Here's our pick"  
**THE BOARD** = "Here's what's wrong + what to do + why we're not acting when we're not"

It serves users who want to:
- **Act faster** (no ambiguity about FIRE/WAIT/PASS)
- **Understand why** edges exist (market error framing)
- **Trust suppression** (blocked edges + unlock conditions)
- **Learn independently** (pattern recognition by edge type)

By splitting product into THE WEDGE (directives) and THE BOARD (reasoning engine), Cheddar Logic creates a competitive moat:

❌ Not: "A smarter model"  
✅ Yes: **"A system that explains its edges and teaches users to act on them independently"**

That's how sharps think. That's retention. That's community.
