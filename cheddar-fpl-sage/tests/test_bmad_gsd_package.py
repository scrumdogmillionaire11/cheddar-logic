"""
Tests for BMAD-GSD package installation and registry wiring.
"""

import pytest


def test_imports():
    """All public BMAD-GSD imports load correctly."""
    try:
        from bmad_gsd import (
            BMAD_CORE_ROOT,
            get_agent_path,
            get_doc_path,
            get_task_path,
            list_agents,
            list_tasks,
        )
        from bmad_gsd.agents import BMAD_AGENTS, GSD_AGENTS, get_agent_info, get_bmad_agents, get_gsd_agents
        from bmad_gsd.tasks import BMAD_TASKS, GSD_TASKS, get_task_info
    except ImportError as exc:
        pytest.fail(f"Import failed: {exc}")

    assert BMAD_CORE_ROOT is not None
    assert callable(get_agent_path)
    assert callable(get_task_path)
    assert callable(get_doc_path)
    assert callable(list_agents)
    assert callable(list_tasks)
    assert BMAD_AGENTS is not None
    assert GSD_AGENTS is not None
    assert BMAD_TASKS is not None
    assert GSD_TASKS is not None
    assert callable(get_agent_info)
    assert callable(get_task_info)
    assert callable(get_bmad_agents)
    assert callable(get_gsd_agents)


def test_agent_registry():
    """Agent registry contains expected BMAD and GSD entries."""
    from bmad_gsd.agents import BMAD_AGENTS, GSD_AGENTS, get_agent_info

    assert len(GSD_AGENTS) == 7
    assert len(BMAD_AGENTS) >= 10

    builder = get_agent_info("gsd-builder")
    assert builder is not None
    assert builder.name == "Flash"


def test_file_access():
    """Core BMAD files are present and resolvable."""
    from bmad_gsd import BMAD_CORE_ROOT, get_agent_path, get_task_path

    assert BMAD_CORE_ROOT.exists()

    builder_path = get_agent_path("gsd-builder")
    assert builder_path is not None
    assert builder_path.exists()

    task_path = get_task_path("gsd-quick-build")
    assert task_path is not None
    assert task_path.exists()


def test_list_functions():
    """List helpers return non-empty registries."""
    from bmad_gsd import list_agents, list_tasks

    agents = list_agents()
    tasks = list_tasks()

    assert len(agents) >= 17  # 7 GSD + 10 BMAD
    assert len(tasks) >= 3


def test_time_budget_filtering():
    """Budget filtering returns broader set for larger budgets."""
    from bmad_gsd.agents import get_agents_by_time_budget

    quick_agents = get_agents_by_time_budget(0.5)
    medium_agents = get_agents_by_time_budget(2.0)

    assert len(quick_agents) > 0
    assert len(medium_agents) >= len(quick_agents)


def test_documentation_access():
    """Expected docs are available through path resolver."""
    from bmad_gsd import get_doc_path

    docs = [
        "GSD-BMAD-INTEGRATION.md",
        "GSD-QUICK-START.md",
    ]

    missing = []
    for doc_name in docs:
        doc_path = get_doc_path(doc_name)
        if not doc_path or not doc_path.exists():
            missing.append(doc_name)

    assert not missing, f"Missing docs: {missing}"
