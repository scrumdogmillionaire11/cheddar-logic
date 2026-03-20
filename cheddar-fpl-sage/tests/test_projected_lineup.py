#!/usr/bin/env python3
"""Quick test to see projected lineup with manual transfers."""
import asyncio
import logging

from cheddar_fpl_sage.analysis import FPLSageIntegration

logging.basicConfig(level=logging.INFO, format='%(levelname)s:%(name)s:%(message)s', force=True)


async def main():
    """Run analysis and show projected lineup."""
    # Load manual transfers from config
    from cheddar_fpl_sage.utils.sprint3_5_config_manager import Sprint35ConfigManager
    config_manager = Sprint35ConfigManager('config/team_config.json')
    config_data = config_manager.get_config()
    manual_transfers = config_data.get('manual_overrides', {}).get('planned_transfers', [])
    
    # Prepare overrides
    overrides = {}
    if manual_transfers:
        overrides['manual_transfers'] = manual_transfers
        print(f"📋 Found {len(manual_transfers)} manual transfer(s) in config:")
        for mt in manual_transfers:
            out = mt.get('player_out', mt.get('out_name', '?'))
            in_p = mt.get('player_in', mt.get('in_name', '?'))
            print(f"   • {out} → {in_p}")
    
    sage = FPLSageIntegration(team_id=711511, config_file='config/team_config.json')
    
    print("🔄 Running analysis...")
    results = await sage.run_full_analysis(save_data=False, overrides=overrides if overrides else None)
    
    print("\n" + "="*60)
    
    # Check what's in results
    print("\n🔍 Inspecting results structure:")
    print(f"   Top-level keys: {list(results.keys())}")
    
    if 'raw_data' in results:
        print(f"\n   raw_data keys: {list(results['raw_data'].keys())[:10]}")
        if 'my_team' in results['raw_data']:
            my_team_keys = list(results['raw_data']['my_team'].keys())
            print(f"   my_team keys: {my_team_keys[:15]}")
            
            # Check if manual transfers were applied
            if 'manual_overrides_applied' in results['raw_data']['my_team']:
                print(f"\n   ✅ manual_overrides_applied: {results['raw_data']['my_team']['manual_overrides_applied']}")
            
            # Check current_squad after manual transfers
            if 'current_squad' in results['raw_data']['my_team']:
                squad = results['raw_data']['my_team']['current_squad']
                print(f"\n   📋 Current squad after manual transfers ({len(squad)} players):")
                player_names = [p.get('name', 'Unknown') for p in squad]
                print(f"      {', '.join(player_names)}")
                # Check if Senesi and Scott are in squad
                if 'Senesi' in player_names:
                    print("      ✅ Senesi found in squad!")
                if 'Scott' in player_names:
                    print("      ✅ Scott found in squad!")
                if 'Romero' in player_names:
                    print("      ❌ Romero still in squad (should be removed)!")
                if 'Stach' in player_names:
                    print("      ❌ Stach still in squad (should be removed)!")
    
    if 'analysis' in results:
        print(f"\n   analysis keys: {list(results['analysis'].keys())[:10]}")
        if 'optimized_xi' in results['analysis']:
            optimized_xi = results['analysis']['optimized_xi']
            if optimized_xi:
                print("   ✅ Found optimized_xi in analysis!")
                print(f"   Length: {len(optimized_xi)}")
                
                print("\n⚽ OPTIMIZED STARTING XI (with manual transfers):")
                for i, player in enumerate(optimized_xi[:11], 1):
                    name = player.get('name', player.get('web_name', 'Unknown'))
                    pos = player.get('position', player.get('element_type', '?'))
                    pts = player.get('expected_pts', player.get('nextGW_pts', player.get('points_next', 0)))
                    print(f"  {i}. {name:20s} ({pos:3s}) - {pts:.1f} pts")
                
                if len(optimized_xi) > 11:
                    print("\n🪑 BENCH:")
                    for i, player in enumerate(optimized_xi[11:15], 1):
                        name = player.get('name', player.get('web_name', 'Unknown'))
                        pos = player.get('position', player.get('element_type', '?'))
                        pts = player.get('expected_pts', player.get('nextGW_pts', player.get('points_next', 0)))
                        print(f"  {i}. {name:20s} ({pos:3s}) - {pts:.1f} pts")
            else:
                print("   ❌ optimized_xi is None")
    
    if 'projected_xi' in results:
        print("✅ Found projected_xi in results!")
        print(f"   Length: {len(results['projected_xi'])}")
        
        print("\n⚽ PROJECTED STARTING XI (with manual transfers):")
        for i, player in enumerate(results['projected_xi'][:11], 1):
            name = player.get('name', player.get('web_name', 'Unknown'))
            pos = player.get('position', '?')
            pts = player.get('expected_pts', player.get('points_next', 0))
            is_new = "🆕" if player.get('is_new') else ""
            print(f"  {i}. {name:20s} ({pos:3s}) - {pts:.1f} pts {is_new}")
        
        if 'projected_bench' in results:
            print("\n🪑 BENCH:")
            for i, player in enumerate(results['projected_bench'][:4], 1):
                name = player.get('name', player.get('web_name', 'Unknown'))
                pos = player.get('position', '?')
                pts = player.get('expected_pts', player.get('points_next', 0))
                is_new = "🆕" if player.get('is_new') else ""
                print(f"  {i}. {name:20s} ({pos:3s}) - {pts:.1f} pts {is_new}")
    else:
        print("❌ No projected_xi found in results")
        print(f"   Available keys: {list(results.keys())}")
        
        # Try current starting XI
        if 'starting_xi' in results:
            print("\n⚽ CURRENT STARTING XI:")
            for i, player in enumerate(results['starting_xi'][:11], 1):
                name = player.get('name', player.get('web_name', 'Unknown'))
                pos = player.get('position', '?')
                print(f"  {i}. {name:20s} ({pos:3s})")
    
    # Check manual transfers in config
    print("\n" + "="*60)
    print("📋 Manual transfers loaded at start:")
    print(f"   Total: {len(manual_transfers) if manual_transfers else 0}")
    if manual_transfers:
        for mt in manual_transfers:
            out = mt.get('player_out', mt.get('out_name', '?'))
            in_p = mt.get('player_in', mt.get('in_name', '?'))
            print(f"   - {out} → {in_p}")
    
    # TEST: Projected lineup display (like in fpl_sage.py)
    print("\n" + "="*60)
    print("PROJECTED LINEUP TEST (Display Logic from fpl_sage.py):")
    print("="*60)
    
    team_data = results['raw_data'].get('my_team', {})
    current_squad = team_data.get('current_squad', [])
    
    overrides = {
        'manual_transfers': manual_transfers
    }
    
    if overrides and overrides.get('manual_transfers'):
        # Apply manual transfers to display projected squad
        projected_squad = current_squad.copy()
        players_in = []
        
        # Get all players for lookup (use web_name, element_type, etc.)
        all_players = results['raw_data'].get('players', [])
        player_lookup = {p.get('web_name', '').lower(): p for p in all_players}
        
        # Get team names for display
        teams = results['raw_data'].get('teams', [])
        team_lookup = {t.get('id'): t.get('short_name', t.get('name', '?')) for t in teams}
        
        # Position mapping
        pos_map = {1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD'}
        
        for mt in overrides['manual_transfers']:
            out_name = (mt.get('player_out') or mt.get('out_name', '')).lower()
            in_name = (mt.get('player_in') or mt.get('in_name', 'Unknown'))
            
            # Remove outgoing player
            projected_squad = [p for p in projected_squad if p.get('name', '').lower() != out_name]
            
            # Add incoming player if we can find them in player data
            player_in = player_lookup.get(in_name.lower())
            if player_in:
                # Convert FPL API format to our display format
                team_id = player_in.get('team')
                team_name = team_lookup.get(team_id, '?')
                position = pos_map.get(player_in.get('element_type'), '?')
                price = player_in.get('now_cost', 0) / 10.0  # Convert from tenths
                
                players_in.append({
                    'name': player_in.get('web_name', in_name),
                    'position': position,
                    'current_price': price,
                    'team': team_name,
                    'team_name': team_name
                })
        
        # Add the incoming players to projected squad
        projected_squad.extend(players_in)
        
        print(f"\n⚽ PROJECTED SQUAD (with your {len(overrides['manual_transfers'])} manual transfer(s)):")
        print(f"   Transferred OUT: {', '.join([mt.get('player_out') or mt.get('out_name', '?') for mt in overrides['manual_transfers']])}")
        print(f"   Transferred IN: {', '.join([mt.get('player_in') or mt.get('in_name', '?') for mt in overrides['manual_transfers']])}")
        print(f"\n   Updated squad ({len(projected_squad)} players):")
        
        # Group by position for better readability
        by_position = {'GK': [], 'DEF': [], 'MID': [], 'FWD': []}
        for player in projected_squad:
            pos = player.get('position', '?')
            by_position.get(pos, []).append(player)
        
        for pos in ['GK', 'DEF', 'MID', 'FWD']:
            if by_position[pos]:
                print(f"\n   {pos}:")
                for player in sorted(by_position[pos], key=lambda p: p.get('name', '')):
                    name = player.get('name', 'Unknown')
                    price = player.get('current_price', 0)
                    team = player.get('team', player.get('team_name', ''))
                    # Mark newly transferred-in players
                    is_new = "🆕" if any((mt.get('player_in') or mt.get('in_name', '')).lower() == name.lower() 
                                       for mt in overrides['manual_transfers']) else ""
                    print(f"     • {name:20s} ({team:3s}) - £{price:.1f}m {is_new}")
        
        print(f"\n   💡 Note: This is your squad AFTER manual transfers.")


if __name__ == "__main__":
    asyncio.run(main())
