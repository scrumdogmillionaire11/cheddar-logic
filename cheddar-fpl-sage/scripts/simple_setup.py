#!/usr/bin/env python3
"""
FPL Sage Simple Setup Script
Lightweight setup that works without database dependencies
"""

import os
import json
import asyncio
import aiohttp
from pathlib import Path
import click

class SimpleFPLSetup:
    def __init__(self):
        self.base_dir = Path(__file__).parent
        self.config = self.load_config()
        self.setup_logging()
    
    def load_config(self) -> dict:
        """Load basic configuration"""
        return {
            'fpl_api_url': 'https://fantasy.premierleague.com/api',
            'season': '2025-26'
        }
    
    def setup_logging(self):
        """Configure basic logging"""
        import logging
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(levelname)s - %(message)s'
        )
        self.logger = logging.getLogger(__name__)

    async def validate_fpl_api(self) -> bool:
        """Test connection to FPL API"""
        self.logger.info("Testing FPL API connection...")
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{self.config['fpl_api_url']}/bootstrap-static/", timeout=10) as response:
                    if response.status != 200:
                        self.logger.error(f"FPL API returned status {response.status}")
                        return False
                    
                    data = await response.json()
                    
                    # Check basic structure
                    required_keys = ['elements', 'teams', 'events', 'element_types']
                    for key in required_keys:
                        if key not in data:
                            self.logger.error(f"Missing key '{key}' in API response")
                            return False
                    
                    players_count = len(data['elements'])
                    teams_count = len(data['teams'])
                    
                    self.logger.info(f"✓ FPL API working - {players_count} players, {teams_count} teams")
                    
                    # Basic validation
                    if teams_count != 20:
                        self.logger.warning(f"Unexpected team count: {teams_count}")
                    if players_count < 400:
                        self.logger.warning(f"Low player count: {players_count}")
                    
                    return True
                    
        except Exception as e:
            self.logger.error(f"API test failed: {e}")
            return False

    def create_simple_config(self):
        """Create a basic config file"""
        config_data = {
            'fpl_api': {
                'base_url': self.config['fpl_api_url'],
                'rate_limit': 1,
                'timeout': 30,
                'max_retries': 3
            },
            'season': self.config['season'],
            'collection_schedule': {
                'timezone': 'Europe/London',
                'pre_deadline_time': '18:00',
                'post_deadline_time': '14:00', 
                'post_gameweek_time': '09:00',
                'mid_week_time': '12:00'
            },
            'thresholds': {
                'min_players': 500,
                'max_stale_hours': 6,
                'min_success_rate': 0.95
            },
            'setup_type': 'simple'  # Indicates this is the lightweight setup
        }
        
        config_path = self.base_dir / 'fpl_config.json'
        with open(config_path, 'w') as f:
            json.dump(config_data, f, indent=2)
        
        self.logger.info(f"✓ Basic config created: {config_path}")
        return config_path

    def create_test_script(self):
        """Create a test script to verify data collection"""
        test_script = '''#!/usr/bin/env python3
"""
Test the FPL data collection without any database dependencies
"""
import asyncio
import sys
from pathlib import Path

# Add current directory to path
sys.path.append(str(Path(__file__).parent))

from simple_fpl_collector import SimpleFPLCollector

async def test_collection():
    """Test data collection and show results"""
    print("🏈 Testing FPL Data Collection")
    print("=" * 40)
    
    try:
        async with SimpleFPLCollector() as collector:
            print("📡 Fetching data from FPL API...")
            data = await collector.get_current_data()
            
            print(f"✅ Success! Collected:")
            print(f"   📊 {len(data['players'])} players")
            print(f"   📅 Current gameweek: {data['current_gameweek']}")
            print(f"   🏟️  {len(data['fixtures'])} fixture entries")
            print(f"   🕐 Last updated: {data['last_updated']}")
            
            # Show sample player
            if data['players']:
                player = data['players'][0]
                print(f"\\n📋 Sample player data:")
                print(f"   Name: {player['name']}")
                print(f"   Team: {player['team']}")
                print(f"   Position: {player['position']}")
                print(f"   Price: £{player['current_price']}m")
                print(f"   Ownership: {player['ownership']}%")
                print(f"   Status: {player['status_flag']}")
            
            # Show sample fixture
            if data['fixtures']:
                fixture = data['fixtures'][0]
                print(f"\\n🏟️  Sample fixture:")
                print(f"   {fixture['team']} vs {fixture['opponent']}")
                print(f"   Gameweek: {fixture['gameweek']}")
                print(f"   Venue: {fixture['venue']}")
            
            # Save data
            filename = collector.save_data(data, 'test_collection.json')
            print(f"\\n💾 Data saved to: {filename}")
            
            return True
            
    except Exception as e:
        print(f"❌ Collection failed: {e}")
        return False

if __name__ == '__main__':
    success = asyncio.run(test_collection())
    if success:
        print("\\n🎉 Test completed successfully!")
        print("\\n📋 Next steps:")
        print("1. Review test_collection.json to see the data format")
        print("2. Try: python simple_fpl_collector.py")
        print("3. Integrate with your existing models")
    else:
        print("\\n❌ Test failed. Check your internet connection and try again.")
'''
        
        script_path = self.base_dir / 'test_collection.py'
        with open(script_path, 'w') as f:
            f.write(test_script)
        
        os.chmod(script_path, 0o755)
        self.logger.info(f"✓ Test script created: {script_path}")
        return script_path

    def create_minimal_requirements(self):
        """Create minimal requirements file for basic functionality"""
        minimal_reqs = """# Minimal requirements for FPL data collection
aiohttp>=3.9.0
pandas>=2.0.0
requests>=2.31.0
click>=8.1.0

# Optional for full automation (install when ready)
# psycopg2-binary>=2.9.0
# redis>=5.0.0
# sqlalchemy>=2.0.0
# schedule>=1.2.0
# tenacity>=8.2.0
"""
        
        req_path = self.base_dir / 'requirements_minimal.txt'
        with open(req_path, 'w') as f:
            f.write(minimal_reqs)
        
        self.logger.info(f"✓ Minimal requirements created: {req_path}")
        return req_path

@click.command()
@click.option('--test-api', is_flag=True, help='Test FPL API connection')
def simple_setup(test_api):
    """Simple FPL Sage setup without database dependencies"""
    
    click.echo("🏈 FPL Sage Simple Setup")
    click.echo("=" * 30)
    
    setup = SimpleFPLSetup()
    success_count = 0
    total_steps = 4
    
    # Step 1: Test API if requested
    if test_api:
        click.echo("\\n1. Testing FPL API connection...")
        if asyncio.run(setup.validate_fpl_api()):
            success_count += 1
            click.echo("   ✅ FPL API is accessible")
        else:
            click.echo("   ❌ FPL API test failed")
    else:
        click.echo("\\n1. Skipping API test (use --test-api to test)")
        success_count += 1
    
    # Step 2: Create config
    click.echo("\\n2. Creating basic configuration...")
    try:
        config_path = setup.create_simple_config()
        click.echo(f"   ✅ Config created: {config_path}")
        success_count += 1
    except Exception as e:
        click.echo(f"   ❌ Config creation failed: {e}")
    
    # Step 3: Create test script
    click.echo("\\n3. Creating test script...")
    try:
        test_path = setup.create_test_script()
        click.echo(f"   ✅ Test script created: {test_path}")
        success_count += 1
    except Exception as e:
        click.echo(f"   ❌ Test script creation failed: {e}")
    
    # Step 4: Create minimal requirements
    click.echo("\\n4. Creating minimal requirements file...")
    try:
        req_path = setup.create_minimal_requirements()
        click.echo(f"   ✅ Requirements created: {req_path}")
        success_count += 1
    except Exception as e:
        click.echo(f"   ❌ Requirements creation failed: {e}")
    
    # Summary
    click.echo("\\n" + "=" * 30)
    click.echo(f"Setup Complete: {success_count}/{total_steps} steps")
    
    if success_count >= 3:
        click.echo("\\n🎉 Basic setup successful!")
        click.echo("\\n📋 Quick start:")
        click.echo("1. Run: python test_collection.py")
        click.echo("2. If that works, try: python simple_fpl_collector.py")
        click.echo("3. Check the generated JSON files to see data formats")
        click.echo("\\n💡 For full automation later, install:")
        click.echo("   pip install psycopg2-binary redis sqlalchemy")
        click.echo("   Then run the full setup_2025_season.py")
    else:
        click.echo("\\n❌ Setup had issues. Check the errors above.")

if __name__ == '__main__':
    simple_setup()