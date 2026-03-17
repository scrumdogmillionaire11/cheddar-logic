# FPL Sage Ops Checklist

Use this as the day-to-day and deployment runbook for FPL Sage on your Pi.

## 1) Pre-Deploy Checklist

- [ ] Confirm target branch/commit and pull latest:
  - `git fetch --all --prune`
  - `git checkout <branch>`
  - `git pull --ff-only`
- [ ] Verify runtime versions:
  - `python3 --version`
  - `node --version` (only needed if deploying frontend)
- [ ] Verify env file exists and required vars are set:
  - API/FPL credentials
  - Any CORS or host settings
  - Optional Redis URL (if used)
- [ ] Install/update backend dependencies:
  - `pip install -r requirements.txt` (or your project equivalent)
- [ ] Run quick backend validation:
  - `pytest -q` (or targeted test set you trust for release)

## 2) Deploy Modes

## Backend-only (most common)

- [ ] Start/restart FPL Sage API service
- [ ] Confirm service is active and healthy:
  - `curl -sS http://localhost:8001/health`
- [ ] Run one real analysis smoke test for your team ID

## Backend + Frontend UI

- [ ] Backend steps above
- [ ] Build frontend (only if UI is hosted on Pi):
  - `cd frontend`
  - `npm ci`
  - `npm run build`
- [ ] Serve built assets via nginx/caddy/static server
- [ ] Validate frontend -> backend API connectivity

## 3) Systemd Service (Recommended)

Example service shape (adapt paths):

- Exec should pin workspace `src` first to avoid importing stale installed packages:
  - `PYTHONPATH=/opt/cheddar-logic/cheddar-fpl-sage/src`
- Use restart policy:
  - `Restart=always`
  - `RestartSec=5`

Suggested verification commands:

- `sudo systemctl daemon-reload`
- `sudo systemctl enable fpl-sage`
- `sudo systemctl restart fpl-sage`
- `sudo systemctl status fpl-sage --no-pager`
- `journalctl -u fpl-sage -n 200 --no-pager`

## 4) Daily Operations

- [ ] Check API health endpoint:
  - `curl -sS http://localhost:8001/health`
- [ ] Check service status/log tail:
  - `sudo systemctl status fpl-sage --no-pager`
  - `journalctl -u fpl-sage -n 100 --no-pager`
- [ ] Run one analysis sanity check for known team ID
- [ ] Confirm recommendation guardrails in output:
  - Max 3 players per club enforced
  - No transfer-in for immediate blank gameweek

## 5) Cache/State Hygiene

- If results look stale or unexpected:
  - [ ] Re-run analysis with explicit overrides (bypasses cache paths in many setups)
  - [ ] Restart service
  - [ ] Re-test via direct API before trusting frontend display
- If using Redis and it is down:
  - [ ] API can still run, but expect cache/rate-limit warnings

## 6) Incident Checklist

When recommendations look wrong:

- [ ] Confirm you are hitting correct host/port
- [ ] Confirm deployed code revision matches expected commit
- [ ] Confirm import path points to intended repo code (not old installed package)
- [ ] Verify direct API JSON payload before frontend interpretation
- [ ] Capture analysis ID + logs + payload snippet for debugging

## 7) Rollback Plan

- [ ] Keep last known-good commit/tag documented
- [ ] Roll back code
- [ ] Restart service
- [ ] Re-run health + smoke analysis checks

## 8) Change Management Notes

For recommendation-logic changes, always validate on a known fixture/team scenario:

- [ ] Scenario with 3 players already from one club (including GK)
- [ ] Scenario with attractive candidate who blanks next GW
- [ ] Confirm those candidates are excluded from transfer-ins

---

Owner: You
Last updated: 2026-03-16
