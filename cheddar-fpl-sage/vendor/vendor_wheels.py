#!/usr/bin/env python3
"""
Vendor wheel downloader for offline Python environments.

This script downloads essential build tools (setuptools, wheel, pip) 
to the vendor/wheels directory for use in sandboxed environments
where PyPI access may be limited.
"""

import sys
import subprocess
import urllib.request
import json
from pathlib import Path


def get_latest_version(package_name):
    """Get the latest version of a package from PyPI."""
    try:
        url = f"https://pypi.org/pypi/{package_name}/json"
        with urllib.request.urlopen(url) as response:
            data = json.load(response)
            return data['info']['version']
    except Exception as e:
        print(f"⚠️  Could not get latest version for {package_name}: {e}")
        return None


def download_wheel(package_name, version=None, dest_dir="vendor/wheels"):
    """Download a wheel file for the specified package."""
    dest_path = Path(dest_dir)
    dest_path.mkdir(parents=True, exist_ok=True)
    
    try:
        if version:
            package_spec = f"{package_name}=={version}"
        else:
            package_spec = package_name
            
        cmd = [
            sys.executable, "-m", "pip", "download",
            "--dest", str(dest_path),
            "--no-deps",
            "--prefer-binary",
            package_spec
        ]
        
        print(f"📥 Downloading {package_spec}...")
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode == 0:
            print(f"✅ Successfully downloaded {package_spec}")
            return True
        else:
            print(f"❌ Failed to download {package_spec}")
            print(f"Error: {result.stderr}")
            return False
            
    except Exception as e:
        print(f"❌ Error downloading {package_name}: {e}")
        return False


def main():
    """Main vendoring function."""
    print("🔧 Vendoring Python build tools for offline use...")
    print("🎯 This will download wheels to vendor/wheels/")
    print()
    
    # Essential packages for building Python packages
    essential_packages = [
        "setuptools",
        "wheel", 
        "pip"
    ]
    
    # Optional but useful packages
    optional_packages = [
        "build",
        "packaging"
    ]
    
    success_count = 0
    total_packages = len(essential_packages) + len(optional_packages)
    
    # Download essential packages
    print("📦 Downloading essential build packages...")
    for package in essential_packages:
        if download_wheel(package):
            success_count += 1
        print()
    
    # Download optional packages
    print("📦 Downloading optional build packages...")
    for package in optional_packages:
        if download_wheel(package):
            success_count += 1
        print()
    
    # Summary
    print(f"📊 Downloaded {success_count}/{total_packages} packages successfully")
    
    # List what we got
    vendor_path = Path("vendor/wheels")
    if vendor_path.exists():
        wheels = list(vendor_path.glob("*.whl"))
        if wheels:
            print(f"📋 Available wheels in {vendor_path}:")
            for wheel in sorted(wheels):
                print(f"   • {wheel.name}")
        else:
            print(f"⚠️  No wheels found in {vendor_path}")
    
    print()
    print("🎉 Vendoring complete!")
    print()
    print("💡 Next steps:")
    print("   1. Run: chmod +x bootstrap_offline_build_tools.sh")
    print("   2. Run: ./bootstrap_offline_build_tools.sh")
    print("   3. Or manually install: python -m pip install --no-index --find-links vendor/wheels setuptools wheel")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help"):
        print("Vendor wheel downloader")
        print()
        print("Usage: python vendor_wheels.py")
        print()
        print("This script downloads essential Python build tools")
        print("(setuptools, wheel, pip) to vendor/wheels/ for")
        print("use in offline or sandboxed environments.")
        sys.exit(0)
    
    main()