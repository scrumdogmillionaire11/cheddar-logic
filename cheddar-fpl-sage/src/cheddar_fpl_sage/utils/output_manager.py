"""
Output bundle manager for FPL Sage runs.
Handles run_id generation, atomic writes, and pointer/summary updates.
"""

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional


def _ensure_dir(path: Path) -> None:
    """Create directory if missing."""
    path.mkdir(parents=True, exist_ok=True)


def write_json_atomic(path: Path, payload: Dict) -> None:
    """Atomically write JSON to disk."""
    _ensure_dir(path.parent)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w") as f:
        json.dump(payload, f, indent=2, default=str)
        f.flush()
        os.fsync(f.fileno())
    tmp_path.replace(path)


def write_text_atomic(path: Path, content: str) -> None:
    """Atomically write text to disk."""
    _ensure_dir(path.parent)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    tmp_path.replace(path)


def generate_run_id(current_gw: Optional[int] = None) -> str:
    """Generate a run_id like 2025-12-29T13-05-22Z__gw19."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    suffix = f"__gw{current_gw}" if current_gw else ""
    return f"{ts}{suffix}"


@dataclass
class RunPaths:
    team_id: Optional[str]
    run_id: str
    run_dir: Path
    data_collection: Path
    model_inputs: Path
    analysis: Path
    report: Path
    injury_fpl: Path
    injury_secondary: Path
    injury_manual: Path
    injury_resolved: Path
    log: Path


class OutputBundleManager:
    """Manage run bundle paths and pointer updates."""

    def __init__(self, base_dir: Path = Path("outputs")):
        self.base_dir = base_dir
        self.runs_dir = self.base_dir / "runs"
        self.snapshots_dir = self.base_dir / "snapshots"
        self.latest_pointer = self.base_dir / "LATEST.json"
        self.summary_file = self.base_dir / "DATA_SUMMARY.json"

    def _team_slug(self, team_id: Optional[int]) -> str:
        return f"team_{team_id}" if team_id is not None else "no_team"

    def team_runs_dir(self, team_id: Optional[int]) -> Path:
        return self.runs_dir / self._team_slug(team_id)

    def paths_for_run(self, run_id: Optional[str] = None, team_id: Optional[int] = None) -> RunPaths:
        run_id = run_id or generate_run_id()
        run_dir = self.team_runs_dir(team_id) / run_id
        team_id_str = str(team_id) if team_id is not None else None
        return RunPaths(
            team_id=team_id_str,
            run_id=run_id,
            run_dir=run_dir,
            data_collection=run_dir / "data_collections" / "enhanced_fpl_data.json",
            model_inputs=run_dir / "processed_data" / "model_inputs" / "model_inputs.json",
            analysis=run_dir / "processed_data" / "analysis" / "decision.json",
            report=run_dir / "processed_data" / "reports" / "summary.md",
            injury_fpl=run_dir / "data_collections" / "injury_fpl.json",
            injury_secondary=run_dir / "data_collections" / "injury_secondary.json",
            injury_manual=run_dir / "data_collections" / "injury_manual.json",
            injury_resolved=run_dir / "data_collections" / "injury_resolved.json",
            log=run_dir / "logs" / "run.log",
        )

    def _artifacts_exist(self, run_paths: RunPaths) -> bool:
        """Check all critical artifacts exist before pointing to them."""
        required = [
            run_paths.data_collection,
            run_paths.model_inputs,
            run_paths.analysis,
            run_paths.report,
        ]
        return all(path.exists() for path in required)

    def _validate_json_payload(self, path: Path) -> None:
        """Ensure required top-level fields exist in the JSON artifact."""
        required_fields = {"schema_version", "run_id", "gameweek", "season", "generated_at"}
        with path.open() as f:
            try:
                payload = json.load(f)
            except Exception as exc:
                raise ValueError(f"Invalid JSON in {path}: {exc}") from exc
        missing = [field for field in required_fields if field not in payload]
        if missing:
            raise ValueError(f"Missing required fields {missing} in {path}")

    def update_latest_pointer(self, run_paths: RunPaths) -> None:
        """Write LATEST.json atomically after verifying artifacts exist."""
        if not self._artifacts_exist(run_paths):
            missing = [
                str(p) for p in [
                    run_paths.data_collection,
                    run_paths.model_inputs,
                    run_paths.analysis,
                    run_paths.report,
                ] if not p.exists()
            ]
            raise FileNotFoundError(f"Cannot update LATEST.json; missing artifacts: {missing}")
        for json_path in [run_paths.data_collection, run_paths.model_inputs, run_paths.analysis]:
            self._validate_json_payload(json_path)
        payload = {
            "run_id": run_paths.run_id,
            "team_id": run_paths.team_id,
            "enhanced_collection": str(run_paths.data_collection),
            "model_inputs": str(run_paths.model_inputs),
            "analysis": str(run_paths.analysis),
            "report": str(run_paths.report),
            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        write_json_atomic(self.latest_pointer, payload)

    def update_data_summary(self, run_paths: RunPaths, season: str, gameweek: int) -> None:
        """Append/update DATA_SUMMARY.json with the latest run entry."""
        summary = []
        if self.summary_file.exists():
            try:
                loaded = json.loads(self.summary_file.read_text())
                if isinstance(loaded, list):
                    summary = [row for row in loaded if isinstance(row, dict)]
                else:
                    summary = []
            except Exception:
                summary = []
        entry = {
            "run_id": run_paths.run_id,
            "team_id": run_paths.team_id,
            "season": season,
            "gameweek": gameweek,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "paths": {
                "enhanced_collection": str(run_paths.data_collection),
                "model_inputs": str(run_paths.model_inputs),
                "analysis": str(run_paths.analysis),
                "report": str(run_paths.report),
            },
            "pinned": False,
            "notes": "",
        }
        # Keep unique by run_id; newest wins.
        summary = [row for row in summary if row.get("run_id") != run_paths.run_id]
        summary.append(entry)
        write_json_atomic(self.summary_file, summary)
