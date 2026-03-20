#!/usr/bin/env python3
"""
Test the FPL data collection without any database dependencies
"""
import asyncio
import sys
from pathlib import Path

# Add current directory to path
sys.path.append(str(Path(__file__).parent))

import pytest
pytest.skip("Legacy collector test relies on simple_fpl_collector module not present", allow_module_level=True)

from simple_fpl_collector import SimpleFPLCollector

async def test_collection():
    """Test data collection and show results"""
    print("🏈 Testing FPL Data Collection")
    print("=" * 40)
    
    try:
        async with SimpleFPLCollector() as collector:
            print("📡 Fetching data from FPL API...")
            data = await collector.get_current_data()
            
            print("✅ Success! Collected:")
            print(f"   📊 {len(data['players'])} players")
            print(f"   📅 Current gameweek: {data['current_gameweek']}")
            print(f"   🏟️  {len(data['fixtures'])} fixture entries")
            print(f"   🕐 Last updated: {data['last_updated']}")
            
            # Show sample player
            if data['players']:
                player = data['players'][0]
                print("\n📋 Sample player data:")
                print(f"   Name: {player['name']}")
                print(f"   Team: {player['team']}")
                print(f"   Position: {player['position']}")
                print(f"   Price: £{player['current_price']}m")
                print(f"   Ownership: {player['ownership']}%")
                print(f"   Status: {player['status_flag']}")
            
            # Show sample fixture
            if data['fixtures']:
                fixture = data['fixtures'][0]
                print("\n🏟️  Sample fixture:")
                print(f"   {fixture['team']} vs {fixture['opponent']}")
                print(f"   Gameweek: {fixture['gameweek']}")
                print(f"   Venue: {fixture['venue']}")
            
            # Save data
            filename = collector.save_data(data, 'latest_test_collection.json', 'data_collections')
            print(f"\n💾 Data saved to: {filename}")
            
            return True
            
    except Exception as e:
        print(f"❌ Collection failed: {e}")
        return False

if __name__ == '__main__':
    success = asyncio.run(test_collection())
    if success:
        print("\n🎉 Test completed successfully!")
        print("\n📋 Next steps:")
        print("1. Review test_collection.json to see the data format")
        print("2. Try: python simple_fpl_collector.py")
        print("3. Integrate with your existing models")
    else:
        print("\n❌ Test failed. Check your internet connection and try again.")
