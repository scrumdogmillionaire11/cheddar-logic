# FPL Sage Enhanced - Hybrid AI Analysis System

A comprehensive Fantasy Premier League analysis system featuring **hybrid FPL Sage + GPT integration** for accurate recommendations despite FPL API limitations.

## 🎯 **What Makes This Special**

✅ **Hybrid AI Workflow** - FPL Sage provides data foundation, GPT makes contextual decisions  
✅ **API Limitation Handling** - Solves stale team data with current team verification  
✅ **Smart Chip Analysis** - BB vs TC comparison with expected points calculations  
✅ **Specific Player Recommendations** - "Rice (£7.2m, 97pts) or Semenyo (£7.7m, 99pts)"  
✅ **Real-time Injury Tracking** - "B.Fernandes - Hamstring injury - Expected back 17 Jan"  
✅ **Team-Specific Analysis** - Different chip recommendations for different teams  
✅ **GPT-Optimized Output** - Pre-formatted for seamless GPT integration  

## 🤖 **The Hybrid Workflow**

**FPL Sage** → Comprehensive data analysis, injury tracking, fixture analysis  
**+**  
**GPT** → Contextual decisions with your current team state  
**=**  
**Accurate Recommendations** despite API limitations

### **Why Hybrid?**
- **FPL API Problem**: Only shows your team from last completed gameweek
- **Solution**: FPL Sage provides foundation analysis + GPT adjusts for current reality
- **Result**: Best of both worlds - deep data analysis + current context

## 🎯 **Key Features**

### **🔍 Intelligent Team Analysis**
```
📋 CURRENT TEAM STATE (from FPL API):
🥅 STARTERS:
  • Haaland (MCI) - £15.1m (C)
  • B.Fernandes (MUN) - £9.2m ❌

⚠️ Note: This reflects your team from the last completed gameweek.
💡 If you've made transfers since then, this won't show your current team.
```

### **💊 Real-Time Injury Integration**
```
🚨 INJURED/UNAVAILABLE STARTERS:
• B.Fernandes - Hamstring injury - Expected back 17 Jan (Next round: 0%)
```

### **🧠 Smart Chip Decision Engine**
```
CHIP OPTIONS ANALYSIS:
🪑 BENCH BOOST OPTION:
Expected: ~16 points from bench
  • Roefs (LEE) - ~4pts ✅
  • Mukiele (LEE) - ~4pts ✅

⚡ TRIPLE CAPTAIN OPTION:
Expected: ~18 points (double captain score)
  • Haaland (MCI) - ~18pts
  • Foden (MCI) - ~12pts

💡 SUGGESTION: Close call - consider fixture difficulty & rotation risk
```

### **🎯 Specific Player Recommendations**
```
Transfer Actions:
- ⚠️ UNACCEPTABLE RISK: Transfer out B.Fernandes immediately
  Target: Suggested: Rice (£7.2m, 97pts) or Semenyo (£7.7m, 99pts)
```

### **🤖 GPT Integration Ready**
```
FOR GPT ANALYSIS

Template for GPT:
My ACTUAL current team is:
GK: [Player names]
DEF: [Player names]
MID: [Player names]
FWD: [Player names]
Bench: [Player names]
Bank: £X.Xm | Free transfers: X

Based on my ACTUAL team above and the FPL Sage analysis:
1. Should I use Bench Boost or Triple Captain this week?
2. Who should be my captain and vice?
3. Any transfers needed?
```  

## 📁 **Project Structure**

```
cheddar-fpl-sage/
├── src/                     # Core source code
│   ├── collectors/          # Data collection modules
│   │   ├── enhanced_fpl_collector.py
│   │   └── simple_fpl_collector.py
│   ├── analysis/            # Decision analysis framework
│   │   ├── enhanced_decision_framework.py
│   │   └── fpl_sage_integration.py
│   └── utils/               # Helper utilities
│       └── chip_status_manager.py
├── docs/                    # Documentation
│   ├── models/              # Model specifications
│   └── workflows/           # Workflow documentation
├── config/                  # Configuration files
│   ├── team_config.json     # Team-specific settings
│   ├── requirements.txt     # Dependencies
│   └── requirements_minimal.txt
├── scripts/                 # Executable scripts
│   ├── run_analysis.py      # Main runner (NEW)
│   ├── setup_2025_season.py
│   └── organize_outputs.py
├── outputs/                 # Generated data
│   ├── data_collections/    # Raw API data
│   ├── processed_data/      # Analysis outputs
│   └── config/              # Generated configs
├── tests/                   # Test files
└── README.md               # This file
```

## 🚀 **Quick Start - Hybrid Workflow**

### **Step 1: Setup FPL Sage**
```bash
# Install dependencies
pip install -r config/requirements.txt

# Configure your team ID and chips
python scripts/run_analysis.py
# Enter your team ID when prompted
# Set up chip status interactively
```

### **Step 2: Run Analysis**  
```bash
# Get comprehensive FPL analysis
python scripts/run_analysis.py

# System will output:
# - Current team state (from API)
# - Chip options comparison (BB vs TC)
# - Specific player recommendations
# - GPT-ready template
```

### **Step 3: GPT Integration**
```bash
# Copy the entire FPL Sage output
# Share with GPT along with your ACTUAL current team
# GPT will adjust recommendations for your real team
```

### **Example Workflow:**
1. **FPL Sage says**: "BB expected ~16pts vs TC ~18pts, Bruno injured, suggest Rice"
2. **You tell GPT**: "My actual team has Roefs/Mukiele/Guéhi/Semenyo on bench, Bruno already transferred out"  
3. **GPT concludes**: "With your strong bench all starting, BB is clearly better than TC"

## 🎯 **Advanced Features**

### **Team-Specific Chip Detection**
- Uses **real chip data** for each team analyzed
- No more "everyone has BB+TC" - shows actual remaining chips
- Manual overrides for YOUR team, API data for others

### **Enhanced Player Matching**
- **Smart recommendations** with price/points context
- **Realistic alternatives** within reasonable price ranges  
- **Injury-aware suggestions** excluding problematic players

### **🔄 Manual Transfer Override**

The FPL API often shows outdated transfer counts, especially after the transfer window resets or during gameweek transitions. Here's how to manually set your actual transfer situation:

**Option 1: Edit config/team_config.json directly**
```json
{
  "team_id": 711511,
  "manual_overrides": {
    "free_transfers": 2,
    "bank_value": 1.5,
    "transfer_notes": "Made 1 transfer yesterday, should have 1 remaining"
  }
}
```

**Option 2: Command line override**
```bash
# Set specific transfer count
python -c "
import json
with open('config/team_config.json', 'r+') as f:
    config = json.load(f)
    config.setdefault('manual_overrides', {})['free_transfers'] = 2
    f.seek(0)
    json.dump(config, f, indent=2)
    f.truncate()
"

# Quick check what the system sees
python -c "
import asyncio
import sys, os
sys.path.append('.')
from src.analysis.fpl_sage_integration import FPLSageIntegration
sage = FPLSageIntegration(team_id=711511)
result = sage.run_quick_team_check()
print(f\"System sees: {result.get('team_info', {}).get('free_transfers', 'N/A')} free transfers\")
"
```

**Option 3: Interactive setup**
```bash
python scripts/manage_transfers.py --interactive
# Will prompt you for current transfer situation
```

**When to use manual override:**
- After making transfers that don't show in API yet
- During GW transition when counts reset
- When you know you have different count than API shows
- For testing different transfer scenarios

# 💡 Player Name Tips:
# Always test names first: python scripts/quick_test_names.py "PlayerName"
# Use FPL web names: "B.Fernandes" not "Bruno Fernandes"
# First names work: "Bruno", "Mohamed", "Cole"
# Case doesn't matter: "SALAH" = "Salah"

# If you want to rely on live API history instead:
#   - Remove the manual_chip_status block
#   - Keep chip_data_source unset or set to api_history
```

### 3. **Run Analysis**
```bash
# Interactive analysis with team data
python scripts/run_analysis.py

# Demo mode (no team ID required)
python scripts/run_analysis.py --demo

# Show system info
python scripts/run_analysis.py --info

# Quick transfer management
python scripts/manage_transfers.py --check    # View current transfers
python scripts/manage_transfers.py --quick "B.Fernandes" "Wirtz" -4  # Add transfer
python scripts/quick_test_names.py "Bruno" "Wirtz"  # Test player names

# Test multiple names at once
python scripts/quick_test_names.py "Salah" "Haaland" "Palmer"
```

## 🎯 **Enhanced Features**

### **Team Data Integration**
- **Personal squad analysis** with current prices and captaincy
- **Chip status tracking** (defaults to live API history; optional manual override)
- **Transfer history** and team value monitoring
- **Overall rank** and performance tracking
- **Manual transfer input** for pending transfers not yet reflected in FPL API

### **Captaincy & Transfers**
- **Auto captain/vice suggestion** from your current XI (points + price heuristic)
- **Transfer prompts** for flagged starters or weak bench depth
- **Bench depth check** so Bench Boost/rotation decisions are realistic
- **Pending transfer tracking** to analyze your actual upcoming team
- **Manual lineup override** for captain, vice-captain, and starting XI

### **Player Name Matching**
- **Smart fuzzy matching** handles name variations and common spellings
- **Use FPL web names**: 'B.Fernandes', 'M.Salah', 'Haaland' (not full names)
- **First names work**: 'Bruno', 'Mohamed', 'Erling' are recognized
- **Case insensitive**: 'SALAH', 'haaland', 'PaLmEr' all work
- **Test before use**: `python scripts/quick_test_names.py "Bruno" "Wirtz"`

### **Enhanced Decision Framework**
- **Risk scenario quantification**: "If [condition], expect [loss range]"
- **Tilt armor protection**: "Decision still correct if X fewer points"
- **Forward-looking planning**: Next chip window identification
- **Variance expectations**: Good process vs. bad luck indicators

### **Sample Analysis Output**
```
🔄================== TRANSFER SITUATION ==================
👤 Team: Wissa-pon a Sarr
📊 Manager: AJ Colubiale  
🏆 Overall Rank: 6,746,279
------------------------------------------------------------
Free Transfers Available: 0
Bank Value: £0.9m

🚨 INJURED/UNAVAILABLE STARTERS:
• B.Fernandes - Hamstring injury - Expected back 17 Jan (Next round: 0%)

📋 CURRENT TEAM STATE (from FPL API):
🥅 STARTERS:
  • Haaland (MCI) - £15.1m (C)
  • Foden (MCI) - £9.0m (VC)
  • B.Fernandes (MUN) - £9.2m ❌

🪑 BENCH:
  • Stach (LEE) - £4.8m
  • Estève (BUR) - £3.9m

⚠️ Note: This reflects your team from the last completed gameweek.
💡 If you've made transfers since then, this won't show your current team.
============================================================

## Decision: Activate Triple Captain on Haaland

CHIP OPTIONS ANALYSIS:
🪑 BENCH BOOST OPTION: Expected: ~16 points from bench
⚡ TRIPLE CAPTAIN OPTION: Expected: ~18 points (double captain score)
💡 SUGGESTION: Close call - consider fixture difficulty & rotation risk

Transfer Actions:
- ⚠️ UNACCEPTABLE RISK: Transfer out B.Fernandes immediately
  Target: Suggested: Rice (£7.2m, 97pts) or Semenyo (£7.7m, 99pts)

🤖 FOR GPT ANALYSIS
Template: [Ready-to-use GPT template with actual team slots]
```

## 🛠️ **Manual Overrides & Configuration**
   Action: Monitor team news

### Chip Strategy
Next optimal window: GW19
**Pivot conditions:**
- Confirmed Haaland minutes restriction
- City rotation concerns escalate

### Post-GW Expectations
**Expected Downside Range:** 0–4 points (variance-acceptable)
**Process Break Threshold:** ≥ 8 points
```

## 🔧 **Architecture Benefits**

### **Modular Design**
- **Collectors**: Data gathering (API, team data)
- **Analysis**: Decision logic and frameworks
- **Utils**: Helper functions and tools
- **Clear separation** of concerns

### **Maintainability**
- **Organized imports** with proper `__init__.py` files
- **Configuration management** centralized in `config/`
- **Documentation** properly categorized
- **Scripts** separated from core logic

### **Extensibility**
- **Easy to add** new collectors or analysis modules
- **Plugin architecture** for additional features
- **Clean interfaces** between components

## 📊 **Data Flow**

1. **Collection**: `collectors/` gather data from FPL API + team config
2. **Analysis**: `analysis/` processes data through decision framework  
3. **Output**: Results saved to `outputs/` with structured formats
4. **Configuration**: Team settings managed in `config/`

## 🛠️ **Development**

### **Common Transfer Name Issues**
```bash
# ❌ These won't work:
"Bruno Fernandes"  # Too long - use "B.Fernandes"
"Mohamed Salah"    # Use "M.Salah" or "Salah"
"VVD"             # Use "van Dijk" or "Virgil"

# ✅ These work perfectly:
"B.Fernandes"      # Official web name
"Bruno"            # First name
"Salah"            # Last name/web name
"Haaland"          # Web name
"van Dijk"         # Exact spelling

# Test any name first:
python scripts/quick_test_names.py "Your Player Name"
```

### **Transfer Name Quick Reference**
```bash
# Popular players - correct names to use:
"M.Salah" or "Salah"           # ❌ NOT "Mohamed Salah"
"Haaland"                      # ❌ NOT "Erling Haaland"  
"B.Fernandes" or "Bruno"       # ❌ NOT "Bruno Fernandes"
"Palmer" or "Cole"             # ✅ Both work
"Son"                          # ❌ NOT "Son Heung-min"
"Virgil" or "van Dijk"         # ❌ NOT "VVD"

# Quick test multiple names:
python scripts/quick_test_names.py "Salah" "Haaland" "Palmer"
```

### **Adding New Features**
```bash
# New collector
src/collectors/new_collector.py

# New analysis module  
src/analysis/new_analyzer.py

# New utility
src/utils/new_helper.py
```

### **Running Tests**
```bash
python tests/test_collection.py
python tests/integration_example.py
```

## 📈 **Migration from Old Structure**

If you have the old unorganized structure:

1. **Backup existing data**: `cp -r outputs/ outputs_backup/`
2. **Use optimized structure**: Copy your `team_config.json` to `config/`
3. **Run setup**: Configure chip status with new manager
4. **Test**: Run `python scripts/run_analysis.py` to verify

## 🎉 **Result**

A clean, maintainable FPL analysis system with:
- **Professional project structure**
- **Enhanced decision-making capabilities** 
- **Reliable team data integration**
- **Modular, extensible architecture**

Ready for serious FPL analysis! 🏆
