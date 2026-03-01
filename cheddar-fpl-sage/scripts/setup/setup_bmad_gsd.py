"""
Setup script for BMAD-GSD framework package.

This ensures the .bmad-core directory and documentation are included in the package.
"""

from setuptools import setup, find_packages
from pathlib import Path

# Read the README
readme_path = Path(__file__).parent / "BMAD_GSD_README.md"
long_description = readme_path.read_text() if readme_path.exists() else ""

# Collect all .bmad-core files
bmad_core_files = []
bmad_core_path = Path(__file__).parent / ".bmad-core"

if bmad_core_path.exists():
    for pattern in ["**/*.md", "**/*.yaml", "**/*.yml"]:
        for file in bmad_core_path.glob(pattern):
            rel_path = file.relative_to(Path(__file__).parent)
            bmad_core_files.append(str(rel_path))

# Collect documentation files
doc_files = [
    "docs/GSD-BMAD-INTEGRATION.md",
    "docs/GSD-QUICK-START.md",
    "docs/GSD-INTEGRATION-SUMMARY.md",
]

setup(
    name="bmad-gsd",
    version="1.0.0",
    description="BMAD-METHOD + GSD framework: Multi-agent system for comprehensive planning and rapid execution",
    long_description=long_description,
    long_description_content_type="text/markdown",
    author="BMAD-GSD Contributors",
    python_requires=">=3.10",
    packages=find_packages(where="."),
    package_dir={"": "."},
    package_data={
        "bmad_gsd": ["py.typed"],
        "": bmad_core_files + doc_files,
    },
    include_package_data=True,
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "Topic :: Software Development :: Libraries :: Application Frameworks",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
    ],
    keywords=[
        "bmad",
        "gsd",
        "agents",
        "multi-agent",
        "framework",
        "planning",
        "rapid-execution",
        "development-workflow",
    ],
    project_urls={
        "Documentation": "https://github.com/yourusername/cheddar-fpl-sage/blob/main/docs/GSD-BMAD-INTEGRATION.md",
        "Quick Start": "https://github.com/yourusername/cheddar-fpl-sage/blob/main/docs/GSD-QUICK-START.md",
    },
)
