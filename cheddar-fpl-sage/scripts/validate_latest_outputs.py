"""
Validate the latest output bundle referenced by outputs/LATEST.json.

Checks:
1) All artifacts exist.
2) Required top-level fields are present in JSON files.
"""

import json
from pathlib import Path
import sys

REQUIRED_FIELDS = {"schema_version", "run_id", "gameweek", "season", "generated_at"}


def load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except Exception as exc:
        raise ValueError(f"Invalid JSON in {path}: {exc}") from exc


def validate_json(path: Path):
    payload = load_json(path)
    missing = [f for f in REQUIRED_FIELDS if f not in payload]
    if missing:
        raise ValueError(f"{path} missing required fields: {missing}")


def validate_latest():
    base = Path("outputs")
    latest_path = base / "LATEST.json"
    if not latest_path.exists():
        print("LATEST.json not found.")
        sys.exit(1)

    latest = load_json(latest_path)
    required_artifacts = {
        "enhanced_collection": Path(latest["enhanced_collection"]),
        "model_inputs": Path(latest["model_inputs"]),
        "analysis": Path(latest["analysis"]),
        "report": Path(latest["report"]),
    }

    missing = [name for name, path in required_artifacts.items() if not path.exists()]
    if missing:
        print(f"Missing artifacts: {missing}")
        sys.exit(1)

    for name, path in required_artifacts.items():
        if path.suffix.lower() == ".json":
            validate_json(path)

    print("✅ Latest bundle is valid.")


def main():
    validate_latest()


if __name__ == "__main__":
    main()
