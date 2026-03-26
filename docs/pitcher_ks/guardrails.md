# Guardrails

These rules exist to prevent the most common failure modes of strikeout prop systems. They are non-negotiable. They cannot be overridden by a strong narrative, a favorable overlay stack, or a gut read.

---

## G-01 — No projection, no play

**Rule:** If the engine cannot produce a projection — missing data, opener/bulk role, fewer than 3 season starts — evaluation halts. No play is issued.

**Why:** A verdict without a projection is a guess. The entire pipeline depends on a calculable number. There is no exception.

---

## G-02 — No margin, no play

**Rule:** If the projection does not clear the margin floor for the side (0.5K over, 0.75K under), evaluation halts at Block 1. No play is issued regardless of leash, overlays, or trap scan result.

**Why:** Thin edges are not edges. They are noise. A 0.3K margin on a prop with standard juice means you need the K total to land on the right side of a coin flip you're not significantly ahead on. That is not a bet — that is a punt.

---

## G-03 — No leash, no over

**Rule:** A Short leash, IL return, or extended rest flag kills the over before any other scoring runs. The over is structurally invalid. The projection cannot be trusted because the IP ceiling is not real.

**Why:** The projection is built on expected IP. If the IP ceiling is capped by an organizational limit you cannot see in the pitch count data, your projection is wrong before you start.

---

## G-04 — No sample, no overlay credit

**Rule:** An overlay that does not meet its minimum sample requirement scores zero. Not a fractional score. Not a leaning. Zero. Missing samples are not estimated.

**Why:** Small samples can produce any K rate. A pitcher with a 35% K rate against three batters in 14 PA tells you nothing. Crediting an unqualified BvP as a "light boost" is storytelling. This engine does not tell stories.

---

## G-05 — Two trap flags = no verdict

**Rule:** When two or more trap flags are active, the play is unscoreable. No verdict is issued. The play is logged as "environment compromised."

**Why:** One trap means the edge is reduced. Two traps mean the environment is too compromised to produce a reliable verdict. The confluence of factors creates unknown interactions between them. The safe and correct response is to pass.

---

## G-06 — Overlays do not create edge

**Rule:** A favorable overlay stack (trend +1, ump +1, BvP +1) does not justify a play with a below-floor margin or a fake leash.

**Why:** Overlays confirm that conditions are favorable for a pitcher who already projects to beat the line. They cannot conjure edge from a neutral or negative projection. A pitcher projecting to 6.8 Ks against a line of 7.5 Ks is a 0-pt Block 1 regardless of how good the ump looks.

---

## G-07 — Unders require bigger margins

**Rule:** Under margin floors and tier thresholds are structurally higher than over equivalents. This is permanent and reflects real market design, not a temporary adjustment.

**Why:** Books build over-bias into strikeout prop pricing because the public leans over on star pitchers. The under is priced with that bias baked in. To confirm a real under edge, you need to clear the public-bias premium built into the line.

---

## G-08 — Look at the line after the projection

**Rule:** The projection is always calculated before the market line is consulted. Looking at the line first anchors the projection.

**Why:** If you know the line is 7.5, your projection will tend toward 7.5 or 8.0. This is anchoring bias — a well-documented cognitive failure that degrades projection quality. The number must be built independently of the market.

---

## G-09 — Confirmed lineup only

**Rule:** BvP, lineup context gap trap, and opponent environment multiplier refinements are run against the confirmed starting lineup only. Projected lineups are not substituted.

**Why:** A projected lineup is a guess. A confirmed lineup is a fact. BvP scored against a projected lineup that changes at game time produces a false signal. The trap scan cannot catch lineup context gaps against a projected lineup.

---

## G-10 — One trap flag is not a kill

**Rule:** One active trap flag scores Block 5 as zero but does not halt evaluation. The play proceeds with the reduced confidence score. Two flags are required to suspend.

**Why:** Almost every play has at least one thing that could go wrong. One flag is a headwind that the confidence scoring accounts for. Using one flag as a kill-switch would eliminate too many valid plays. Two flags indicate a structurally compromised environment — that is the threshold.

---

## G-11 — Confidence is earned, not assumed

**Rule:** The default confidence level for any play is zero. Points are added by the scoring model based on confirmed evidence. The burden is on the play to earn confidence — not on the engine to find reasons to discount it.

**Why:** Systems that start from "this looks good" and then look for disqualifying reasons will play through bad edges. Systems that start from zero and require evidence will discard them. The latter produces better long-term results.

---

## G-12 — The pass is a verdict

**Rule:** A pass is not a failure of the engine. A pass is a valid output. Logging a pass is as important as logging a play.

**Why:** The value of any selection system comes from what it does not play as much as what it does. A system that plays everything with a positive margin will get blown up by trap plays and fake leashes. Passes protect the bankroll. They must be tracked, logged, and reviewed for calibration.

---

## G-13 — No chasing CLV in prop markets

**Rule:** Closing line value is not used as a confidence signal in prop markets. Line movement at sharp books is a directional check only (Block 4), not a CLV calculation.

**Why:** Prop markets are illiquid. Sharp money moves prop lines disproportionately because limits are low. The market efficiency that makes CLV meaningful in game markets does not exist in props. A prop line moving in your direction confirms you're not obviously wrong — it does not confirm you're right.

---

## G-14 — Velocity data is a forward-looking signal

**Rule:** A velocity drop of >1.5 mph over the last 3 starts versus season average triggers a -2 penalty regardless of whether K/9 has declined yet.

**Why:** K/9 is a lagging indicator. Velocity decline precedes strikeout decline by 2–4 weeks in most cases because batters take time to adjust and because pitchers compensate with location before they lose the ability to miss bats. Betting the over into a velocity decline means betting against a regression that is already in motion.