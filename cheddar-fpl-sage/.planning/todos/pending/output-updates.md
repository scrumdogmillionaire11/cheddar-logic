Gap Analysis vs. Actual Output
The actual output (summary.md) is better than the gap analysis describes in some areas:

Transfers ARE shown (Van de Ven → Collins, Watkins → Mané)
Injuries ARE attached to specific players
But the analysis still correctly identifies these real deficiencies:

#	Issue	Severity	Location
1	Confidence unjustified	High	output_formatter.py:88-91 - hardcoded map
2	Captaincy rationale weak	Medium	captain_selector.py:142 - only shows points
3	No delta shown	Medium	Output shows "+2.8 pts" but no comparison to alternatives
4	Chip reasoning empty	Low	Line 27: ChipType.TRIPLE_CAPTAIN with no justification
5	Risk too generic	Medium	output_formatter.py:251-272 - shows "acceptable" but no specifics
6	No squad health snapshot	High	Missing entirely - bench quality, weakest line
7	No "why not" section	Medium	No avoid list or rejected alternatives
8	Captain Δ not shown	Medium	0.2 pts difference, not displayed
Proposed Fix Priorities
Phase 1 - Critical (trust-building):

Add confidence justification line with numeric delta
Add squad health snapshot section
Show captain vs vice Δ with rationale
Phase 2 - Important (completeness):
4. Add bench rationale tags (MINUTES_RISK, FIXTURE_TRAP, etc.)
5. Add "Not Recommended" section with 2-4 players
6. Make chip reasoning show specific thresholds

Phase 3 - Polish:
7. Tone adjustments

