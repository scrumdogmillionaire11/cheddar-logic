# Installing bmad_gsd in personal-dashboard

## Quick Installation

### Method 1: Development Mode (Recommended)

This creates a symbolic link, so changes to the source code are immediately reflected:

```bash
cd /Users/ajcolubiale/projects/cheddar-fpl-sage/bmad_gsd
./install_to_personal_dashboard.sh
```

Or manually:

```bash
pip install -e /Users/ajcolubiale/projects/cheddar-fpl-sage/bmad_gsd
```

### Method 2: Regular Installation

This copies the package to your Python environment:

```bash
pip install /Users/ajcolubiale/projects/cheddar-fpl-sage/bmad_gsd
```

## Verify Installation

Test that the package works:

```bash
cd /Users/ajcolubiale/projects/cheddar-fpl-sage/bmad_gsd
python test_package.py
```

Or in Python:

```python
from bmad_gsd import agents, get_agent_path

# List all GSD agents
for agent_id, agent in agents.GSD_AGENTS.items():
    print(f"{agent.icon} {agent.title}: {agent.when_to_use}")

# Get path to an agent definition
builder_path = get_agent_path('gsd-builder')
print(f"Builder agent: {builder_path}")
```

## Usage in personal-dashboard

Once installed, you can use it in your personal-dashboard project:

```python
# In /Users/ajcolubiale/projects/personal-dashboard/your_script.py

from bmad_gsd import agents, tasks, get_agent_path, get_task_path

# Access GSD agents
print("Available GSD agents:")
for agent_id, agent_info in agents.GSD_AGENTS.items():
    print(f"  {agent_info.icon} {agent_info.name} ({agent_id})")
    print(f"     {agent_info.when_to_use}")
    print(f"     Time budget: {agent_info.time_budget}")

# Access BMAD agents
print("\nAvailable BMAD agents:")
for agent_id, agent_info in agents.BMAD_AGENTS.items():
    print(f"  {agent_info.icon} {agent_info.title} ({agent_id})")

# Get path to agent definitions (requires .bmad-core structure)
builder_path = get_agent_path('gsd-builder')
if builder_path and builder_path.exists():
    with open(builder_path) as f:
        agent_definition = f.read()
    print(f"\nAgent definition loaded from: {builder_path}")

# Find agents by time budget
quick_agents = agents.get_agents_by_time_budget(1.0)  # < 1 hour
print(f"\nFound {len(quick_agents)} agents that work in < 1 hour")

# Filter by category
gsd_only = agents.get_agents_by_category('gsd')
bmad_only = agents.get_agents_by_category('bmad')
```

## Uninstalling

```bash
pip uninstall bmad-gsd
```

## Package Contents

The `bmad_gsd` package provides:

1. **Agent Registry** (`bmad_gsd.agents`)
   - `GSD_AGENTS`: Time-boxed execution agents
   - `BMAD_AGENTS`: Planning and quality agents
   - `ALL_AGENTS`: Combined registry
   - Helper functions for filtering and searching

2. **Task Templates** (`bmad_gsd.tasks`)
   - `GSD_TASKS`: Execution task templates
   - `BMAD_TASKS`: Planning task templates
   - `ALL_TASKS`: Combined task registry

3. **Path Utilities** (`bmad_gsd`)
   - `get_agent_path(agent_id)`: Get path to agent definition
   - `get_task_path(task_id)`: Get path to task template
   - `get_doc_path(doc_name)`: Get path to documentation

## Important Notes

### .bmad-core Directory

The path resolution functions (`get_agent_path`, `get_task_path`) look for the `.bmad-core` directory relative to the package installation. If you want to use these features:

**Option 1**: Copy `.bmad-core` to your personal-dashboard project:

```bash
cp -r /Users/ajcolubiale/projects/cheddar-fpl-sage/.bmad-core \
      /Users/ajcolubiale/projects/personal-dashboard/
```

**Option 2**: Set an environment variable to point to the source:

```python
import os
os.environ['BMAD_CORE_PATH'] = '/Users/ajcolubiale/projects/cheddar-fpl-sage/.bmad-core'

from bmad_gsd import get_agent_path
builder_path = get_agent_path('gsd-builder')
```

**Option 3**: Just use the agent metadata without needing files:

```python
from bmad_gsd.agents import GSD_AGENTS

# All agent info is available without needing .bmad-core files
builder = GSD_AGENTS['gsd-builder']
print(builder.title, builder.when_to_use, builder.time_budget)
```

## Troubleshooting

### "Module not found"

Make sure you're in the correct Python environment where the package was installed:

```bash
which python
pip list | grep bmad
```

### "Path not found" errors

The agent/task definition files are in `.bmad-core`. Either:
- Copy `.bmad-core` to your project
- Use the metadata API instead of file paths
- Set `BMAD_CORE_PATH` environment variable

### Development mode changes not reflecting

If using `-e` install, changes should be immediate. If not:

```bash
pip uninstall bmad-gsd
pip install -e /Users/ajcolubiale/projects/cheddar-fpl-sage/bmad_gsd
```
