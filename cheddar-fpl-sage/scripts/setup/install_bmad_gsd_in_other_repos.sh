#!/bin/bash
# Install BMAD-GSD Framework in NBA and NHL Repos

FPL_SAGE_PATH="/Users/ajcolubiale/projects/cheddar-fpl-sage"
NBA_PATH="/Users/ajcolubiale/projects/cheddar-nba-2.0"
NHL_PATH="/Users/ajcolubiale/projects/cheddar-nhl"

echo "======================================"
echo "BMAD-GSD Framework Installation"
echo "======================================"
echo ""

# Install in NBA repo
if [ -d "$NBA_PATH" ]; then
    echo "📦 Installing in cheddar-nba-2.0..."
    cd "$NBA_PATH"
    pip install -e "$FPL_SAGE_PATH"
    
    if [ $? -eq 0 ]; then
        echo "✅ Successfully installed in NBA repo"
        
        # Create test file
        cat > test_bmad_gsd.py << 'EOF'
from bmad_gsd import list_agents
from bmad_gsd.agents import get_agent_info

agents = list_agents()
print(f"✓ Found {len(agents)} BMAD-GSD agents")

builder = get_agent_info('gsd-builder')
print(f"✓ {builder.icon} {builder.name}: {builder.when_to_use}")

print("\n✅ BMAD-GSD successfully installed in NBA repo!")
EOF
        
        echo ""
        echo "Testing installation..."
        python test_bmad_gsd.py
        echo ""
    else
        echo "❌ Failed to install in NBA repo"
    fi
else
    echo "⚠️  NBA repo not found at $NBA_PATH"
fi

echo ""
echo "--------------------------------------"
echo ""

# Install in NHL repo
if [ -d "$NHL_PATH" ]; then
    echo "📦 Installing in cheddar-nhl..."
    cd "$NHL_PATH"
    pip install -e "$FPL_SAGE_PATH"
    
    if [ $? -eq 0 ]; then
        echo "✅ Successfully installed in NHL repo"
        
        # Create test file
        cat > test_bmad_gsd.py << 'EOF'
from bmad_gsd import list_agents
from bmad_gsd.agents import get_agent_info

agents = list_agents()
print(f"✓ Found {len(agents)} BMAD-GSD agents")

builder = get_agent_info('gsd-builder')
print(f"✓ {builder.icon} {builder.name}: {builder.when_to_use}")

print("\n✅ BMAD-GSD successfully installed in NHL repo!")
EOF
        
        echo ""
        echo "Testing installation..."
        python test_bmad_gsd.py
        echo ""
    else
        echo "❌ Failed to install in NHL repo"
    fi
else
    echo "⚠️  NHL repo not found at $NHL_PATH"
fi

echo ""
echo "======================================"
echo "Installation Complete!"
echo "======================================"
echo ""
echo "Next steps:"
echo "1. The framework is now importable in both repos"
echo "2. Use: from bmad_gsd import get_agent_path, list_agents"
echo "3. See examples/bmad_gsd_usage.py for usage examples"
