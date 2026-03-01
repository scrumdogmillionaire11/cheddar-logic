#!/usr/bin/env python3
"""
Standalone Manual Transfer Manager
Quick script to manage transfers without running full analysis
"""

import os
import sys

from cheddar_fpl_sage.utils.manual_transfer_manager import ManualTransferManager


def main():
    """Main entry point for transfer manager"""
    config_path = os.path.join(os.path.dirname(__file__), '..', 'config', 'team_config.json')
    
    print("🔄 FPL Sage - Manual Transfer Manager")
    print("=" * 45)
    print("Use this tool to input transfers you've made that aren't showing in FPL yet.")
    print("This keeps your analysis up-to-date with your actual team.\n")
    
    # Command line arguments for quick actions
    if len(sys.argv) > 1:
        if sys.argv[1] == '--check' or sys.argv[1] == '-c':
            # Quick check mode
            manager = ManualTransferManager(config_path)
            manager.quick_transfer_check()
            return
        
        elif sys.argv[1] == '--clear':
            # Clear all overrides
            manager = ManualTransferManager(config_path)
            confirm = input("🗑️  Clear all manual overrides? (y/n): ").lower().strip()
            if confirm == 'y':
                manager.update_config_with_overrides({})
                print("✅ All manual overrides cleared!")
            return
        
        elif sys.argv[1] == '--quick' and len(sys.argv) >= 4:
            # Quick transfer: --quick "Player Out" "Player In" [cost]
            out_player = sys.argv[2]
            in_player = sys.argv[3]
            cost = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4].lstrip('-').isdigit() else 0
            
            manager = ManualTransferManager(config_path)
            if manager.add_quick_transfer(out_player, in_player, cost):
                print(f"✅ Transfer added: {out_player} → {in_player} (cost: {cost})")
            return
        
        elif sys.argv[1] == '--help' or sys.argv[1] == '-h':
            print_help()
            return
    
    # Interactive mode
    manager = ManualTransferManager(config_path)
    manager.main()


def print_help():
    """Print help information"""
    print("""
Usage: python manage_transfers.py [options]

Options:
  (no args)              Interactive transfer management
  -c, --check           Show current manual overrides
  --clear               Clear all manual overrides
  --quick "Out" "In" [cost]  Quick add single transfer
  -h, --help            Show this help message

Examples:
  python manage_transfers.py --check
  python manage_transfers.py --quick "Salah" "Haaland" -4
  python manage_transfers.py --quick "123456" "234567" 0
  
Note: Players can be specified by name or ID number.
""")


if __name__ == "__main__":
    main()
