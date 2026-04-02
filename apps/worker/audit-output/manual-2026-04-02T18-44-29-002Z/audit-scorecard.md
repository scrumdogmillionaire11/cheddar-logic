# Audit Scorecard

Generated at: 2026-04-02T18:44:29.002Z
Run scope: manual-2026-04-02T18-44-29-002Z

Audit fixtures: 18/18 passed
Severity counts: critical=0 high=0 warn=6
Performance alerts: 1

## Family Risk
- MLB.MLB_F5_TOTAL: risk=LOW; trend(executable=STABLE, pass=STABLE, calibration=STABLE); reasons=NONE
- MLB.MLB_PITCHER_K: risk=LOW; trend(executable=STABLE, pass=STABLE, calibration=STABLE); reasons=NONE
- NBA.NBA_SPREAD: risk=MEDIUM; trend(executable=STABLE, pass=STABLE, calibration=STABLE); reasons=WARN_AUDIT_DRIFT
- NBA.NBA_TOTAL: risk=MEDIUM model_decay=true; trend(executable=UP, pass=STABLE, calibration=STABLE); reasons=WARN_AUDIT_DRIFT, WARN_PERFORMANCE_ALERT:PASS_RATE_COLLAPSE
- NHL.MIXED: risk=LOW; trend(executable=STABLE, pass=STABLE, calibration=STABLE); reasons=NONE
- NHL.NHL_1P_TOTAL: risk=LOW; trend(executable=STABLE, pass=STABLE, calibration=STABLE); reasons=NONE
- NHL.NHL_ML: risk=MEDIUM; trend(executable=STABLE, pass=STABLE, calibration=STABLE); reasons=WARN_AUDIT_DRIFT
- NHL.NHL_PLAYER_SHOTS: risk=LOW; trend(executable=STABLE, pass=STABLE, calibration=STABLE); reasons=NONE
- NHL.NHL_TOTAL: risk=MEDIUM; trend(executable=UP, pass=STABLE, calibration=STABLE); reasons=WARN_AUDIT_DRIFT
