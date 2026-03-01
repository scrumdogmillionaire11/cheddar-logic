# Follow-up Issues to Fix

## Post Manual Transfer Bug Fix - January 10, 2026

### Issue 1: Manual Player Display Name
- **Problem**: Collins shows as "Player 999999 - £0.0m - 5.0 pts" instead of proper name
- **Root Cause**: Fallback projection uses temporary player_id 999999, display logic needs to handle manual players
- **Priority**: Medium (cosmetic but confusing)
- **Location**: Recommended XI formatting in analysis output

### Issue 2: Chip Window Analysis Missing
- **Problem**: "🧭 Chip Window: UNAVAILABLE (missing context)"
- **Root Cause**: Chip window scoring/analysis logic not working, missing required data or calculation
- **Priority**: Medium (affects chip timing decisions)
- **Location**: Decision analysis output header

### Issue 3: Questionable Defensive Recommendations
- **Problem**: System recommending 2 Brentford defenders (likely Thiago FWD + Lewis-Potter DEF) against Chelsea
- **Root Cause**: May be fixture difficulty calculation issue or positional classification problem
- **Priority**: Low (user can override, but affects trust in recommendations)
- **Location**: Recommended XI logic
- **Note**: User questioning the tactical wisdom but willing to "roll with it"

### Issue 4: Need FPL-Specialized IDE Agent
- **Problem**: General-purpose coding assistant lacks deep FPL domain knowledge for optimal orchestration
- **Proposal**: Create specialized IDE agent that acts as "brain" for FPL analysis system
- **Priority**: Enhancement (would improve development experience)
- **Features Needed**:
  - Deep understanding of FPL mechanics, terminology, and analysis patterns
  - Context-aware suggestions for FPL-specific debugging and development
  - Better orchestration of sports analytics conversations
  - Knowledge of FPL data structures, rules, and constraints
  - Understanding of fantasy football strategy and analysis needs

### Status
- Core manual transfer bugs: ✅ FIXED
- Manual transfers now properly applied to analysis
- Squad rule violations resolved  
- Override reporting working
- Analysis completion unblocked

### Next Steps
1. Fix display name for manually added players
2. Investigate chip window analysis failure
3. Review fixture difficulty scoring for defensive recommendations