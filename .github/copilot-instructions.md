# Copilot Instructions for PAX Agents Repo

This repo stores PAX agent definitions and workflows for cross-tool usage.

## Source of Truth

- Agent prompts: `.claude/agents/pax-*.md`
- Commands: `.claude/commands/pax/*.md`
- Workflow templates/references: `.claude/process-acceleration-executors/**`

## Working Rules

1. Preserve paths and relative references used by command/workflow markdown files.
2. Do not modify `.planning/**` in this package repo (consumer runtime state only).
3. Keep updates backward-compatible unless explicitly doing a major release.
4. Validate changes with:
   - `./scripts/doctor.sh .`
   - `./tests/link-integrity.sh .`

## Copilot Usage Pattern

- Interpret user intent against PAX commands (e.g., "plan phase", "execute phase", "verify work").
- Reference corresponding docs in `.claude/commands/pax/` and `.claude/process-acceleration-executors/workflows/`.
- For implementation changes, edit canonical files in `.claude/agents/` and related workflow docs.
