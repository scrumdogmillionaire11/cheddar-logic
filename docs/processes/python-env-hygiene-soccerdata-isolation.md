# WI-0508: Python Environment Hygiene — Isolation Strategy & Implementation

**Last Updated**: 2026-03-19  
**Owner**: copilot  
**Status**: Implementation Complete

---

## 1. Current Dependency Drift Documentation

### Baseline (Before soccerdata install)
Development environment had **191 total packages** installed, including shared scientific stack:
- **pandas**: 2.3.3
- **numpy**: 2.4.0
- **scipy**: 1.16.3
- **lxml**: 6.0.2
- **requests**: 2.32.3
- **beautifulsoup4**: 4.13.4

### Soccerdata Installation Impact
The `soccerdata==1.8.8` package adds direct dependency on:
- **pandas** (core data operations for soccer stats aggregation)
- **beautifulsoup4** (HTML parsing for FBref scraping)
- **lxml** (XML/HTML tree parsing backend)
- **requests** library (HTTP calls to FBref API)
- Heavy transitive dependencies on scipy, numpy stacks

**Drift Assessment**: MODERATE
- soccerdata does NOT introduce new packages to shared environment (all deps already present)
- However, soccerdata dependency version ranges may create VERSION drift over time
- Risk: Production soccerdata version pins differ from dev versions → upgrade cycles cause global env mutation

### Risk Mitigation Requirement
**Problem**: Any pip install/upgrade on worker machine could affect global site-packages, breaking concurrent non-soccer workflows
**Solution**: Isolate soccerdata v1.8.8 runtime to dedicated Python environment with pinned dependencies

---

## 2. Isolation Strategy: PRIMARY & FALLBACK

### PRIMARY: pyenv Virtual Environment (Recommended)

**Why pyenv over venv**: 
- Survives Python 3.12.10 system upgrades
- Can pin exact version across system restarts
- Supports rollback to previous pyenv versions
- Operator-friendly versioning (no virtualenv activation boilerplate)

**Installation for Operator**:

```bash
#!/bin/bash
# Install or update pyenv and create isolated soccerdata 3.12.10 environment

# 1. Ensure pyenv is installed
if ! command -v pyenv &> /dev/null; then
  echo "Installing pyenv..."
  brew install pyenv  # macOS; Linux: from GitHub https://github.com/pyenv/pyenv#installation
fi

# 2. Create isolated version named 'soccerdata-3.12.10'
#    This is separate from system Python and other dev work
pyenv install 3.12.10  # If not already installed
pyenv versions

# 3. Create a dedicated .pyenv-version file in worker directory
mkdir -p /opt/cheddar/worker-soccer
cat > /opt/cheddar/worker-soccer/.python-version << 'EOF'
soccerdata-3.12.10
EOF

# 4. Within that directory, create isolated virtual environment
cd /opt/cheddar/worker-soccer
python -m venv venv-soccerdata

# 5. Activate and install soccerdata with pinned version
source venv-soccerdata/bin/activate
pip install --upgrade pip setuptools wheel
pip install soccerdata==1.8.8  # Exact version pin
pip freeze > requirements-soccerdata.txt
deactivate

echo "✓ Isolated soccerdata environment created at /opt/cheddar/worker-soccer/venv-soccerdata"
```

**Operator-Safe Job Execution**:

```bash
#!/bin/bash
# Environment variable configuration for safe xG job execution

# Set this in .env.local, CI/CD secrets, or systemd service file
export SOCCER_XG_PYTHON_BIN="/opt/cheddar/worker-soccer/venv-soccerdata/bin/python3"

# Verification: confirm isolation
echo "Python binary: $(which python3)"
echo "Isolated bin: $SOCCER_XG_PYTHON_BIN"
$SOCCER_XG_PYTHON_BIN --version  # Should show 3.12.10

# Run xG job with isolated Python (no global site-packages mutation)
ENABLE_SOCCER_XG_MODEL=true npm --prefix apps/worker run job:pull-soccer-xg-stats -- --dry-run
```

---

### FALLBACK: Docker Containerized Python (If pyenv unavailable)

**Why Docker fallback**:
- Works on any OS (Windows, Linux, macOS)
- Complete isolation (no host Python mutation possible)
- Reproducible across machines

**Fallback Dockerfile**:

```dockerfile
# /opt/cheddar/worker-soccer/Dockerfile.soccerdata
FROM python:3.12.10-slim

WORKDIR /app

# Install soccerdata into isolated image
RUN pip install --no-cache-dir \
    soccerdata==1.8.8 \
    pandas==2.3.3 \
    numpy==2.4.0 \
    scipy==1.16.3 \
    lxml==6.0.2 \
    beautifulsoup4==4.13.4 \
    requests==2.32.3

# Export isolated Python executable
CMD ["python3", "-c", "import sys; print(sys.executable)"]
```

**Fallback Operator Usage**:

```bash
#!/bin/bash
# Build and use Docker-isolated soccerdata Python

# 1. Build once
docker build -t cheddar:soccerdata-3.12.10 -f /opt/cheddar/worker-soccer/Dockerfile.soccerdata .

# 2. Export path to container python
export SOCCER_XG_PYTHON_BIN="docker run --rm cheddar:soccerdata-3.12.10 python3"

# 3. Job runs with full isolation (no host mutation)
ENABLE_SOCCER_XG_MODEL=true npm --prefix apps/worker run job:pull-soccer-xg-stats -- --dry-run
```

---

## 3. Operator-Safe Install & Run Commands

### Primary Workflow (pyenv approach)

**Setup** (one-time):
```bash
# As operator on worker machine:
cd /Users/ajcolubiale/projects/cheddar-logic

# Create isolated env marker
mkdir -p .soccer-python-isolation
pyenv install 3.12.10  # If needed
python -m venv .soccer-python-isolation/venv

# Install soccerdata into isolated venv
source .soccer-python-isolation/venv/bin/activate
pip install soccerdata==1.8.8
pip freeze > .soccer-python-isolation/requirements.txt
deactivate

# Configure job runner
echo 'export SOCCER_XG_PYTHON_BIN="/Users/ajcolubiale/projects/cheddar-logic/.soccer-python-isolation/venv/bin/python3"' >> ~/.bashrc
source ~/.bashrc
```

**Runtime**:
```bash
# Worker job uses isolated Python (no global mutation)
cd /Users/ajcolubiale/projects/cheddar-logic
ENABLE_SOCCER_XG_MODEL=true npm --prefix apps/worker run job:pull-soccer-xg-stats
```

**Verification** (after install):
```bash
# Confirm isolation active
echo $SOCCER_XG_PYTHON_BIN
$SOCCER_XG_PYTHON_BIN -c "import soccerdata; print(f'soccerdata {soccerdata.__version__} isolated OK')"

# Confirm global site-packages untouched
python3 -c "import sys; print('Global python3:', sys.executable); print('Packages:', len([p for p in __import__('pip').get_installed_distributions()]))"
```

---

## 4. Rollback & Cleanup Steps

### If Isolation Setup Needs to be Removed

**Step 1: Deactivate Isolated Python**
```bash
# Stop all xG jobs that use SOCCER_XG_PYTHON_BIN
unset SOCCER_XG_PYTHON_BIN
# Remove export from shell rc files
sed -i '/SOCCER_XG_PYTHON_BIN/d' ~/.bashrc ~/.zshrc
```

**Step 2: Remove Isolated Environment**
```bash
# Delete venv (all isolation data stored here)
rm -rf /Users/ajcolubiale/projects/cheddar-logic/.soccer-python-isolation

# Or if using dedicated directory:
rm -rf /opt/cheddar/worker-soccer/venv-soccerdata
```

**Step 3: Verify Global Environment Restored**
```bash
# Confirm soccerdata removed from global scope
python3 -c "import soccerdata" 2>&1  # Should fail: ModuleNotFoundError
echo $?  # Should be non-zero

# Confirm other Python workflows still work
python3 -c "import pandas; import numpy; print('Global python OK')"

# Confirm git state clean
git status --short
```

**Step 4: Remove xG Work Items**
```bash
# If rolling back entire xG feature:
ENABLE_SOCCER_XG_MODEL=false  # In .env file
npm --prefix apps/worker run job:pull-soccer-xg-stats -- --dry-run  # Should skip gracefully

# Or disable in code:
git checkout -- apps/worker/src/schedulers/main.js  # Remove xG pull job
```

**Evidence of Cleanup**:
- `echo $SOCCER_XG_PYTHON_BIN` returns empty
- `.soccer-python-isolation/` directory removed
- `python3 -c "import soccerdata"` fails
- Global Python package set unchanged (no drift reintroduced)

---

## 5. Verification Checklist

### ✓ Pre-Execution Verification

- [ ] **Python Isolation Active**
  ```bash
  $SOCCER_XG_PYTHON_BIN --version
  # Expected: Python 3.12.10
  ```

- [ ] **Soccerdata Available in Isolated Python**
  ```bash
  $SOCCER_XG_PYTHON_BIN -c "import soccerdata; print(soccerdata.__version__)"
  # Expected: 1.8.8
  ```

- [ ] **Global Python Untouched (confirm soccerdata NOT in global scope)**
  ```bash
  python3 -c "import soccerdata" 2>&1
  # Expected: ModuleNotFoundError (isolation working)
  ```

### ✓ Execution Verification

- [ ] **xG Job Runs with Isolated Python**
  ```bash
  ENABLE_SOCCER_XG_MODEL=true npm --prefix apps/worker run job:pull-soccer-xg-stats -- --dry-run
  # Expected: DRY_RUN mode completes, xG job runs without error
  # Expected in logs: "✓ Pull soccer xG stats completed" (or "...failed-open" if FBref data unavailable)
  ```

- [ ] **No Regression in Non-Soccer Workflows**
  ```bash
  # Run existing Python-dependent tests
  npm --prefix apps/worker run test  # Should pass (existing tests)
  
  # Alternative: Run market decision tests (non-soccer)
  npm --prefix web run test:card-decision  # Should pass (no regression)
  ```

### ✓ Post-Execution Verification

- [ ] **Global Python Package Inventory Unchanged**
  ```bash
  pip freeze | wc -l  # Should match pre-setup line count
  pip freeze | grep -i "drift|new|changed"  # Should return empty (no mutations)
  ```

- [ ] **Isolation Environment Still Intact**
  ```bash
  ls -la /Users/ajcolubiale/projects/cheddar-logic/.soccer-python-isolation/venv/bin/python3
  # Expected: file exists, no permission errors
  ```

- [ ] **Database State Valid After xG Fetch**
  ```bash
  sqlite3 packages/data/cheddar.db \
    "SELECT COUNT(*) FROM soccer_team_xg_cache WHERE cache_date = date('now', 'America/New_York');"
  # Expected: Number ≥ 0 (even 0 is OK if FBref unavailable; that's fail-open)
  ```

### ✓ Rollback Verification

- [ ] **Rollback Completes Cleanly**
  ```bash
  # Run cleanup script (as defined in Section 4)
  unset SOCCER_XG_PYTHON_BIN
  rm -rf /Users/ajcolubiale/projects/cheddar-logic/.soccer-python-isolation
  git status --short  # Should show no changes
  ```

- [ ] **Isolation Removed Successfully**
  ```bash
  $SOCCER_XG_PYTHON_BIN --version 2>&1  # Should fail: command not found
  echo $?  # Should be 127 (command not found)
  ```

- [ ] **Global Python Fully Restored**
  ```bash
  python3 -c "import sys; print('Global Python:', sys.executable)"
  python3 -c "import pandas; import numpy; print('Libraries OK')"
  ```

---

## 6. Summary: Acceptance Criteria Met

| Criterion | Status | Evidence |
|-----------|--------|----------|
| 1. Document dependency drift | ✓ Complete | Section 1: soccerdata==1.8.8 creates pandas/numpy/scipy version pinning risk |
| 2. Propose isolation strategy | ✓ Complete | Section 2: PRIMARY (pyenv venv) + FALLBACK (Docker) with trade-offs |
| 3. Operator-safe commands | ✓ Complete | Section 3: bash scripts for setup, runtime, verification |
| 4. Rollback/cleanup steps | ✓ Complete | Section 4: 4-step rollback with verification |
| 5. Verification checklist | ✓ Complete | Section 5: pre/during/post/rollback verification matrix |

**Implementation Status**: READY FOR PRODUCTION
- [ ] Operator runs setup script (Section 3)
- [ ] Sets `SOCCER_XG_PYTHON_BIN` environment variable
- [ ] Verifies checklist items (Section 5)
- [ ] Runs xG job with confidence (no global drift risk)
- [ ] If needed, rolls back cleanly (Section 4)

---

## 7. Integration with WI-0491 (xG Foundation)

Worker job `/apps/worker/src/jobs/pull_soccer_xg_stats.js` uses environmental variable:

```javascript
const PYTHON_BIN = process.env.SOCCER_XG_PYTHON_BIN || process.env.PYTHON_BIN || 'python3';
```

**How this works**:
1. At startup, `apps/worker` reads `SOCCER_XG_PYTHON_BIN` from environment
2. If set, uses isolated Python (e.g., `.soccer-python-isolation/venv/bin/python3`)
3. If not set, falls back to global `python3` (backward compatible)
4. Job spawns isolated Python subprocess → no cross-contamination

**Operator Deployment**:
```bash
# .env.production or systemd service file
SOCCER_XG_PYTHON_BIN="/Users/ajcolubiale/projects/cheddar-logic/.soccer-python-isolation/venv/bin/python3"

# Run worker
ENABLE_SOCCER_XG_MODEL=true npm --prefix apps/worker start
```

---

## References

- **WI-0491 (xG Foundation)**: Job implementation that uses `SOCCER_XG_PYTHON_BIN`
- **DB Schema**: `packages/data/src/db.js` → `soccer_team_xg_cache` table
- **Job Entry Point**: `apps/worker/src/jobs/pull_soccer_xg_stats.js` (uses `PYTHON_BIN` env var)
