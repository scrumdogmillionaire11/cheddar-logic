#!/bin/bash
set -e

# Bootstrap script for offline Python environment setup
# Handles the setuptools/wheel dependency issue in sandboxed environments

VENDOR_DIR="vendor/wheels"
PYTHON=${PYTHON:-python}

echo "🔧 Bootstrapping offline Python build environment..."

# Create vendor directory if it doesn't exist
mkdir -p "$VENDOR_DIR"

# Function to download wheels if we have internet access
download_wheels() {
    echo "📥 Downloading build dependencies to $VENDOR_DIR..."
    
    # Try to download essential wheels
    if command -v pip > /dev/null 2>&1; then
        # Download without installing
        $PYTHON -m pip download --dest "$VENDOR_DIR" setuptools wheel pip --no-deps --prefer-binary 2>/dev/null || {
            echo "⚠️  Failed to download wheels - continuing with vendored copies"
            return 1
        }
        echo "✅ Successfully downloaded build tools"
        return 0
    else
        echo "❌ pip not available for downloading"
        return 1
    fi
}

# Function to install from vendored wheels
install_from_vendor() {
    echo "🔨 Installing build tools from vendor directory..."
    
    # Count available wheels
    wheel_count=$(find "$VENDOR_DIR" -name "*.whl" | wc -l)
    
    if [ "$wheel_count" -eq 0 ]; then
        echo "❌ No wheels found in $VENDOR_DIR"
        echo "💡 You need to manually place setuptools and wheel .whl files in $VENDOR_DIR"
        echo "💡 Or run this script with internet access to download them automatically"
        exit 1
    fi
    
    echo "📦 Found $wheel_count wheel files in vendor directory"
    
    # Install wheels without index
    $PYTHON -m pip install --no-index --find-links "$VENDOR_DIR" setuptools wheel --force-reinstall --no-deps || {
        echo "❌ Failed to install from vendor wheels"
        exit 1
    }
    
    echo "✅ Build tools installed successfully"
}

# Function to install project in development mode
install_project_dev() {
    echo "🚀 Installing project in development mode..."
    
    # Install project without dependencies from PyPI
    PIP_NO_INDEX=1 $PYTHON -m pip install -e . --no-build-isolation --no-deps || {
        echo "❌ Failed to install project in development mode"
        exit 1
    }
    
    echo "✅ Project installed in development mode"
}

# Function to run tests
run_tests() {
    echo "🧪 Running tests..."
    
    if [ -d "tests" ]; then
        $PYTHON -m pytest tests -v || {
            echo "⚠️  Some tests failed"
            return 1
        }
        echo "✅ All tests passed"
    else
        echo "ℹ️  No tests directory found - skipping test run"
    fi
}

# Main execution flow
main() {
    echo "🎯 Python: $(which $PYTHON)"
    echo "🎯 Python version: $($PYTHON --version)"
    echo "🎯 Working directory: $(pwd)"
    echo "🎯 Vendor directory: $VENDOR_DIR"
    echo ""
    
    # Try to download wheels if we have internet, otherwise use existing ones
    if ! download_wheels; then
        echo "🔄 Falling back to existing vendor wheels..."
    fi
    
    # Install build tools from vendor directory
    install_from_vendor
    
    # Install project in development mode
    install_project_dev
    
    # Run tests if requested
    if [ "$1" = "--test" ] || [ "$1" = "-t" ]; then
        run_tests
    fi
    
    echo ""
    echo "🎉 Bootstrap complete!"
    echo ""
    echo "📚 Next steps:"
    echo "  • Run tests: python -m pytest tests"
    echo "  • Import your package: python -c 'import cheddar_fpl_sage'"
    echo "  • Add dependencies to pyproject.toml [project.dependencies] as needed"
    echo ""
}

# Help text
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    echo "Bootstrap offline Python environment"
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -t, --test    Run tests after setup"
    echo "  -h, --help    Show this help"
    echo ""
    echo "Environment variables:"
    echo "  PYTHON        Python executable to use (default: python)"
    echo ""
    echo "This script:"
    echo "  1. Downloads or uses vendored setuptools/wheel packages"
    echo "  2. Installs build tools from vendor/wheels directory"  
    echo "  3. Installs project in development mode without PyPI"
    echo "  4. Optionally runs tests"
    exit 0
fi

# Run main function
main "$@"