"""
FPL Sage Enhanced Runner
Optimized entry point for the FPL analysis system
"""

import argparse
import asyncio
import json
import logging
import os
import traceback

# Configure logging once at entry point - prevents duplicate handlers
logging.basicConfig(
    level=logging.INFO,
    format='%(levelname)s:%(name)s:%(message)s',
    force=True  # Clear any existing handlers to prevent duplicates
)

from cheddar_fpl_sage.analysis import FPLSageIntegration
from cheddar_fpl_sage.collectors.enhanced_fpl_collector import EnhancedFPLCollector
from cheddar_fpl_sage.utils import ChipStatusManager
from cheddar_fpl_sage.utils.manual_transfer_manager import ManualTransferManager
from cheddar_fpl_sage.utils.sprint3_5_config_manager import Sprint35ConfigManager


async def _prompt_bench_injury_overrides(team_id: int, config_manager: Sprint35ConfigManager):
    """Prompt the user to confirm injury status for bench players."""
    if not team_id:
        return

    config = config_manager.get_config(force_reload=True)
    manual_overrides = config.get('manual_injury_overrides', {}).copy()

    try:
        async with EnhancedFPLCollector(team_id=team_id) as collector:
            team_data = await collector.get_team_data(team_id=team_id, config=config)
    except Exception as exc:
        print(f"⚠️ Could not fetch bench snapshot: {exc}")
        return

    bench_players = [p for p in team_data.get('current_squad', []) if not p.get('is_starter', False)]
    if not bench_players:
        return

    print("\n🪑 BENCH INJURY CHECK")
    print("=" * 50)
    for idx, player in enumerate(bench_players, 1):
        status = player.get('status_flag', 'UNK')
        override = manual_overrides.get(player.get('name', '').lower())
        override_note = f" (override: {override.get('status_flag')})" if override else ""
        print(f"{idx}. {player.get('name')} ({player.get('team', 'UNK')}) - status: {status}{override_note}")

    raw_selection = input("\nEnter bench player numbers to override (comma-separated, or press Enter to skip): ").strip()
    if not raw_selection:
        return

    indices = []
    for part in raw_selection.split(','):
        try:
            idx = int(part.strip())
            if 1 <= idx <= len(bench_players):
                indices.append(idx - 1)
        except ValueError:
            continue

    if not indices:
        return

    updated = False
    for idx in indices:
        player = bench_players[idx]
        name_key = player.get('name', '').lower()
        status_input = input(f"Status for {player['name']} (OUT/DOUBT/FIT): ").strip().upper()
        if status_input not in {'OUT', 'DOUBT', 'FIT'}:
            print("⚠️ Invalid status, defaulting to DOUBT")
            status_input = 'DOUBT'
        chance_input = input("Chance of playing next round (0-100, blanks skips): ").strip()
        chance = None
        if chance_input.isdigit():
            chance = max(0, min(100, int(chance_input)))

        manual_overrides[name_key] = {
            "status_flag": status_input,
            "chance_of_playing_next_round": chance
        }
        updated = True

    if updated:
        config_manager.update_manual_injury_overrides(manual_overrides)
        print("💾 Bench injury overrides saved.")


async def main(debug: bool = False, risk_posture: str = None):
    """Main entry point for FPL Sage Enhanced Analysis"""
    print("🚀 FPL Sage Enhanced Analysis (Optimized)")
    print("=" * 50)
    print("💡 NEW: Manual transfer input for pending transfers")
    print("   Use 'python scripts/manage_transfers.py' for transfer management")
    print("=" * 50)
    
    # Optional quick-pick profiles
    profiles_path = os.path.join(os.path.dirname(__file__), 'config', 'fpl_team_ids.json')
    profiles = {}
    if os.path.exists(profiles_path):
        try:
            with open(profiles_path, 'r') as pf:
                loaded = json.load(pf)
                if isinstance(loaded, dict):
                    profiles = loaded
        except Exception:
            profiles = {}
    if profiles:
        print("\n📁 Saved team profiles:")
        for name, tid in profiles.items():
            print(f"  - {name}: {tid}")
    prompt = "Enter your FPL team ID"
    if profiles:
        prompt += " or profile name"
    prompt += " (or press Enter to skip): "
    team_id = input(prompt).strip()
    if profiles and team_id in profiles:
        team_id = str(profiles[team_id])
    
    if not team_id:
        print("Running general analysis without team data...")
        sage = FPLSageIntegration()
        results = await sage.run_full_analysis(save_data=True)
        print("✅ General analysis completed!")
        return
    
    try:
        team_id = int(team_id)
    except ValueError:
        print("❌ Invalid team ID format")
        return
    
    print(f"🎯 Running analysis for team {team_id}...")
    
    # Check chip status
    config_path = os.path.join(os.path.dirname(__file__), 'config', 'team_config.json')
    chip_manager = ChipStatusManager(config_path)
    config_manager = Sprint35ConfigManager(config_path)

    async def edit_overrides():
        """Inline editor for chips, free transfers, and injuries."""
        # Chips
        chip_status = chip_manager.get_current_chip_status()
        if not chip_status:
            print("\n⚠️  Setting up chip status...")
            chip_status = chip_manager.interactive_chip_setup()
            chip_manager.update_config_with_chips(chip_status)
        else:
            print("\n✅ Using configured chip status:")
            chip_manager.quick_chip_check()
            update_chips = input("\n🔄 Update chip status (e.g., mark Bench Boost used)? (y/n): ").lower().strip()
            if update_chips == 'y':
                chip_status = chip_manager.interactive_chip_setup()
                chip_manager.update_config_with_chips(chip_status)
        # Manual free transfers
        current_manual_ft = config_manager.get_manual_free_transfers()
        prompt = "\n🔢 Set manual free transfers (blank to keep"
        if current_manual_ft is not None:
            prompt += f" current={current_manual_ft}"
        prompt += ", or enter 0-5): "
        user_ft = input(prompt).strip()
        if user_ft:
            normalized_ft = user_ft.lower()
            if normalized_ft in {'n', 'q'}:
                print("Keeping existing free transfer value.")
            elif normalized_ft.isdigit():
                ft_value = int(normalized_ft)
                if 0 <= ft_value <= 5:
                    config_manager.update_manual_free_transfers(ft_value)
                    print(f"💾 Saved manual free transfers: {ft_value}")
                else:
                    print("❌ Free transfers must be between 0 and 5. Keeping existing value.")
            else:
                print("❌ Free transfer input must be 0-5, or type 'n'/'q' to skip.")

        # Manual injury overrides by name
        injury_input = input("\n🩺 Override injury status? Enter as Name=STATUS[:chance] comma-separated (e.g., 'Haaland=OUT:0,Foden=FIT') or press Enter to skip: ").strip()
        if injury_input:
            manual_injury_overrides = config_manager.get_config(force_reload=True).get('manual_injury_overrides', {}).copy()
            for part in injury_input.split(','):
                if '=' not in part:
                    continue
                name_part, status_part = part.split('=', 1)
                name = name_part.strip()
                status_tokens = status_part.split(':')
                status_flag = status_tokens[0].strip().upper()
                chance = None
                if len(status_tokens) > 1:
                    try:
                        chance = int(status_tokens[1])
                    except ValueError:
                        chance = None
                if name and status_flag:
                    manual_injury_overrides[name.lower()] = {
                        "status_flag": status_flag,
                        "chance_of_playing_next_round": chance
                    }
            config_manager.update_manual_injury_overrides(manual_injury_overrides)
            print(f"💾 Saved manual injury overrides for {len(manual_injury_overrides)} player(s).")
        await _prompt_bench_injury_overrides(int(team_id), config_manager)
        
        # Risk Posture Override
        current_posture = config_manager.get_risk_posture() if hasattr(config_manager, 'get_risk_posture') else "BALANCED"
        if risk_posture:
            current_posture = risk_posture
            print(f"\nℹ️  Risk posture set via CLI: {current_posture}")
        else:
            print(f"\n📊 Current risk posture: {current_posture}")
            posture_input = input(
                "Set risk posture? (CONSERVATIVE/BALANCED/AGGRESSIVE or blank to keep): "
            ).strip()
            
            if posture_input:
                try:
                    from cheddar_fpl_sage.analysis.decision_framework.constants import normalize_risk_posture
                    new_posture = normalize_risk_posture(posture_input)
                    
                    persist = input(f"Persist '{new_posture}' to team_config.json? (y/n): ").strip().lower()
                    if persist == 'y':
                        if hasattr(config_manager, 'set_risk_posture'):
                            config_manager.set_risk_posture(new_posture, persist=True)
                            print(f"✅ Saved '{new_posture}' to config")
                        else:
                            # Fallback: manually update config
                            config = config_manager.get_config(force_reload=True)
                            config['risk_posture'] = new_posture
                            config_manager._save_config(config)
                            print(f"✅ Saved '{new_posture}' to config")
                    else:
                        print(f"✅ Using '{new_posture}' for this run only")
                    
                    current_posture = new_posture
                except ValueError as e:
                    print(f"❌ {e}")
                    print(f"Keeping current posture: {current_posture}")
        
        # CRITICAL: Invalidate cache so FPLSageIntegration reads the updated risk_posture
        config_manager.invalidate_cache()
        return current_posture  # Return the final posture for use in analysis

    # Offer quick edit menu
    edit_choice = input("\n⚙️  Edit overrides (chips/free transfers/injuries)? (y/n): ").lower().strip()
    final_risk_posture = None
    if edit_choice in ['y', 'yes']:
        final_risk_posture = await edit_overrides()
    elif edit_choice in ['n', 'no', '']:
        pass  # User declined, continue
    else:
        print("ℹ️  Assuming 'no' and continuing...")
    
    # Check for manual transfers/overrides
    transfer_manager = ManualTransferManager(config_path)
    manual_overrides = transfer_manager.get_manual_overrides()
    
    if manual_overrides:
        print("\n✅ Using manual team overrides:")
        transfer_manager.quick_transfer_check()
        
        # Ask if user wants to update
        update_transfers = input("\n🔄 Update manual transfers? (y/n): ").lower().strip()
        if update_transfers == 'y':
            manual_overrides = transfer_manager.interactive_transfer_setup()
            transfer_manager.update_config_with_overrides(manual_overrides)
    else:
        # Ask if user wants to add manual transfers
        add_transfers = input("\n🔄 Add manual transfers/team changes? (y/n): ").lower().strip()
        if add_transfers == 'y':
            manual_overrides = transfer_manager.interactive_transfer_setup()
            transfer_manager.update_config_with_overrides(manual_overrides)
    
    # Load manual transfers from config for analysis
    config_manager = Sprint35ConfigManager(config_path)
    config_data = config_manager.get_config()
    manual_transfers = config_data.get('manual_overrides', {}).get('planned_transfers', [])
    
    # Prepare overrides dict
    overrides = {}
    if manual_transfers:
        overrides['manual_transfers'] = manual_transfers
        print(f"\n📋 Loaded {len(manual_transfers)} manual transfer(s) from config:")
        for mt in manual_transfers:
            out = mt.get('player_out', mt.get('out_name', '?'))
            in_p = mt.get('player_in', mt.get('in_name', '?'))
            print(f"   • {out} → {in_p}")
    
    # Run analysis
    sage = FPLSageIntegration(team_id=team_id, config_file=config_path)
    
    try:
        results = await sage.run_full_analysis(save_data=True, overrides=overrides if overrides else None)
        
        print("\n✅ Analysis completed!")
        
        # Show results summary
        if 'my_team' in results['raw_data'] and 'error' not in results['raw_data']['my_team']:
            team_data = results['raw_data']['my_team']
            team_info = team_data.get('team_info', {})
            
            print(f"👤 Team: {team_info.get('team_name', 'Unknown')}")
            rank_val = team_info.get('overall_rank')
            if isinstance(rank_val, (int, float)):
                rank_text = f"{rank_val:,}"
            else:
                rank_text = rank_val if rank_val is not None else "N/A"
            print(f"📈 Rank: {rank_text}")
            print(f"💰 Team Value: £{team_info.get('team_value', 0):.1f}m")
            print(f"🏦 Bank: £{team_info.get('bank_value', 0):.1f}m")
            print(f"🔄 Free Transfers: {team_info.get('free_transfers', 0)}")
            
            # Show available chips
            chip_status = team_data.get('chip_status', {})
            available = [chip for chip, status in chip_status.items() 
                        if status.get('available', False)]
            print(f"🎯 Available Chips: {', '.join(available) if available else 'None'}")
            
            # Show projected lineup (includes manual transfers + optimized selection)
            # Apply manual transfers to current_squad to show projected lineup
            team_data = results['raw_data'].get('my_team', {})
            current_squad = team_data.get('current_squad', [])
            
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
                print(f"\n   Total squad: {len(projected_squad)} players")
                
                # Get player projections for expected points
                projections = results['analysis'].get('projections', {})
                player_projections = projections.get('player_projections', [])
                
                # Create lookup for expected points by player name
                pts_lookup = {}
                for proj in player_projections:
                    name = proj.get('player_name', '').lower()
                    pts = proj.get('nextGW_pts', proj.get('expected_pts', 0))
                    pts_lookup[name] = pts
                
                # Add expected points to each player in projected squad
                for player in projected_squad:
                    name_lower = player.get('name', '').lower()
                    player['expected_pts'] = pts_lookup.get(name_lower, 0)
                
                # Simple XI selection: Pick best players by position while respecting formation constraints
                # Formation: 1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD (must have 11 total)
                by_position = {'GK': [], 'DEF': [], 'MID': [], 'FWD': []}
                for player in projected_squad:
                    pos = player.get('position', '?')
                    if pos in by_position:
                        by_position[pos].append(player)
                
                # Sort each position by expected points (descending)
                for pos in by_position:
                    by_position[pos].sort(key=lambda p: p.get('expected_pts', 0), reverse=True)
                
                # Select starting XI using a balanced formation (e.g., 1-4-4-2 or best available)
                starting_xi = []
                bench = []
                
                # Always start best GK
                if by_position['GK']:
                    starting_xi.append(by_position['GK'][0])
                    bench.extend(by_position['GK'][1:])  # Other GK goes to bench
                
                # Pick DEF (start top 4 or 5 depending on available)
                def_to_start = min(5, max(3, len(by_position['DEF']) - 1))  # Leave at least 1 for bench if possible
                starting_xi.extend(by_position['DEF'][:def_to_start])
                bench.extend(by_position['DEF'][def_to_start:])
                
                # Pick MID (fill remaining slots prioritizing MID/FWD)
                remaining_slots = 11 - len(starting_xi)
                
                # Combine MID and FWD, sort by expected points
                outfield = by_position['MID'] + by_position['FWD']
                outfield.sort(key=lambda p: p.get('expected_pts', 0), reverse=True)
                
                # Need at least 2 FWD and 2 MID in starting XI
                fwd_in_xi = [p for p in outfield[:remaining_slots] if p.get('position') == 'FWD']
                mid_in_xi = [p for p in outfield[:remaining_slots] if p.get('position') == 'MID']
                
                # Simple selection: take top remaining_slots by expected points
                selected = outfield[:remaining_slots]
                starting_xi.extend(selected)
                bench.extend(outfield[remaining_slots:])
                
                # Sort bench: GK first, then by expected points
                bench.sort(key=lambda p: (0 if p.get('position') == 'GK' else 1, -p.get('expected_pts', 0)))
                
                # Display optimized starting XI
                print("\n🎯 OPTIMIZED STARTING XI:")
                for i, player in enumerate(starting_xi, 1):
                    name = player.get('name', 'Unknown')
                    pos = player.get('position', '?')
                    team = player.get('team', player.get('team_name', ''))
                    pts = player.get('expected_pts', 0)
                    is_new = "🆕" if any((mt.get('player_in') or mt.get('in_name', '')).lower() == name.lower() 
                                       for mt in overrides['manual_transfers']) else ""
                    print(f"  {i:2d}. {name:20s} ({pos:3s}, {team:3s}) - {pts:5.1f} pts {is_new}")
                
                # Display bench order
                print("\n🪑 BENCH (in order):")
                for i, player in enumerate(bench, 1):
                    name = player.get('name', 'Unknown')
                    pos = player.get('position', '?')
                    team = player.get('team', player.get('team_name', ''))
                    pts = player.get('expected_pts', 0)
                    is_new = "🆕" if any((mt.get('player_in') or mt.get('in_name', '')).lower() == name.lower() 
                                       for mt in overrides['manual_transfers']) else ""
                    print(f"  {i}. {name:20s} ({pos:3s}, {team:3s}) - {pts:5.1f} pts {is_new}")
                
                # Show formation
                formation_counts = {'GK': 0, 'DEF': 0, 'MID': 0, 'FWD': 0}
                for player in starting_xi:
                    pos = player.get('position', '?')
                    formation_counts[pos] = formation_counts.get(pos, 0) + 1
                
                formation = f"{formation_counts.get('GK', 0)}-{formation_counts.get('DEF', 0)}-{formation_counts.get('MID', 0)}-{formation_counts.get('FWD', 0)}"
                print(f"\n   📊 Formation: {formation}")
                print("   💡 Players ordered by expected points within position groups")
                
            elif 'analysis' in results and 'optimized_xi' in results['analysis'] and results['analysis']['optimized_xi']:
                # Show optimized XI if available (OptimizedXI object with starting_xi and bench)
                print("\n⚽ PROJECTED STARTING XI:")
                optimized_xi = results['analysis']['optimized_xi']
                for i, player in enumerate(optimized_xi.starting_xi, 1):
                    name = getattr(player, 'name', 'Unknown')
                    pos = getattr(player, 'position', '?')
                    pts = getattr(player, 'nextGW_pts', 0)
                    print(f"  {i}. {name:20s} ({pos:3s}) - {pts:.1f} pts")

                if optimized_xi.bench:
                    print("\n🪑 BENCH:")
                    for i, player in enumerate(optimized_xi.bench, 1):
                        name = getattr(player, 'name', 'Unknown')
                        pos = getattr(player, 'position', '?')
                        pts = getattr(player, 'nextGW_pts', 0)
                        print(f"  {i}. {name:20s} ({pos:3s}) - {pts:.1f} pts")
            elif 'my_team' in results['raw_data'] and 'starting_xi' in results['raw_data']['my_team']:
                # Fallback to current starting XI from last gameweek
                print("\n⚽ CURRENT STARTING XI (from last gameweek):")
                starting_xi = results['raw_data']['my_team']['starting_xi']
                for i, player in enumerate(starting_xi[:11], 1):
                    name = player.get('name', player.get('web_name', 'Unknown'))
                    pos = player.get('position', player.get('element_type', '?'))
                    print(f"  {i}. {name:20s} ({pos:3s})")
            
            
            print("\n📁 Results saved to outputs/ directory")
        
    except Exception as e:
        print(f"❌ Analysis failed: {e}")
        if debug:
            traceback.print_exc()
        else:
            print("Run with `--debug` to surface the stack trace.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run FPL Sage enhanced analysis")
    parser.add_argument("--debug", action="store_true", help="Dump traceback when analysis fails")
    parser.add_argument(
        "--risk-posture",
        type=str,
        choices=["CONSERVATIVE", "BALANCED", "AGGRESSIVE"],
        help="Override manager risk tolerance (CONSERVATIVE|BALANCED|AGGRESSIVE)"
    )
    args = parser.parse_args()
    asyncio.run(main(debug=args.debug, risk_posture=args.risk_posture))
