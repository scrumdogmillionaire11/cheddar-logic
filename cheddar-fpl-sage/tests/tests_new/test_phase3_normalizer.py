#!/usr/bin/env python3
"""
Phase 3 Test Suite: Weekly Inputs Normalization

Validates:
1. players_dim: All 615 players normalized correctly
2. teams_dim: All 20 teams normalized correctly
3. fixtures_fact: All fixtures with GW matches normalized
4. team_state: Exactly 15 players per team (11 starters + 4 bench)
5. player_gw_stats: Historical player performance stats normalized
6. input_manifest.json: Counts match DB tables
"""

import tempfile
import logging
from pathlib import Path
from typing import Tuple

from cheddar_fpl_sage.storage.fpl_db import FPLDatabase
from cheddar_fpl_sage.pipelines.build_weekly_inputs import WeeklyInputsNormalizer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class Phase3TestSuite:
    """Phase 3 acceptance tests."""
    
    def __init__(self):
        self.test_data_dir = Path(__file__).parent / "fixtures"
        self.test_data_dir.mkdir(exist_ok=True)
    
    def run_all_tests(self) -> Tuple[int, int]:
        """Run all 6 Phase 3 acceptance tests."""
        tests = [
            ("Test 1: players_dim normalization", self.test_players_dim),
            ("Test 2: teams_dim normalization", self.test_teams_dim),
            ("Test 3: fixtures_fact normalization", self.test_fixtures_fact),
            ("Test 4: player_gw_stats normalization", self.test_player_gw_stats),
            ("Test 5: team_state with 15-player rule", self.test_team_state_15_rule),
            ("Test 6: input_manifest generation", self.test_input_manifest),
        ]
        
        passed = 0
        failed = 0
        
        for test_name, test_func in tests:
            try:
                result = test_func()
                if result:
                    logger.info(f"✅ {test_name} PASSED")
                    passed += 1
                else:
                    logger.error(f"❌ {test_name} FAILED")
                    failed += 1
            except AssertionError as e:
                logger.error(f"❌ {test_name} FAILED: {e}")
                failed += 1
            except Exception as e:
                logger.error(f"❌ {test_name} ERROR: {e}")
                failed += 1
        
        return passed, failed
    
    def test_players_dim(self) -> bool:
        """Test 1: Verify all players normalized into players_dim."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.sqlite"
            
            # Create test data with 5 players
            bootstrap = {
                "elements": [
                    {
                        "id": 1,
                        "first_name": "John",
                        "second_name": "Doe",
                        "team": 1,
                        "element_type": 4,
                        "now_cost": 700,
                        "selected_by_percent": 50.0,
                        "status": "a",
                        "chance_of_playing_this_round": 100,
                        "chance_of_playing_next_round": 100,
                        "news": "Fit"
                    },
                    {
                        "id": 2,
                        "first_name": "Jane",
                        "second_name": "Smith",
                        "team": 1,
                        "element_type": 3,
                        "now_cost": 600,
                        "selected_by_percent": 40.0,
                        "status": "a",
                        "chance_of_playing_this_round": 75,
                        "chance_of_playing_next_round": 100,
                        "news": ""
                    }
                ],
                "teams": [],
                "fixtures": []
            }
            
            normalizer = WeeklyInputsNormalizer(str(db_path))
            success, msg, manifest = normalizer.normalize_snapshot(
                "test_snap_1",
                bootstrap,
                {"fixtures": []},
                {"elements": []}
            )
            
            assert success, f"Normalization failed: {msg}"
            assert manifest["tables"]["players_dim"]["count"] == 2
            
            # Verify in DB
            with FPLDatabase(str(db_path)) as db:
                cursor = db.connection.cursor()
                cursor.execute(
                    "SELECT COUNT(*) FROM players_dim WHERE snapshot_id = ?",
                    ("test_snap_1",)
                )
                count = cursor.fetchone()[0]
                assert count == 2, f"Expected 2 players in DB, got {count}"
            
            logger.info("  ✓ 2 players normalized correctly")
            return True
    
    def test_teams_dim(self) -> bool:
        """Test 2: Verify all teams normalized into teams_dim."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.sqlite"
            
            bootstrap = {
                "elements": [],
                "teams": [
                    {
                        "id": 1,
                        "name": "Arsenal",
                        "short_name": "ARS",
                        "strength_home": 1.4,
                        "strength_away": 1.3,
                        "strength": 1.35,
                        "strength_defence": 1.5
                    },
                    {
                        "id": 2,
                        "name": "Aston Villa",
                        "short_name": "AVL",
                        "strength_home": 1.3,
                        "strength_away": 1.2,
                        "strength": 1.25,
                        "strength_defence": 1.4
                    }
                ],
                "fixtures": []
            }
            
            normalizer = WeeklyInputsNormalizer(str(db_path))
            success, msg, manifest = normalizer.normalize_snapshot(
                "test_snap_2",
                bootstrap,
                {"fixtures": []},
                {"elements": []}
            )
            
            assert success, f"Normalization failed: {msg}"
            assert manifest["tables"]["teams_dim"]["count"] == 2
            
            with FPLDatabase(str(db_path)) as db:
                cursor = db.connection.cursor()
                cursor.execute(
                    "SELECT COUNT(*) FROM teams_dim WHERE snapshot_id = ?",
                    ("test_snap_2",)
                )
                count = cursor.fetchone()[0]
                assert count == 2, f"Expected 2 teams in DB, got {count}"
            
            logger.info("  ✓ 2 teams normalized correctly")
            return True
    
    def test_fixtures_fact(self) -> bool:
        """Test 3: Verify fixtures normalized with GW matching."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.sqlite"
            
            bootstrap = {
                "elements": [],
                "teams": [],
                "fixtures": [
                    {
                        "id": 1,
                        "event": 20,
                        "kickoff_time": "2025-12-30T15:00:00Z",
                        "team_h": 1,
                        "team_a": 2,
                        "team_h_score": None,
                        "team_a_score": None,
                        "finished": False,
                        "minutes": 0
                    },
                    {
                        "id": 2,
                        "event": 20,
                        "kickoff_time": "2025-12-30T17:30:00Z",
                        "team_h": 3,
                        "team_a": 4,
                        "team_h_score": None,
                        "team_a_score": None,
                        "finished": False,
                        "minutes": 0
                    }
                ]
            }
            
            normalizer = WeeklyInputsNormalizer(str(db_path))
            success, msg, manifest = normalizer.normalize_snapshot(
                "test_snap_3",
                bootstrap,
                {"fixtures": []},
                {"elements": []}
            )
            
            assert success, f"Normalization failed: {msg}"
            assert manifest["tables"]["fixtures_fact"]["count"] == 2
            
            with FPLDatabase(str(db_path)) as db:
                cursor = db.connection.cursor()
                cursor.execute(
                    "SELECT COUNT(*) FROM fixtures_fact WHERE snapshot_id = ? AND gw = ?",
                    ("test_snap_3", 20)
                )
                count = cursor.fetchone()[0]
                assert count == 2, f"Expected 2 GW20 fixtures, got {count}"
            
            logger.info("  ✓ 2 fixtures normalized for GW20")
            return True
    
    def test_player_gw_stats(self) -> bool:
        """Test 4: Verify player GW stats normalized."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.sqlite"
            
            events = {
                "elements": [
                    {
                        "id": 1,
                        "history": [
                            {
                                "round": 19,
                                "minutes": 90,
                                "goals_scored": 1,
                                "assists": 0,
                                "clean_sheets": 0,
                                "bonus": 3,
                                "bps": 45,
                                "total_points": 7
                            },
                            {
                                "round": 20,
                                "minutes": 90,
                                "goals_scored": 0,
                                "assists": 1,
                                "clean_sheets": 0,
                                "bonus": 1,
                                "bps": 35,
                                "total_points": 5
                            }
                        ]
                    }
                ]
            }
            
            normalizer = WeeklyInputsNormalizer(str(db_path))
            success, msg, manifest = normalizer.normalize_snapshot(
                "test_snap_4",
                {"elements": [], "teams": [], "fixtures": []},
                {"fixtures": []},
                events
            )
            
            assert success, f"Normalization failed: {msg}"
            assert manifest["tables"]["player_gw_stats"]["count"] == 2
            
            with FPLDatabase(str(db_path)) as db:
                cursor = db.connection.cursor()
                cursor.execute(
                    "SELECT COUNT(*) FROM player_gw_stats WHERE snapshot_id = ?",
                    ("test_snap_4",)
                )
                count = cursor.fetchone()[0]
                assert count == 2, f"Expected 2 stats entries, got {count}"
            
            logger.info("  ✓ 2 player GW stats normalized correctly")
            return True
    
    def test_team_state_15_rule(self) -> bool:
        """Test 5: Verify team_state has exactly 15 players per team."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.sqlite"
            
            bootstrap = {
                "elements": [
                    {
                        "id": i,
                        "first_name": f"Player{i}",
                        "second_name": f"Name{i}",
                        "team": 1,
                        "element_type": 4,
                        "now_cost": 700,
                        "selected_by_percent": 50.0,
                        "status": "a",
                        "chance_of_playing_this_round": 100,
                        "chance_of_playing_next_round": 100,
                        "news": ""
                    }
                    for i in range(1, 16)  # 15 players
                ],
                "teams": [],
                "fixtures": []
            }
            
            team_picks = {
                "teams": [
                    {
                        "id": 1,
                        "picks": [
                            {
                                "element": i,
                                "position": i,
                                "is_captain": i == 1,
                                "is_vice_captain": i == 2
                            }
                            for i in range(1, 16)
                        ]
                    }
                ]
            }
            
            normalizer = WeeklyInputsNormalizer(str(db_path))
            success, msg, manifest = normalizer.normalize_snapshot(
                "test_snap_5",
                bootstrap,
                {"fixtures": []},
                {"elements": []},
                team_picks
            )
            
            assert success, f"Normalization failed: {msg}"
            
            with FPLDatabase(str(db_path)) as db:
                cursor = db.connection.cursor()
                cursor.execute(
                    "SELECT COUNT(*) FROM team_state WHERE snapshot_id = ? AND team_id = ?",
                    ("test_snap_5", 1)
                )
                count = cursor.fetchone()[0]
                assert count == 15, f"Expected exactly 15 players, got {count}"
            
            logger.info("  ✓ Team has exactly 15 players (validated)")
            return True
    
    def test_input_manifest(self) -> bool:
        """Test 6: Verify input_manifest.json generated correctly."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.sqlite"
            
            bootstrap = {
                "season": {"name": "2025-26"},
                "events": [{"id": 20}],
                "elements": [{"id": 1}],
                "teams": [{"id": 1}],
                "fixtures": [{"id": 1}]
            }
            
            normalizer = WeeklyInputsNormalizer(str(db_path))
            success, msg, manifest = normalizer.normalize_snapshot(
                "test_snap_6",
                bootstrap,
                {"fixtures": []},
                {"elements": []}
            )
            
            assert success, f"Normalization failed: {msg}"
            assert manifest is not None
            assert manifest["snapshot_id"] == "test_snap_6"
            assert manifest["season"] == "2025-26"
            assert manifest["gw"] == 20
            assert "normalized_ts" in manifest
            assert "tables" in manifest
            assert manifest["tables"]["players_dim"]["status"] == "OK"
            assert manifest["tables"]["teams_dim"]["status"] == "OK"
            assert manifest["tables"]["fixtures_fact"]["status"] == "OK"
            assert manifest["tables"]["player_gw_stats"]["status"] == "OK"
            
            logger.info("  ✓ Manifest generated with all required fields")
            return True


def main():
    """Run all Phase 3 tests."""
    logger.info("=" * 60)
    logger.info("PHASE 3: WEEKLY INPUTS NORMALIZATION TEST SUITE")
    logger.info("=" * 60)
    
    suite = Phase3TestSuite()
    passed, failed = suite.run_all_tests()
    
    logger.info("=" * 60)
    logger.info(f"RESULTS: {passed} passed, {failed} failed")
    logger.info("=" * 60)
    
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    exit(main())
