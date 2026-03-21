# vegas-agent

Portable VEGAS agent pack for betting logic audits.

## Purpose

VEGAS stands for **Verified Edge & Game Assessment System**.

VEGAS is a challenge-first auditor. It does not generate picks.

It is built to:
- challenge assumptions
- validate edge quality
- enforce risk discipline
- block low-quality bets

Hard gate: `EDGE VERIFICATION REQUIRED`  
No verification, no play.

## Package Layout

- `core/`: non-negotiable principles and risk doctrine
- `models/`: EV and market-audit frameworks
- `workflows/`: repeatable review flows for bet and card analysis
- `guardrails/`: failure patterns and stop conditions
- `prompts/`: ready-to-use prompts for VSCode/LLM workflows
- `.claude/agents/vegas-auditor.md`: portable agent definition
- `scripts/`: install, update, and health checks
- `tests/`: link-integrity check

## Quick Start

1. Install into a consumer project:

```bash
./vegas-agent/scripts/install.sh /path/to/target-project
```

2. Validate package health:

```bash
./vegas-agent/scripts/doctor.sh /path/to/target-project/vegas-agent
./vegas-agent/tests/link-integrity.sh /path/to/target-project/vegas-agent
```

3. Use in your agent workflow:
- feed bet/card payload into `workflows/bet_review.md`
- require output verdict: `PLAY`, `LEAN`, `PASS`, or `FADE`
- reject weak edges that fail guardrails

## Design Rules

- Price over narrative
- Explanation over confidence
- Process over picks
- Survival over short-term ROI
