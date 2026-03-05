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

## Tool Access & Capabilities

**For VS Code Copilot Chat:**
- ✅ File Read: Use read_file tool for all `.claude/`, `.github/`, `.planning/**` paths
- ✅ File Create/Edit: Use create_file and replace_string_in_file tools
- ✅ Terminal Execution: Use run_in_terminal for all bash/shell commands
- ✅ Git Operations: Use git tools for commits, branches, pushes
- ⚠️ If tools not showing: Reload VS Code (Cmd+Shift+P → "Developer: Reload Window")

**For Full Automation (Recommended):**
- Use **Claude Desktop** or **Cursor IDE** which have native MCP support
- These can directly execute workflows without tool coordination

**Tool Usage Rules:**
1. Always use run_in_terminal for: git operations, npm/node commands, python execution, file system operations
2. Use edit tools for: updating markdown plans, modifying configuration files, code changes
3. Batch independent operations together (parallel tool calls) when possible
4. For Phase execution: Read plan → Execute tasks → Update STATE.md → Commit changes
