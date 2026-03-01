"""
BMAD-GSD Agent Registry

This module provides structured access to all BMAD and GSD agent definitions.
"""

from typing import Dict, List, Optional
from dataclasses import dataclass


@dataclass
class AgentInfo:
    """Information about a BMAD-GSD agent."""
    id: str
    name: str
    title: str
    icon: str
    when_to_use: str
    time_budget: Optional[str] = None  # For GSD agents only
    category: str = "bmad"  # 'bmad' or 'gsd'


# GSD (Get Shit Done) Execution Agents
GSD_AGENTS: Dict[str, AgentInfo] = {
    "gsd-builder": AgentInfo(
        id="gsd-builder",
        name="Flash",
        title="GSD Builder",
        icon="⚡",
        when_to_use="Build features quickly (1-4 hours), rapid implementation, proof of concepts",
        time_budget="1-4 hours",
        category="gsd"
    ),
    "gsd-fixer": AgentInfo(
        id="gsd-fixer",
        name="Bolt",
        title="GSD Fixer",
        icon="🔧",
        when_to_use="Emergency bug fixes, production issues, critical problems needing immediate resolution",
        time_budget="15-30 min",
        category="gsd"
    ),
    "gsd-prototyper": AgentInfo(
        id="gsd-prototyper",
        name="Spark",
        title="GSD Prototyper",
        icon="🔬",
        when_to_use="Test ideas quickly, validate feasibility, rapid experimentation, proof of concepts",
        time_budget="2-4 hours",
        category="gsd"
    ),
    "gsd-debugger": AgentInfo(
        id="gsd-debugger",
        name="Trace",
        title="GSD Debugger",
        icon="🔍",
        when_to_use="Complex debugging, execution analysis, state inspection, performance issues",
        time_budget="30-60 min",
        category="gsd"
    ),
    "gsd-optimizer": AgentInfo(
        id="gsd-optimizer",
        name="Turbo",
        title="GSD Optimizer",
        icon="🚀",
        when_to_use="Performance improvements, speed optimization, resource efficiency",
        time_budget="1-2 hours",
        category="gsd"
    ),
    "gsd-integrator": AgentInfo(
        id="gsd-integrator",
        name="Link",
        title="GSD Integrator",
        icon="🔗",
        when_to_use="System integration, API connections, service hookups, data pipeline setup",
        time_budget="2-6 hours",
        category="gsd"
    ),
    "gsd-tester": AgentInfo(
        id="gsd-tester",
        name="Check",
        title="GSD Tester",
        icon="✅",
        when_to_use="Quick test creation, regression prevention, test coverage addition",
        time_budget="1-3 hours",
        category="gsd"
    ),
}


# BMAD Planning & Quality Agents
BMAD_AGENTS: Dict[str, AgentInfo] = {
    "ux-expert": AgentInfo(
        id="ux-expert",
        name="Sally",
        title="UX Expert",
        icon="🎨",
        when_to_use="Use for UI/UX design, wireframes, prototypes, front-end specifications, and user experience optimization",
        category="bmad"
    ),
    "sm": AgentInfo(
        id="sm",
        name="Bob",
        title="Scrum Master",
        icon="🏃",
        when_to_use="Use for story creation, epic management, retrospectives in party-mode, and agile process guidance",
        category="bmad"
    ),
    "qa": AgentInfo(
        id="qa",
        name="Quinn",
        title="Test Architect & Quality Advisor",
        icon="🧪",
        when_to_use="Use for comprehensive test architecture review, quality gate decisions, and code improvement",
        category="bmad"
    ),
    "po": AgentInfo(
        id="po",
        name="Sarah",
        title="Product Owner",
        icon="📝",
        when_to_use="Use for backlog management, story refinement, acceptance criteria, sprint planning, and prioritization decisions",
        category="bmad"
    ),
    "pm": AgentInfo(
        id="pm",
        name="John",
        title="Product Manager",
        icon="📋",
        when_to_use="Use for creating PRDs, product strategy, feature prioritization, roadmap planning, and stakeholder communication",
        category="bmad"
    ),
    "dev": AgentInfo(
        id="dev",
        name="James",
        title="Full Stack Developer",
        icon="💻",
        when_to_use="Use for code implementation, debugging, refactoring, and development best practices",
        category="bmad"
    ),
    "bmad-orchestrator": AgentInfo(
        id="bmad-orchestrator",
        name="BMad Orchestrator",
        title="BMad Master Orchestrator",
        icon="🎭",
        when_to_use="Use for workflow coordination, multi-agent tasks, role switching guidance, and when unsure which specialist to consult",
        category="bmad"
    ),
    "bmad-master": AgentInfo(
        id="bmad-master",
        name="BMad Master",
        title="BMad Master Task Executor",
        icon="🧙",
        when_to_use="Use when you need comprehensive expertise across all domains, running 1 off tasks that do not require a persona",
        category="bmad"
    ),
    "architect": AgentInfo(
        id="architect",
        name="Winston",
        title="Architect",
        icon="🏗️",
        when_to_use="Use for system design, architecture documents, technology selection, API design, and infrastructure planning",
        category="bmad"
    ),
    "analyst": AgentInfo(
        id="analyst",
        name="Mary",
        title="Business Analyst",
        icon="📊",
        when_to_use="Use for market research, brainstorming, competitive analysis, creating project briefs, initial project discovery",
        category="bmad"
    ),
}


# Combined registry
ALL_AGENTS: Dict[str, AgentInfo] = {**BMAD_AGENTS, **GSD_AGENTS}


def get_agent_info(agent_id: str) -> AgentInfo:
    """
    Get information about a specific agent.
    
    Args:
        agent_id: Agent identifier
        
    Returns:
        AgentInfo object
        
    Raises:
        KeyError: If agent_id not found
    """
    return ALL_AGENTS[agent_id]


def get_gsd_agents() -> List[AgentInfo]:
    """Get list of all GSD execution agents."""
    return list(GSD_AGENTS.values())


def get_bmad_agents() -> List[AgentInfo]:
    """Get list of all BMAD planning agents."""
    return list(BMAD_AGENTS.values())


def get_agents_by_category(category: str) -> List[AgentInfo]:
    """
    Get agents filtered by category.
    
    Args:
        category: 'bmad' or 'gsd'
        
    Returns:
        List of AgentInfo objects
    """
    return [agent for agent in ALL_AGENTS.values() if agent.category == category]


def get_agents_by_time_budget(max_hours: float) -> List[AgentInfo]:
    """
    Get GSD agents that fit within a time budget.
    
    Args:
        max_hours: Maximum time budget in hours
        
    Returns:
        List of suitable GSD agents
        
    Example:
        >>> quick_agents = get_agents_by_time_budget(1.0)  # Agents that work in < 1 hour
    """
    result = []
    for agent in GSD_AGENTS.values():
        if agent.time_budget:
            # Parse time budget (e.g., "15-30 min", "1-4 hours")
            parts = agent.time_budget.split()
            max_time_str = parts[0].split('-')[-1]  # Get max value
            
            if 'min' in agent.time_budget:
                max_time_hours = float(max_time_str) / 60
            else:  # hours
                max_time_hours = float(max_time_str)
            
            if max_time_hours <= max_hours:
                result.append(agent)
    
    return result


__all__ = [
    "AgentInfo",
    "GSD_AGENTS",
    "BMAD_AGENTS",
    "ALL_AGENTS",
    "get_agent_info",
    "get_gsd_agents",
    "get_bmad_agents",
    "get_agents_by_category",
    "get_agents_by_time_budget",
]
