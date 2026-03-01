#!/usr/bin/env python3
"""
Example: Using Manual Transfer Data
Demonstrates how to check and use manual transfer overrides in your analysis
"""

import os
from datetime import datetime

from cheddar_fpl_sage.utils.manual_transfer_manager import ManualTransferManager


def example_usage():
    """Example of how to use manual transfer data in your analysis"""
    
    config_path = os.path.join(os.path.dirname(__file__), '..', 'config', 'team_config.json')
    manager = ManualTransferManager(config_path)
    
    print("📊 Manual Transfer Integration Example")
    print("=" * 45)
    
    # 1. Check if manual overrides exist
    overrides = manager.get_manual_overrides()
    
    if not overrides:
        print("ℹ️  No manual overrides found.")
        print("💡 Run 'python scripts/manage_transfers.py' to add some.")
        return
    
    # 2. Extract different types of overrides
    transfers = overrides.get('planned_transfers', [])
    captain = overrides.get('captain') or overrides.get('captain_id')
    vice = overrides.get('vice_captain') or overrides.get('vice_captain_id')
    starters = overrides.get('planned_starters', [])
    
    print(f"🔄 Found {len(transfers)} pending transfers")
    print(f"👑 Captain override: {captain if captain else 'None'}")
    print(f"🥈 Vice override: {vice if vice else 'None'}")
    print(f"⚽ Starter overrides: {len(starters)}")
    
    # 3. Process transfers for analysis
    if transfers:
        print("\n📝 Processing transfers for analysis:")
        total_cost = 0
        
        for i, transfer in enumerate(transfers, 1):
            out = transfer.get('out_name', transfer.get('out_id', 'Unknown'))
            in_player = transfer.get('in_name', transfer.get('in_id', 'Unknown'))
            cost = transfer.get('cost', 0)
            total_cost += cost
            
            print(f"  {i}. {out} → {in_player} (cost: {cost})")
        
        print(f"\n💰 Total transfer cost: {total_cost} points")
        
        # Example: How you might use this in analysis
        if total_cost != 0:
            print(f"⚠️  Analysis should account for {total_cost} point hit")
        else:
            print("✅ All transfers are free - no hit penalty")
    
    # 4. Show how to integrate with team analysis
    print("\n🔧 Integration with analysis:")
    print("- Use transfers to build projected team composition")
    print("- Apply captaincy overrides to expected lineup")
    print("- Factor transfer costs into point projections")
    print("- Validate bench strength with new lineup")
    
    # 5. Example of clearing old overrides
    last_updated = overrides.get('last_updated')
    if last_updated:
        updated_time = datetime.fromisoformat(last_updated.replace('Z', '+00:00'))
        hours_old = (datetime.now() - updated_time).total_seconds() / 3600
        
        print(f"\n⏰ Manual overrides last updated: {hours_old:.1f} hours ago")
        
        if hours_old > 48:
            print("⚠️  Consider updating or clearing old manual overrides")


def example_quick_operations():
    """Example of quick programmatic operations"""
    config_path = os.path.join(os.path.dirname(__file__), '..', 'config', 'team_config.json')
    manager = ManualTransferManager(config_path)
    
    print("\n🚀 Quick Operations Example")
    print("-" * 30)
    
    # Example: Add a transfer programmatically
    success = manager.add_quick_transfer("Example Player Out", "Example Player In", -4)
    
    if success:
        print("✅ Example transfer added successfully")
        
        # Show the result
        transfers = manager.get_pending_transfers()
        if transfers:
            latest = transfers[-1]
            print(f"Latest transfer: {latest}")
        
        # Clean up the example
        overrides = manager.get_manual_overrides()
        if 'planned_transfers' in overrides:
            # Remove the example transfer
            overrides['planned_transfers'] = [t for t in overrides['planned_transfers'] 
                                            if not (t.get('out_name') == "Example Player Out")]
            manager.update_config_with_overrides(overrides)
            print("🧹 Example transfer cleaned up")


if __name__ == "__main__":
    example_usage()
    example_quick_operations()
    
    print("\n💡 Tips:")
    print("- Check for manual overrides before running analysis")
    print("- Clear overrides after gameweek goes live")
    print("- Use player names for easier manual input")
    print("- Track transfer costs for accurate projections")
