# Sports Betting Model Research Transcript

## 1) Initial Research Request

**User:**
Are you able to find any data on the top profitable sports betting models across all sports? Can you research that and provide some insights?

**Assistant (research synthesis):**
This is a great research rabbit hole, and there is solid academic and practitioner-level data that maps to The Cheddar Board.

### Key findings

1. **Calibration beats raw accuracy**
   - A study cited from ScienceDirect reported much stronger ROI when models were selected for probability calibration rather than hit-rate accuracy.
   - Takeaway: a model with slightly lower win rate can outperform if its probabilities are better calibrated.

2. **Closing Line Value (CLV) is the core metric**
   - Sharp practitioners prioritize CLV over short-term win/loss.
   - Beating closing lines consistently is a stronger indicator of long-term edge.

3. **Efficiency differs by sport/market**
   - NFL/CFB/MLB often show more exploitable pockets than NBA/NHL spread markets in many studies.
   - Smaller markets, props, and live markets may retain more inefficiency.

4. **Staking approach matters**
   - Fractional Kelly is generally preferred over full Kelly for bankroll survival and long-horizon growth.

5. **Core implementation implication**
   - The biggest profitability gap is often calibration + CLV tracking, not just model “accuracy.”

---

## 2) Markets by Sport: Least Volatile + Most Profitable Tendencies

**User:**
Tell me the markets in each sport that are tending to be least volatile and most profitable.

**Assistant (cross-sport synthesis):**

- **NFL:** selective sides/totals and situational spots; key-number sensitivity is critical.
- **NHL:** totals and certain moneyline structures may be less efficiently priced than expected.
- **MLB:** F5 moneyline often isolates starter edge and reduces bullpen variance.
- **Soccer (EPL/Bundesliga style findings):** stronger home-side signals in some xG-based approaches.
- **NCAAM:** market softness can be higher than NBA in some segments.

### Practical stack proposed

- NFL situational totals
- MLB F5 moneylines
- NHL totals (with model-specific directional bias)
- EPL home-win/xG-aligned spots

---

## 3) Build Request: Full Market Model Coverage

**User:**
Can we write and configure models for all of the top markets in each sport?

**Assistant requested implementation context before coding:**

### Questions + user answers

- **Where does your current Sports Data Decision Engine live?**
  - Local files
- **Which sports first?**
  - NFL, MLB, NBA, NHL, EPL, NCAAM, MLS, Champions League
- **Primary output format?**
  - Python scripts
- **Current model output per play?**
  - Edge % (numeric), confidence tier (HOT/WATCH/etc.), recommended bet type
- **Odds source?**
  - The Odds API
- **Model structure preference?**
  - One file per sport (`sport_model.py`)

---

## 4) Proposed Architecture (5 Layers)

1. `odds_api_client.py`
   - Fetch odds, normalize prices, remove vig, implied probabilities
2. `market_router.py`
   - Route by sport + market type
3. `[sport]_model.py` x8
   - NFL, MLB, NBA, NHL, EPL, NCAAM, MLS, UCL
4. `edge_engine.py`
   - Edge logic, market-aware sigma assumptions, Kelly sizing
5. `play_schema.py`
   - Unified output object across markets

### Example standardized play object

- Game, sport, market, pick
- `edge_pct`
- tier (HOT/WATCH/PASS)
- `kelly_stake`
- reasoning array

---

## 5) Player Props: Least Volatile vs Highest Variance

**User:**
How about player props per sport, same idea — least volatile, most profitable?

**Assistant synthesis:**

### Universal principle

- Volume/behavior stats are typically less volatile than binary outcome stats.

### By sport (summary)

- **NFL:** rushing/receiving volume often steadier than TD props
- **NBA:** PRA, rebounds, assists often steadier than 3PM/stocks
- **MLB:** pitcher Ks/outs often steadier than HR/RBI props
- **NHL:** shots on goal/saves often steadier than goal/assist props
- **Soccer:** shots on target/saves often steadier than first-goalscorer
- **NCAAM:** usage-driven points/rebounds can be steadier than 3PM props

### Tiering concept

- **Tier 1:** volume-driven props
- **Tier 2:** execution-dependent with matchup edge
- **Tier 3:** high-variance binary/rare events

---

## 6) Important Clarification from User

**User:**
Current Odds API fetch only covers game totals/sides/spreads. Player props, team totals, and NHL 1P O/U are projection-based and should be treated differently than edge finders.

**Assistant:**
That distinction is correct and important.

### Two-system architecture

1. **System A: Market Edge Finder**
   - Uses market line + model probability
   - Outputs edge vs line

2. **System B: Projection Engine**
   - Produces true-stat projections first
   - Only computes edge when a reliable line is available for comparison

### Tracking guidance

- Keep model families logically separate
- Use tailored performance tracking per family
- User preference captured: projection quality tracked by win rate on recommended side

---

## 7) Integration Into Current Node/TS Cron System

**User:**
How would I best implement these models into my current system?

**User environment answers:**

- Current system: Node project with multiple JS/TS modules
- Current behavior: fetch odds, compute edge for totals/spreads, write plays, display in UI
- Runtime: scheduled jobs (cron/task scheduler)

**Assistant recommendation:**

- Keep Node scheduler and pipeline intact
- Add Python models as a sidecar service (e.g., FastAPI)
- Node calls Python endpoints for model outputs
- Merge returned model plays into existing write/display flow

### Proposed bridge files

- `python/api.py`
- `python/requirements.txt`
- `src/python_client.js`

---

## 8) Notes

- Original transcript included UI artifacts such as `Searched the web`, `show_widget`, and view-transition snippets; these were removed for readability.
- Content intent was preserved and organized into thematic sections.
