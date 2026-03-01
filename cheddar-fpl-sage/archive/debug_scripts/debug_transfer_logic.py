#!/usr/bin/env python3
"""
Debug the critical transfer needs assessment
"""

import json
import sys
import os

# Add the current directory to the path to import from src/
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.analysis.enhanced_decision_framework import EnhancedDecisionFramework


def debug_transfer_assessment():
    """Debug why multi-transfer optimization isn't triggering"""
    
    # Load test data
    with open('outputs/data_collections/enhanced_fpl_data_20251226_103157.json', 'r') as f:
        data = json.load(f)
    
    # Modify to have multiple transfers
    data['my_team']['team_info']['free_transfers'] = 4
    team_data = data['my_team']
    
    framework = EnhancedDecisionFramework()
    
    # Get squad and analyze
    squad = team_data.get('current_squad', [])
    print("🔍 SQUAD ANALYSIS")
    print("="*60)
    
    # Check each player
    starters = [p for p in squad if p.get('is_starter', False)]
    print(f"Starters: {len(starters)}")
    
    critical_needs = 0
    for player in starters:
        status = player.get('status_flag', 'NONE')
        price = player.get('current_price', 0)
        points = player.get('total_points', 0)
        
        is_critical = False
        reason = ""
        
        if status == 'OUT':
            is_critical = True
            critical_needs += 1
            reason = "Status: OUT"
        elif status == 'DOUBT' and price > 8.0:
            is_critical = True
            critical_needs += 1
            reason = f"Status: DOUBT + Expensive (£{price}m)"
        elif not status or status == 'NONE':
            if price > 10.0 and points < (price * 8):
                is_critical = True
                critical_needs += 0.5
                reason = f"Expensive underperformer (£{price}m, {points}pts)"
        
        print(f"{'🚨' if is_critical else '✅'} {player['name']} ({player['team']}) - £{price}m, {points}pts, Status: {status} {reason}")
    
    print(f"\n🔢 Total Critical Transfer Needs: {critical_needs}")
    
    # Test the actual method
    framework_result = framework._assess_critical_transfer_needs(squad)
    print(f"🧠 Framework Assessment: {framework_result}")
    
    # Test bench strength
    bench_players = [p for p in squad if not p.get('is_starter', False)]
    bench_strength = framework._assess_bench_strength(bench_players)
    print(f"💪 Bench Strength: {bench_strength}")
    
    # Test the full decision logic
    print("\n🤔 DECISION LOGIC:")
    print(f"Free transfers: {team_data.get('team_info', {}).get('free_transfers', 0)}")
    print(f"Critical needs: {framework_result}")
    print(f"Free transfers >= 3: {team_data.get('team_info', {}).get('free_transfers', 0) >= 3}")
    print(f"Critical needs > 0: {framework_result > 0}")


if __name__ == "__main__":
    debug_transfer_assessment()