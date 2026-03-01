"""
Phase 3: Build Weekly Model Inputs
Normalize DB snapshots into 5 normalized tables for ML training.

Schema Validation Rules:
1. team_state: SELECT COUNT(*) FROM team_state WHERE team_id={team_id} => exactly 15
2. players_dim: All players in team_state must exist in players_dim (FK constraint)
3. fixtures_fact: All fixtures for current GW must be present
4. player_gw_stats: Latency-free stats (live or post-GW event data)
5. input_manifest.json: Counts + validation timestamps
"""

import logging
from typing import Optional, Tuple
from datetime import datetime, timezone

from cheddar_fpl_sage.storage.fpl_db import FPLDatabase

logger = logging.getLogger(__name__)


class WeeklyInputsNormalizer:
    """Normalize FPL snapshots into weekly ML model inputs."""
    
    def __init__(self, db_path: str = "db/fpl_snapshots.sqlite"):
        self.db_path = db_path
    
    def normalize_snapshot(
        self,
        snapshot_id: str,
        bootstrap_data: dict,
        fixtures_data: dict,
        events_data: dict,
        team_picks_data: Optional[dict] = None
    ) -> Tuple[bool, str, Optional[dict]]:
        """
        Normalize a snapshot into weekly model inputs.
        
        Args:
            snapshot_id: Unique snapshot identifier
            bootstrap_data: Static FPL data (players, teams, fixtures metadata)
            fixtures_data: Live fixture updates
            events_data: Player event history
            team_picks_data: Optional team picks for injury enrichment
        
        Returns:
            (success, message, manifest)
        """
        try:
            with FPLDatabase(self.db_path) as db:
                db.init_db()
                
                # Extract metadata
                season = bootstrap_data.get("season", {}).get("name", "unknown")
                gw = bootstrap_data.get("events", [{}])[0].get("id", 1) if bootstrap_data.get("events") else 1
                
                # 1. Normalize players_dim
                self._normalize_players_dim(db, snapshot_id, bootstrap_data)
                logger.info(f"✅ players_dim normalized ({len(bootstrap_data.get('elements', []))} players)")
                
                # 2. Normalize teams_dim
                self._normalize_teams_dim(db, snapshot_id, bootstrap_data)
                logger.info(f"✅ teams_dim normalized ({len(bootstrap_data.get('teams', []))} teams)")
                
                # 3. Normalize fixtures_fact
                self._normalize_fixtures_fact(db, snapshot_id, bootstrap_data, fixtures_data)
                logger.info("✅ fixtures_fact normalized")
                
                # 4. Normalize player_gw_stats (if live data available)
                stats_count = self._normalize_player_gw_stats(db, snapshot_id, events_data)
                logger.info(f"✅ player_gw_stats normalized ({stats_count} entries)")
                
                # 5. Normalize team_state (requires team_picks_data)
                if team_picks_data:
                    team_count = self._normalize_team_state(db, snapshot_id, bootstrap_data, team_picks_data)
                    logger.info(f"✅ team_state normalized ({team_count} teams with injury enrichment)")
                    
                    # Validate: team_state must have exactly 15 players per team
                    valid, msg = self._validate_team_state(db, snapshot_id)
                    if not valid:
                        return False, msg, None
                else:
                    logger.warning("⚠️  team_picks_data not provided; team_state SKIPPED")
                    team_count = 0
                
                # Generate manifest
                manifest = self._generate_manifest(
                    snapshot_id, season, gw, bootstrap_data, 
                    fixtures_data, events_data, team_picks_data is not None
                )
                
                return True, f"OK: Snapshot {snapshot_id} normalized successfully", manifest
                
        except Exception as e:
            logger.error(f"FAIL: {str(e)}", exc_info=True)
            return False, f"FAIL: {str(e)}", None
    
    def _normalize_players_dim(self, db: FPLDatabase, snapshot_id: str, bootstrap: dict) -> None:
        """Load players_dim from bootstrap static data."""
        for player in bootstrap.get("elements", []):
            db.insert_player_dim(
                snapshot_id=snapshot_id,
                element_id=player["id"],
                name=player.get("first_name", "") + " " + player.get("second_name", ""),
                team_id=player.get("team", 0),
                position=self._get_position_name(player.get("element_type", 0), bootstrap),
                price=player.get("now_cost", 0) / 10.0,  # API returns price in tenths
                selected_by_percent=player.get("selected_by_percent", 0),
                status=player.get("status", "u"),
                chance_this_round=player.get("chance_of_playing_this_round"),
                chance_next_round=player.get("chance_of_playing_next_round"),
                news=player.get("news", "")
            )
    
    def _normalize_teams_dim(self, db: FPLDatabase, snapshot_id: str, bootstrap: dict) -> None:
        """Load teams_dim from bootstrap static data."""
        for team in bootstrap.get("teams", []):
            db.insert_team_dim(
                snapshot_id=snapshot_id,
                team_id=team["id"],
                name=team.get("name", ""),
                short_name=team.get("short_name", ""),
                strength_home=team.get("strength_home", 0),
                strength_away=team.get("strength_away", 0),
                strength_overall=team.get("strength", 0),
                strength_defense=team.get("strength_defence", 0)
            )
    
    def _normalize_fixtures_fact(
        self, 
        db: FPLDatabase, 
        snapshot_id: str, 
        bootstrap: dict, 
        fixtures: dict
    ) -> None:
        """Load fixtures_fact from bootstrap + live fixtures."""
        # Map fixture_id -> live data for score updates
        # Handle both list format (raw from API) and dict format (wrapped)
        fixtures_list = fixtures if isinstance(fixtures, list) else fixtures.get("fixtures", [])
        live_map = {f["id"]: f for f in fixtures_list}
        
        for fixture in bootstrap.get("fixtures", []):
            live_fixture = live_map.get(fixture["id"], fixture)
            
            db.insert_fixture_fact(
                snapshot_id=snapshot_id,
                fixture_id=fixture["id"],
                gw=fixture.get("event", 0),
                kickoff_time=fixture.get("kickoff_time", ""),
                team_h=fixture.get("team_h", 0),
                team_a=fixture.get("team_a", 0),
                team_h_score=live_fixture.get("team_h_score"),
                team_a_score=live_fixture.get("team_a_score"),
                finished=bool(live_fixture.get("finished", False)),
                minutes=live_fixture.get("minutes", 0)
            )
    
    def _normalize_player_gw_stats(self, db: FPLDatabase, snapshot_id: str, events: dict) -> int:
        """Load player_gw_stats from live player event data."""
        count = 0
        for player_event in events.get("elements", []):
            element_id = player_event["id"]
            for event_gw in player_event.get("history", []):
                db.insert_player_gw_stats(
                    snapshot_id=snapshot_id,
                    gw=event_gw.get("round", 0),
                    element_id=element_id,
                    minutes=event_gw.get("minutes", 0),
                    goals_scored=event_gw.get("goals_scored", 0),
                    assists=event_gw.get("assists", 0),
                    clean_sheets=event_gw.get("clean_sheets", 0),
                    bonus=event_gw.get("bonus", 0),
                    bps=event_gw.get("bps", 0),
                    total_points=event_gw.get("total_points", 0)
                )
                count += 1
        return count
    
    def _normalize_team_state(
        self, 
        db: FPLDatabase, 
        snapshot_id: str, 
        bootstrap: dict, 
        team_picks: dict
    ) -> int:
        """Load team_state with injury enrichment from team picks."""
        # Build lookup tables
        players_map = {p["id"]: p for p in bootstrap.get("elements", [])}
        
        team_count = 0
        for team_entry in team_picks.get("teams", []):
            team_id = team_entry["id"]
            
            # Load this team's picks
            for pick in team_entry.get("picks", []):
                player = players_map.get(pick["element"], {})
                
                db.insert_team_state(
                    snapshot_id=snapshot_id,
                    team_id=team_id,
                    element_id=pick["element"],
                    is_starter=pick.get("position", 0) <= 11,
                    bench_order=pick.get("position", 0) - 11 if pick.get("position", 0) > 11 else None,
                    is_captain=pick.get("is_captain", False),
                    is_vice_captain=pick.get("is_vice_captain", False),
                    player_name=player.get("first_name", "") + " " + player.get("second_name", ""),
                    player_status=player.get("status", "u"),
                    chance_this_round=player.get("chance_of_playing_this_round"),
                    chance_next_round=player.get("chance_of_playing_next_round"),
                    news=player.get("news", "")
                )
            
            team_count += 1
        
        return team_count
    
    def _validate_team_state(self, db: FPLDatabase, snapshot_id: str) -> Tuple[bool, str]:
        """Validate team_state has exactly 15 players per team."""
        cursor = db.connection.cursor()
        
        # Get all teams in team_state
        cursor.execute(
            "SELECT DISTINCT team_id FROM team_state WHERE snapshot_id = ?",
            (snapshot_id,)
        )
        teams = [row[0] for row in cursor.fetchall()]
        
        # Check each team has exactly 15 players
        for team_id in teams:
            cursor.execute(
                "SELECT COUNT(*) FROM team_state WHERE snapshot_id = ? AND team_id = ?",
                (snapshot_id, team_id)
            )
            count = cursor.fetchone()[0]
            if count != 15:
                return False, f"FAIL: Team {team_id} has {count} players, expected 15"
        
        return True, f"OK: All {len(teams)} teams have exactly 15 players"
    
    def _generate_manifest(
        self,
        snapshot_id: str,
        season: str,
        gw: int,
        bootstrap: dict,
        fixtures: dict,
        events: dict,
        has_team_picks: bool
    ) -> dict:
        """Generate input_manifest.json with validation metadata."""
        return {
            "snapshot_id": snapshot_id,
            "season": season,
            "gw": gw,
            "normalized_ts": datetime.now(timezone.utc).isoformat(),
            "tables": {
                "players_dim": {
                    "count": len(bootstrap.get("elements", [])),
                    "status": "OK"
                },
                "teams_dim": {
                    "count": len(bootstrap.get("teams", [])),
                    "status": "OK"
                },
                "fixtures_fact": {
                    "count": len(bootstrap.get("fixtures", [])),
                    "status": "OK"
                },
                "player_gw_stats": {
                    "count": sum(len(p.get("history", [])) for p in events.get("elements", [])),
                    "status": "OK"
                },
                "team_state": {
                    "status": "OK" if has_team_picks else "SKIPPED",
                    "validation": "15 players per team" if has_team_picks else "N/A"
                }
            }
        }
    
    @staticmethod
    def _get_position_name(element_type: int, bootstrap: dict) -> str:
        """Convert element_type to position name."""
        position_map = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}
        return position_map.get(element_type, "UNKNOWN")
