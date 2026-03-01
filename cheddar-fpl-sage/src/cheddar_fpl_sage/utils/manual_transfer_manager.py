#!/usr/bin/env python3
"""
Manual Transfer Input Manager
Allows users to input transfers they've made but aren't yet reflected in the FPL API
"""

from datetime import datetime
from typing import Dict, List, Optional

from .sprint3_5_config_manager import Sprint35ConfigManager

class ManualTransferManager:
    """Manage pending transfers through user interaction"""
    
    def __init__(self, config_file: str = "team_config.json"):
        self.config_file = config_file
        self.config_manager = Sprint35ConfigManager(config_file)

    def _load_config(self) -> Dict:
        return self.config_manager.get_config(force_reload=True)
    
    def get_pending_transfers(self) -> List[Dict]:
        """Get current pending transfers from config"""
        config = self._load_config()
        return config.get('manual_overrides', {}).get('planned_transfers', [])
    
    def get_manual_overrides(self) -> Dict:
        """Get all manual overrides from config"""
        config = self._load_config()
        return config.get('manual_overrides', {})
    
    def interactive_transfer_setup(self, players_data: Optional[Dict] = None) -> Dict:
        """Interactive setup for pending transfers and team changes"""
        print("\n🔄 MANUAL TRANSFER & TEAM SETUP")
        print("=" * 50)
        print("Enter any transfers you've made that aren't showing in the FPL app yet.")
        print("This helps the analysis work with your actual upcoming team.")
        print("\n💡 Player Name Tips:")
        print("  • Use web names from FPL: 'Salah', 'Haaland', 'Palmer'")
        print("  • First names work: 'Mohamed', 'Erling', 'Cole'") 
        print("  • Nicknames: 'Mo', 'KDB', case doesn't matter")
        print("  • Player IDs also work if names fail\n")
        
        # Start with existing transfers
        current_transfers = self.get_pending_transfers()
        manual_overrides = self.get_manual_overrides()
        
        if current_transfers:
            print("📋 Current pending transfers:")
            for i, transfer in enumerate(current_transfers, 1):
                out_name = transfer.get('out_name', transfer.get('out_id', 'Unknown'))
                in_name = transfer.get('in_name', transfer.get('in_id', 'Unknown'))
                print(f"  {i}. {out_name} → {in_name}")
            
            clear = input("\n🗑️  Clear current transfers and start fresh? (y/n): ").lower().strip()
            if clear == 'y':
                current_transfers = []
                manual_overrides.pop('planned_transfers', None)
        
        # Menu-driven approach
        transfers = current_transfers.copy()
        
        while True:
            print("\n🔄 TRANSFER MANAGER")
            print(f"Current transfers: {len(transfers)}")
            print("\nOptions:")
            print("1. Add a transfer (Player Out → Player In)")
            print("2. Set captain & vice-captain")
            print("3. Set starting XI & bench order")
            print("4. Review & save")
            print("5. Clear all and exit")
            print("6. Test player name matching")
            
            choice = input("\nChoose option (1-6): ").strip()
            
            if choice == '1':
                transfer = self._add_single_transfer()
                if transfer:
                    transfers.append(transfer)
                    print(f"✅ Added: {transfer.get('out_name', 'Unknown')} → {transfer.get('in_name', 'Unknown')}")
            
            elif choice == '2':
                captain_info = self._set_captaincy()
                if captain_info:
                    manual_overrides.update(captain_info)
            
            elif choice == '3':
                lineup = self._set_lineup()
                if lineup:
                    manual_overrides['planned_starters'] = lineup
            
            elif choice == '4':
                # CRITICAL A3: Validate all transfers before saving
                valid_transfers = []
                invalid_count = 0
                
                for transfer in transfers:
                    if self._is_valid_transfer(transfer):
                        valid_transfers.append(transfer)
                    else:
                        invalid_count += 1
                        out_desc = transfer.get('out_name') or transfer.get('out_id') or 'Unknown'
                        in_desc = transfer.get('in_name') or transfer.get('in_id') or 'Unknown'
                        print(f"⚠️  Skipping invalid transfer: {out_desc} → {in_desc}")
                
                if invalid_count > 0:
                    print(f"\n⚠️  {invalid_count} invalid transfer(s) removed")
                
                # CRITICAL A3: Always save planned_transfers (even if empty array)
                manual_overrides['planned_transfers'] = valid_transfers
                manual_overrides['last_updated'] = datetime.now().isoformat()
                
                self._show_summary(manual_overrides)
                confirm = input("\n💾 Save these settings? (y/n): ").lower().strip()
                
                if confirm == 'y':
                    return manual_overrides
                else:
                    continue
            
            elif choice == '5':
                print("🚫 Clearing all manual overrides...")
                return {}
            
            elif choice == '6':
                self._test_player_matching()
            
            else:
                print("❌ Invalid choice. Please enter 1-6.")
    
    def _add_single_transfer(self) -> Optional[Dict]:
        """Add a single transfer interactively"""
        print("\n📝 ADD TRANSFER")
        print("Enter player names or IDs. Leave blank if you're done.")
        
        # Player out
        out_input = input("Player OUT (name or ID): ").strip()
        if not out_input:
            return None
        
        # CRITICAL A3: Validate out_input is not a placeholder
        if self._is_placeholder(out_input):
            print("❌ Invalid player - cannot use 'None', 'Unknown', '?', or placeholders")
            return None
        
        # Player in  
        in_input = input("Player IN (name or ID): ").strip()
        if not in_input:
            return None
        
        # CRITICAL A3: Validate in_input is not a placeholder
        if self._is_placeholder(in_input):
            print("❌ Invalid player - cannot use 'None', 'Unknown', '?', or placeholders")
            return None
        
        # Try to determine if it's ID or name
        transfer = {}
        
        # Handle out player - ENFORCE required field
        if out_input.isdigit():
            out_id = int(out_input)
            if out_id <= 0:  # Invalid ID
                print("❌ Invalid player ID - must be positive")
                return None
            transfer['out_player_id'] = out_id
            transfer['out_id'] = out_id  # Keep for backward compatibility
        else:
            transfer['out_name'] = out_input
            transfer['out_player_id'] = None  # Will be resolved later
        
        # Handle in player - ENFORCE required field
        if in_input.isdigit():
            in_id = int(in_input)
            if in_id <= 0:  # Invalid ID
                print("❌ Invalid player ID - must be positive")
                return None
            transfer['in_player_id'] = in_id
            transfer['in_id'] = in_id  # Keep for backward compatibility
        else:
            transfer['in_name'] = in_input
            transfer['in_player_id'] = None  # Will be resolved later
        
        # Optional: ask for hit info
        hit_cost = input("Transfer cost/hit (-4, -8, or 0 for free): ").strip()
        if hit_cost and hit_cost.lstrip('-').isdigit():
            transfer['cost'] = int(hit_cost)
        
        return transfer
    
    def _is_placeholder(self, value: str) -> bool:
        """Check if a value is a placeholder that should not be saved"""
        if not value or not value.strip():
            return True
        
        # Normalize for comparison
        normalized = value.lower().strip()
        
        # List of invalid placeholders
        placeholders = {
            'none', 'null', 'unknown', '?', '??', '???',
            'n/a', 'na', 'tbd', 'to be determined',
            'placeholder', 'temp', 'temporary'
        }
        
        return normalized in placeholders or normalized.startswith('?')
    
    def _set_captaincy(self) -> Optional[Dict]:
        """Set captain and vice-captain"""
        print("\n👑 SET CAPTAIN & VICE-CAPTAIN")
        
        captain = input("Captain (name or ID): ").strip()
        if not captain:
            return None
        
        vice = input("Vice-captain (name or ID): ").strip()
        
        captaincy = {}
        
        if captain:
            if captain.isdigit():
                captaincy['captain_id'] = int(captain)
            else:
                captaincy['captain'] = captain
        
        if vice:
            if vice.isdigit():
                captaincy['vice_captain_id'] = int(vice)
            else:
                captaincy['vice_captain'] = vice
        
        return captaincy
    
    def _set_lineup(self) -> Optional[List[str]]:
        """Set starting XI"""
        print("\n⚽ SET STARTING XI")
        print("Enter your 11 starters (names or IDs), one per line.")
        print("Press Enter with no input when done:")
        
        starters = []
        for i in range(11):
            player = input(f"Starter {i+1}: ").strip()
            if not player:
                break
            starters.append(player)
        
        if len(starters) == 0:
            return None
        
        if len(starters) < 11:
            print(f"⚠️  Only {len(starters)} players entered. You can add more later.")
        
        return starters
    
    def _test_player_matching(self):
        """Test player name matching interactively"""
        print("\n🧪 PLAYER NAME MATCHING TEST")
        print("Test how well your player names will match.")
        print("Enter player names to see if they'll be found (or 'q' to quit):")
        
        try:
            import asyncio
            from cheddar_fpl_sage.collectors.enhanced_fpl_collector import EnhancedFPLCollector
            
            async def test_matching():
                async with EnhancedFPLCollector() as collector:
                    data = await collector.get_current_data()
                    elements = {p['id']: p for p in data['elements']}
                    
                    while True:
                        test_name = input("\nPlayer name to test (or 'q' to quit): ").strip()
                        if test_name.lower() == 'q':
                            break
                        
                        if not test_name:
                            continue
                        
                        matched_player = collector._match_player(test_name, elements)
                        
                        if matched_player:
                            print(f"✅ '{test_name}' matches:")
                            print(f"   Web name: {matched_player['web_name']}")
                            print(f"   Full name: {matched_player['first_name']} {matched_player['second_name']}")
                            print(f"   Team: {matched_player.get('team_code', 'Unknown')}")
                            print(f"   Position: {matched_player.get('element_type', 'Unknown')}")
                        else:
                            print(f"❌ '{test_name}' → No match found")
                            print("💡 Try:")
                            print("   • Check spelling")
                            print("   • Use web name from FPL site")
                            print("   • Try first name only")
                            print("   • Use player ID as fallback")
            
            # Run the async test
            asyncio.run(test_matching())
            
        except Exception as e:
            print(f"❌ Could not run matching test: {e}")
            print("💡 Run 'python scripts/test_transfer_matching.py' for detailed testing")

    def _is_valid_transfer(self, transfer: Dict) -> bool:
        """Validate that transfer has required fields and no placeholders"""
        if not transfer:
            return False
        
        # Check for required fields (at least one identifier for each player)
        has_out = bool(transfer.get('out_player_id') or transfer.get('out_id') or transfer.get('out_name'))
        has_in = bool(transfer.get('in_player_id') or transfer.get('in_id') or transfer.get('in_name'))
        
        if not (has_out and has_in):
            return False
        
        # Check for placeholder values in names
        for field in ['out_name', 'in_name']:
            value = transfer.get(field)
            if value and self._is_placeholder(str(value)):
                return False
        
        # Check for invalid IDs (None, 0, negative)
        for field in ['out_player_id', 'in_player_id', 'out_id', 'in_id']:
            value = transfer.get(field)
            if value is not None:
                try:
                    if int(value) <= 0:
                        return False
                except (ValueError, TypeError):
                    return False
        
        return True
    
    def _show_summary(self, manual_overrides: Dict):
        """Show summary of manual overrides"""
        print("\n📊 MANUAL OVERRIDE SUMMARY")
        print("=" * 40)
        self.config_manager.invalidate_cache()
        manual_summary = self.config_manager.get_manual_override_summary()
        for line in manual_summary.splitlines():
            print(line)
        print("")
        
        transfers = manual_overrides.get('planned_transfers', [])
        if transfers:
            print(f"🔄 Transfers ({len(transfers)}):")
            for i, transfer in enumerate(transfers, 1):
                out = transfer.get('out_name', transfer.get('out_id', '?'))
                in_player = transfer.get('in_name', transfer.get('in_id', '?'))
                cost = transfer.get('cost', '?')
                print(f"  {i}. {out} → {in_player} (cost: {cost})")
        
        captain = manual_overrides.get('captain') or manual_overrides.get('captain_id')
        vice = manual_overrides.get('vice_captain') or manual_overrides.get('vice_captain_id')
        
        if captain:
            print(f"👑 Captain: {captain}")
        if vice:
            print(f"🥈 Vice-captain: {vice}")
        
        starters = manual_overrides.get('planned_starters', [])
        if starters:
            print(f"⚽ Starting XI: {len(starters)} players set")
        
    
    def update_config_with_overrides(self, manual_overrides: Dict):
        """Update config file with manual overrides"""
        success = self.config_manager.update_manual_overrides(manual_overrides)
        if manual_overrides:
            print(f"💾 Manual overrides saved to {self.config_file}" if success else "⚠️ Failed to save manual overrides")
        else:
            print(f"🗑️  Manual overrides cleared from {self.config_file}" if success else "⚠️ Failed to clear manual overrides")
    
    def quick_transfer_check(self) -> Dict:
        """Quick check of current manual overrides"""
        overrides = self.get_manual_overrides()
        
        if not overrides:
            print("ℹ️  No manual overrides configured.")
            return {}
        
        print("\n🔧 CURRENT MANUAL OVERRIDES:")
        self._show_summary(overrides)
        
        return overrides
    
    def add_quick_transfer(self, out_player: str, in_player: str, cost: int = 0) -> bool:
        """Add a transfer quickly without full interactive setup"""
        try:
            config = self._load_config()
            manual_overrides = config.get('manual_overrides', {})
            transfers = manual_overrides.get('planned_transfers', [])
            
            # Add new transfer
            new_transfer = {
                'out_name' if not out_player.isdigit() else 'out_id': 
                    out_player if not out_player.isdigit() else int(out_player),
                'in_name' if not in_player.isdigit() else 'in_id': 
                    in_player if not in_player.isdigit() else int(in_player),
                'cost': cost,
                'added': datetime.now().isoformat()
            }
            
            transfers.append(new_transfer)
            manual_overrides['planned_transfers'] = transfers
            manual_overrides['last_updated'] = datetime.now().isoformat()
            
            manual_overrides['planned_transfers'] = transfers
            manual_overrides['last_updated'] = datetime.now().isoformat()
            return self.config_manager.update_manual_overrides(manual_overrides)
        
        except Exception as e:
            print(f"❌ Failed to add transfer: {e}")
            return False

def main():
    """Run interactive transfer configuration"""
    manager = ManualTransferManager()
    
    print("🔄 FPL Sage - Manual Transfer Manager")
    print("=" * 45)
    
    # Show current status if exists
    current_overrides = manager.get_manual_overrides()
    if current_overrides:
        print("\n📊 Current manual overrides:")
        manager.quick_transfer_check()
        
        update = input("\n🔄 Update manual settings? (y/n): ").lower().strip()
        if update != 'y':
            print("👍 Keeping current configuration.")
            return current_overrides
    
    # Run interactive setup
    manual_overrides = manager.interactive_transfer_setup()
    
    # Save configuration
    manager.update_config_with_overrides(manual_overrides)
    
    print("\n✅ Manual transfer configuration complete!")
    return manual_overrides

if __name__ == "__main__":
    main()
