#!/usr/bin/env python3
"""
Debug the chip type comparison
"""

import json
import sys
import os

# Add the current directory to the path to import from src/
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.analysis.enhanced_decision_framework import EnhancedDecisionFramework, ChipType


def debug_chip_comparison():
    """Debug chip type comparison"""
    
    # Load test data
    with open('outputs/data_collections/enhanced_fpl_data_20251226_103157.json', 'r') as f:
        data = json.load(f)
    
    team_data = data['my_team']
    framework = EnhancedDecisionFramework()
    
    # Check available chips
    available_chips = framework._get_available_chips(team_data.get('chip_status', {}))
    print(f"🎯 Available chips: {available_chips}")
    print(f"🎯 Chip types: {[type(chip) for chip in available_chips]}")
    
    # Check each chip individually
    for chip in available_chips:
        print(f"Chip: {chip}, Type: {type(chip)}, Value: {chip.value}")
    
    # Test the specific condition
    tc_available = ChipType.TRIPLE_CAPTAIN in available_chips
    print(f"🎯 TC in available_chips: {tc_available}")
    
    # Check enum values
    print(f"ChipType.TRIPLE_CAPTAIN: {ChipType.TRIPLE_CAPTAIN}")
    print(f"ChipType.TRIPLE_CAPTAIN.value: {ChipType.TRIPLE_CAPTAIN.value}")


if __name__ == "__main__":
    debug_chip_comparison()