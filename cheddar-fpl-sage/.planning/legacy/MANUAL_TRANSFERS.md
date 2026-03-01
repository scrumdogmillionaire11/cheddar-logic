# Manual Transfer Input Feature

## Overview
The Manual Transfer Manager allows users to input transfers they've made that haven't yet appeared in the FPL API. This is particularly useful during the period between making transfers and the gameweek going live.

## Key Features

### 🔄 **Transfer Tracking**
- Input pending transfers (player out → player in)
- Track transfer costs (-4, -8, or free)
- Support for both player names and IDs

### 👑 **Captaincy Override**
- Set captain and vice-captain manually
- Override API captaincy when you've made changes

### ⚽ **Lineup Control**  
- Set your starting XI manually
- Control bench order
- Useful for Free Hit or Wildcard planning

## Player Name Matching

### **How It Works**
The system uses intelligent fuzzy matching with multiple fallback strategies:

1. **Exact web name match**: "Salah" → "M.Salah"
2. **First/last name match**: "Mohamed" → "M.Salah" 
3. **Partial matching**: "van Dijk" → "Virgil"
4. **Common variations**: "Mo" → "M.Salah"

### **What Works Well**
```bash
✅ Web names: "Salah", "Haaland", "Palmer"
✅ First names: "Mohamed", "Erling", "Cole"
✅ Any case: "SALAH", "haaland", "PaLmEr"
✅ Hyphenated: "van Dijk", "Mac Allister"
✅ Nicknames: "Mo" (Mohamed), "Bruno" (Bruno Fernandes)
```

### **What's Tricky**
```bash
⚠️  Initials: "VVD" (use "van Dijk" instead)
⚠️  Too generic: "Bruno F" (use "Bruno" or "B.Fernandes")
⚠️  Creative nicknames: System doesn't know all variations
```

### **Testing Names**
```bash
# Test before adding transfers
python scripts/quick_test_names.py "Bruno" "Wirtz" "VVD"

# Interactive testing within transfer manager (option 6)
python scripts/manage_transfers.py
```

## Usage

### Interactive Mode
```bash
# Full interactive setup
python scripts/manage_transfers.py
```

### Quick Commands
```bash
# Check current manual settings
python scripts/manage_transfers.py --check

# Add a quick transfer
python scripts/manage_transfers.py --quick "Salah" "Haaland" -4

# Clear all manual overrides  
python scripts/manage_transfers.py --clear
```

### Integration with Main Analysis
The manual transfer system automatically integrates with the main analysis workflow:

```bash
# During regular analysis
python fpl_sage.py
# Will prompt to add/update manual transfers if team ID provided
```

## Configuration

Manual overrides are stored in `config/team_config.json`:

```json
{
  "manual_overrides": {
    "planned_transfers": [
      {
        "out_name": "Salah",
        "in_name": "Haaland", 
        "cost": -4,
        "added": "2025-01-15T10:30:00"
      }
    ],
    "captain": "Haaland",
    "vice_captain": "Son",
    "planned_starters": [
      "Haaland", "Son", "Palmer", "..."
    ],
    "last_updated": "2025-01-15T10:30:00"
  }
}
```

## Why This Matters

### **API Lag Problem**
- FPL API often lags behind actual transfers
- Transfers may not appear until gameweek is live
- Analysis based on old team composition can be misleading

### **Decision Timing**
- Best transfer decisions happen before deadline
- Need to analyze the team you'll actually have
- Manual input bridges this gap

### **Use Cases**
- **Pre-deadline planning**: Analyze team with pending transfers
- **Free Hit strategy**: Plan entire new team
- **Wildcard preparation**: Test different team compositions  
- **Captain changes**: Override when API hasn't updated

## Advanced Features

### **Player Matching**
The system accepts both:
- Player names (e.g., "Salah", "Haaland")
- Player IDs (e.g., "123456", "234567")

### **Transfer Cost Tracking**
- Automatically tracks hit costs
- Supports -4, -8, or 0 for free transfers
- Helps with overall team planning

### **Data Integration**
- Seamlessly integrates with existing collector system
- Applied during team data processing
- Overrides API data when manual input available

## Best Practices

1. **Update regularly**: Clear overrides after gameweek goes live
2. **Verify names**: Double-check player names for accuracy  
3. **Track costs**: Always input transfer costs for accurate analysis
4. **Use sparingly**: Only when API data is significantly delayed
5. **Clear after deadline**: Remove overrides once API catches up