#!/usr/bin/env python3
"""
FPL Sage Data Organizer
Moves existing data files to organized structure and creates summary
"""

import json
import shutil
from pathlib import Path
from datetime import datetime

def organize_existing_files():
    """Move existing data files to organized structure"""
    base_dir = Path(".")
    outputs_dir = Path("outputs")
    
    # Create output directories
    (outputs_dir / "data_collections").mkdir(parents=True, exist_ok=True)
    (outputs_dir / "processed_data").mkdir(parents=True, exist_ok=True)
    (outputs_dir / "logs").mkdir(parents=True, exist_ok=True)
    (outputs_dir / "config").mkdir(parents=True, exist_ok=True)
    (outputs_dir / "integration").mkdir(parents=True, exist_ok=True)
    
    moved_files = []
    
    # Move existing JSON data files
    for json_file in base_dir.glob("*.json"):
        if json_file.name.startswith("fpl_data_") or json_file.name == "test_collection.json":
            dest = outputs_dir / "data_collections" / json_file.name
            shutil.move(json_file, dest)
            moved_files.append(f"✓ {json_file.name} → data_collections/")
    
    # Move config file
    config_file = base_dir / "fpl_config.json"
    if config_file.exists():
        dest = outputs_dir / "config" / "fpl_config.json"
        shutil.move(config_file, dest)
        moved_files.append("✓ fpl_config.json → config/")
    
    # Move integration example
    integration_file = base_dir / "integration_example.py"
    if integration_file.exists():
        dest = outputs_dir / "integration" / "integration_example.py"
        shutil.move(integration_file, dest)
        moved_files.append("✓ integration_example.py → integration/")
    
    # Copy requirements files to config
    for req_file in base_dir.glob("requirements*.txt"):
        dest = outputs_dir / "config" / req_file.name
        shutil.copy2(req_file, dest)
        moved_files.append(f"✓ {req_file.name} → config/ (copied)")
    
    return moved_files

def create_data_summary():
    """Create summary of available data"""
    outputs_dir = Path("outputs")
    summary = {
        "generated_at": datetime.now().isoformat(),
        "fpl_sage_data_summary": {
            "season": "2025-26",
            "current_gameweek": None,
            "total_players": 0,
            "total_fixtures": 0
        },
        "available_files": {
            "data_collections": [],
            "processed_data": [],
            "config": [],
            "integration": []
        },
        "file_descriptions": {
            "data_collections": "Raw FPL API data in JSON format",
            "processed_data": "Data formatted for your FPL Sage models",
            "config": "Configuration files and requirements",
            "integration": "Code examples for integrating with your models"
        }
    }
    
    # Scan directories
    for category in summary["available_files"].keys():
        dir_path = outputs_dir / category
        if dir_path.exists():
            for file_path in dir_path.glob("*"):
                file_info = {
                    "name": file_path.name,
                    "size_kb": round(file_path.stat().st_size / 1024, 2),
                    "modified": datetime.fromtimestamp(file_path.stat().st_mtime).isoformat()
                }
                summary["available_files"][category].append(file_info)
    
    # Get data details from latest collection
    latest_data_file = None
    data_dir = outputs_dir / "data_collections"
    if data_dir.exists():
        json_files = list(data_dir.glob("*.json"))
        if json_files:
            latest_data_file = max(json_files, key=lambda f: f.stat().st_mtime)
    
    if latest_data_file:
        try:
            with open(latest_data_file, 'r') as f:
                data = json.load(f)
                summary["fpl_sage_data_summary"]["current_gameweek"] = data.get("current_gameweek")
                summary["fpl_sage_data_summary"]["total_players"] = len(data.get("players", []))
                summary["fpl_sage_data_summary"]["total_fixtures"] = len(data.get("fixtures", []))
        except (FileNotFoundError, KeyError, TypeError):
            pass
    
    # Save summary
    summary_path = outputs_dir / "DATA_SUMMARY.json"
    with open(summary_path, 'w') as f:
        json.dump(summary, f, indent=2)
    
    return summary, summary_path

def create_readme():
    """Create README for outputs directory"""
    readme_content = """# FPL Sage Data Outputs

This directory contains all data collected and processed by the FPL Sage automated collection system.

## 📁 Directory Structure

```
outputs/
├── data_collections/     # Raw FPL API data (JSON format)
├── processed_data/       # Data formatted for FPL Sage models
├── config/              # Configuration files and requirements
├── integration/         # Code examples and integration helpers
├── logs/               # System logs and collection history
└── DATA_SUMMARY.json   # Overview of all available data
```

## 📊 Data Files

### data_collections/
- **Raw FPL API responses** in JSON format
- Contains player data, fixtures, teams, gameweek info
- File naming: `fpl_data_YYYYMMDD_HHMMSS.json`
- Compatible with your existing FPL Sage model formats

### processed_data/ 
- **Model-ready data** formatted for direct use
- Includes FplTeamInput and FixtureModelInput formats
- Sample team configurations and fixture analyses

### config/
- **System configuration** files
- **Requirements** files for dependencies  
- **Settings** for automated collection

### integration/
- **Code examples** for connecting to your existing models
- **Integration patterns** and best practices
- **Helper functions** for data processing

## 🚀 Using the Data

### Quick Integration
```python
# Load latest data
with open('outputs/data_collections/latest_collection.json') as f:
    fpl_data = json.load(f)

# Data is already in your model formats:
players = fpl_data['players']        # FplPlayerEntry format
fixtures = fpl_data['fixtures']      # FixtureRow format  
gameweek = fpl_data['current_gameweek']
```

### Model Integration
Check `integration/integration_example.py` for complete examples of feeding this data into your:
- FPL Team Model
- FPL Fixture Model  
- FPL Projection Engine
- Transfer Advisor Workflow

## 📈 Data Freshness

- **Updated**: Automatically via scheduled collections
- **Manual Updates**: Run `python simple_fpl_collector.py`  
- **Current Season**: 2025-26
- **Data Source**: Official FPL API

## 🔄 Transfer to Your Project

1. **Copy the entire `outputs/` directory** to your main project
2. **Use integration examples** to connect data to your models
3. **Set up automated collection** using the scheduler components
4. **Monitor data freshness** using the summary files

All data is ready for immediate use with your existing FPL Sage system!
"""
    
    readme_path = Path("outputs") / "README.md"
    with open(readme_path, 'w') as f:
        f.write(readme_content)
    
    return readme_path

def main():
    """Organize all FPL Sage data outputs"""
    print("🏈 FPL Sage Data Organizer")
    print("=" * 30)
    
    # Organize files
    print("\n📁 Moving files to organized structure...")
    moved_files = organize_existing_files()
    for file_info in moved_files:
        print(f"   {file_info}")
    
    # Create summary
    print("\n📊 Creating data summary...")
    summary, summary_path = create_data_summary()
    print(f"   ✓ Summary created: {summary_path}")
    
    # Create README
    print("\n📖 Creating documentation...")
    readme_path = create_readme()
    print(f"   ✓ README created: {readme_path}")
    
    # Show summary
    print("\n" + "=" * 30)
    print("📈 Data Summary:")
    print(f"   Season: {summary['fpl_sage_data_summary']['season']}")
    print(f"   Current GW: {summary['fpl_sage_data_summary']['current_gameweek']}")
    print(f"   Players: {summary['fpl_sage_data_summary']['total_players']}")
    print(f"   Fixtures: {summary['fpl_sage_data_summary']['total_fixtures']}")
    
    print("\n📂 Available Files:")
    for category, files in summary['available_files'].items():
        if files:
            print(f"   {category}: {len(files)} files")
    
    print("\n🎉 Organization complete!")
    print("📁 All data organized in: outputs/")
    print("📋 Check: outputs/README.md for usage guide")
    print("📊 Check: outputs/DATA_SUMMARY.json for details")

if __name__ == '__main__':
    main()