#!/usr/bin/env python3
"""
Phase 1: Storage Layer (DB-first)
Persists weekly FPL data snapshots to SQLite for reproducible analysis.

SQLite schema:
- snapshots(snapshot_id, season, gw, ts, manifest_json, validation_status)
- bootstrap_raw(snapshot_id, json_path, sha256, status)
- fixtures_raw(snapshot_id, json_path, sha256, status)
- events_raw(snapshot_id, json_path, sha256, status)
- team_picks_raw(snapshot_id, json_path, sha256, status)

A snapshot is VALID only if all required sources have status=OK and hashes match.
"""

import sqlite3
import hashlib
import json
import logging
from pathlib import Path
from typing import Dict, Optional, Tuple
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


class FPLDatabase:
    """Manage FPL weekly snapshot storage and validation."""
    
    def __init__(self, db_path: str = "db/fpl_snapshots.sqlite"):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = None
    
    def __enter__(self):
        self.connection = sqlite3.connect(self.db_path)
        self.connection.row_factory = sqlite3.Row
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.connection:
            self.connection.close()
    
    def init_db(self) -> None:
        """Initialize database schema if not exists."""
        cursor = self.connection.cursor()
        
        # Main snapshots table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS snapshots (
                snapshot_id TEXT PRIMARY KEY,
                season TEXT NOT NULL,
                gw INTEGER NOT NULL,
                snapshot_ts TEXT NOT NULL,
                manifest_json TEXT NOT NULL,
                validation_status TEXT DEFAULT 'PENDING',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # Raw artifact tracking tables
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS bootstrap_raw (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_id TEXT NOT NULL,
                json_path TEXT,
                sha256 TEXT,
                status TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id),
                UNIQUE(snapshot_id)
            )
        """)
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS fixtures_raw (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_id TEXT NOT NULL,
                json_path TEXT,
                sha256 TEXT,
                status TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id),
                UNIQUE(snapshot_id)
            )
        """)
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS events_raw (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_id TEXT NOT NULL,
                json_path TEXT,
                sha256 TEXT,
                status TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id),
                UNIQUE(snapshot_id)
            )
        """)
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS team_picks_raw (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_id TEXT NOT NULL,
                json_path TEXT,
                sha256 TEXT,
                status TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id),
                UNIQUE(snapshot_id)
            )
        """)
        
        # Phase 3: Normalization tables
        self._init_normalization_tables()
        
        self.connection.commit()
        logger.info(f"Database initialized: {self.db_path}")
    
    @staticmethod
    def compute_sha256(file_path: Path) -> str:
        """Compute SHA256 hash of a file."""
        sha256_hash = hashlib.sha256()
        with open(file_path, 'rb') as f:
            for byte_block in iter(lambda: f.read(4096), b""):
                sha256_hash.update(byte_block)
        return sha256_hash.hexdigest()
    
    def upsert_bootstrap(self, snapshot_id: str, json_path: Path, status: str) -> str:
        """
        Record bootstrap_static artifact.
        
        Args:
            snapshot_id: Unique snapshot identifier (run_id)
            json_path: Path to bootstrap_static.json
            status: "OK" | "FAILED" | "UNAVAILABLE_404"
        
        Returns:
            SHA256 hash of the file (if status=OK), or None
        """
        sha256 = self.compute_sha256(json_path) if status == "OK" else None
        
        cursor = self.connection.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO bootstrap_raw (snapshot_id, json_path, sha256, status)
            VALUES (?, ?, ?, ?)
        """, (snapshot_id, str(json_path), sha256, status))
        self.connection.commit()
        
        logger.info(f"Recorded bootstrap for {snapshot_id}: {status}")
        return sha256
    
    def upsert_fixtures(self, snapshot_id: str, json_path: Path, status: str) -> str:
        """Record fixtures artifact."""
        sha256 = self.compute_sha256(json_path) if status == "OK" else None
        
        cursor = self.connection.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO fixtures_raw (snapshot_id, json_path, sha256, status)
            VALUES (?, ?, ?, ?)
        """, (snapshot_id, str(json_path), sha256, status))
        self.connection.commit()
        
        logger.info(f"Recorded fixtures for {snapshot_id}: {status}")
        return sha256
    
    def upsert_events(self, snapshot_id: str, json_path: Path, status: str) -> str:
        """Record events artifact."""
        sha256 = self.compute_sha256(json_path) if status == "OK" else None
        
        cursor = self.connection.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO events_raw (snapshot_id, json_path, sha256, status)
            VALUES (?, ?, ?, ?)
        """, (snapshot_id, str(json_path), sha256, status))
        self.connection.commit()
        
        logger.info(f"Recorded events for {snapshot_id}: {status}")
        return sha256
    
    def upsert_team_picks(self, snapshot_id: str, json_path: Optional[Path], status: str) -> Optional[str]:
        """Record team_picks artifact (optional)."""
        sha256 = self.compute_sha256(json_path) if status == "OK" and json_path else None
        
        cursor = self.connection.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO team_picks_raw (snapshot_id, json_path, sha256, status)
            VALUES (?, ?, ?, ?)
        """, (snapshot_id, str(json_path) if json_path else None, sha256, status))
        self.connection.commit()
        
        logger.info(f"Recorded team_picks for {snapshot_id}: {status}")
        return sha256
    
    def write_manifest(
        self,
        snapshot_id: str,
        season: str,
        gw: int,
        manifest: Dict
    ) -> None:
        """
        Write snapshot manifest to DB.
        
        Args:
            snapshot_id: Unique snapshot identifier
            season: Season (e.g., "2025-26")
            gw: Gameweek number
            manifest: Full manifest dict with all source statuses and hashes
        """
        cursor = self.connection.cursor()
        
        snapshot_ts = manifest.get("snapshot_ts", datetime.now(timezone.utc).isoformat())
        manifest_json = json.dumps(manifest)
        
        cursor.execute("""
            INSERT OR REPLACE INTO snapshots (snapshot_id, season, gw, snapshot_ts, manifest_json)
            VALUES (?, ?, ?, ?, ?)
        """, (snapshot_id, season, gw, snapshot_ts, manifest_json))
        self.connection.commit()
        
        logger.info(f"Wrote manifest for snapshot {snapshot_id} (S{season} GW{gw})")
    
    def validate_snapshot(self, snapshot_id: str) -> Tuple[bool, str]:
        """
        Validate a snapshot's integrity.
        
        Returns:
            (is_valid: bool, status_message: str)
        
        Rules:
        - All required sources must be recorded
        - All OK sources must have valid hashes
        - At least bootstrap, fixtures, events must be OK
        - team_picks can be UNAVAILABLE_404 (optional)
        """
        cursor = self.connection.cursor()
        
        # Get snapshot
        cursor.execute("SELECT * FROM snapshots WHERE snapshot_id = ?", (snapshot_id,))
        snapshot_row = cursor.fetchone()
        if not snapshot_row:
            return False, f"FAIL: Snapshot {snapshot_id} not found"
        
        # Get all sources
        cursor.execute("SELECT * FROM bootstrap_raw WHERE snapshot_id = ?", (snapshot_id,))
        bootstrap = cursor.fetchone()
        
        cursor.execute("SELECT * FROM fixtures_raw WHERE snapshot_id = ?", (snapshot_id,))
        fixtures = cursor.fetchone()
        
        cursor.execute("SELECT * FROM events_raw WHERE snapshot_id = ?", (snapshot_id,))
        events = cursor.fetchone()
        
        cursor.execute("SELECT * FROM team_picks_raw WHERE snapshot_id = ?", (snapshot_id,))
        team_picks = cursor.fetchone()
        
        # Validate required sources
        if not bootstrap:
            return False, f"FAIL: bootstrap_raw missing for {snapshot_id}"
        if bootstrap["status"] != "OK":
            return False, f"FAIL: bootstrap_raw status={bootstrap['status']} (expected OK)"
        
        if not fixtures:
            return False, f"FAIL: fixtures_raw missing for {snapshot_id}"
        if fixtures["status"] != "OK":
            return False, f"FAIL: fixtures_raw status={fixtures['status']} (expected OK)"
        
        if not events:
            return False, f"FAIL: events_raw missing for {snapshot_id}"
        if events["status"] != "OK":
            return False, f"FAIL: events_raw status={events['status']} (expected OK)"
        
        # team_picks can be missing or UNAVAILABLE_404
        # If present and OK, verify hash
        
        # Verify hashes by re-computing
        try:
            bootstrap_path = Path(bootstrap["json_path"])
            bootstrap_hash = self.compute_sha256(bootstrap_path)
            if bootstrap_hash != bootstrap["sha256"]:
                return False, f"FAIL: bootstrap_raw hash mismatch (stored={bootstrap['sha256']}, computed={bootstrap_hash})"
            
            fixtures_path = Path(fixtures["json_path"])
            fixtures_hash = self.compute_sha256(fixtures_path)
            if fixtures_hash != fixtures["sha256"]:
                return False, "FAIL: fixtures_raw hash mismatch"
            
            events_path = Path(events["json_path"])
            events_hash = self.compute_sha256(events_path)
            if events_hash != events["sha256"]:
                return False, "FAIL: events_raw hash mismatch"
            
            if team_picks and team_picks["status"] == "OK":
                picks_path = Path(team_picks["json_path"])
                picks_hash = self.compute_sha256(picks_path)
                if picks_hash != team_picks["sha256"]:
                    return False, "FAIL: team_picks_raw hash mismatch"
        
        except FileNotFoundError as e:
            return False, f"FAIL: File not found during hash verification: {e}"
        
        # All checks passed
        return True, f"OK: Snapshot {snapshot_id} is valid"
    
    def get_snapshot_manifest(self, snapshot_id: str) -> Optional[Dict]:
        """Retrieve manifest for a snapshot."""
        cursor = self.connection.cursor()
        cursor.execute("SELECT manifest_json FROM snapshots WHERE snapshot_id = ?", (snapshot_id,))
        row = cursor.fetchone()
        if row:
            return json.loads(row["manifest_json"])
        return None
    
    def list_snapshots(self, season: Optional[str] = None) -> list:
        """List all snapshots, optionally filtered by season."""
        cursor = self.connection.cursor()
        if season:
            cursor.execute("SELECT * FROM snapshots WHERE season = ? ORDER BY gw DESC", (season,))
        else:
            cursor.execute("SELECT * FROM snapshots ORDER BY season DESC, gw DESC")
        return [dict(row) for row in cursor.fetchall()]

    # ==================== Phase 3: Normalization Tables ====================

    def _init_normalization_tables(self) -> None:
        """Initialize Phase 3 normalization tables."""
        cursor = self.connection.cursor()
        
        # players_dim: player master data with injury info
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS players_dim (
                snapshot_id TEXT NOT NULL,
                element_id INTEGER NOT NULL,
                name TEXT,
                team_id INTEGER,
                position TEXT,
                price REAL,
                selected_by_percent REAL,
                status TEXT,
                chance_this_round REAL,
                chance_next_round REAL,
                news TEXT,
                PRIMARY KEY (snapshot_id, element_id),
                FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id)
            )
        """)
        
        # teams_dim: team master data
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS teams_dim (
                snapshot_id TEXT NOT NULL,
                team_id INTEGER NOT NULL,
                name TEXT,
                short_name TEXT,
                strength_home REAL,
                strength_away REAL,
                strength_overall REAL,
                strength_defense REAL,
                PRIMARY KEY (snapshot_id, team_id),
                FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id)
            )
        """)
        
        # fixtures_fact: fixture data
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS fixtures_fact (
                snapshot_id TEXT NOT NULL,
                fixture_id INTEGER NOT NULL,
                gw INTEGER,
                kickoff_time TEXT,
                team_h INTEGER,
                team_a INTEGER,
                team_h_score INTEGER,
                team_a_score INTEGER,
                finished BOOLEAN,
                minutes INTEGER,
                PRIMARY KEY (snapshot_id, fixture_id),
                FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id)
            )
        """)
        
        # team_state: team picks with injury enrichment (15 players per team)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS team_state (
                snapshot_id TEXT NOT NULL,
                team_id INTEGER NOT NULL,
                element_id INTEGER NOT NULL,
                is_starter BOOLEAN,
                bench_order INTEGER,
                is_captain BOOLEAN,
                is_vice_captain BOOLEAN,
                player_name TEXT,
                player_status TEXT,
                chance_this_round REAL,
                chance_next_round REAL,
                news TEXT,
                PRIMARY KEY (snapshot_id, team_id, element_id),
                FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id),
                FOREIGN KEY (snapshot_id, element_id) REFERENCES players_dim(snapshot_id, element_id)
            )
        """)
        
        # player_gw_stats: per-player stats for each GW (from event/live)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS player_gw_stats (
                snapshot_id TEXT NOT NULL,
                gw INTEGER NOT NULL,
                element_id INTEGER NOT NULL,
                minutes INTEGER,
                goals_scored INTEGER,
                assists INTEGER,
                clean_sheets INTEGER,
                bonus INTEGER,
                bps INTEGER,
                total_points INTEGER,
                PRIMARY KEY (snapshot_id, gw, element_id),
                FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id)
            )
        """)
        
        self.connection.commit()

    def insert_player_dim(
        self,
        snapshot_id: str,
        element_id: int,
        name: str,
        team_id: int,
        position: str,
        price: float,
        selected_by_percent: float,
        status: str,
        chance_this_round: Optional[float],
        chance_next_round: Optional[float],
        news: str
    ) -> None:
        """Insert player into players_dim."""
        cursor = self.connection.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO players_dim
            (snapshot_id, element_id, name, team_id, position, price, selected_by_percent, 
             status, chance_this_round, chance_next_round, news)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (snapshot_id, element_id, name, team_id, position, price, selected_by_percent,
              status, chance_this_round, chance_next_round, news))
        self.connection.commit()

    def insert_team_dim(
        self,
        snapshot_id: str,
        team_id: int,
        name: str,
        short_name: str,
        strength_home: float,
        strength_away: float,
        strength_overall: float,
        strength_defense: Optional[float]
    ) -> None:
        """Insert team into teams_dim."""
        cursor = self.connection.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO teams_dim
            (snapshot_id, team_id, name, short_name, strength_home, strength_away, 
             strength_overall, strength_defense)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (snapshot_id, team_id, name, short_name, strength_home, strength_away,
              strength_overall, strength_defense))
        self.connection.commit()

    def insert_fixture_fact(
        self,
        snapshot_id: str,
        fixture_id: int,
        gw: int,
        kickoff_time: str,
        team_h: int,
        team_a: int,
        team_h_score: Optional[int],
        team_a_score: Optional[int],
        finished: bool,
        minutes: int
    ) -> None:
        """Insert fixture into fixtures_fact."""
        cursor = self.connection.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO fixtures_fact
            (snapshot_id, fixture_id, gw, kickoff_time, team_h, team_a, team_h_score,
             team_a_score, finished, minutes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (snapshot_id, fixture_id, gw, kickoff_time, team_h, team_a, team_h_score,
              team_a_score, finished, minutes))
        self.connection.commit()

    def insert_team_state(
        self,
        snapshot_id: str,
        team_id: int,
        element_id: int,
        is_starter: bool,
        bench_order: Optional[int],
        is_captain: bool,
        is_vice_captain: bool,
        player_name: str,
        player_status: str,
        chance_this_round: Optional[float],
        chance_next_round: Optional[float],
        news: str
    ) -> None:
        """Insert player into team_state (with injury enrichment)."""
        cursor = self.connection.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO team_state
            (snapshot_id, team_id, element_id, is_starter, bench_order, is_captain,
             is_vice_captain, player_name, player_status, chance_this_round, 
             chance_next_round, news)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (snapshot_id, team_id, element_id, is_starter, bench_order, is_captain,
              is_vice_captain, player_name, player_status, chance_this_round,
              chance_next_round, news))
        self.connection.commit()

    def insert_player_gw_stats(
        self,
        snapshot_id: str,
        gw: int,
        element_id: int,
        minutes: int,
        goals_scored: int,
        assists: int,
        clean_sheets: int,
        bonus: int,
        bps: int,
        total_points: int
    ) -> None:
        """Insert player GW stats into player_gw_stats."""
        cursor = self.connection.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO player_gw_stats
            (snapshot_id, gw, element_id, minutes, goals_scored, assists, clean_sheets,
             bonus, bps, total_points)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (snapshot_id, gw, element_id, minutes, goals_scored, assists, clean_sheets,
              bonus, bps, total_points))
        self.connection.commit()


def main():
    """Test the storage layer."""
    import tempfile
    
    # Create temp DB for testing
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.sqlite"
        
        with FPLDatabase(str(db_path)) as db:
            db.init_db()
            print("✅ Database initialized")
            
            # Test write
            snapshot_id = "test_run_20260102"
            manifest = {
                "season": "2025-26",
                "gw": 20,
                "snapshot_ts": datetime.now(timezone.utc).isoformat(),
                "sources": {
                    "bootstrap_static": {"status": "OK", "hash": "abc123"},
                    "fixtures": {"status": "OK", "hash": "def456"},
                    "events": {"status": "OK", "hash": "ghi789"},
                    "team_picks": {"status": "UNAVAILABLE_404", "hash": None}
                }
            }
            
            db.write_manifest(snapshot_id, "2025-26", 20, manifest)
            print("✅ Manifest written")
            
            # Retrieve and verify
            retrieved = db.get_snapshot_manifest(snapshot_id)
            assert retrieved is not None
            assert retrieved["season"] == "2025-26"
            print("✅ Manifest retrieved successfully")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
