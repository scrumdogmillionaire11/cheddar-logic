#!/usr/bin/env python3
"""
Debug the captain candidate assessment
"""

import json
import sys
import os

# Add the current directory to the path to import from src/
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.analysis.enhanced_decision_framework import EnhancedDecisionFramework


def debug_captain_assessment():
    """Debug captain candidate assessment"""
    
    # Load test data
    with open('outputs/data_collections/enhanced_fpl_data_20251226_103157.json', 'r') as f:
        data = json.load(f)
    
    # Modify to have multiple transfers
    data['my_team']['team_info']['free_transfers'] = 4
    team_data = data['my_team']
    
    framework = EnhancedDecisionFramework()
    
    # Get squad and analyze
    squad = team_data.get('current_squad', [])
    
    # Mock fixture data
    fixture_data = {
        'gw_fixtures': [
            {'team': 'MCI', 'difficulty': 2, 'is_home': True},
            {'team': 'ARS', 'difficulty': 3, 'is_home': False}
        ]
    }
    
    # Test captain candidate detection
    has_strong_captain = framework._has_strong_captain_candidate(squad, fixture_data)
    print(f"🎯 Has strong captain candidate: {has_strong_captain}")
    
    # Check available chips
    available_chips = framework._get_available_chips(team_data.get('chip_status', {}))
    print(f"🎯 Available chips: {available_chips}")
    
    # Check specifically for Haaland
    starters = [p for p in squad if p.get('is_starter', False)]
    for player in starters:
        if 'Haaland' in player['name']:
            print(f"⭐ Found Haaland: {player['name']} - {player['total_points']} points")
    
    # Test the decision flow manually
    print("\n🤔 DECISION FLOW:")
    free_transfers = team_data.get('team_info', {}).get('free_transfers', 0)
    critical_needs = framework._assess_critical_transfer_needs(squad)
    bench_strength = framework._assess_bench_strength([p for p in squad if not p.get('is_starter', False)])
    
    print(f"1. Free transfers: {free_transfers}")
    print(f"2. Critical needs: {critical_needs}")
    print(f"3. free_transfers >= 3: {free_transfers >= 3}")
    print(f"4. critical_transfer_needs > 0: {critical_needs > 0}")
    print(f"5. Has strong captain: {has_strong_captain}")
    print(f"6. TC available: {'TRIPLE_CAPTAIN' in [str(chip) for chip in available_chips]}")
    print(f"7. Bench strength: {bench_strength}")
    print(f"8. bench_strength >= 15: {bench_strength >= 15}")


if __name__ == "__main__":
    debug_captain_assessment()