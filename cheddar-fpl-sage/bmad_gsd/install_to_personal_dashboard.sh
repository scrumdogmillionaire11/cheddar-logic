#!/bin/bash
# Install bmad_gsd package to personal-dashboard

set -e

BMAD_GSD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PERSONAL_DASHBOARD_DIR="/Users/ajcolubiale/projects/personal-dashboard"

echo "🚀 Installing bmad_gsd package..."
echo "   Source: $BMAD_GSD_DIR"
echo "   Target: $PERSONAL_DASHBOARD_DIR"
echo ""

# Check if personal-dashboard exists
if [ ! -d "$PERSONAL_DASHBOARD_DIR" ]; then
    echo "❌ Error: personal-dashboard directory not found at $PERSONAL_DASHBOARD_DIR"
    exit 1
fi

# Option 1: Install in development mode (recommended)
echo "Installing in development mode (editable)..."
pip install -e "$BMAD_GSD_DIR"

echo ""
echo "✅ Installation complete!"
echo ""
echo "Usage in personal-dashboard:"
echo "  from bmad_gsd import agents, tasks, get_agent_path"
echo "  builder_path = get_agent_path('gsd-builder')"
echo ""
echo "To uninstall:"
echo "  pip uninstall bmad-gsd"
