# Vendor Directory

This directory contains wheel files for Python build tools needed for offline installation in sandboxed environments.

## Contents

- **setuptools** - Python package development utilities  
- **wheel** - Built-package format for Python
- **pip** - Package installer for Python
- **build** - PEP 517 build frontend (optional)
- **packaging** - Core utilities for Python packaging (optional)

## Usage

### Automatic Setup (Recommended)

```bash
# If you have internet access, download wheels first:
python vendor_wheels.py

# Then bootstrap the offline environment:
./bootstrap_offline_build_tools.sh
```

### Manual Setup

```bash
# Install build tools from vendored wheels:
python -m pip install --no-index --find-links vendor/wheels setuptools wheel

# Install your project in development mode:
PIP_NO_INDEX=1 python -m pip install -e . --no-build-isolation --no-deps

# Run tests:
python -m pytest tests
```

## Troubleshooting

### No wheels found
If you see "No wheels found in vendor/wheels":
1. Run `python vendor_wheels.py` to download them
2. Or manually place .whl files in this directory

### Permission errors
```bash
chmod +x bootstrap_offline_build_tools.sh
```

### Python version conflicts
Ensure you're using the same Python version that the wheels were built for:
```bash
PYTHON=python3.10 ./bootstrap_offline_build_tools.sh
```

## For CI/CD

Add to your CI script:
```yaml
- name: Bootstrap offline Python environment
  run: |
    python vendor_wheels.py
    ./bootstrap_offline_build_tools.sh --test
```

## Files in this directory

The vendored wheels will appear here after running `python vendor_wheels.py`.