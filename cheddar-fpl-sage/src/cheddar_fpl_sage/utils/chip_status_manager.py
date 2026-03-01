#!/usr/bin/env python3
"""
Interactive Chip Status Configuration
Allows users to manually set their available chips since API data is unreliable
"""

from typing import Dict

from .sprint3_5_config_manager import normalize_manual_chip_status, Sprint35ConfigManager

class ChipStatusManager:
    """Manage chip status through user interaction"""
    
    def __init__(self, config_file: str = "team_config.json"):
        self.config_file = config_file
        self.config_manager = Sprint35ConfigManager(config_file)
        self.chip_options = {
            1: {"name": "Wildcard", "description": "Replace entire team without point hits"},
            2: {"name": "Free Hit", "description": "Temporary team for one gameweek only"}, 
            3: {"name": "Bench Boost", "description": "All 15 players score points this gameweek"},
            4: {"name": "Triple Captain", "description": "Captain scores triple points instead of double"}
        }
    
    def get_current_chip_status(self) -> Dict:
        """Get current chip status from config"""
        return self.config_manager.get_manual_chips() or {}
    
    def interactive_chip_setup(self) -> Dict:
        """Interactive setup for available chips"""
        print("\n🎯 CHIP STATUS SETUP")
        print("=" * 50)
        print("Since FPL API chip data is unreliable, let's set this manually.")
        print("Which chips do you still have available?\n")
        
        # Show options
        for num, chip_info in self.chip_options.items():
            print(f"{num}. {chip_info['name']}")
            print(f"   {chip_info['description']}")
        
        print("\n📝 Enter the numbers of chips you STILL HAVE (e.g., 1,3,4 or 3 or 1,2,3,4):")
        print("💡 Press Enter with no input if you've used all chips")
        
        while True:
            try:
                user_input = input("\nAvailable chips: ").strip()
                
                if not user_input:
                    # No chips available
                    available_chips = []
                    break
                
                # Parse input
                chip_numbers = [int(x.strip()) for x in user_input.split(',')]
                
                # Validate
                invalid_numbers = [n for n in chip_numbers if n not in self.chip_options]
                if invalid_numbers:
                    print(f"❌ Invalid chip numbers: {invalid_numbers}. Please use 1-4 only.")
                    continue
                
                available_chips = chip_numbers
                break
                
            except ValueError:
                print("❌ Please enter numbers separated by commas (e.g., 1,3,4)")
                continue
        
        # Create chip status
        chip_status = {}
        for num, chip_info in self.chip_options.items():
            chip_name = chip_info['name']
            chip_status[chip_name] = {
                "available": num in available_chips,
                "played_gw": None if num in available_chips else "unknown"
            }
        
        # Show summary
        print("\n✅ CHIP STATUS CONFIGURED")
        print("-" * 30)
        available_names = [self.chip_options[n]['name'] for n in available_chips]
        used_names = [info['name'] for num, info in self.chip_options.items() if num not in available_chips]
        
        if available_names:
            print(f"🎯 Available: {', '.join(available_names)}")
        else:
            print("🎯 Available: None")
            
        if used_names:
            print(f"❌ Used: {', '.join(used_names)}")
        
        return normalize_manual_chip_status(chip_status)
    
    def update_config_with_chips(self, chip_status: Dict):
        """Update config file with manual chip status"""
        success = self.config_manager.update_manual_chips(chip_status)
        if success:
            print(f"💾 Manual chip status saved to {self.config_file}")
        else:
            print(f"⚠️ Failed to save chip status to {self.config_file}")
    
    def quick_chip_check(self) -> Dict:
        """Quick check of current chip status"""
        chip_status = self.get_current_chip_status()
        
        if not chip_status:
            print("⚠️  No chip status configured. Run interactive setup.")
            return {}
        
        print("\n🎯 CURRENT CHIP STATUS:")
        for chip_name, status in chip_status.items():
            status_icon = "✅" if status['available'] else "❌"
            print(f"{status_icon} {chip_name}")
        
        return chip_status

def main():
    """Run interactive chip configuration"""
    manager = ChipStatusManager()
    
    print("🔧 FPL Sage - Chip Status Manager")
    print("=" * 40)
    
    # Show current status if exists
    current_status = manager.get_current_chip_status()
    if current_status:
        print("\n📊 Current status:")
        manager.quick_chip_check()
        
        update = input("\n🔄 Update chip status? (y/n): ").lower().strip()
        if update != 'y':
            print("👍 Keeping current configuration.")
            return current_status
    
    # Run interactive setup
    chip_status = manager.interactive_chip_setup()
    
    # Save to config
    manager.update_config_with_chips(chip_status)
    
    return chip_status

if __name__ == "__main__":
    main()
