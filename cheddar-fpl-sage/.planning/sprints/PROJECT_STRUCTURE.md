# FPL Sage Project Structure

## Core Application
```
fpl_sage.py                 # Main entry point
config/                     # Configuration files
├── requirements.txt        # Production dependencies
├── requirements_minimal.txt
└── team_config.json       # Team-specific settings
```

## Source Code
```
src/
├── __init__.py
├── analysis/              # Decision logic
├── collectors/            # Data collection
├── models/               # Data models & contracts
└── utils/                # Utilities
```

## Documentation
```
docs/
├── ARCHITECTURE.md       # Technical architecture
├── components/           # Component-specific docs
└── legacy/              # Old/deprecated docs
```

## Scripts & Tools
```
scripts/                  # Utility scripts
├── run_analysis.py      # Main analysis runner
├── manage_transfers.py  # Transfer management
└── ...
```

## Data & Outputs
```
outputs/
├── data_collections/    # Organized by date
│   ├── 2024-12-26/     # Latest collections
│   ├── 2024-12-23/     # Previous day
│   └── legacy/         # Old format data
├── processed_data/     # Analysis results
├── integration/        # Integration examples
└── logs/              # System logs
```

## Development & Testing
```
archive/
├── debug_scripts/      # Debug utilities
├── test_scripts/       # Test files
└── old_docs/          # Archived documentation

tests/                  # Formal test suite
```

## Key Files
- `README.md` - User documentation
- `PROJECT_STRUCTURE.md` - This file
- `OPTIMIZATION_SUMMARY.md` - Performance notes