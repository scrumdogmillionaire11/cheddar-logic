"""
Example usage of the BMAD-GSD framework.

This demonstrates how to use the bmad_gsd package in your own projects.
"""

from bmad_gsd import (
    get_agent_path,
    get_task_path,
    get_doc_path,
    list_agents,
)
from bmad_gsd.agents import (
    get_agent_info,
    get_gsd_agents,
    get_bmad_agents,
    get_agents_by_time_budget,
)
from bmad_gsd.tasks import get_task_info


def example_list_all_agents():
    """List all available agents."""
    print("=" * 60)
    print("ALL AVAILABLE AGENTS")
    print("=" * 60)
    
    agents = list_agents()
    for agent_id, path in agents.items():
        info = get_agent_info(agent_id)
        budget = f" ({info.time_budget})" if info.time_budget else ""
        print(f"{info.icon} {info.name}{budget}")
        print(f"   ID: {agent_id}")
        print(f"   Use: {info.when_to_use}")
        print(f"   Path: {path}")
        print()


def example_gsd_vs_bmad():
    """Show GSD vs BMAD agent categories."""
    print("=" * 60)
    print("GSD AGENTS (Time-Boxed Rapid Execution)")
    print("=" * 60)
    
    for agent in get_gsd_agents():
        print(f"{agent.icon} {agent.name} - {agent.time_budget}")
        print(f"   {agent.when_to_use}")
        print()
    
    print("=" * 60)
    print("BMAD AGENTS (Comprehensive Planning & Quality)")
    print("=" * 60)
    
    for agent in get_bmad_agents():
        print(f"{agent.icon} {agent.name}")
        print(f"   {agent.when_to_use}")
        print()


def example_time_budget_selection():
    """Select agents by time budget."""
    print("=" * 60)
    print("TIME BUDGET SELECTION")
    print("=" * 60)
    
    time_budgets = [0.5, 1.0, 2.0, 4.0]
    
    for hours in time_budgets:
        print(f"\nAgents available for {hours} hour{'s' if hours != 1 else ''} or less:")
        agents = get_agents_by_time_budget(hours)
        
        if agents:
            for agent in agents:
                print(f"  {agent.icon} {agent.name} ({agent.time_budget})")
        else:
            print("  No agents available for this time budget")


def example_load_agent_definition():
    """Load and display an agent definition file."""
    print("=" * 60)
    print("AGENT DEFINITION EXAMPLE")
    print("=" * 60)
    
    agent_id = 'gsd-builder'
    path = get_agent_path(agent_id)
    
    if path and path.exists():
        print(f"Loading {agent_id} from {path}\n")
        with open(path) as f:
            content = f.read()
            # Show first 500 characters
            print(content[:500])
            print("\n... (truncated)")
    else:
        print(f"Agent {agent_id} not found")


def example_load_task_template():
    """Load and display a task template."""
    print("=" * 60)
    print("TASK TEMPLATE EXAMPLE")
    print("=" * 60)
    
    task_id = 'gsd-quick-build'
    path = get_task_path(task_id)
    
    if path and path.exists():
        info = get_task_info(task_id)
        print(f"Task: {info.title}")
        print(f"Description: {info.description}")
        print(f"Time: {info.time_estimate}")
        print(f"Path: {path}\n")
        
        with open(path) as f:
            content = f.read()
            # Show first 500 characters
            print(content[:500])
            print("\n... (truncated)")
    else:
        print(f"Task {task_id} not found")


def example_access_documentation():
    """Access framework documentation."""
    print("=" * 60)
    print("DOCUMENTATION ACCESS")
    print("=" * 60)
    
    docs = [
        'GSD-BMAD-INTEGRATION.md',
        'GSD-QUICK-START.md',
        'GSD-INTEGRATION-SUMMARY.md'
    ]
    
    for doc_name in docs:
        path = get_doc_path(doc_name)
        if path and path.exists():
            print(f"✓ {doc_name}")
            print(f"  Path: {path}")
        else:
            print(f"✗ {doc_name} (not found)")
    print()


def example_practical_workflow():
    """Example of practical workflow selection."""
    print("=" * 60)
    print("PRACTICAL WORKFLOW EXAMPLE")
    print("=" * 60)
    
    scenarios = [
        {
            "task": "Emergency production bug",
            "time_available": 0.5,  # 30 minutes
            "expected_agent": "gsd-fixer"
        },
        {
            "task": "Quick feature prototype",
            "time_available": 2.0,  # 2 hours
            "expected_agent": "gsd-prototyper"
        },
        {
            "task": "New product planning",
            "time_available": None,  # No time constraint
            "expected_agent": "pm"
        },
    ]
    
    for scenario in scenarios:
        print(f"\nScenario: {scenario['task']}")
        print(f"Time available: {scenario['time_available']} hours" if scenario['time_available'] else "Time available: No constraint")
        
        if scenario['time_available']:
            # GSD workflow - time-boxed
            agents = get_agents_by_time_budget(scenario['time_available'])
            if agents:
                # Select agent with longest budget that fits
                selected = max(agents, key=lambda a: a.time_budget or "0")
                print(f"Recommended: {selected.icon} {selected.name} ({selected.time_budget})")
                print(f"Reason: {selected.when_to_use}")
            else:
                print("No agents available for this time budget")
        else:
            # BMAD workflow - comprehensive planning
            agent_id = scenario['expected_agent']
            agent = get_agent_info(agent_id)
            print(f"Recommended: {agent.icon} {agent.name}")
            print(f"Reason: {agent.when_to_use}")


if __name__ == "__main__":
    # Run all examples
    examples = [
        ("List All Agents", example_list_all_agents),
        ("GSD vs BMAD Categories", example_gsd_vs_bmad),
        ("Time Budget Selection", example_time_budget_selection),
        ("Load Agent Definition", example_load_agent_definition),
        ("Load Task Template", example_load_task_template),
        ("Access Documentation", example_access_documentation),
        ("Practical Workflow", example_practical_workflow),
    ]
    
    print("\n\n")
    print("*" * 60)
    print("BMAD-GSD FRAMEWORK USAGE EXAMPLES")
    print("*" * 60)
    print("\n")
    
    for i, (title, func) in enumerate(examples, 1):
        print(f"\n{'=' * 60}")
        print(f"EXAMPLE {i}: {title.upper()}")
        print(f"{'=' * 60}\n")
        func()
        print("\n")
    
    print("*" * 60)
    print("END OF EXAMPLES")
    print("*" * 60)
