#!/usr/bin/env python3
import asyncio
import json
from cheddar_fpl_sage.analysis import FPLSageIntegration

async def main():
    sage = FPLSageIntegration()
    results = await sage.run_full_analysis(save_data=False)
    
    if 'players' in results['raw_data']:
        players = results['raw_data']['players']
        print(f'Total players in raw_data: {len(players)}')
        
        # Show structure of first player
        if players:
            print("\nFirst player structure:")
            print(json.dumps(players[0], indent=2, default=str)[:500])
        
        # Try different key patterns
        for p in players[:5]:
            print(f"\nSample player keys: {list(p.keys())[:10]}")
            break
        
        # Look for Senesi and Scott with different key names
        for p in players:
            # Try web_name, first_name + last_name, etc.
            names_to_check = [
                p.get('name', '').lower(),
                p.get('web_name', '').lower(),
                f"{p.get('first_name', '')} {p.get('second_name', '')}".lower(),
                p.get('second_name', '').lower()
            ]
            
            if any('senesi' in n for n in names_to_check):
                print("\n✅ Found Senesi:")
                print(f"   web_name: {p.get('web_name')}")
                print(f"   full_name: {p.get('first_name')} {p.get('second_name')}")
                print(f"   position: {p.get('element_type')} / {p.get('position')}")
                print(f"   team: {p.get('team_name')} / {p.get('team')}")
                print(f"   price: {p.get('now_cost')} / {p.get('current_price')}")
            
            if any('scott' in n for n in names_to_check if 'mcscott' not in n):
                print("\n✅ Found Scott:")
                print(f"   web_name: {p.get('web_name')}")
                print(f"   full_name: {p.get('first_name')} {p.get('second_name')}")
                print(f"   position: {p.get('element_type')} / {p.get('position')}")
                print(f"   team: {p.get('team_name')} / {p.get('team')}")
                print(f"   price: {p.get('now_cost')} / {p.get('current_price')}")

if __name__ == "__main__":
    asyncio.run(main())
