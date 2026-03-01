---
phase: quick-002
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/cheddar_fpl_sage/analysis/fpl_sage_integration.py
autonomous: true

must_haves:
  truths:
    - "CLI output displays correct risk posture selected by user"
    - "Risk posture AGGRESSIVE shows as AGGRESSIVE not BALANCED"
    - "Risk posture persists from config through to markdown output"
  artifacts:
    - path: "src/cheddar_fpl_sage/analysis/fpl_sage_integration.py"
      provides: "DecisionOutput instances with risk_posture set"
      min_lines: 1900
  key_links:
    - from: "DecisionOutput instances (lines 421, 721, 1874)"
      to: "OutputFormatter.generate_decision_summary"
      via: "risk_posture attribute"
      pattern: "risk_posture=self\\.decision_framework\\.risk_posture"
---

<objective>
Fix risk posture display inconsistency where user-selected AGGRESSIVE posture shows as BALANCED in CLI output.

Purpose: Ensure the risk posture configured by the user is accurately displayed in the final markdown output, maintaining consistency between internal logic and user-facing display.

Output: CLI output correctly displays the configured risk posture (e.g., AGGRESSIVE) instead of defaulting to BALANCED.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
Bug context: User selected AGGRESSIVE risk posture. Log messages correctly show it's being used internally, but the final markdown output displays "Risk Posture: BALANCED".

Root cause: Three `DecisionOutput` instances in fpl_sage_integration.py are created without passing the `risk_posture` parameter, causing them to default to "BALANCED". The OutputFormatter reads `decision_output.risk_posture` to display in the summary (output_formatter.py:53-55).

Code flow:
1. User selects AGGRESSIVE → saved to config (fpl_sage.py:209-244)
2. FPLSageIntegration initializes decision_framework with risk_posture (fpl_sage_integration.py:56-60)
3. Decision analysis runs → creates DecisionOutput
4. OutputFormatter reads decision_output.risk_posture (output_formatter.py:53)
5. Displays in markdown as "**Risk Posture:** {risk_posture}"

Missing risk_posture parameter at:
- Line 421: Data gate block DecisionOutput
- Line 721: Exception handler DecisionOutput
- Line 1874: Fallback analysis DecisionOutput

All other DecisionOutput creations in enhanced_decision_framework.py correctly pass risk_posture=self.risk_posture.
</context>

<tasks>

<task type="auto">
  <name>Add risk_posture parameter to three DecisionOutput instantiations</name>
  <files>src/cheddar_fpl_sage/analysis/fpl_sage_integration.py</files>
  <action>
Add `risk_posture=self.decision_framework.risk_posture` parameter to three DecisionOutput constructor calls that are missing it:

1. **Line ~421** (data gate block):
```python
decision = DecisionOutput(
    primary_decision="HOLD",
    reasoning=reasoning,
    risk_scenarios=[],
    decision_status="HOLD",
    block_reason=gate_result.block_reason,
    risk_posture=self.decision_framework.risk_posture  # ADD THIS
)
```

2. **Line ~721** (exception handler):
```python
decision = DecisionOutput(
    primary_decision=f"HOLD - {exc_type}: {exc_msg[:50]}",
    reasoning=f"Projection analysis failed with {exc_type}. Check logs for details.",
    risk_scenarios=[...],
    decision_status="BLOCKED",
    confidence_score=0.0,
    risk_posture=self.decision_framework.risk_posture  # ADD THIS
)
```

3. **Line ~1874** (fallback analysis):
```python
return DecisionOutput(
    primary_decision="HOLD - Use GPT Integration",
    reasoning="Analysis system encountered errors. Please use GPT integration with this team data.",
    decision_status="BLOCKED",
    block_reason="Canonical projection system failed",
    confidence_score=0.0,
    risk_scenarios=[...],
    risk_posture=self.decision_framework.risk_posture  # ADD THIS
)
```

Why this fixes the bug: The OutputFormatter reads `getattr(decision_output, 'risk_posture', None)` to display the risk posture. Without this parameter, DecisionOutput uses its default value of "BALANCED" from enhanced_decision_framework.py:79. By passing the framework's risk_posture (which was correctly initialized from config), the output will show the user's actual selection.

Note: Do NOT modify enhanced_decision_framework.py or output_formatter.py - those are working correctly. The issue is only in these three exception/edge case paths in fpl_sage_integration.py.
  </action>
  <verify>
Run the following to confirm all DecisionOutput calls now include risk_posture:
```bash
grep -n "DecisionOutput(" src/cheddar_fpl_sage/analysis/fpl_sage_integration.py
```

All three instances should be followed by a check that risk_posture is set:
```bash
grep -A 8 "decision = DecisionOutput(" src/cheddar_fpl_sage/analysis/fpl_sage_integration.py | grep risk_posture
```

Expected: Should see 3 lines with `risk_posture=self.decision_framework.risk_posture`
  </verify>
  <done>
File src/cheddar_fpl_sage/analysis/fpl_sage_integration.py updated with risk_posture parameter added to all three DecisionOutput instantiations at lines ~421, ~721, and ~1874. All DecisionOutput calls in this file now correctly pass the configured risk posture through to the output formatter.
  </done>
</task>

</tasks>

<verification>
Test the fix:
1. Run CLI with AGGRESSIVE risk posture: `python fpl_sage.py --risk-posture AGGRESSIVE`
2. Check log output confirms: "FPLSageIntegration initialized with risk_posture=AGGRESSIVE"
3. Check final markdown output shows: "**Risk Posture:** AGGRESSIVE" (not BALANCED)
4. Test with CONSERVATIVE and BALANCED to ensure all three display correctly
</verification>

<success_criteria>
- [ ] All three DecisionOutput instantiations in fpl_sage_integration.py include risk_posture parameter
- [ ] CLI output displays the correct risk posture (AGGRESSIVE, CONSERVATIVE, or BALANCED)
- [ ] No regression in existing functionality (logs still show correct risk posture)
- [ ] Output formatter receives risk_posture attribute on decision_output object
</success_criteria>

<output>
After completion, create `.planning/quick/002-fix-risk-posture-display-in-cli-output/002-01-SUMMARY.md`
</output>
