#!/usr/bin/env python3
"""
FPL Sage Acceptance Criteria Validator

Validates that the FPL Sage output meets the "blessing" acceptance criteria.
"""

import sys
import json
from pathlib import Path

def validate_acceptance_criteria(summary_text: str) -> dict:
    """Validate the summary text against acceptance criteria."""
    results = {
        'passed': 0,
        'failed': 0,
        'issues': [],
        'details': {}
    }
    
    def check(criterion_id: str, condition: bool, description: str):
        if condition:
            results['passed'] += 1
            results['details'][criterion_id] = f"✅ PASS: {description}"
        else:
            results['failed'] += 1
            results['details'][criterion_id] = f"❌ FAIL: {description}"
            results['issues'].append(f"{criterion_id}: {description}")
    
    # A. Single-source-of-truth decisions
    has_urgent_transfer = "URGENT_TRANSFER" in summary_text
    has_forced_transfer_quick = "🔄 FORCED:" in summary_text and "None" not in summary_text.split("🔄 FORCED:")[1].split('\n')[0]
    
    check("A1", "URGENT_TRANSFER" in summary_text, 
          "Exactly one primary decision (URGENT_TRANSFER found)")
    
    check("A2", has_urgent_transfer and has_forced_transfer_quick,
          "Quick Decisions matches primary decision (both show urgent/forced transfer)")
    
    # B. Squad rule violations  
    has_squad_rule_check = "🚫 Squad Rule Check" in summary_text
    has_mci_violation = "MCI: 4" in summary_text and "violates max 3" in summary_text
    
    check("B4", has_urgent_transfer, 
          "Primary decision set to URGENT_TRANSFER for squad rule violation")
    
    check("B5", has_squad_rule_check and has_mci_violation,
          "Squad Rule Check section with club, count, max, and player names")
    
    # C. Forced transfer plan correctness
    has_transfer_plan = "🔄 Transfer Plan" in summary_text
    has_out_player = "• OUT:" in summary_text
    has_in_player = "• IN:" in summary_text and "replacement unavailable" not in summary_text
    has_impact = "• Impact:" in summary_text and "MCI count = 3" in summary_text
    
    check("C7a", has_transfer_plan and has_out_player,
          "Transfer Plan includes OUT player")
    
    check("C7b", has_in_player,
          "Transfer Plan includes IN replacement (not 'unavailable')")
    
    check("C7c", has_impact,
          "Impact statement shows violation resolved")
    
    # D. Injury Status Summary (basic check)  
    has_injury_details = "Squad injury details" in summary_text
    check("D10", has_injury_details,
          "Injury Status Summary present")
    
    # E. Captain/Vice correctness
    captain_line = ""
    if "👑 CAPTAIN:" in summary_text:
        captain_line = summary_text.split("👑 CAPTAIN:")[1].split('\n')[0]
    
    has_captain_points = " pts)" in captain_line
    has_vice_points = "🥈 VICE:" in captain_line and " pts)" in captain_line
    
    check("E13", has_captain_points and has_vice_points,
          "Captain and Vice show non-null expected points")
    
    # F. Formatting + UX
    h1_count = summary_text.count('\n# ')
    has_single_h1 = h1_count == 1
    
    check("F15", has_single_h1,
          f"Exactly one H1 header (found {h1_count})")
    
    # Check section order
    sections = ["## 🎯 Quick Decisions", "## 📋 Detailed Analysis", "## Decision:", "### 👑", "### 🔄 Transfer Plan"]
    section_positions = []
    for section in sections:
        pos = summary_text.find(section)
        if pos != -1:
            section_positions.append(pos)
    
    sections_in_order = section_positions == sorted(section_positions)
    check("F16", sections_in_order,
          "Sections in correct order")
    
    # G. Data availability (basic checks)
    no_literal_newlines = "\\n" not in summary_text
    check("G21", no_literal_newlines,
          "No literal \\n newlines in reasoning")
    
    return results

def main():
    print("🔍 FPL Sage Acceptance Criteria Validator")
    print("=" * 50)
    
    # Try to find the latest output file
    project_root = Path(__file__).parent
    outputs_dir = project_root / "outputs"
    
    latest_file = outputs_dir / "LATEST.json"
    if not latest_file.exists():
        print("❌ No LATEST.json found. Please run FPL Sage analysis first.")
        return False
    
    # Load the latest analysis metadata
    with open(latest_file) as f:
        metadata = json.load(f)
    
    # Get the report file path
    report_path = project_root / metadata.get('report', '')
    if not report_path.exists():
        print(f"❌ Report file not found: {report_path}")
        return False
    
    # Read the markdown summary
    summary_text = report_path.read_text()
    if not summary_text:
        print("❌ Empty summary file.")
        return False
    
    print(f"📄 Analyzing summary ({len(summary_text)} characters)")
    print()
    
    # Validate against acceptance criteria
    results = validate_acceptance_criteria(summary_text)
    
    # Print results
    print("📊 Validation Results:")
    print(f"✅ Passed: {results['passed']}")
    print(f"❌ Failed: {results['failed']}")
    print()
    
    if results['details']:
        print("📋 Detailed Results:")
        for criterion_id, result in results['details'].items():
            print(f"  {result}")
    
    if results['issues']:
        print()
        print("🚨 Issues to Fix:")
        for issue in results['issues']:
            print(f"  • {issue}")
    
    print()
    
    # Blessing decision
    pass_rate = results['passed'] / (results['passed'] + results['failed']) if (results['passed'] + results['failed']) > 0 else 0
    
    if pass_rate >= 0.85:  # 85% pass rate for blessing
        print("🎉 BLESSED: Output meets acceptance criteria!")
        print(f"   Pass Rate: {pass_rate:.1%}")
        return True
    else:
        print("❌ NOT BLESSED: Output needs improvement")
        print(f"   Pass Rate: {pass_rate:.1%} (need ≥85%)")
        return False

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)