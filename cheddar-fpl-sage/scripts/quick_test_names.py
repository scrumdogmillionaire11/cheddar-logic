#!/usr/bin/env python3
"""
Quick Transfer Tester
Test player names before adding them to your transfers
"""

import sys
import asyncio

from cheddar_fpl_sage.collectors.enhanced_fpl_collector import EnhancedFPLCollector


async def quick_test():
    """Quick interactive test for player names"""
    
    if len(sys.argv) > 1:
        # Command line mode
        test_names = sys.argv[1:]
    else:
        # Interactive mode
        print("🧪 Quick Player Name Tester")
        print("=" * 35)
        print("Test if your player names will work in transfers.")
        print("Enter player names (separate with spaces if multiple):")
        
        user_input = input("\nPlayer names: ").strip()
        if not user_input:
            print("No names entered.")
            return
        
        test_names = user_input.split()
    
    # Get FPL data
    async with EnhancedFPLCollector() as collector:
        bootstrap = await collector.fetch_json("/bootstrap-static/")
    
    elements = {p['id']: p for p in bootstrap['elements']}
    
    print(f"\n📝 Testing {len(test_names)} player names:")
    print("=" * 40)
    
    successful = 0
    failed = []
    
    for name in test_names:
        matched_player = collector._match_player(name, elements)
        
        if matched_player:
            print(f"✅ '{name}' → {matched_player['web_name']}")
            print(f"   Full: {matched_player['first_name']} {matched_player['second_name']}")
            print(f"   Team: {matched_player.get('team_code', 'Unknown')}")
            successful += 1
        else:
            print(f"❌ '{name}' → Not found")
            failed.append(name)
    
    print(f"\n📊 Results: {successful}/{len(test_names)} successful")
    
    if failed:
        print("\n💡 Failed names - try these alternatives:")
        
        # Suggest similar matches for failed names
        for name in failed:
            suggestions = []
            name_lower = name.lower()
            
            for player in list(elements.values())[:50]:  # Sample first 50 to avoid too much output
                web_name = player['web_name'].lower()
                first_name = player['first_name'].lower()  
                second_name = player['second_name'].lower()
                
                if (name_lower in web_name or web_name in name_lower or
                    name_lower in first_name or name_lower in second_name):
                    suggestions.append(player['web_name'])
            
            if suggestions:
                print(f"   '{name}' → Try: {', '.join(suggestions[:3])}")
            else:
                print(f"   '{name}' → Try checking the exact spelling on FPL website")
    
    print("\n💡 Tips:")
    print("• Use exact web names from FPL: 'M.Salah' not 'Mohamed Salah'")
    print("• First names often work: 'Mohamed', 'Erling'")
    print("• Case doesn't matter: 'SALAH' works")
    print("• When in doubt, use player ID numbers")


if __name__ == "__main__":
    asyncio.run(quick_test())
