#!/usr/bin/env python3
"""
Script to check league standings for specific gameweeks
Fetches data from FPL API and shows the top performer each week
"""

import requests
from typing import Dict

def fetch_league_standings(league_id: int, gameweek: int) -> Dict:
    """Fetch league standings for a specific gameweek"""
    url = f"https://fantasy.premierleague.com/api/leagues-classic/{league_id}/standings/"
    params = {'page_standings': 1}
    
    print(f"Fetching league {league_id} standings for GW{gameweek}...")
    response = requests.get(url, params=params, timeout=10)
    response.raise_for_status()
    return response.json()

def fetch_manager_gameweek_points(entry_id: int, gameweek: int) -> int:
    """Fetch a specific manager's points for a gameweek"""
    url = f"https://fantasy.premierleague.com/api/entry/{entry_id}/event/{gameweek}/picks/"
    
    response = requests.get(url, timeout=10)
    response.raise_for_status()
    data = response.json()
    return data['entry_history']['points']

def get_league_name(league_id: int) -> str:
    """Get the league name"""
    url = f"https://fantasy.premierleague.com/api/leagues-classic/{league_id}/standings/"
    response = requests.get(url, timeout=10)
    response.raise_for_status()
    data = response.json()
    return data['league']['name']

def find_top_scorer_for_gameweek(league_id: int, gameweek: int) -> Dict | None:
    """Find the manager with highest points in a specific gameweek"""
    # Get league standings (this gives us all managers)
    standings_data = fetch_league_standings(league_id, gameweek)
    managers = standings_data['standings']['results']
    
    # Fetch each manager's GW points
    top_manager = None
    top_points = -1
    
    print(f"Checking {len(managers)} managers for GW{gameweek}...")
    
    for manager in managers:
        entry_id = manager['entry']
        manager_name = manager['entry_name']
        player_name = manager['player_name']
        
        try:
            gw_points = fetch_manager_gameweek_points(entry_id, gameweek)
            
            if gw_points > top_points:
                top_points = gw_points
                top_manager = {
                    'entry_id': entry_id,
                    'manager_name': manager_name,
                    'player_name': player_name,
                    'points': gw_points
                }
            
            print(f"  {player_name} ({manager_name}): {gw_points} pts")
        except Exception as e:
            print(f"  Error fetching data for {player_name}: {e}")
    
    return top_manager

def main():
    league_id = 207091  # Farmer's League
    gameweeks = [20, 21, 22]
    
    print("=" * 70)
    try:
        league_name = get_league_name(league_id)
        print(f"League: {league_name} (ID: {league_id})")
    except Exception as e:
        print(f"League ID: {league_id}")
        print(f"(Could not fetch league name: {e})")
    print("=" * 70)
    print()
    
    results = {}
    
    for gw in gameweeks:
        print(f"\n{'='*70}")
        print(f"GAMEWEEK {gw}")
        print('='*70)
        
        try:
            top_manager = find_top_scorer_for_gameweek(league_id, gw)
            
            if top_manager:
                results[gw] = top_manager
                print(f"\n🏆 TOP SCORER GW{gw}:")
                print(f"   Manager: {top_manager['player_name']}")
                print(f"   Team: {top_manager['manager_name']}")
                print(f"   Points: {top_manager['points']}")
            else:
                print(f"\n⚠️  No data found for GW{gw}")
        except Exception as e:
            print(f"\n❌ Error processing GW{gw}: {e}")
    
    # Summary
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    
    for gw in gameweeks:
        if gw in results:
            top = results[gw]
            print(f"GW{gw}: {top['player_name']} ({top['manager_name']}) - {top['points']} pts")
        else:
            print(f"GW{gw}: No data available")
    
    print("=" * 70)

if __name__ == "__main__":
    main()
