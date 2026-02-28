#!/bin/bash
# Start FPL Sage Backend (FastAPI on port 8000)

set -e

cd "$(dirname "$0")/../cheddar-fpl-sage"

echo "🚀 Starting FPL Sage Backend..."
echo "   Port: 8000"
echo "   Docs: http://localhost:8000/docs"
echo ""

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "⚙️  Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate

# Install dependencies if needed
if ! python -c "import fastapi, pydantic_settings" 2>/dev/null; then
    echo "📦 Installing dependencies..."
    pip install -r config/requirements.txt
fi

# Ensure local package imports resolve
export PYTHONPATH="$(pwd):$(pwd)/src"

# Initialize database if needed
if [ ! -f "db/fpl_sage.db" ]; then
    echo "🗄️  Initializing database..."
    python scripts/data_pipeline_cli.py init-db
fi

# Start the server
echo "✓ Starting server..."
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000
