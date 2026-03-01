"""
BMAD-GSD Framework
==================

A structured multi-agent framework combining:
- BMAD-METHOD: Comprehensive planning & quality agents (PM, Architect, PO, QA, Dev, etc.)
- GSD (Get Shit Done): Time-boxed rapid execution agents (Builder, Fixer, Prototyper, etc.)

Usage:
    from bmad_gsd import agents, tasks, get_agent_path, get_task_path
    
    # Get agent definition path
    builder_path = get_agent_path('gsd-builder')
    
    # Get task template path
    quick_build_path = get_task_path('gsd-quick-build')
    
    # Access agent registry
    from bmad_gsd.agents import GSD_AGENTS, BMAD_AGENTS, ALL_AGENTS
"""

from pathlib import Path
from typing import Dict, Optional

__version__ = "1.0.0"

# Package root
PACKAGE_ROOT = Path(__file__).parent
BMAD_CORE_ROOT = PACKAGE_ROOT.parent / ".bmad-core"
DOCS_ROOT = PACKAGE_ROOT.parent / "docs"


def get_agent_path(agent_id: str) -> Optional[Path]:
    """
    Get the file path for an agent definition.
    
    Args:
        agent_id: Agent identifier (e.g., 'gsd-builder', 'pm', 'dev')
        
    Returns:
        Path to agent markdown file, or None if not found
        
    Example:
        >>> path = get_agent_path('gsd-builder')
        >>> print(path)
        /path/to/.bmad-core/agents/gsd-builder.md
    """
    agent_path = BMAD_CORE_ROOT / "agents" / f"{agent_id}.md"
    return agent_path if agent_path.exists() else None


def get_task_path(task_id: str) -> Optional[Path]:
    """
    Get the file path for a task template.
    
    Args:
        task_id: Task identifier (e.g., 'gsd-quick-build', 'create-doc')
        
    Returns:
        Path to task markdown file, or None if not found
        
    Example:
        >>> path = get_task_path('gsd-quick-build')
        >>> print(path)
        /path/to/.bmad-core/tasks/gsd-quick-build.md
    """
    task_path = BMAD_CORE_ROOT / "tasks" / f"{task_id}.md"
    return task_path if task_path.exists() else None


def get_doc_path(doc_name: str) -> Optional[Path]:
    """
    Get the file path for a documentation file.
    
    Args:
        doc_name: Document name (e.g., 'GSD-QUICK-START.md', 'GSD-BMAD-INTEGRATION.md')
        
    Returns:
        Path to documentation file, or None if not found
    """
    doc_path = DOCS_ROOT / doc_name
    return doc_path if doc_path.exists() else None


def list_agents() -> Dict[str, Path]:
    """
    List all available agent definitions.
    
    Returns:
        Dictionary mapping agent_id to file path
        
    Example:
        >>> agents = list_agents()
        >>> for agent_id, path in agents.items():
        ...     print(f"{agent_id}: {path}")
    """
    agents_dir = BMAD_CORE_ROOT / "agents"
    if not agents_dir.exists():
        return {}
    
    return {
        path.stem: path
        for path in agents_dir.glob("*.md")
    }


def list_tasks() -> Dict[str, Path]:
    """
    List all available task templates.
    
    Returns:
        Dictionary mapping task_id to file path
    """
    tasks_dir = BMAD_CORE_ROOT / "tasks"
    if not tasks_dir.exists():
        return {}
    
    return {
        path.stem: path
        for path in tasks_dir.glob("*.md")
    }


# Export convenience functions
__all__ = [
    "get_agent_path",
    "get_task_path", 
    "get_doc_path",
    "list_agents",
    "list_tasks",
    "PACKAGE_ROOT",
    "BMAD_CORE_ROOT",
    "DOCS_ROOT",
    "__version__",
]
