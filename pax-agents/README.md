# pax-agents

Portable PAX agent pack for Claude projects.

## What this repo ships

- `.claude/agents/pax-*.md`
- `.claude/commands/pax/*.md`
- `.claude/process-acceleration-executors/**`
- `.claude/hooks/pax-*.js`
- `.claude/settings.template.json`
- install/update/doctor scripts + integrity checks

## Quick start

1. Copy this folder into its own git repo (or use as-is).
1. From the repo root run:

```bash
./scripts/install.sh /path/to/consumer-project
```

1. Optionally apply settings template:

```bash
cp .claude/settings.template.json /path/to/consumer-project/.claude/settings.json
```

1. Validate installation:

```bash
./scripts/doctor.sh /path/to/consumer-project
```

## Updating an existing project

```bash
./scripts/update.sh /path/to/consumer-project
./scripts/doctor.sh /path/to/consumer-project
```

## What install/update will manage

- `.claude/agents/pax-*`
- `.claude/commands/pax/*`
- `.claude/process-acceleration-executors/**`
- `.claude/hooks/pax-*.js`

## What install/update will NOT touch

- `.planning/**`
- non-PAX command folders
- `.claude/settings.local.json`

## CI

GitHub Actions runs:

- `tests/link-integrity.sh`
- `scripts/doctor.sh .`

## Release versioning

- Semantic Versioning (`MAJOR.MINOR.PATCH`)
- Keep `.claude/process-acceleration-executors/VERSION` aligned with release tags
