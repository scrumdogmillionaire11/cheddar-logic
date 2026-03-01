# BMAD-GSD Framework

**Multi-Agent Framework for Comprehensive Planning + Rapid Execution**

## What It Is

BMAD-GSD combines two complementary methodologies:

- **BMAD-METHOD**: Structured agents for comprehensive planning, architecture, quality (PM, Architect, PO, QA, Dev, etc.)
- **GSD (Get Shit Done)**: Time-boxed agents for rapid execution (Builder, Fixer, Prototyper, Debugger, Optimizer, Integrator, Tester)

## Installation

### From This Repo (Local Development)

```bash
# Clone the repo
git clone <repository-url>
cd cheddar-fpl-sage

# Install the BMAD-GSD framework package
pip install -e .
```

### From Another Repo (Import as Dependency)

**Option 1: Install from Git URL**

```bash
pip install git+https://github.com/yourusername/cheddar-fpl-sage.git
```

**Option 2: Add to requirements.txt**

```
bmad-gsd @ git+https://github.com/yourusername/cheddar-fpl-sage.git
```

**Option 3: Add to pyproject.toml**

```toml
[project]
dependencies = [
    "bmad-gsd @ git+https://github.com/yourusername/cheddar-fpl-sage.git",
]
```

## Usage

### Access Agent Definitions

```python
from bmad_gsd import get_agent_path, list_agents
from bmad_gsd.agents import GSD_AGENTS, BMAD_AGENTS, get_agent_info

# Get path to specific agent definition
builder_path = get_agent_path('gsd-builder')
print(f"GSD Builder definition: {builder_path}")

# List all available agents
all_agents = list_agents()
for agent_id, path in all_agents.items():
    print(f"{agent_id}: {path}")

# Get agent metadata
builder_info = get_agent_info('gsd-builder')
print(f"{builder_info.title}: {builder_info.when_to_use}")
print(f"Time budget: {builder_info.time_budget}")

# Get all GSD agents
from bmad_gsd.agents import get_gsd_agents
for agent in get_gsd_agents():
    print(f"{agent.icon} {agent.name} ({agent.time_budget}): {agent.when_to_use}")
```

### Access Task Templates

```python
from bmad_gsd import get_task_path, list_tasks
from bmad_gsd.tasks import GSD_TASKS, get_task_info

# Get path to specific task template
quick_build_path = get_task_path('gsd-quick-build')

# List all available tasks
all_tasks = list_tasks()
for task_id, path in all_tasks.items():
    print(f"{task_id}: {path}")

# Get task metadata
task_info = get_task_info('gsd-quick-build')
print(f"{task_info.title}: {task_info.description}")
```

### Access Documentation

```python
from bmad_gsd import get_doc_path

# Get integration guide
integration_guide = get_doc_path('GSD-BMAD-INTEGRATION.md')

# Get quick start guide
quick_start = get_doc_path('GSD-QUICK-START.md')

# Read and use the documentation
with open(quick_start) as f:
    content = f.read()
    print(content)
```

### Query Agents by Time Budget

```python
from bmad_gsd.agents import get_agents_by_time_budget

# Get agents that work in under 1 hour
quick_agents = get_agents_by_time_budget(1.0)
for agent in quick_agents:
    print(f"{agent.icon} {agent.name}: {agent.time_budget}")

# Output:
# 🔧 Bolt: 15-30 min
# 🔍 Trace: 30-60 min
```

## Available Agents

### GSD (Get Shit Done) - Time-Boxed Execution

| Agent | ID | Time Budget | Use Case |
|-------|-----|-------------|----------|
| ⚡ Flash | `gsd-builder` | 1-4 hours | Build features quickly |
| 🔧 Bolt | `gsd-fixer` | 15-30 min | Emergency bug fixes |
| 🔬 Spark | `gsd-prototyper` | 2-4 hours | Proof of concepts |
| 🔍 Trace | `gsd-debugger` | 30-60 min | Complex debugging |
| 🚀 Turbo | `gsd-optimizer` | 1-2 hours | Performance optimization |
| 🔗 Link | `gsd-integrator` | 2-6 hours | System integration |
| ✅ Check | `gsd-tester` | 1-3 hours | Test creation |

### BMAD - Comprehensive Planning & Quality

| Agent | ID | Use Case |
|-------|-----|----------|
| 🎨 Sally | `ux-expert` | UI/UX design and specifications |
| 🏃 Bob | `sm` | Story creation, agile process |
| 🧪 Quinn | `qa` | Test architecture, quality gates |
| 📝 Sarah | `po` | Backlog management, prioritization |
| 📋 John | `pm` | PRDs, product strategy |
| 💻 James | `dev` | Code implementation, debugging |
| 🎭 BMad Orchestrator | `bmad-orchestrator` | Workflow coordination |
| 🧙 BMad Master | `bmad-master` | Comprehensive task execution |
| 🏗️ Winston | `architect` | System design, architecture |
| 📊 Mary | `analyst` | Market research, analysis |

## Available Tasks

### GSD Tasks

- `gsd-quick-build`: 60min feature implementation
- `gsd-rapid-fix`: 30min bug fix workflow
- `gsd-fast-prototype`: 2-4hr proof of concept

### BMAD Tasks

- `create-doc`: Create documents from YAML templates
- `execute-checklist`: Validate against checklists
- `create-next-story`: Create implementation-ready stories
- And many more in `.bmad-core/tasks/`

## Documentation

- **[GSD-BMAD Integration Guide](docs/GSD-BMAD-INTEGRATION.md)**: Complete framework overview
- **[GSD Quick Start](docs/GSD-QUICK-START.md)**: 5-minute reference guide
- **[Integration Summary](docs/GSD-INTEGRATION-SUMMARY.md)**: High-level summary

## Example: Using in Your Project

```python
# your_project/analysis_runner.py

from bmad_gsd import get_agent_path, get_task_path
from bmad_gsd.agents import get_agents_by_time_budget

class AnalysisWorkflow:
    """Example integration of BMAD-GSD framework."""
    
    def __init__(self):
        # Load agent definitions for your AI/LLM integration
        self.builder_path = get_agent_path('gsd-builder')
        self.quick_build_task = get_task_path('gsd-quick-build')
    
    def select_agent_for_timeframe(self, available_hours: float):
        """Select appropriate GSD agent based on time budget."""
        suitable_agents = get_agents_by_time_budget(available_hours)
        
        if not suitable_agents:
            return None
        
        # Return the agent with the longest time budget that fits
        return max(suitable_agents, 
                   key=lambda a: self._parse_max_hours(a.time_budget))
    
    def _parse_max_hours(self, time_budget: str) -> float:
        """Parse time budget string to hours."""
        if 'min' in time_budget:
            max_mins = float(time_budget.split('-')[-1].split()[0])
            return max_mins / 60
        else:
            return float(time_budget.split('-')[-1].split()[0])

# Usage
workflow = AnalysisWorkflow()

# Select agent for 2-hour time budget
agent = workflow.select_agent_for_timeframe(2.0)
print(f"Selected: {agent.name} ({agent.time_budget})")

# Load the agent definition to feed to your LLM
with open(workflow.builder_path) as f:
    agent_definition = f.read()
    # Send to your LLM/AI system for agent activation
```

## Project Structure

When you install `bmad-gsd`, you get:

```
bmad_gsd/
├── __init__.py          # Main module with utility functions
├── agents.py            # Agent registry and metadata
├── tasks.py             # Task template registry
└── .bmad-core/          # Agent and task definitions
    ├── agents/
    │   ├── gsd-builder.md
    │   ├── gsd-fixer.md
    │   ├── gsd-prototyper.md
    │   └── ... (all agent definitions)
    └── tasks/
        ├── gsd-quick-build.md
        ├── gsd-rapid-fix.md
        └── ... (all task templates)
```

## License

MIT

## Contributing

Contributions welcome! See the main repository for contribution guidelines.
