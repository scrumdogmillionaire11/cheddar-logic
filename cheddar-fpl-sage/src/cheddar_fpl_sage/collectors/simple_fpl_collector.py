#!/usr/bin/env python3
"""
Simple FPL Data Collector Implementation
A minimal working version to get you started immediately
"""

import asyncio
import aiohttp
import logging
from datetime import datetime, timezone
from typing import Dict

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class SimpleFPLCollector:
    """Minimal FPL data collector that works with your existing models"""
    
    def __init__(self):
        self.base_url = "https://fantasy.premierleague.com/api"
        self.session = None
    
    async def __aenter__(self):
        self.session = aiohttp.ClientSession()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.session:
            await self.session.close()
    
    async def fetch_json(self, endpoint: str) -> Dict:
        """Fetch JSON from FPL API endpoint"""
        url = f"{self.base_url}{endpoint}"
        logger.info(f"Fetching {url}")
        
        async with self.session.get(url) as response:
            response.raise_for_status()
            return await response.json()
    
    async def get_current_data(self) -> Dict:
        """Get current gameweek data in format compatible with your models"""
        
        # Fetch bootstrap data
        bootstrap = await self.fetch_json("/bootstrap-static/")
        fixtures = await self.fetch_json("/fixtures/")
        
        # Process players into FplPlayerEntry format
        players = []
        for player in bootstrap['elements']:
            player_entry = {
                'player_id': str(player['id']),
                'name': player['web_name'],
                'team': self._get_team_code(player['team']),
                'position': self._get_position_code(player['element_type']),
                'buy_price': player['now_cost'] / 10.0,
                'sell_price': player['now_cost'] / 10.0,  # Simplified
                'current_price': player['now_cost'] / 10.0,
                'ownership': player['selected_by_percent'],
                'is_starter': False,  # Will be set by your team model
                'is_captain': False,
                'is_vice': False,
                'bench_order': 0,
                'status_flag': self._parse_status(player['status'], 
                                               player.get('chance_of_playing_this_round'))
            }
            players.append(player_entry)
        
        # Process fixtures into FixtureRow format
        fixture_rows = []
        for fixture in fixtures:
            if fixture['event'] is None:  # Skip unscheduled fixtures
                continue
            
            # Add fixture for home team
            fixture_rows.append({
                'team': self._get_team_code(fixture['team_h']),
                'opponent': self._get_team_code(fixture['team_a']),
                'gameweek': fixture['event'],
                'venue': 'H',
                'xG_for_team': None,  # Could be enhanced with external data
                'xG_against_team': None,
                'xG_for_opponent': None,
                'xG_against_opponent': None,
                'book_goals_for': None,
                'book_cs_prob': None,
                'competition': 'PL',
                'is_dgw_leg': False,  # Could be enhanced
                'is_blank': False,
                'context_tags': []
            })
            
            # Add fixture for away team
            fixture_rows.append({
                'team': self._get_team_code(fixture['team_a']),
                'opponent': self._get_team_code(fixture['team_h']),
                'gameweek': fixture['event'],
                'venue': 'A',
                'xG_for_team': None,
                'xG_against_team': None,
                'xG_for_opponent': None,
                'xG_against_opponent': None,
                'book_goals_for': None,
                'book_cs_prob': None,
                'competition': 'PL',
                'is_dgw_leg': False,
                'is_blank': False,
                'context_tags': []
            })
        
        # Get current gameweek
        current_gw = 1
        for event in bootstrap['events']:
            if event['is_current']:
                current_gw = event['id']
                break
        
        return {
            'players': players,
            'fixtures': fixture_rows,
            'current_gameweek': current_gw,
            'teams': {team['id']: team['short_name'] for team in bootstrap['teams']},
            'last_updated': datetime.now().isoformat()
        }
    
    def _get_team_code(self, team_id: int) -> str:
        """Convert team ID to 3-letter code"""
        # 2025-26 season team mapping (may need updating based on promotions/relegations)
        team_mapping = {
            1: 'ARS', 2: 'AVL', 3: 'BOU', 4: 'BRE', 5: 'BHA',
            6: 'CHE', 7: 'CRY', 8: 'EVE', 9: 'FUL', 10: 'IPS',
            11: 'LEI', 12: 'LIV', 13: 'MCI', 14: 'MUN', 15: 'NEW',
            16: 'NFO', 17: 'SOU', 18: 'TOT', 19: 'WHU', 20: 'WOL'
        }
        return team_mapping.get(team_id, 'UNK')
    
    def _get_position_code(self, element_type: int) -> str:
        """Convert element_type to position code"""
        return {1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD'}.get(element_type, 'UNK')
    
    def _parse_status(self, status: str, chance_of_playing: int = None) -> str:
        """Parse player status flag"""
        if status == 'u':  # unavailable
            return 'OUT'
        elif status == 'i':  # injured
            return 'OUT'
        elif status == 'd':  # doubtful
            return 'DOUBT'
        elif status == 'a':  # available
            if chance_of_playing is not None and chance_of_playing < 75:
                return 'DOUBT'
            return 'FIT'
        else:
            return 'UNKNOWN'
    
    def save_data(self, data: Dict, filename: str = None, subdirectory: str = "data_collections"):
        """Save data to JSON file (legacy helper; kept for compatibility)."""
        from pathlib import Path
        from utils import write_json_atomic

        output_base = Path("outputs")
        output_dir = output_base / subdirectory
        output_dir.mkdir(parents=True, exist_ok=True)

        if filename is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"fpl_data_{timestamp}.json"

        filepath = output_dir / filename
        write_json_atomic(filepath, data)
        logger.info(f"Data saved to {filepath}")
        return str(filepath)


async def main():
    """Simple test of the data collector"""
    logger.info("Starting FPL data collection test...")
    
    async with SimpleFPLCollector() as collector:
        data = await collector.get_current_data()

        from utils import OutputBundleManager, generate_run_id, write_json_atomic, write_text_atomic
        run_id = generate_run_id(data.get("current_gameweek"))
        bundle = OutputBundleManager().paths_for_run(run_id)
        now = datetime.now(timezone.utc)
        season = data.get("season", "unknown")
        current_gw = data.get("current_gameweek", 0)

        # raw with metadata
        raw_with_meta = {
            **data,
            "schema_version": "1.0.0",
            "run_id": run_id,
            "gameweek": current_gw,
            "season": season,
            "generated_at": now.isoformat(),
            "source": {"type": "fpl_api"},
        }
        write_json_atomic(bundle.data_collection, raw_with_meta)

        model_inputs = {
            "schema_version": "1.0.0",
            "run_id": run_id,
            "gameweek": current_gw,
            "season": season,
            "generated_at": now.isoformat(),
            "team_input": {},  # Not available in simple collector
            "fixture_input": data.get("fixtures", []),
        }
        write_json_atomic(bundle.model_inputs, model_inputs)

        analysis_placeholder = {
            "schema_version": "1.0.0",
            "run_id": run_id,
            "gameweek": current_gw,
            "season": season,
            "generated_at": now.isoformat(),
            "decision": {},
            "formatted_summary": "No analysis generated by simple collector.",
            "analysis_timestamp": now.isoformat(),
        }
        write_json_atomic(bundle.analysis, analysis_placeholder)
        write_text_atomic(bundle.report, "# FPL Analysis\n\nNo analysis generated by simple collector.")

        manager = OutputBundleManager()
        manager.update_latest_pointer(bundle)
        manager.update_data_summary(bundle, season, current_gw)

        print("\n✅ Data collection complete!")
        print(f"📊 Found {len(data['players'])} players")
        print(f"📅 Current gameweek: {data['current_gameweek']}")
        print(f"🏟️  Found {len(data['fixtures'])} fixture rows")
        print(f"💾 Run bundle: {bundle.run_dir}")
        print("📍 Latest pointer updated: outputs/LATEST.json")


def create_integration_example():
    """Create an example of how to integrate with your existing models"""
    
    integration_code = '''
# Integration example for your existing FPL Sage models
# Add this to your core__fpl_orchestrator.md command processing

async def update_with_fresh_fpl_data():
    """Update all models with fresh FPL data"""
    
    # Collect fresh data
    async with SimpleFPLCollector() as collector:
        fresh_data = await collector.get_current_data()
    
    # Convert to your model formats
    
    # 1. For FPL Team Model
    team_input = FplTeamInput(
        season="2025-26",
        gameweek=fresh_data['current_gameweek'],
        players=fresh_data['players'][:15],  # Your actual team
        bank_itb=0.0,  # Get from your team data
        free_transfers=1,
        chip_status={},  # Get from your team data
        hits_already_committed=0
    )
    
    # 2. For FPL Fixture Model  
    fixture_input = FixtureModelInput(
        season="2025-26",
        base_gameweek=fresh_data['current_gameweek'],
        rows=fresh_data['fixtures']
    )
    
    # 3. For FPL Projection Engine
    projection_input = ProjectionEngineInput(
        season="2025-26", 
        gameweek=fresh_data['current_gameweek'],
        player_rows=[],  # Convert from fresh_data['players']
        fixture_rows=fresh_data['fixtures'],
        team_rows=[]  # Add team-level data
    )
    
    # Run your models
    team_model_output = run_team_model(team_input)
    fixture_profiles = run_fixture_model(fixture_input) 
    projections = run_projection_engine(projection_input)
    
    # Run transfer advisor
    transfer_advice = run_transfer_advisor(
        team_input, team_model_output, fixture_profiles, projections
    )
    
    return transfer_advice

# Add to your orchestrator commands:
elif command_token.lower() == "fpl_update_data":
    advice = await update_with_fresh_fpl_data()
    return f"✅ Data updated and analysis complete:\\n{advice}"
'''
    
    with open('integration_example.py', 'w') as f:
        f.write(integration_code)
    
    logger.info("✅ Integration example created: integration_example.py")


if __name__ == '__main__':
    # Run the data collection test
    asyncio.run(main())
    
    # Create integration example
    create_integration_example()
    
    print("\n🚀 Quick Start Instructions:")
    print("1. Run this script to test data collection")
    print("2. Check integration_example.py for model integration")
    print("3. Add the update command to your orchestrator")
    print("4. For full automation, implement the scheduler from automation__fpl_scheduler.md")
    print("\n📝 Note: You may need to update team mappings for 2025-26 season based on promotions/relegations")
