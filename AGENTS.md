# PAX Agents (Codex + Claude + Copilot Friendly)

This repository packages canonical PAX agent definitions from `.claude/agents/`.

## Canonical Agent Source

- `.claude/agents/pax-*.md`

## Tool Compatibility

### Codex CLI / Codex IDE

- `AGENTS.md` is intentionally included so Codex can load agent guidance from the repo.
- Use command/workflow files in `.claude/commands/pax/` and `.claude/process-acceleration-executors/` as the executable source of truth.

### GitHub Copilot (VS Code Chat)

- Copilot does not natively execute Claude slash commands.
- Use `.github/copilot-instructions.md` to map intent to equivalent workflows and preserve behavior.
- Keep `.claude/agents/` as canonical prompt/instruction artifacts.

### Claude

- Native layout remains unchanged and directly usable.

## Maintenance Rules

1. Make changes in `.claude/agents/` first.
2. Keep command/workflow references valid (`@./.claude/...`).
3. Run:
   - `./tests/link-integrity.sh .`
   - `./scripts/doctor.sh .`
4. Update `CHANGELOG.md` and `.claude/process-acceleration-executors/VERSION` for releases.
