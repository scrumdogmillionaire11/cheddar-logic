# Installing BMAD-GSD Framework in Other Repos

This guide shows how to use the BMAD-GSD framework in your own projects.

## Installation Methods

### Method 1: Install from Git (Recommended)

In your project, add to `requirements.txt`:

```
bmad-gsd @ git+https://github.com/yourusername/cheddar-fpl-sage.git
```

Or install directly:

```bash
pip install git+https://github.com/yourusername/cheddar-fpl-sage.git
```

### Method 2: Install from Local Clone

If you have the repo cloned locally:

```bash
# From the cheddar-fpl-sage directory
pip install -e .

# Or from another directory
pip install -e /path/to/cheddar-fpl-sage
```

### Method 3: Using pyproject.toml

Add to your `pyproject.toml`:

```toml
[project]
dependencies = [
    "bmad-gsd @ git+https://github.com/yourusername/cheddar-fpl-sage.git",
]
```

## Verification

After installation, verify it works:

```python
# test_bmad_gsd.py
from bmad_gsd import get_agent_path, list_agents
from bmad_gsd.agents import get_agent_info

# List all agents
agents = list_agents()
print(f"Found {len(agents)} agents")

# Get specific agent info
builder = get_agent_info('gsd-builder')
print(f"{builder.icon} {builder.name}: {builder.when_to_use}")

# Get agent definition file path
path = get_agent_path('gsd-builder')
print(f"Agent definition at: {path}")
```

Run the test:

```bash
python test_bmad_gsd.py
```

Expected output:
```
Found 17 agents
⚡ Flash: Build features quickly (1-4 hours), rapid implementation, proof of concepts
Agent definition at: /path/to/site-packages/bmad_gsd/.bmad-core/agents/gsd-builder.md
```

## Usage in Your Project

### Example 1: LLM Agent Integration

```python
# your_project/ai_agent_runner.py
from bmad_gsd import get_agent_path
import openai  # or your preferred LLM library

def activate_gsd_builder():
    """Load GSD Builder agent definition and activate in LLM."""
    
    # Get the agent definition file
    agent_path = get_agent_path('gsd-builder')
    
    # Read the agent persona and instructions
    with open(agent_path) as f:
        agent_definition = f.read()
    
    # Send to LLM for activation
    response = openai.ChatCompletion.create(
        model="gpt-4",
        messages=[
            {
                "role": "system",
                "content": f"You are now activating as a GSD Builder agent. Here is your full definition:\n\n{agent_definition}"
            },
            {
                "role": "user",
                "content": "Build a user authentication feature for my web app. I have 2 hours."
            }
        ]
    )
    
    return response.choices[0].message.content
```

### Example 2: Dynamic Agent Selection

```python
# your_project/agent_selector.py
from bmad_gsd.agents import get_agents_by_time_budget, get_agent_info

class AgentSelector:
    """Select the best agent based on task requirements."""
    
    def select_for_timeframe(self, hours_available: float):
        """Select GSD agent that fits the time budget."""
        suitable_agents = get_agents_by_time_budget(hours_available)
        
        if not suitable_agents:
            print(f"No GSD agents available for {hours_available} hours")
            return None
        
        # Return agent with longest time budget that fits
        best_agent = max(
            suitable_agents,
            key=lambda a: self._parse_max_hours(a.time_budget)
        )
        
        return best_agent
    
    def _parse_max_hours(self, time_budget: str) -> float:
        """Convert time budget string to hours."""
        if 'min' in time_budget:
            max_val = float(time_budget.split('-')[-1].split()[0])
            return max_val / 60
        else:
            return float(time_budget.split('-')[-1].split()[0])

# Usage
selector = AgentSelector()

# Emergency bug - need fast fix
agent = selector.select_for_timeframe(0.5)  # 30 minutes
print(f"Selected: {agent.name} ({agent.time_budget})")
# Output: Selected: Bolt (15-30 min)

# Feature development - have a few hours
agent = selector.select_for_timeframe(3.0)  # 3 hours
print(f"Selected: {agent.name} ({agent.time_budget})")
# Output: Selected: Spark (2-4 hours) or Flash (1-4 hours)
```

### Example 3: Task Template Integration

```python
# your_project/workflow_manager.py
from bmad_gsd import get_task_path
from bmad_gsd.tasks import get_task_info

def load_workflow(task_id: str):
    """Load a task workflow template."""
    
    # Get task metadata
    task_info = get_task_info(task_id)
    print(f"Loading: {task_info.title}")
    print(f"Description: {task_info.description}")
    print(f"Estimated time: {task_info.time_estimate}")
    
    # Get the workflow file
    task_path = get_task_path(task_id)
    
    # Read the workflow steps
    with open(task_path) as f:
        workflow = f.read()
    
    return workflow

# Usage
workflow = load_workflow('gsd-quick-build')
# Use workflow to guide your LLM or automation
```

### Example 4: Documentation Access

```python
# your_project/docs_viewer.py
from bmad_gsd import get_doc_path

def show_quick_start():
    """Display the GSD quick start guide."""
    doc_path = get_doc_path('GSD-QUICK-START.md')
    
    if doc_path and doc_path.exists():
        with open(doc_path) as f:
            content = f.read()
        
        # Display in your UI, terminal, or web app
        print(content)
    else:
        print("Quick start guide not found")

# Usage
show_quick_start()
```

## Complete Example Project

Here's a complete example of using BMAD-GSD in a new project:

```
my_ai_project/
├── pyproject.toml          # Dependencies include bmad-gsd
├── requirements.txt        # Or here
├── src/
│   └── my_ai_project/
│       ├── __init__.py
│       ├── agent_runner.py    # LLM integration
│       ├── agent_selector.py  # Dynamic selection
│       └── workflow_manager.py # Task templates
└── examples/
    └── run_gsd_builder.py  # Example usage
```

**pyproject.toml**:
```toml
[project]
name = "my-ai-project"
version = "1.0.0"
dependencies = [
    "bmad-gsd @ git+https://github.com/yourusername/cheddar-fpl-sage.git",
    "openai>=1.0",
]
```

**examples/run_gsd_builder.py**:
```python
from bmad_gsd import get_agent_path, get_task_path
from bmad_gsd.agents import get_agent_info

def main():
    # 1. Get agent info
    builder = get_agent_info('gsd-builder')
    print(f"Activating: {builder.title}")
    print(f"Use case: {builder.when_to_use}")
    print(f"Time budget: {builder.time_budget}")
    
    # 2. Load agent definition
    agent_path = get_agent_path('gsd-builder')
    with open(agent_path) as f:
        agent_definition = f.read()
    
    # 3. Load task template
    task_path = get_task_path('gsd-quick-build')
    with open(task_path) as f:
        task_template = f.read()
    
    # 4. Send to your LLM
    prompt = f"""
{agent_definition}

TASK TEMPLATE:
{task_template}

USER REQUEST:
Build a REST API endpoint for user registration in 2 hours.
"""
    
    # Your LLM integration here
    print("Ready to send to LLM...")

if __name__ == "__main__":
    main()
```

## Troubleshooting

### Import Error

If you get `ModuleNotFoundError: No module named 'bmad_gsd'`:

```bash
# Check if installed
pip list | grep bmad-gsd

# If not installed
pip install git+https://github.com/yourusername/cheddar-fpl-sage.git

# Or in development mode
pip install -e /path/to/cheddar-fpl-sage
```

### Files Not Found

If agent/task files are not found:

```python
from bmad_gsd import BMAD_CORE_ROOT
print(f"BMAD core directory: {BMAD_CORE_ROOT}")

# Check if directory exists
if BMAD_CORE_ROOT.exists():
    print("✓ .bmad-core directory found")
    print(f"  Contents: {list(BMAD_CORE_ROOT.iterdir())}")
else:
    print("✗ .bmad-core directory not found")
```

### Package Data Not Included

If the .bmad-core directory is missing after install:

1. Check MANIFEST.in exists in the package
2. Reinstall with:
   ```bash
   pip install --force-reinstall --no-cache-dir git+https://github.com/yourusername/cheddar-fpl-sage.git
   ```

## Next Steps

1. **Read the documentation**: 
   ```python
   from bmad_gsd import get_doc_path
   integration_guide = get_doc_path('GSD-BMAD-INTEGRATION.md')
   ```

2. **Explore available agents**:
   ```python
   from bmad_gsd import list_agents
   print(list_agents())
   ```

3. **Run the examples**:
   ```bash
   python examples/bmad_gsd_usage.py
   ```

4. **Integrate with your LLM/AI system**

## Support

For issues or questions, see the main repository documentation or file an issue.
