"""
BMAD-GSD Task Templates

This module provides access to task template definitions.
"""

from typing import Dict, List, Optional
from dataclasses import dataclass


@dataclass
class TaskInfo:
    """Information about a BMAD-GSD task template."""
    id: str
    title: str
    description: str
    category: str  # 'gsd' or 'bmad'
    time_estimate: Optional[str] = None


# GSD Task Templates
GSD_TASKS: Dict[str, TaskInfo] = {
    "gsd-quick-build": TaskInfo(
        id="gsd-quick-build",
        title="Quick Build (60min Feature)",
        description="Build a working feature in 60 minutes with time-boxed phases",
        category="gsd",
        time_estimate="60 min"
    ),
    "gsd-rapid-fix": TaskInfo(
        id="gsd-rapid-fix",
        title="Rapid Fix (30min Bug Fix)",
        description="Fix bugs in 30 minutes with systematic approach",
        category="gsd",
        time_estimate="30 min"
    ),
    "gsd-fast-prototype": TaskInfo(
        id="gsd-fast-prototype",
        title="Fast Prototype (2-4hr POC)",
        description="Build proof of concept in 2-4 hours for idea validation",
        category="gsd",
        time_estimate="2-4 hours"
    ),
}


# BMAD Task Templates (examples - these would come from .bmad-core/tasks/)
BMAD_TASKS: Dict[str, TaskInfo] = {
    "create-doc": TaskInfo(
        id="create-doc",
        title="Create Document from Template",
        description="Create documents using YAML-driven templates with elicitation",
        category="bmad"
    ),
    "execute-checklist": TaskInfo(
        id="execute-checklist",
        title="Execute Checklist",
        description="Validate documentation against checklists systematically",
        category="bmad"
    ),
    "create-next-story": TaskInfo(
        id="create-next-story",
        title="Create Next Story",
        description="Create comprehensive, self-contained story files ready for implementation",
        category="bmad"
    ),
}


ALL_TASKS: Dict[str, TaskInfo] = {**BMAD_TASKS, **GSD_TASKS}


def get_task_info(task_id: str) -> TaskInfo:
    """
    Get information about a specific task.
    
    Args:
        task_id: Task identifier
        
    Returns:
        TaskInfo object
        
    Raises:
        KeyError: If task_id not found
    """
    return ALL_TASKS[task_id]


def get_gsd_tasks() -> List[TaskInfo]:
    """Get list of all GSD task templates."""
    return list(GSD_TASKS.values())


def get_bmad_tasks() -> List[TaskInfo]:
    """Get list of all BMAD task templates."""
    return list(BMAD_TASKS.values())


def get_tasks_by_category(category: str) -> List[TaskInfo]:
    """
    Get tasks filtered by category.
    
    Args:
        category: 'bmad' or 'gsd'
        
    Returns:
        List of TaskInfo objects
    """
    return [task for task in ALL_TASKS.values() if task.category == category]


__all__ = [
    "TaskInfo",
    "GSD_TASKS",
    "BMAD_TASKS",
    "ALL_TASKS",
    "get_task_info",
    "get_gsd_tasks",
    "get_bmad_tasks",
    "get_tasks_by_category",
]
