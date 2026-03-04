# Code Audit: Unused & Duplicative Code Report
**Generated:** March 3, 2026  
**Scope:** Full cheddar-logic repository  
**Concern:** Legacy and duplicative items from multi-agent development

---

## Executive Summary

The project contains **significant code duplication** and several **legacy/unused components** that accumulated during multi-agent development:

| Category | Count | Severity |
|----------|-------|----------|
| **Duplicate Files** | 4 file pairs | 🔴 High |
| **Unused Debug/Test Scripts** | 9+ files | 🟡 Medium |
| **Legacy Config Files** | 3 duplicates | 🟡 Medium |
| **Unused SQL Wrapper** | 1 file | 🟡 Medium |
| **Sprint-versioned Code** | 2 integration adapters | 🟠 Consider |
| **Archive Folders** | 3 folders | 🟢 Low |

---

## 🔴 CRITICAL: Duplicate JavaScript Files

### 1. **Duplicate: espn-client.js**
- **Location 1:** [apps/worker/src/espn-client.js](apps/worker/src/espn-client.js)
- **Location 2:** [packages/data/src/espn-client.js](packages/data/src/espn-client.js)
- **Status:** Both exist and are virtually identical
- **Used by:** `team-metrics.js` (both versions import from local copy)
- **Problem:** Creates confusion about which is authoritative; changes to one won't propagate to the other
- **Recommendation:** 
  - Keep only `packages/data/src/espn-client.js` as the canonical source
  - Update `apps/worker/src/team-metrics.js` to import from `../../../packages/data/src/`
  - Delete `apps/worker/src/espn-client.js`

### 2. **Duplicate: team-metrics.js**
- **Location 1:** [apps/worker/src/team-metrics.js](apps/worker/src/team-metrics.js)
- **Location 2:** [packages/data/src/team-metrics.js](packages/data/src/team-metrics.js)
- **Status:** Both exist; `packages/data/` version is more complete (563 lines vs 353 lines)
- **Used by:** 
  - `apps/worker/src/jobs/` (via local import)
  - `packages/data/src/odds-enrichment.js` (via local import)
- **Problem:** Same as above — divergence over time, maintenance burden
- **Recommendation:**
  - Keep only `packages/data/src/team-metrics.js` (it's more feature-complete)
  - Update `apps/worker/src/team-metrics.js` to re-export from packages
  - Create wrapper: `apps/worker/src/team-metrics.js` → `module.exports = require('../../../packages/data/src/team-metrics.js')`

### 3. **Potential Issue: Multiple sqlite-wrapper implementations**
- **Location:** [packages/data/src/sqlite-wrapper.js](packages/data/src/sqlite-wrapper.js)
- **Status:** Exists but unused — no imports found
- **Current Usage:** Project uses [packages/data/src/db.js](packages/data/src/db.js) instead
- **Recommendation:** 
  - Verify this is not needed
  - If confirmed unused, archive to `_bmad-output/deprecated/`
  - Document why it exists (historical sql.js wrapper attempt?)

---

## 🟡 MEDIUM: Unused Debug & Test Scripts

### Root-level Quick Query Scripts (Debugging)**
These are ad-hoc scripts for manual database inspection. Not referenced anywhere in the codebase:

| File | Purpose | Recommendation |
|------|---------|-----------------|
| [check-ncaam-market.js](check-ncaam-market.js) | Query latest NCAAM card | Archive or move to `scripts/debug/` |
| [check-ncaam-payload.js](check-ncaam-payload.js) | Inspect NCAAM payload structure | Archive |
| [check-play-status.js](check-play-status.js) | Check recent card statuses | Archive |
| [check-raw-data.js](check-raw-data.js) | Query raw odds snapshot | Archive |
| [verify-markets.js](verify-markets.js) | Compare market data | Archive |

**Action:** Move all five to a dedicated `scripts/debug/` folder to declutter root:
```bash
mkdir scripts/debug
mv check-*.js verify-markets.js scripts/debug/
```

### Migration Scripts (Potentially Obsolete)**
| File | Purpose | Status |
|------|---------|--------|
| [scripts/migrate-dev-to-prod.js](scripts/migrate-dev-to-prod.js) | Synchronous migration (legacy) | 🟡 Superseded by `migrate-dev-to-prod-safe.sh` |
| [scripts/migrate-dev-to-prod-safe.sh](scripts/migrate-dev-to-prod-safe.sh) | Atomic safe migration | ✅ Current standard |

**Recommendation:** Remove or archive `migrate-dev-to-prod.js` (appears to be v1, replaced by shell script)

---

## 🟡 MEDIUM: Legacy Configuration Files

### Duplicate team_config.json**
Three copies exist with different values:

| File | manager_id | manager_name | Status |
|------|-----------|--------------|--------|
| [cheddar-fpl-sage/team_config.json](cheddar-fpl-sage/team_config.json) | 123 | Unknown | Default template |
| [cheddar-fpl-sage/config/team_config.json](cheddar-fpl-sage/config/team_config.json) | 711511 | AJ Colubiale | **Authoritative** |
| [cheddar-fpl-sage/backend/team_config.json](cheddar-fpl-sage/backend/team_config.json) | 123456 | Christian Tokerud | Alternate user config |

**Code References:** All tools load from `config/team_config.json` as primary source:
- [cheddar-fpl-sage/fpl_sage.py](cheddar-fpl-sage/fpl_sage.py#L141)
- [src/cheddar_fpl_sage/analysis/fpl_sage_integration.py](cheddar-fpl-sage/src/cheddar_fpl_sage/analysis/fpl_sage_integration.py#L41)

**Recommendation:**
- Keep `config/team_config.json` as canonical (it's the one active code uses)
- Root `team_config.json` → document as template in README
- `backend/team_config.json` → if needed, keep with documentation that it's for alternate testing
- Add `.gitignore` entries: `team_config.json` (root level) to prevent sync issues

---

## 🟠 CONSIDER: Sprint-versioned Integration Adapters

### sprint2_integration.py vs sprint3_integration.py**
- **Location:** `cheddar-fpl-sage/src/cheddar_fpl_sage/analysis/`
- **Status:** Both exist and both are in use (not legacy)
- **Context:** Part of iterative development with incremental fixes

| File | Purpose | Lines | Status |
|------|---------|-------|--------|
| [sprint2_integration.py](cheddar-fpl-sage/src/cheddar_fpl_sage/analysis/sprint2_integration.py) | Chip/FT resolution adapter | 296 | Active |
| [sprint3_integration.py](cheddar-fpl-sage/src/cheddar_fpl_sage/analysis/sprint3_integration.py) | Bench injury + season resolution | 271 | Active |

**Observation:** This is not duplicative code — both are needed as separate integration points into different phases.

**Recommendation:** 
- This is acceptable design; document clearly in [cheddar-fpl-sage/AGENTS.md](cheddar-fpl-sage/AGENTS.md) why both exist
- Consider renaming to `_chip_ft_adapter.py` and `_injuries_season_adapter.py` for clarity
- Plan eventual consolidation into a unified `analysis_adapters.py` module in future refactor

### Supporting Sprint-named Utilities**
The following are specialized utilities supporting sprint work (not unused):

- `utils/sprint2_integration.py` → Uses chip/FT resolvers
- `utils/sprint3_fixes.py` → Contains bench enricher, season resolver
- `utils/sprint3_5_config_manager.py` → Config management for Sprint 3.5

**Status:** All actively imported and used.

---

## 🟢 LOW: Archive Folders (Already Isolated)

The project correctly isolates legacy content in archive folders:

| Folder | Contents | Assessment |
|--------|----------|------------|
| [cheddar-fpl-sage/archive/debug_scripts/](cheddar-fpl-sage/archive/debug_scripts/) | `debug_*.py` (captain, chip, transfer logic) | ✅ Good isolation |
| [cheddar-fpl-sage/archive/test_scripts/](cheddar-fpl-sage/archive/test_scripts/) | `test_*.py` (integration tests) | ✅ Good isolation |
| [cheddar-fpl-sage/archive/old_docs/](cheddar-fpl-sage/archive/old_docs/) | README_OLD.md | ✅ Good isolation |
| [.planning/](cheddar-fpl-sage/.planning/) | Sprint planning artifacts | ✅ Documented separately |

**Recommendation:** No action needed; these are well-contained.

---

## 🟢 PLANNING-ONLY: Design & Planning Artifacts

The repository contains extensive planning outputs that are **not duplicative code**, but rather documentation of development:

| Folder | Purpose |
|--------|---------|
| [_bmad-output/](https://github.com/user/projects/cheddar-logic/_bmad-output/) | Agent decision logs and analysis reports |
| [.planning/](cheddar-fpl-sage/.planning/) | Sprint planning, roadmaps, architecture notes |
| [docs/](docs/) | Architecture, deployment, migration guides |

**Status:** These are appropriate for a multi-agent project and should be kept for auditability.

---

## Consolidation Roadmap

### Phase 1: Immediate (No Risk)
**Effort:** 2-3 hours

```bash
# 1. Move debug scripts
mkdir -p scripts/debug
mv check-*.js verify-markets.js scripts/debug/

# 2. Delete or archive unused migration script
mv scripts/migrate-dev-to-prod.js _bmad-output/deprecated/

# 3. Verify espn-client/team-metrics usage
grep -r "apps/worker/src/espn-client" --include="*.js"
grep -r "apps/worker/src/team-metrics" --include="*.js"
```

### Phase 2: Core Deduplication (Requires Testing)
**Effort:** 4-6 hours

```javascript
// Step 1: Create wrapper in apps/worker/src/team-metrics.js
module.exports = require('../../../packages/data/src/team-metrics');

// Step 2: Delete apps/worker/src/espn-client.js
// Step 3: Verify all tests pass
npm --prefix apps/worker run test

// Step 4: Commit with message:
// "refactor: consolidate espn-client and team-metrics to packages/data"
```

### Phase 3: Configuration Cleanup (Optional)
**Effort:** 1-2 hours

```bash
# Document root team_config.json as template
echo "# Template file — copy to ./config/ to customize" >> team_config.json

# Add to .gitignore
echo "team_config.json" >> .gitignore

# Verify backend version is for specific testing
git log --oneline cheddar-fpl-sage/backend/team_config.json | head -5
```

---

## File Cleanup Checklist

### Delete/Archive These Files
- [ ] `apps/worker/src/espn-client.js` (after consolidation)
- [ ] `check-ncaam-market.js` (move to `scripts/debug/`)
- [ ] `check-ncaam-payload.js` (move to `scripts/debug/`)
- [ ] `check-play-status.js` (move to `scripts/debug/`)
- [ ] `check-raw-data.js` (move to `scripts/debug/`)
- [ ] `verify-markets.js` (move to `scripts/debug/`)
- [ ] `scripts/migrate-dev-to-prod.js` (archive)

### Optional Reviews
- [ ] `packages/data/src/sqlite-wrapper.js` — Confirm unused before deletion
- [ ] `cheddar-fpl-sage/backend/team_config.json` — Document if it's for specific user testing
- [ ] `cheddar-fpl-sage/team_config.json` — Confirm it's just a template

---

## Impact Analysis

### Zero-Risk Changes
✅ Moving root debug scripts to `scripts/debug/` — no imports, no risk

### Low-Risk Changes  
✅ Deleting unused migration script — appears superseded

### Medium-Risk (Requires Testing)
⚠️ Consolidating espn-client/team-metrics — must verify:
- [ ] All jobs work: `npm run job:run-nhl-model`
- [ ] All tests pass: `npm --prefix apps/worker run test`
- [ ] Web app still builds: `npm --prefix web run build`

---

## Future Prevention

### For Multi-Agent Teams
1. **Enforce single source of truth:** Define canonical locations for shared libraries
2. **Document module ownership:** Use CODEOWNERS file for critical modules
3. **Lint for unused imports:** Use `eslint-plugin-unused-imports`
4. **Regular audits:** Schedule quarterly reviews of new files
5. **Clear handoff protocol:** When agents complete tasks, document module locations

### Recommended .gitignore additions
```bash
# Local config overrides
team_config.json
.env.local

# Debug outputs
scripts/debug/*.output.json
data/debug/
```

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| **Duplicate file pairs** | 2 critical (espn-client, team-metrics) |
| **Unused scripts** | 5 (check-* and verify-) |
| **Legacy test/debug code** | 7 (archive scripts) |
| **Team config duplicates** | 3 files (1 canonical) |
| **Unused modules** | 1 (sqlite-wrapper) |
| **Estimated cleanup time** | 6-10 hours total |
| **Estimated code reduction** | ~800-1000 lines removed |

---

## Conclusion

The codebase shows healthy signs of iterative agent development with relatively minor accumulated debt:

✅ **Good:** Archive folders are well-isolated  
✅ **Good:** Planning artifacts are centralized  
✅ **Good:** No massive dead code branches  
⚠️ **Concern:** Duplicate utility files (espn-client, team-metrics)  
⚠️ **Concern:** Scattered debug scripts  
⚠️ **Concern:** Config file duplication  

**All issues are fixable with low-to-medium effort and minimal testing impact.**

Proceed with Phase 1 immediately (moving debug scripts); Phase 2-3 can follow after validation.
