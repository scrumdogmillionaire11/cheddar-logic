# BMAD-GSD Framework

A structured multi-agent framework combining:
- **BMAD-METHOD**: Comprehensive planning & quality agents (PM, Architect, PO, QA, Dev, etc.)
- **GSD (Get Shit Done)**: Time-boxed rapid execution agents (Builder, Fixer, Prototyper, etc.)

## Installation

### From Local Source

```bash
# Install from the cheddar-fpl-sage repository
pip install /path/to/cheddar-fpl-sage/bmad_gsd

# Or in development mode (editable)
pip install -e /path/to/cheddar-fpl-sage/bmad_gsd
```

### From Git Repository

```bash
pip install git+https://github.com/yourusername/cheddar-fpl-sage.git#subdirectory=bmad_gsd
```

## Quick Start

```python
from bmad_gsd import agents, tasks, get_agent_path, get_task_path

# Access agent registry
print("GSD Agents:", list(agents.GSD_AGENTS.keys()))
print("BMAD Agents:", list(agents.BMAD_AGENTS.keys()))

# Get agent definition path
builder_path = get_agent_path('gsd-builder')
if builder_path:
    print(f"Builder agent definition: {builder_path}")

# Get task template path
quick_build_path = get_task_path('gsd-quick-build')
if quick_build_path:
    print(f"Quick build task: {quick_build_path}")

# Access agent information
builder = agents.GSD_AGENTS['gsd-builder']
print(f"{builder.icon} {builder.title}")
print(f"When to use: {builder.when_to_use}")
print(f"Time budget: {builder.time_budget}")
```

## Features

### Agent Registry

- **GSD Agents**: Time-boxed execution agents (Builder, Fixer, Prototyper, Debugger, Optimizer, Integrator, Tester)
- **BMAD Agents**: Planning and quality agents (PM, Architect, PO, SM, QA, Dev, UX Expert, Analyst, Orchestrator)

### Task Templates

- Access to pre-defined task templates for both GSD and BMAD workflows
- Time estimates and descriptions for each task
- Easy lookup by task ID

### Path Resolution

- Automatic path resolution to agent definitions (`.bmad-core/agents/`)
- Task template path resolution (`.bmad-core/tasks/`)
- Documentation path resolution (`docs/`)

## Usage Examples

### List All Available Agents

```python
from bmad_gsd.agents import ALL_AGENTS

for agent_id, agent_info in ALL_AGENTS.items():
    print(f"{agent_info.icon} {agent_info.title} ({agent_info.id})")
    print(f"  Category: {agent_info.category}")
    print(f"  When to use: {agent_info.when_to_use}")
    if agent_info.time_budget:
        print(f"  Time budget: {agent_info.time_budget}")
    print()
```

### Get Agent by Category

```python
from bmad_gsd.agents import get_agents_by_category

gsd_agents = get_agents_by_category('gsd')
bmad_agents = get_agents_by_category('bmad')

print(f"Found {len(gsd_agents)} GSD agents")
print(f"Found {len(bmad_agents)} BMAD agents")
```

### Search Agents

```python
from bmad_gsd.agents import search_agents

# Find agents related to debugging
debug_agents = search_agents('debug')
for agent in debug_agents:
    print(f"{agent.icon} {agent.title}: {agent.when_to_use}")
```

### Access Task Templates

```python
from bmad_gsd.tasks import ALL_TASKS, get_tasks_by_category

# List all GSD tasks
gsd_tasks = get_tasks_by_category('gsd')
for task_id, task_info in gsd_tasks.items():
    print(f"{task_info.title} - {task_info.time_estimate}")
    print(f"  {task_info.description}")
```

## Integration with Personal Dashboard

This package is designed to work seamlessly with your personal dashboard project:

```python
# In your personal-dashboard project
from bmad_gsd import get_agent_path, agents

# Get path to GSD Builder agent
builder_path = get_agent_path('gsd-builder')

# Read and parse agent definition
# Use for automation, UI display, etc.
```

## Project Structure

```
bmad_gsd/
├── __init__.py          # Main package interface
├── agents.py            # Agent registry and metadata
├── tasks.py             # Task template registry
├── pyproject.toml       # Package configuration
└── README.md            # This file
```

## Requirements

- Python >= 3.10
- No external dependencies (pure Python)

## License

MIT

## Contributing

This is part of the Cheddar FPL Sage project. For contributions, please refer to the main project repository.
