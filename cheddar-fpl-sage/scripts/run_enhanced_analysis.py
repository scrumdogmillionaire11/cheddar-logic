#!/usr/bin/env python3
"""
FPL Sage Enhanced Runner
Simple script to test the enhanced analysis system
"""

import asyncio
import sys

from cheddar_fpl_sage.analysis import FPLSageIntegration
from cheddar_fpl_sage.utils import ChipStatusManager

async def run_demo():
    """Run demo analysis"""
    print("🚀 FPL Sage Enhanced Analysis Demo")
    print("-" * 40)
    
    # Initialize without team ID (will use general data)
    sage = FPLSageIntegration()
    
    print("📊 Running analysis...")
    try:
        results = await sage.run_full_analysis(save_data=True)
        
        print("\n✅ Demo completed successfully!")
        print("📁 Data saved to outputs/ directory")
        
        # Show sample of what was collected
        raw_data = results['raw_data']
        print(f"🔢 Players collected: {len(raw_data.get('players', []))}")
        print(f"📅 Current gameweek: {raw_data.get('current_gameweek', 'N/A')}")
        
        if 'my_team' in raw_data and 'error' not in raw_data['my_team']:
            print("👤 Team data: ✅ Collected")
            print("🧠 Decision analysis: ✅ Generated")
        else:
            print("👤 Team data: ❌ Not available (no team ID configured)")
            print("💡 To include team analysis:")
            print("   1. Get your team ID from FPL website URL")  
            print("   2. Add it to team_config.json")
            print("   3. Run again for full analysis")
        
        return True
        
    except Exception as e:
        print(f"❌ Demo failed: {e}")
        return False

async def run_with_team_id():
    """Run with team ID input"""
    team_id = input("Enter your FPL team ID (or press Enter to skip): ").strip()
    
    if not team_id:
        print("Skipping team-specific analysis...")
        return await run_demo()
    
    try:
        team_id = int(team_id)
    except ValueError:
        print("Invalid team ID. Running without team data...")
        return await run_demo()
    
    print(f"🎯 Running analysis for team {team_id}...")
    
    # Check if chip status is configured
    chip_manager = ChipStatusManager()
    chip_status = chip_manager.get_current_chip_status()
    
    if not chip_status:
        print("\n⚠️  Chip status not configured yet!")
        print("🔧 Setting up chip status (API data is unreliable)...")
        chip_status = chip_manager.interactive_chip_setup()
        chip_manager.update_config_with_chips(chip_status)
    else:
        print("\n✅ Using existing chip configuration:")
        chip_manager.quick_chip_check()
    
    sage = FPLSageIntegration(team_id=team_id)
    
    try:
        results = await sage.run_full_analysis(save_data=True)
        
        print("\n✅ Full analysis completed!")
        
        if 'my_team' in results['raw_data']:
            team_data = results['raw_data']['my_team']
            if 'error' in team_data:
                print(f"❌ Team data error: {team_data['error']}")
            else:
                team_info = team_data.get('team_info', {})
                print(f"👤 Team: {team_info.get('team_name', 'Unknown')}")
                rank_val = team_info.get('overall_rank')
                if isinstance(rank_val, (int, float)):
                    rank_text = f"{rank_val:,}"
                else:
                    rank_text = rank_val if rank_val is not None else "N/A"
                print(f"📈 Rank: {rank_text}")
                print(f"💰 Value: £{team_info.get('team_value', 0):.1f}m")
                
                # Show chip status source and actual chips
                chip_source = team_data.get('chip_data_source', 'unknown')
                print(f"📊 Chip data source: {chip_source}")
                
                chip_status = team_data.get('chip_status', {})
                available = [chip for chip, status in chip_status.items() 
                           if status.get('available', False)]
                print(f"🎯 Available chips: {', '.join(available) if available else 'None'}")
        
        return True
        
    except Exception as e:
        print(f"❌ Analysis failed: {e}")
        print("This might be due to:")
        print("  - Invalid team ID")
        print("  - FPL API temporarily unavailable") 
        print("  - Network connectivity issues")
        return False

def show_improvements():
    """Show what improvements were implemented"""
    print("\n🎯 IMPLEMENTED IMPROVEMENTS FROM FEEDBACK:")
    print("-" * 50)
    
    print("1. ✅ Risk Scenario Templates")
    print("   - Explicit downside quantification")  
    print("   - 'If [condition], expect [loss range] - [acceptable/unacceptable]'")
    
    print("\n2. ✅ Simplified Lineup Guidance for Chip Weeks")
    print("   - BB weeks: Focus on captaincy + risk flags only")
    print("   - 'Captain correctly, then ignore the pitch view'")
    
    print("\n3. ✅ Forward-Looking Chip Setup") 
    print("   - Next chip window preparation")
    print("   - Fixture conflict flagging")
    print("   - Clear pivot conditions")
    
    print("\n4. ✅ Decision Framework Codification")
    print("   - Repeatable 'forced chip window' rules")
    print("   - Consistent output formatting")
    print("   - Systematic decision patterns")
    
    print("\n5. ✅ Variance Communication")
    print("   - Post-GW expectation setting") 
    print("   - Good process vs. bad luck indicators")
    print("   - Pre-emptive sanity check guidance")
    
    print("\n📁 New Files Created:")
    print("   - enhanced_decision_framework.py")
    print("   - enhanced_fpl_collector.py") 
    print("   - fpl_sage_integration.py")
    print("   - team_config.json (updated)")

async def main():
    """Main runner"""
    if len(sys.argv) > 1 and sys.argv[1] == "--demo":
        return await run_demo()
    elif len(sys.argv) > 1 and sys.argv[1] == "--improvements":
        show_improvements()
        return True
    else:
        print("🔧 FPL Sage Enhanced - Implementation of GPT Feedback")
        print("=" * 55)
        
        show_improvements()
        
        print("\n" + "="*55)
        print("🏃‍♂️ Ready to test the enhanced system!")
        print("="*55)
        
        return await run_with_team_id()

if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)
