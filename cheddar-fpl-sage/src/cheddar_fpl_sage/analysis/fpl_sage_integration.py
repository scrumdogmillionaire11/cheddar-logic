#!/usr/bin/env python3
"""
FPL Sage Enhanced Integration
Combines team data collection with improved decision framework
"""

import asyncio
import json
import logging
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, Optional, List, Any

from cheddar_fpl_sage.collectors.enhanced_fpl_collector import EnhancedFPLCollector
from cheddar_fpl_sage.collectors.weekly_bundle_collector import collect_weekly_bundle, BundlePaths
from cheddar_fpl_sage.analysis.enhanced_decision_framework import EnhancedDecisionFramework, DecisionOutput
from cheddar_fpl_sage.utils import OutputBundleManager, generate_run_id, write_json_atomic, write_text_atomic
from cheddar_fpl_sage.utils.sprint3_5_config_manager import Sprint35ConfigManager
from cheddar_fpl_sage.injury.processing import (
    build_injury_artifact_payload,
    build_manual_injury_reports,
    resolve_injury_payloads,
)
from cheddar_fpl_sage.models.injury_report import InjuryReport
from cheddar_fpl_sage.models.canonical_projections import (
    CanonicalProjectionSet,
    CanonicalPlayerProjection,
)
from cheddar_fpl_sage.validation.data_gate import validate_bundle
from cheddar_fpl_sage.validation.id_integrity import validate_player_identity
from cheddar_fpl_sage.rules.fpl_rules import load_ruleset

# DO NOT call logging.basicConfig here - it's configured in fpl_sage.py entry point
# Multiple basicConfig calls create duplicate handlers causing repeated log messages
logger = logging.getLogger(__name__)


class FPLSageIntegration:
    """Main integration class for enhanced FPL analysis"""
    
    def __init__(self, team_id: Optional[int] = None, config_file: str = "team_config.json"):
        self.team_id = team_id
        self.config_file = config_file
        
        # Sprint 3.5: Use centralized config manager with cache invalidation
        self.config_manager = Sprint35ConfigManager(config_file)
        self.config = self.config_manager.get_config(force_reload=True)
        self._chip_authority_source: Optional[str] = None

        # Override team_id with config if not provided
        if not self.team_id and self.config.get('team_id'):
            self.team_id = self.config['team_id']
        
        # Get risk_posture from config (defaults to BALANCED)
        # Priority: root level risk_posture > analysis_preferences.risk_posture > BALANCED
        risk_posture = (self.config.get('risk_posture') or 
                       self.config.get('analysis_preferences', {}).get('risk_posture') or 
                       self.config_manager.get_risk_posture())
        logger.info(f"FPLSageIntegration initialized with risk_posture={risk_posture}")
        self.decision_framework = EnhancedDecisionFramework(risk_posture=risk_posture)
        
        # Apply config overrides to framework
        if 'analysis_preferences' in self.config:
            prefs = self.config['analysis_preferences']
            if 'risk_scenario_thresholds' in prefs:
                self.decision_framework.risk_thresholds.update(prefs['risk_scenario_thresholds'])
            if 'chip_optimization' in prefs:
                self.decision_framework.chip_optimization_rules.update(prefs['chip_optimization'])
    
    def _load_config(self) -> Dict:
        """Load configuration from file"""
        try:
            with open(self.config_file, 'r') as f:
                raw = json.load(f)
                # If the file itself is a stringified JSON, decode it
                if isinstance(raw, str):
                    try:
                        raw = json.loads(raw)
                    except json.JSONDecodeError:
                        raw = {}
                        
                # Convert to dictionary format (handle Pydantic objects or raw dicts)
                # Pydantic validation ensures consistency but we need dicts for the engine
                try:
                    from cheddar_fpl_sage.analysis.decision_framework import TeamConfig
                    validated_config = TeamConfig(**raw)
                    # Use model_dump() to convert Pydantic models to dicts
                    config_dict = validated_config.model_dump(mode='python')
                    logger.debug("Config validated through Pydantic and converted to dict")
                    return config_dict
                except Exception as e:
                    logger.warning(f"Could not validate config through Pydantic: {e}. Using raw dict.")
                    # Fallback: normalize string fields manually
                    for key in ["manual_chip_status", "chip_policy", "manual_overrides", "manual_injury_overrides"]:
                        raw[key] = self._ensure_dict(raw.get(key), key)
                    return raw
        except FileNotFoundError:
            logger.warning(f"Config file {self.config_file} not found. Using defaults.")
            return {}
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in config file: {e}")
            return {}

    def _ensure_dict(self, value: Any, label: str, default: Optional[Dict] = None) -> Dict:
        """Ensure value is a dict; if stringified JSON, decode and warn."""
        if default is None:
            default = {}
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                if isinstance(parsed, dict):
                    logger.warning(f"{label} provided as string; auto-parsed into dict")
                    return parsed
            except json.JSONDecodeError:
                logger.warning(f"{label} provided as string but could not be parsed; using defaults")
            return default
        return default

    def _apply_api_overrides(self, overrides: Dict) -> None:
        """
        Apply API overrides to config before analysis runs.
        Transforms API format to engine config format.
        
        API overrides format:
        - available_chips: ['wildcard', 'bench_boost', 'triple_captain', 'free_hit']
        - free_transfers: int
        - risk_posture: 'conservative' | 'balanced' | 'aggressive'
        - manual_transfers: [{'player_out': str, 'player_in': str}, ...]
        - injury_overrides: [{'player_name': str, 'status': str, 'chance': int}, ...]
        - thresholds: dict of posture thresholds
        """
        print(f"🔧 _apply_api_overrides called with: {overrides}")
        logger.info(f"Applying API overrides: {list(overrides.keys())}")
        
        # 1. Available chips → manual_chip_status
        if 'available_chips' in overrides:
            chip_map = {
                'wildcard': 'Wildcard',
                'bench_boost': 'Bench Boost',
                'triple_captain': 'Triple Captain',
                'free_hit': 'Free Hit'
            }
            
            # Build chip status dict
            chip_status = {}
            for api_chip in overrides['available_chips']:
                engine_chip = chip_map.get(api_chip.lower().replace('_', ''))
                if engine_chip:
                    chip_status[engine_chip] = {'available': True, 'played_by_entry': 0}
            
            self.config['manual_chip_status'] = chip_status
            logger.info(f"Set manual_chip_status: {list(chip_status.keys())}")
        
        # 2. Free transfers → manual_overrides.free_transfers
        if 'free_transfers' in overrides:
            if not isinstance(self.config.get('manual_overrides'), dict):
                self.config['manual_overrides'] = {}
            self.config['manual_overrides']['free_transfers'] = overrides['free_transfers']
            logger.info(f"Set manual free_transfers: {overrides['free_transfers']}")
        
        # 3. Risk posture → update decision framework AND submodules
        if 'risk_posture' in overrides:
            risk_posture = overrides['risk_posture'].upper()
            logger.info(f"Updating risk_posture from {self.decision_framework.risk_posture} to {risk_posture}")
            self.decision_framework.risk_posture = risk_posture
            # CRITICAL: Update all submodules so they use new risk setting
            self.decision_framework._transfer_advisor.risk_posture = risk_posture
            self.decision_framework._captain_selector.risk_posture = risk_posture
            self.decision_framework._chip_analyzer.risk_posture = risk_posture
            # Also store in config for consistency (both locations)
            self.config['risk_posture'] = risk_posture
            if not isinstance(self.config.get('analysis_preferences'), dict):
                self.config['analysis_preferences'] = {}
            self.config['analysis_preferences']['risk_posture'] = risk_posture
            logger.info(f"✓ Risk posture updated across all analysis modules: {risk_posture}")
        
        # 4. Manual transfers → track for filtering recommendations
        if 'manual_transfers' in overrides and overrides['manual_transfers']:
            if not isinstance(self.config.get('manual_overrides'), dict):
                self.config['manual_overrides'] = {}
            # Store for later filtering (format: list of {player_out, player_in})
            self.config['manual_overrides']['completed_transfers'] = overrides['manual_transfers']
            logger.info(f"Recorded {len(overrides['manual_transfers'])} manual transfers")

        # 5. Injury overrides → manual_injury_overrides
        if 'injury_overrides' in overrides and overrides['injury_overrides']:
            manual_injuries = {}
            for override in overrides['injury_overrides']:
                if hasattr(override, 'dict'):
                    override = override.dict()
                if not isinstance(override, dict):
                    continue
                player_name = override.get('player_name') or override.get('player')
                if not player_name:
                    continue
                entry = {}
                status = override.get('status')
                chance = override.get('chance')
                if status:
                    entry['status_flag'] = status
                if chance is not None:
                    entry['chance_of_playing_next_round'] = chance
                manual_injuries[player_name] = entry
            if manual_injuries:
                self.config['manual_injury_overrides'] = manual_injuries
                logger.info(f"Applied {len(manual_injuries)} manual injury overrides")

        # 6. Threshold overrides → analysis_preferences
        if 'thresholds' in overrides and overrides['thresholds']:
            if not isinstance(self.config.get('analysis_preferences'), dict):
                self.config['analysis_preferences'] = {}
            self.config['analysis_preferences']['thresholds'] = overrides['thresholds']
            logger.info("Stored risk posture thresholds in analysis_preferences")
    
    def _normalize_chip_status_map(self, chip_status: Dict) -> Dict:
        """Ensure each chip entry is a dict; replace bad entries with {}."""
        # Defensive: ensure chip_status is a dict (in case it's stringified)
        if isinstance(chip_status, str):
            try:
                chip_status = json.loads(chip_status)
            except json.JSONDecodeError:
                chip_status = {}
        normalized = {}
        for chip, status in (chip_status or {}).items():
            if isinstance(status, dict):
                normalized[chip] = status
            elif isinstance(status, str):
                try:
                    parsed = json.loads(status)
                    normalized[chip] = parsed if isinstance(parsed, dict) else {}
                except json.JSONDecodeError:
                    normalized[chip] = {}
            else:
                normalized[chip] = {}
        return normalized
    
    def _safe_float(self, value: Any, default: float = 0.0) -> float:
        """Convert value to float with safe fallback for invalid/missing data."""
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    def _build_fixture_lookup(self, fixtures: List[Dict], current_gw: int) -> Dict[int, Dict[str, Any]]:
        """Map each team to its next upcoming fixture (event >= current_gw)."""
        lookup: Dict[int, Dict[str, Any]] = {}
        sorted_fixtures = sorted(
            (fix for fix in fixtures if isinstance(fix, dict)),
            key=lambda fix: ((fix.get("event") or 0), fix.get("id") or 0)
        )
        for fixture in sorted_fixtures:
            event = fixture.get("event")
            if event is None or event < current_gw:
                continue
            for team_key, is_home in (("team_h", True), ("team_a", False)):
                team_id = fixture.get(team_key)
                if team_id is None or team_id in lookup:
                    continue
                difficulty_key = "team_h_difficulty" if is_home else "team_a_difficulty"
                difficulty = fixture.get(difficulty_key) or 3
                lookup[team_id] = {
                    "event": event,
                    "fixture": fixture,
                    "is_home": is_home,
                    "difficulty": difficulty,
                    "opponent": fixture.get("team_a" if is_home else "team_h"),
                }
        return lookup
    
    async def run_full_analysis(self, save_data: bool = True, overrides: Optional[Dict] = None) -> Dict:
        """
        Run complete FPL analysis with enhanced decision framework
        
        Args:
            save_data: Whether to save collected data to disk
            overrides: Manual overrides from API (available_chips, free_transfers, risk_posture, manual_transfers)
        """
        logger.info("Starting enhanced FPL analysis...")
        
        # Apply API overrides to config before analysis
        if overrides:
            self._apply_api_overrides(overrides)

        target_gw = (
            self.config.get("target_gw")
            or self.config.get("target_gameweek")
            or None
        )
        run_id = generate_run_id(target_gw)

        # Step 0: Check for existing data first, then collect if needed
        existing_paths = None
        should_collect_fresh = True
        
        # Try to find existing data from LATEST.json
        try:
            from pathlib import Path
            latest_file = Path("outputs/LATEST.json")
            if latest_file.exists():
                with open(latest_file) as f:
                    latest_data = json.load(f)
                    if latest_data.get("team_id") == str(self.team_id):
                        # Check if existing data is fresh enough
                        existing_run_dir = Path(f"outputs/runs/team_{self.team_id}") / latest_data["run_id"]
                        if existing_run_dir.exists():
                            data_dir = existing_run_dir / "data_collections"
                            existing_paths = BundlePaths(
                                team_id=self.team_id,
                                run_id=latest_data["run_id"],
                                run_dir=existing_run_dir,
                                bootstrap_static=data_dir / "bootstrap_static.json",
                                fixtures=data_dir / "fixtures.json",
                                events=data_dir / "events.json",
                                team_picks=(data_dir / "team_picks.json") if self.team_id else None,
                                slate=data_dir / f"slate_gw{target_gw or 'unknown'}.json",
                                collection_meta=data_dir / "collection_meta.json",
                                entry_info=data_dir / "entry_info.json",
                                injury_fpl=data_dir / "injury_fpl.json",
                                injury_secondary=data_dir / "injury_secondary.json", 
                                injury_manual=data_dir / "injury_manual.json",
                                injury_resolved=data_dir / "injury_resolved.json",
                            )
                            
                            # Test if existing data passes freshness check
                            test_gate = validate_bundle(existing_paths, self.team_id, target_gw or 0, freshness_max_minutes=4320)
                            if test_gate.status == "PASS":
                                should_collect_fresh = False
                                bundle_paths = existing_paths
                                print("🔄 Using existing fresh data...")
        except (FileNotFoundError, json.JSONDecodeError, KeyError, TypeError) as exc:
            logger.debug(f"Could not load existing data: {exc}")
        
        # Collect fresh data if needed
        if should_collect_fresh:
            print("📡 Collecting fresh FPL data...")
            bundle_paths = await collect_weekly_bundle(self.team_id, target_gw, force_refresh=True, run_id=run_id)
        # Use collected meta for derived target_gw
        try:
            with open(bundle_paths.collection_meta) as f:
                meta_loaded = json.load(f)
                target_gw = target_gw or meta_loaded.get("target_gw")
                season = meta_loaded.get("season")
                
                # CRITICAL A2: Never allow season = unknown
                if not season or season.lower() == "unknown":
                    error_msg = (
                        "\n" + "-" * 60 + "\n"
                        "DATA_GAP: SEASON_MISSING\n"
                        "\n"
                        "We couldn't detect the FPL season from the data.\n"
                        "\n"
                        "Why this matters:\n"
                        "  The season determines chip windows, deadlines, and rules.\n"
                        "  Without it, we can't make reliable recommendations.\n"
                        "\n"
                        "How to fix:\n"
                        "  Run: python fpl_sage.py --season 2025-26\n"
                        "  Or add \"season\": \"2025-26\" to team_config.json\n"
                        "\n" + "-" * 60
                    )
                    logger.error(error_msg)
                    raise ValueError("Season resolution failed - cannot proceed without valid season")
                
                logger.info(f"✓ Season resolved: {season}")
        except ValueError:
            # Re-raise season validation errors
            raise
        except (FileNotFoundError, json.JSONDecodeError, KeyError) as exc:
            logger.debug(f"Could not load collection meta: {exc}")
            meta_loaded = {}
            # CRITICAL A2: Do not silently default - fail explicitly
            error_msg = (
                "\n" + "="*60 + "\n"
                "DATA_GAP: SEASON_MISSING\n"
                "Failed to load metadata and determine season.\n"
                "\n"
                "How to fix:\n"
                "  Run: python fpl_sage.py --season 2025-26\n"
                "  Or add \"season\": \"2025-26\" to team_config.json\n"
                "\n"
                "="*60
            )
            logger.error(error_msg)
            raise ValueError(f"Season resolution failed: {exc}")

        # Load ruleset (season-aware)
        try:
            ruleset = load_ruleset(season or "2025-26")
        except (FileNotFoundError, json.JSONDecodeError, KeyError, ValueError) as exc:
            logger.warning(f"Ruleset load failed ({exc}); using default rules")
            ruleset = None

        # Data freshness check: reject data older than 3 days (4320 minutes)
        gate_result = validate_bundle(bundle_paths, self.team_id, target_gw or 0, freshness_max_minutes=4320)
        if gate_result.status == "HOLD":
            # Special handling for stale data with automatic refresh
            if gate_result.block_reason == "STALE_COLLECTION":
                print("\n" + "=" * 60)
                print("⚠️ STALE DATA DETECTED - FETCHING FRESH PRICES")
                print("=" * 60)
                print("🕒 Cached data is too old - player prices may have changed")
                if gate_result.missing:
                    print(f"📅 Details: {gate_result.missing[0]}")
                print("")
                print("🔄 Automatically fetching fresh FPL data...")
                print("   This may take 30-60 seconds...")
                print("=" * 60)
                
                # Force fresh data collection
                try:
                    bundle_paths = await collect_weekly_bundle(self.team_id, target_gw, force_refresh=True, run_id=run_id)
                    print("✅ Fresh data collected successfully!")
                    print("🔄 Restarting analysis with updated prices...\n")
                    
                    # Reload metadata with fresh data
                    try:
                        with open(bundle_paths.collection_meta) as f:
                            meta_loaded = json.load(f)
                            target_gw = target_gw or meta_loaded.get("target_gw")
                            season = meta_loaded.get("season", "unknown")
                    except (FileNotFoundError, json.JSONDecodeError, KeyError) as exc:
                        logger.debug(f"Could not load fresh collection meta: {exc}")
                        meta_loaded = {}
                        season = "unknown"
                    
                    # Revalidate with fresh data
                    gate_result = validate_bundle(bundle_paths, self.team_id, target_gw or 0, freshness_max_minutes=4320)
                    if gate_result.status == "HOLD":
                        print("❌ Fresh data collection failed - still have stale data")
                        print("💡 Try running: python scripts/data_pipeline_cli.py --team-id YOUR_TEAM_ID")
                        import sys
                        sys.exit(1)
                        
                except (OSError, IOError, json.JSONDecodeError, ValueError, KeyError, asyncio.TimeoutError) as exc:
                    print(f"❌ Failed to collect fresh data: {exc}")
                    print("")
                    print("💡 Manual solutions:")
                    print("   1. Run data collection manually:")
                    print("      python scripts/data_pipeline_cli.py --team-id YOUR_TEAM_ID")
                    print("   2. Or delete cached data to force fresh collection:")
                    print("      rm -rf outputs/LATEST.json")
                    print("")
                    print("⛔ Exiting to prevent inaccurate analysis...")
                    print("=" * 60 + "\n")
                    import sys
                    sys.exit(1)
            
            reasoning = f"Blocked by data gate: {gate_result.block_reason}"
            if gate_result.missing:
                reasoning += f" | Missing: {', '.join(gate_result.missing)}"
            decision = DecisionOutput(
                primary_decision="HOLD",
                reasoning=reasoning,
                risk_scenarios=[],
                decision_status="HOLD",
                block_reason=gate_result.block_reason,
                risk_posture=self.decision_framework.risk_posture,
            )
            summary_lines = [
                "# Analysis blocked",
                "",
                f"## Decision: HOLD — {gate_result.block_reason}",
                "",
                f"**Reason:** {reasoning}",
                f"**Missing inputs:** {', '.join(gate_result.missing or [])}" if gate_result.missing else "",
                "",
                "No modeling run executed because required bundle inputs were missing or stale.",
            ]
            summary = "\n".join([line for line in summary_lines if line is not None])
            analysis_output = {
                "decision": decision,
                "formatted_summary": summary,
                "analysis_timestamp": datetime.now(timezone.utc).isoformat(),
            }
            raw_data = {
                "schema_version": "1.0.0",
                "season": season,
                "current_gameweek": target_gw or 0,
                "source": {"type": "data_gate", "block_reason": gate_result.block_reason},
                "ruleset": ruleset.__dict__ if ruleset else None,
            }
            if save_data:
                await self._save_analysis_data(raw_data, analysis_output, run_id=run_id, bundle_paths=bundle_paths)
            return {
                "raw_data": raw_data,
                "analysis": analysis_output,
                "config_used": self.config,
            }
        
        # Step 1: Load bundle data (bootstrap, fixtures, events, picks, slate)
        try:
            with open(bundle_paths.bootstrap_static) as f:
                bootstrap_loaded = json.load(f)
                # Handle both wrapped and unwrapped formats
                bootstrap = bootstrap_loaded.get("data", bootstrap_loaded) if isinstance(bootstrap_loaded, dict) and "data" in bootstrap_loaded and isinstance(bootstrap_loaded.get("data"), dict) else bootstrap_loaded
            
            with open(bundle_paths.fixtures) as f:
                fixtures_loaded = json.load(f)
                # Extract fixtures data if wrapped
                fixtures = fixtures_loaded.get("data", fixtures_loaded) if isinstance(fixtures_loaded, dict) and "data" in fixtures_loaded else fixtures_loaded
            
            with open(bundle_paths.events) as f:
                events_loaded = json.load(f)
                # Extract events data if wrapped
                events = events_loaded.get("data", events_loaded) if isinstance(events_loaded, dict) and "data" in events_loaded else events_loaded
            
            with open(bundle_paths.slate) as f:
                slate_loaded = json.load(f)
                # Extract slate data if wrapped
                slate = slate_loaded.get("data", slate_loaded) if isinstance(slate_loaded, dict) and "data" in slate_loaded else slate_loaded
            
            team_picks = None
            if self.team_id and bundle_paths.team_picks and Path(bundle_paths.team_picks).exists():
                with open(bundle_paths.team_picks) as f:
                    team_picks_loaded = json.load(f)
                    # Extract team picks data if wrapped
                    team_picks = team_picks_loaded.get("data", team_picks_loaded) if isinstance(team_picks_loaded, dict) and "data" in team_picks_loaded else team_picks_loaded
            entry_identity = None
            if self.team_id and bundle_paths.entry_info and Path(bundle_paths.entry_info).exists():
                with open(bundle_paths.entry_info) as f:
                    entry_loaded = json.load(f)
                    entry_identity = entry_loaded.get("data", entry_loaded) if isinstance(entry_loaded, dict) and "data" in entry_loaded else entry_loaded
        except (FileNotFoundError, json.JSONDecodeError, KeyError, TypeError) as exc:
            logger.error(f"Failed to load bundle artifacts: {exc}")
            raise

        # Derive current GW from events
        current_gw = target_gw or 0
        for ev in events or []:
            if ev.get("is_current"):
                current_gw = ev.get("id") or current_gw
        if not current_gw and events:
            current_gw = (events[0].get("id") or 0)

        data = {
            "fixtures": fixtures,
            "events": events,
            "players": bootstrap.get("elements", []),
            "teams": bootstrap.get("teams", []),
            "current_gameweek": current_gw,
            "slate": slate,
            "collection_meta": meta_loaded,
            "ruleset": ruleset.__dict__ if ruleset else None,
        }
        if self.team_id and team_picks:
            data["my_team"] = self._build_team_from_bundle(team_picks, bootstrap, events, identity_info=entry_identity)
        else:
            data["my_team"] = {"error": "No team data in bundle"} if self.team_id else {}
        
        # Step 2: Run decision analysis if we have team data
        analysis_output = {}
        if 'my_team' in data and 'error' not in data['my_team']:
            logger.info("Running decision analysis...")
            
            current_gw = data.get('current_gameweek', target_gw or 1)
            team_data = data['my_team']
            fixture_data = {'fixtures': data.get('fixtures', [])}
            chip_authority_source = self._resolve_chip_authority_source(team_data)
            data['chip_authority_source'] = chip_authority_source
            team_data['chip_authority_source'] = chip_authority_source
            team_data['chip_policy'] = (ruleset.chip_policy if ruleset else {})
            analysis_prefs = self.config.get('analysis_preferences', {})
            team_data['analysis_preferences'] = analysis_prefs
            team_data['manager_context'] = analysis_prefs.get('manager_context') or self.config.get('manager_context')
            team_data['force_tc_override'] = analysis_prefs.get('force_tc_override', False) or self.config.get('force_tc_override', False)
            
            # Inject manual overrides from config into team_data for decision framework
            team_data['manual_overrides'] = self.config.get('manual_overrides') or {}
            team_data['manual_injury_overrides'] = self.config.get('manual_injury_overrides') or {}
            logger.info(f"DEBUG: Injected manual_overrides into team_data: {list(team_data['manual_overrides'].keys())}")
            planned_xfers = team_data['manual_overrides'].get('planned_transfers', [])
            logger.info(f"DEBUG: planned_transfers count = {len(planned_xfers)}")
            if planned_xfers:
                logger.info(f"DEBUG: First transfer keys: {list(planned_xfers[0].keys())}")
            logger.debug(f"DEBUG: Injected manual_injury_overrides into team_data: {list(team_data['manual_injury_overrides'].keys())}")
            # Attach ruleset metadata for summary/output context
            if ruleset:
                team_data['ruleset_meta'] = {
                    "season_id": ruleset.season_id,
                    "ruleset_version": ruleset.version,
                    "ruleset_source": ruleset.source,
                }
            
            # Display transfer information prominently
            team_info = team_data.get('team_info', {})
            try:
                injury_artifacts = self._prepare_injury_artifacts(team_data, bundle_paths, run_id)
            except (KeyError, ValueError, TypeError) as exc:
                logger.warning("Failed to resolve injury artifacts for summary: %s", exc)
                injury_artifacts = None
            if injury_artifacts:
                data['injury_artifacts'] = injury_artifacts
                resolved_reports = injury_artifacts.get('resolved_reports', [])
                resolution_traces = injury_artifacts.get('resolution_traces', {})
                data['injury_reports'] = resolved_reports
                data['injury_resolution_traces'] = resolution_traces
                team_data['injury_reports'] = resolved_reports
                team_data['injury_resolution_traces'] = resolution_traces
                team_data['injury_summary'] = injury_artifacts.get('summary', {})
                team_data['injury_data_source'] = "resolved"
            free_transfers = team_info.get('free_transfers', 0)
            ft_source = team_info.get('free_transfers_source', 'api')
            print("\n🔄 TRANSFER SITUATION:")
            print("\n" + "🔄" + " TRANSFER SITUATION ".center(56, "="))
            
            # Team identification
            # Sprint 3.5: Extract and save manager identity from API
            team_name = team_info.get('team_name', 'Unknown Team')
            manager_name = team_info.get('manager_name', 'Unknown Manager')
            manager_id = team_info.get('manager_id')
            
            # Save manager identity to config if found
            if manager_name and manager_name != 'Unknown Manager' and self.config_manager:
                try:
                    self.config_manager.update_manager_identity(
                        manager_id=manager_id,
                        manager_name=manager_name
                    )
                except (IOError, json.JSONDecodeError, KeyError, TypeError) as e:
                    logger.debug(f"Could not save manager identity: {e}")
            
            overall_rank = team_info.get('overall_rank')
            
            print(f"👤 Team: {team_name}")
            print(f"📊 Manager: {manager_name}")
            if isinstance(overall_rank, (int, float)):
                print(f"🏆 Overall Rank: {overall_rank:,}")
            elif overall_rank:
                print(f"🏆 Overall Rank: {overall_rank}")
            print("-" * 60)
            
            # Detect Free Hit and adjust effective transfers
            active_chip = team_data.get('active_chip')
            chip_status = self._normalize_chip_status_map(
                self._ensure_dict(team_data.get('chip_status', {}), "chip_status")
            )
            is_free_hit_week = active_chip == 'freehit'
            if is_free_hit_week:
                free_transfers = 0
                team_info['ft_effective_this_week'] = 0
                team_info['ft_ignored_reason'] = "FREE_HIT_ACTIVE"
            else:
                team_info['ft_effective_this_week'] = free_transfers
            
            ft_note = " (manual)" if ft_source == 'manual' else ""
            print(f"Free Transfers Available: {free_transfers}{ft_note}")
            print(f"Bank Value: £{team_data.get('team_info', {}).get('bank_value', 0):.1f}m")
            print(f"Team Value: £{team_data.get('team_info', {}).get('team_value', 0):.1f}m")
            chip_authority = team_data.get('chip_authority_source', 'bundle')
            print(f"Chip data source: {chip_authority}")
            injury_source = team_data.get('injury_data_source', 'api')
            if injury_source == 'manual':
                print("Injury data source: manual overrides applied")
            elif injury_source == 'resolved':
                print("Injury data source: resolved (FPL + secondary + manual)")
            else:
                print("Injury data source: api (use overrides for current injuries)")
            
            # Check for injured/unavailable players
            squad = team_data.get('current_squad', [])
            injured_players = []
            doubtful_players = []
            
            for player in squad:
                if player.get('is_starter', False):
                    status = player.get('status_flag', 'FIT')
                    news = player.get('news', '')
                    chance_next = player.get('chance_of_playing_next_round')
                    
                    if status == 'OUT':
                        injured_players.append({
                            'name': player['name'],
                            'news': news,
                            'chance_next': chance_next
                        })
                    elif status == 'DOUBT':
                        doubtful_players.append({
                            'name': player['name'], 
                            'news': news,
                            'chance_next': chance_next
                        })
            
            if injured_players:
                print("\n🚨 INJURED/UNAVAILABLE STARTERS:")
                for player in injured_players:
                    news_text = f" - {player['news']}" if player['news'] else ""
                    chance_text = f" (Next round: {player['chance_next']}%)" if player['chance_next'] is not None else ""
                    print(f"• {player['name']}{news_text}{chance_text}")
                    
            if doubtful_players:
                print("\n⚠️ DOUBTFUL STARTERS:")
                for player in doubtful_players:
                    news_text = f" - {player['news']}" if player['news'] else ""
                    chance_text = f" (Next round: {player['chance_next']}%)" if player['chance_next'] is not None else ""
                    print(f"• {player['name']}{news_text}{chance_text}")
            
            # Strategic guidance based on transfer count
            if free_transfers >= 4:
                print(f"\n🚀 MULTIPLE TRANSFER STRATEGY ({free_transfers} transfers):")
                print("• Excellent opportunity for major squad restructuring")
                print("• Consider premium upgrades and position rebalancing")
                print("• Plan upgrade pathway to maximize team value")
                print("• Focus on form players with favorable fixture runs")
            elif free_transfers == 3:
                print("\n🎯 TRIPLE TRANSFER STRATEGY:")
                print("• Address multiple weaknesses simultaneously") 
                print("• Consider complete position overhauls")
                print("• Balance premium upgrades with budget optimization")
            elif free_transfers == 2:
                print("\n⚡ DUAL TRANSFER STRATEGY:")
                print("• Target two most critical improvements")
                print("• Consider sideways moves for fixture advantages")
            elif free_transfers == 1:
                print("\n🔧 SINGLE TRANSFER FOCUS:")
                print("• Prioritize highest impact improvement only")
                print("• Avoid luxury upgrades - focus on urgent needs")
            else:
                print("\n⚠️ NO FREE TRANSFERS:")
                print("• Hold chips until a future window clearly outperforms this week.")
                print("• Prioritize captaincy and wait for manager context confirmation before irreversible moves.")
            print("=" * 60)
            
            # Display current team state for manual verification
            self._display_current_team_for_verification(team_data)
            
            # Add all players data for transfer recommendations
            team_data['all_players'] = data.get('players', [])
            team_data['teams'] = data.get('teams', [])
            
            # Build basic projections from available data
            projections = self._build_basic_projections(data, current_gw)
            logger.info(f"Built {len(projections.projections)} projections for {len(data.get('players', []))} players")
            
            # Store projections for later retrieval
            team_data['_projections'] = projections
            
            try:
                decision = self.decision_framework.analyze_chip_decision(
                    team_data, fixture_data, projections, current_gw
                )
            except (KeyError, ValueError, TypeError, AttributeError, IndexError) as exc:
                import traceback
                from cheddar_fpl_sage.analysis.enhanced_decision_framework import RiskScenario, RiskLevel
                exc_type = type(exc).__name__
                exc_msg = str(exc)
                tb = traceback.format_exc()
                logger.error(f"❌ Decision framework failed with {exc_type}: {exc_msg}")
                logger.error(f"Full traceback:\n{tb}")
                logger.error(f"Team data keys: {list(team_data.keys())}")
                logger.error(f"Projections count: {len(projections.projections)}")
                logger.error(f"Current GW: {current_gw}")
                decision = DecisionOutput(
                    primary_decision=f"HOLD - {exc_type}: {exc_msg[:50]}",
                    reasoning=f"Projection analysis failed with {exc_type}. Check logs for details.",
                    risk_scenarios=[
                        RiskScenario(
                            condition=f"Code exception: {exc_type}",
                            expected_loss_range=(0, 4),
                            risk_level=RiskLevel.CRITICAL,
                            mitigation_action="Fix engine error and retry"
                        )
                    ],
                    decision_status="BLOCKED",
                    confidence_score=0.0,
                    risk_posture=self.decision_framework.risk_posture,
                )
            
            # Attach Free Hit context to decision output for downstream consumers
            if is_free_hit_week:
                decision.free_hit_plan = self._build_free_hit_plan(team_data, projections)
                decision.post_free_hit_plan = self._build_post_free_hit_plan(team_data, projections)
                decision.free_hit_context = {
                    "is_active": True,
                    "gw": current_gw,
                    "ft_available_post_fh": team_info.get('free_transfers', 0),
                    "pre_free_hit_team_hash": str(hash(str(team_data.get('current_squad', [])))),
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "expires_after_gw": self._ensure_dict(self.config.get("chip_policy", {}), "chip_policy").get("expiration", {}).get("chips_expire_after_gw", 19),
                    "urgency": False
                }
                # Avoid chip activation language when FH is active
                if "Triple Captain" in decision.primary_decision:
                    decision.primary_decision = "Free Hit squad optimization"
                if decision.decision_status == "PASS":
                    decision.decision_status = "HOLD"
                    decision.block_reason = "FREE_HIT_ACTIVE"
            
            # Chip expiry urgency gating
            chip_policy = self._ensure_dict(self.config.get("chip_policy", {}), "chip_policy")
            chip_expires_this_gw = EnhancedDecisionFramework.chip_expires_before_next_deadline(
                "Free Hit", current_gw, chip_policy
            )
            # Ensure chip_status is a dict before calling .get()
            if isinstance(chip_status, str):
                try:
                    chip_status = json.loads(chip_status)
                except json.JSONDecodeError:
                    chip_status = {}
            fh_available = chip_status.get('Free Hit', {}).get('available', False)
            if chip_expires_this_gw and fh_available:
                if decision.decision_status == "PASS":
                    # Force FH activation
                    decision.primary_decision = "ACTIVATE_FREE_HIT"
                    if not decision.chip_guidance:
                        from cheddar_fpl_sage.analysis.enhanced_decision_framework import ChipDecisionContext, ChipType
                        decision.chip_guidance = ChipDecisionContext(
                            current_gw=current_gw,
                            chip_type=ChipType.FREE_HIT,
                            available_chips=[ChipType.FREE_HIT],
                            selected_chip=ChipType.FREE_HIT,
                            reason_codes=["EXPIRING_CHIP_FORCE"]
                        )
                    else:
                        decision.chip_guidance.selected_chip = decision.chip_guidance.selected_chip or decision.chip_guidance.chip_type
                        reasons = decision.chip_guidance.reason_codes or []
                        if "EXPIRING_CHIP_FORCE" not in reasons:
                            reasons.append("EXPIRING_CHIP_FORCE")
                        decision.chip_guidance.reason_codes = reasons
                    # Ensure FH plans are present
                    if not decision.free_hit_plan:
                        decision.free_hit_plan = self._build_free_hit_plan(team_data, projections)
                    if not decision.post_free_hit_plan:
                        decision.post_free_hit_plan = self._build_post_free_hit_plan(team_data, projections)
                    decision.free_hit_context = decision.free_hit_context or {}
                    decision.free_hit_context.update({
                        "is_active": True,
                        "gw": current_gw,
                        "ft_available_post_fh": team_info.get('free_transfers', 0),
                        "pre_free_hit_team_hash": str(hash(str(team_data.get('current_squad', [])))),
                        "generated_at": datetime.now(timezone.utc).isoformat(),
                        "expires_after_gw": self._ensure_dict(self.config.get("chip_policy", {}), "chip_policy").get("expiration", {}).get("chips_expire_after_gw"),
                        "urgency": True
                    })
                    # Strip transfer recommendations headline
                    decision.transfer_recommendations = []
                else:
                    # Stale snapshot - hold but communicate urgency
                    decision.decision_status = "HOLD"
                    decision.block_reason = "STALE_SNAPSHOT"
                    decision.free_hit_context = decision.free_hit_context or {}
                    decision.free_hit_context.update({
                        "is_active": True,
                        "gw": current_gw,
                        "ft_available_post_fh": team_info.get('free_transfers', 0),
                        "pre_free_hit_team_hash": str(hash(str(team_data.get('current_squad', [])))),
                        "generated_at": datetime.now(timezone.utc).isoformat(),
                        "expires_after_gw": self._ensure_dict(self.config.get("chip_policy", {}), "chip_policy").get("expiration", {}).get("chips_expire_after_gw"),
                        "urgency": True
                    })
            
            # Enforce authority cap and log restrictions if team_picks_confidence is LOW
            capability_matrix = data.get('capability_matrix', {})
            team_picks_conf = capability_matrix.get('team_picks_confidence', 'UNKNOWN')
            authority_level = 'DAL_2'  # Default
            blocked_actions = []
            reasons = []
            if team_picks_conf == 'LOW':
                authority_level = 'DAL_1'
                blocked_actions = ['chips', 'hits', 'aggressive_captaincy']
                reasons.append('team_picks_confidence_low')
                print("\n⚠️ Authority capped: DAL_1 due to missing or stale team picks. Chips, hits, and aggressive captaincy are blocked.")
            data['authority_level'] = authority_level
            data['blocked_actions'] = blocked_actions
            data['block_reasons'] = reasons
            
            # Validate identity consistency across rendered sections (ID-first)
            try:
                rendered_sections = []
                if decision.free_hit_plan and decision.free_hit_plan.get("squad"):
                    rendered_sections.append(decision.free_hit_plan["squad"])
                if decision.post_free_hit_plan:
                    rendered_sections.extend(plan for plan in decision.post_free_hit_plan.get("plans", []) if isinstance(plan, list))
                validate_player_identity(team_data.get("current_squad", []), rendered_sections)
            except ValueError as exc:
                decision.decision_status = "HOLD"
                decision.block_reason = "DATA_INTEGRITY"
                decision.reasoning += f" | {exc}"
            
            # Generate formatted summary
            decision_summary = self.decision_framework.generate_decision_summary(decision, team_data)
            
            # Get optimized XI if available (may be stored in team_data during decision process)
            optimized_xi = team_data.get('_optimized_xi')
            
            analysis_output = {
                'decision': decision,
                'projections': projections,  # Add projections for API consumers
                'optimized_xi': optimized_xi,  # Add optimized XI if available
                'formatted_summary': decision_summary,
                'analysis_timestamp': datetime.now().isoformat()
            }
            
            logger.info(f"Analysis output includes {len(projections.projections)} projections")
            if optimized_xi:
                logger.info(f"Optimized XI includes {len(optimized_xi.starting_xi)} starters and {len(optimized_xi.bench)} bench")
            
            # Print summary to console
            print("\n" + "="*60)
            print("FPL SAGE ENHANCED ANALYSIS")
            print("="*60)
            print(decision_summary)
            print("="*60 + "\n")
        
        # Step 3: Save data if requested
        # Compute and save capability matrix
        capability_matrix = self._compute_capability_matrix(data)
        data['capability_matrix'] = capability_matrix
        if save_data:
            await self._save_analysis_data(data, analysis_output, run_id=run_id, bundle_paths=bundle_paths)
            # Save capability matrix as run_context.json
            context_path = bundle_paths.run_dir / 'run_context.json'
            with open(context_path, 'w') as f:
                json.dump({
                    'capability_matrix': capability_matrix,
                    'timestamp': datetime.now(timezone.utc).isoformat()
                }, f, indent=2)
        return {
            'raw_data': data,
            'analysis': analysis_output,
            'config_used': self.config,
            'capability_matrix': capability_matrix
        }

    def _build_free_hit_plan(self, team_data: Dict, projections: CanonicalProjectionSet) -> Dict:
        """Deterministic Free Hit plan builder (greedy, policy-compliant)."""
        # Use provided FH squad if present, else start from current squad pool
        fh_snapshot = team_data.get("team_input_free_hit", {}).get("current_squad") or team_data.get("current_squad", [])
        bank_value = team_data.get("team_info", {}).get("bank_value", 0.0)
        budget = team_data.get("team_info", {}).get("team_value", 100.0) + bank_value

        # If no FH snapshot exists, build a fresh 15 using projections (greedy within constraints)
        if not fh_snapshot:
            pos_limits = {"GK": 2, "DEF": 5, "MID": 5, "FWD": 3}
            team_limits: Dict[str, int] = {}
            squad = []
            total_cost = 0.0

            for proj in sorted(projections.projections, key=lambda p: p.nextGW_pts, reverse=True):
                if pos_limits.get(proj.position, 0) <= 0:
                    continue
                if team_limits.get(proj.team, 0) >= 3:
                    continue
                if total_cost + proj.current_price > budget + 1e-6:
                    continue

                squad.append(proj)
                pos_limits[proj.position] -= 1
                team_limits[proj.team] = team_limits.get(proj.team, 0) + 1
                total_cost += proj.current_price

                if len(squad) == 15:
                    break

            fh_snapshot = [
                {
                    "player_id": p.player_id,
                    "name": p.name,
                    "position": p.position,
                    "team": p.team,
                    "current_price": p.current_price,
                }
                for p in squad
            ]

        # Build XI from FH snapshot respecting formation
        proj_lookup = {p.player_id: p for p in projections.projections}
        gks = []
        defs = []
        mids = []
        fwds = []
        for p in fh_snapshot:
            proj = proj_lookup.get(p.get("player_id"))
            if not proj:
                continue
            if proj.position == "GK":
                gks.append(proj)
            elif proj.position == "DEF":
                defs.append(proj)
            elif proj.position == "MID":
                mids.append(proj)
            elif proj.position == "FWD":
                fwds.append(proj)

        gks.sort(key=lambda p: p.nextGW_pts, reverse=True)
        defs.sort(key=lambda p: p.nextGW_pts, reverse=True)
        mids.sort(key=lambda p: p.nextGW_pts, reverse=True)
        fwds.sort(key=lambda p: p.nextGW_pts, reverse=True)

        xi: List[CanonicalPlayerProjection] = []
        bench: List[CanonicalPlayerProjection] = []

        if gks:
            xi.append(gks.pop(0))
        xi.extend(defs[:3])
        xi.extend(mids[:3])
        if fwds:
            xi.append(fwds.pop(0))

        # Fill remaining XI slots with best remaining projections regardless of position (respecting team limit 3)
        remaining_pool = defs[3:] + mids[3:] + fwds + gks
        team_counts = {}
        for player in xi:
            team_counts[player.team] = team_counts.get(player.team, 0) + 1

        for player in sorted(remaining_pool, key=lambda p: p.nextGW_pts, reverse=True):
            if len(xi) >= 11:
                break
            if team_counts.get(player.team, 0) >= 3:
                continue
            xi.append(player)
            team_counts[player.team] = team_counts.get(player.team, 0) + 1

        # Bench is remaining sorted by projection
        used_ids = {p.player_id for p in xi}
        bench = [p for p in remaining_pool if p.player_id not in used_ids]
        bench.sort(key=lambda p: p.nextGW_pts, reverse=True)
        bench = bench[:4]

        starting_ids = [p.player_id for p in xi]
        bench_ids = [p.player_id for p in bench]
        projected_points = round(sum(p.nextGW_pts for p in xi), 2)

        return {
            "squad": [
                {
                    "player_id": p.get("player_id"),
                    "position": p.get("position"),
                    "team": p.get("team"),
                    "price": p.get("current_price"),
                }
                for p in fh_snapshot
            ],
            "starting_xi": starting_ids,
            "bench_order": bench_ids,
            "captain_id": starting_ids[0] if starting_ids else None,
            "vice_id": starting_ids[1] if len(starting_ids) > 1 else None,
            "projected_points_gw": projected_points,
            "notes": [
                "Greedy FH XI built from highest projected points within formation/team limits",
                f"Budget used: ~£{sum(p.get('current_price', 0) for p in fh_snapshot):.1f}m (cap £{budget:.1f}m)"
            ],
            "constraints_check": {
                "budget_ok": sum(p.get("current_price", 0) for p in fh_snapshot) <= budget + 1e-6,
                "formation_ok": len(starting_ids) == 11 and len([p for p in xi if p.position == "DEF"]) >= 3
                                 and len([p for p in xi if p.position == "MID"]) >= 3 and len([p for p in xi if p.position == "FWD"]) >= 1,
                "team_limit_ok": all(count <= 3 for count in team_counts.values())
            }
        }

    def _build_post_free_hit_plan(self, team_data: Dict, projections: CanonicalProjectionSet) -> Dict:
        """Post-FH transfer plan using pre-FH squad as baseline."""
        pre_fh = team_data.get("team_input_pre_free_hit", {}).get("current_squad") or team_data.get("current_squad", [])
        bank = team_data.get("team_info", {}).get("bank_value", 0.0)
        ft_available = team_data.get("team_info", {}).get("free_transfers", 0)
        projection_lookup = {p.player_id: p for p in projections.projections}

        # Build hold plan
        plans = [
            {
                "transfers_out": [],
                "transfers_in": [],
                "bank_delta": 0.0,
                "bank_after": bank,
                "projected_gain_horizon": 0.0,
                "risk_flags": ["BASELINE_HOLD"]
            }
        ]

        # Simple single-upgrade plan: swap lowest projection bench player for best affordable upgrade
        if pre_fh:
            squad_ids = {p.get("player_id") for p in pre_fh}
            bench_like = sorted(
                [p for p in pre_fh if not p.get("is_starter")],
                key=lambda x: projection_lookup.get(x.get("player_id"), None).next6_pts if projection_lookup.get(x.get("player_id")) else 0,
            )
            if bench_like:
                sell = bench_like[0]
                sell_proj = projection_lookup.get(sell.get("player_id"))
                sell_price = sell.get("current_price", sell.get("now_cost", 0) / 10)
                buy_budget = bank + sell_price
                candidates = [
                    p for p in projections.projections
                    if p.player_id not in squad_ids and p.current_price <= buy_budget + 1e-6
                ]
                if candidates:
                    best_buy = sorted(candidates, key=lambda p: p.next6_pts, reverse=True)[0]
                    gain = (best_buy.next6_pts - (sell_proj.next6_pts if sell_proj else 0))
                    plans.append(
                        {
                            "transfers_out": [sell.get("player_id")],
                            "transfers_in": [best_buy.player_id],
                            "bank_delta": round(best_buy.current_price - sell_price, 2),
                            "bank_after": round(bank - (best_buy.current_price - sell_price), 2),
                            "projected_gain_horizon": round(gain, 2),
                            "risk_flags": ["SINGLE_UPGRADE"]
                        }
                    )

        return {
            "horizon_gws": 6,
            "ft_available": ft_available,
            "plans": plans
        }
    
    def _compute_capability_matrix(self, data: Dict) -> Dict:
        """Compute the capability matrix for the given data bundle."""
        matrix = {
            "raw_data_freshness": "UNKNOWN",
            "model_inputs_freshness": "UNKNOWN",
            "analysis_freshness": "UNKNOWN",
            "team_picks_confidence": "UNKNOWN",
            "team_picks_provenance": "UNKNOWN",
        }

        # Heuristic freshness checks (basic)
        now = datetime.now(timezone.utc)
        max_staleness = 60 * 60  # 1 hour in seconds

        # Check collection_meta timestamps if available
        meta = data.get('collection_meta', {})
        if meta:
            collection_time = meta.get('collection_time')
            if collection_time:
                try:
                    collection_dt = datetime.fromisoformat(collection_time.replace("Z", "+00:00"))
                    if now and collection_dt:
                        age = (now - collection_dt).total_seconds()
                        if age < max_staleness:
                            matrix['raw_data_freshness'] = "FRESH"
                        else:
                            matrix['raw_data_freshness'] = "STALE"
                except (ValueError, TypeError):
                    matrix['raw_data_freshness'] = "UNKNOWN"

            # Model inputs freshness (derived from analysis timestamp)
            analysis_timestamp = meta.get('analysis_timestamp')
            if analysis_timestamp:
                try:
                    analysis_dt = datetime.fromisoformat(analysis_timestamp.replace("Z", "+00:00"))
                    if now and analysis_dt:
                        age = (now - analysis_dt).total_seconds()
                        if age < max_staleness:
                            matrix['model_inputs_freshness'] = "FRESH"
                        else:
                            matrix['model_inputs_freshness'] = "STALE"
                except (ValueError, TypeError):
                    matrix['model_inputs_freshness'] = "UNKNOWN"

            # Analysis freshness (directly from analysis output)
            analysis_age = (now - (data.get('analysis_timestamp') or now)).total_seconds()
            if analysis_age < max_staleness:
                matrix['analysis_freshness'] = "FRESH"
            else:
                matrix['analysis_freshness'] = "STALE"

            # Team picks confidence and provenance from collection_meta if available
            matrix['team_picks_confidence'] = meta.get('team_picks_confidence', 'UNKNOWN')
            matrix['team_picks_provenance'] = meta.get('team_picks_provenance', 'UNKNOWN')
        else:
            matrix['team_picks_confidence'] = 'UNKNOWN'
            matrix['team_picks_provenance'] = 'UNKNOWN'

        return matrix
    
    async def _save_analysis_data(self, raw_data: Dict, analysis_output: Dict, run_id: Optional[str] = None, bundle_paths=None):
        """Save analysis data following the run bundle contract."""
        now = datetime.now(timezone.utc)
        timestamp = now.strftime("%Y%m%d_%H%M%S")
        current_gw = raw_data.get('current_gameweek') or raw_data.get('my_team', {}).get('current_gameweek') or 0
        season = raw_data.get('season') or raw_data.get('my_team', {}).get('season') or "unknown"

        run_id = run_id or generate_run_id(current_gw)
        bundle_manager = OutputBundleManager()
        run_paths = bundle_manager.paths_for_run(run_id, team_id=self.team_id)

        # Enrich raw data with metadata
        if isinstance(raw_data, dict):
            raw_with_meta = dict(raw_data)
        else:
            # Gracefully handle unexpected shapes
            raw_with_meta = {"raw": raw_data}
        raw_with_meta.update({
            "schema_version": "1.0.0",
            "run_id": run_id,
            "gameweek": current_gw,
            "season": season,
            "generated_at": now.isoformat(),
            "source": raw_data.get("source", {"type": "bundle"}),
            "source_bundle": {
                "bootstrap_static": str(bundle_paths.bootstrap_static) if bundle_paths else None,
                "fixtures": str(bundle_paths.fixtures) if bundle_paths else None,
                "events": str(bundle_paths.events) if bundle_paths else None,
                "team_picks": str(bundle_paths.team_picks) if bundle_paths and bundle_paths.team_picks else None,
                "slate": str(bundle_paths.slate) if bundle_paths else None,
                "collection_meta": str(bundle_paths.collection_meta) if bundle_paths else None,
            },
            "ruleset": raw_data.get("ruleset"),
        })
        write_json_atomic(run_paths.data_collection, raw_with_meta)
        logger.info(f"Raw data saved to {run_paths.data_collection}")

        # Pull decision object early (for FH snapshots)
        decision_obj = analysis_output['decision'] if analysis_output else None

        # Model inputs derived from collected data (team + fixtures)
        my_team = raw_data.get("my_team", {})

        injury_artifacts = raw_data.get('injury_artifacts', {})
        manual_payload = injury_artifacts.get('manual_payload')
        resolved_payload = injury_artifacts.get('resolved_payload')
        resolved_reports = injury_artifacts.get('resolved_reports')
        resolution_traces = injury_artifacts.get('resolution_traces')

        if not (manual_payload and resolved_payload):
            fallback = self._prepare_injury_artifacts(my_team, bundle_paths, run_id)
            if fallback:
                manual_payload = manual_payload or fallback.get('manual_payload')
                resolved_payload = resolved_payload or fallback.get('resolved_payload')
                resolved_reports = resolved_reports or fallback.get('resolved_reports')
                resolution_traces = resolution_traces or fallback.get('resolution_traces')
                raw_data['injury_artifacts'] = {
                    'manual_payload': manual_payload,
                    'resolved_payload': resolved_payload,
                    'resolved_reports': resolved_reports,
                    'resolution_traces': resolution_traces,
                    'summary': fallback.get('summary')
                }
                if isinstance(my_team, dict):
                    my_team['injury_summary'] = fallback.get('summary', {})
                    my_team['injury_data_source'] = "resolved"

        if manual_payload:
            write_json_atomic(run_paths.injury_manual, manual_payload)
        if resolved_payload:
            write_json_atomic(run_paths.injury_resolved, resolved_payload)

        if resolved_reports is not None:
            raw_data["injury_reports"] = resolved_reports
        if resolution_traces is not None:
            raw_data["injury_resolution_traces"] = resolution_traces
        if isinstance(my_team, dict):
            if resolved_reports is not None:
                my_team["injury_reports"] = resolved_reports
            if resolution_traces is not None:
                my_team["injury_resolution_traces"] = resolution_traces
        # Persist both team states for FH context (currently using same squad as placeholder)
        team_input_pre_fh = {
            "team_info": my_team.get("team_info", {}),
            "chip_status": my_team.get("chip_status", {}),
            "current_squad": my_team.get("current_squad", []),
            "recent_transfers": my_team.get("recent_transfers", []),
            "active_chip": my_team.get("active_chip"),
            "captain_info": my_team.get("captain_info", {}),
            "lineup_source": my_team.get("lineup_source"),
            "picks_gameweek": my_team.get("picks_gameweek"),
            "current_gameweek": my_team.get("current_gameweek"),
            "next_gameweek": my_team.get("next_gameweek"),
        }
        fh_plan_squad = None
        if decision_obj and getattr(decision_obj, "free_hit_plan", None):
            fh_plan_squad = decision_obj.free_hit_plan.get("squad")
        team_input_free_hit = {
            "team_info": my_team.get("team_info", {}),
            "chip_status": my_team.get("chip_status", {}),
            "current_squad": fh_plan_squad or team_input_pre_fh.get("current_squad", []),
            "recent_transfers": my_team.get("recent_transfers", []),
            "active_chip": my_team.get("active_chip"),
            "captain_info": my_team.get("captain_info", {}),
            "lineup_source": my_team.get("lineup_source"),
            "picks_gameweek": my_team.get("picks_gameweek"),
            "current_gameweek": my_team.get("current_gameweek"),
            "next_gameweek": my_team.get("next_gameweek"),
        }

        model_inputs = {
            "schema_version": "1.0.0",
            "run_id": run_id,
            "gameweek": current_gw,
            "season": season,
            "generated_at": now.isoformat(),
            "team_input": team_input_pre_fh,
            "team_input_pre_free_hit": team_input_pre_fh,
            "team_input_free_hit": team_input_free_hit,
            "chip_calendar": self.config.get("chip_calendar", {"reset_gw": 20, "expires_after_gw": 19}),
            "chip_policy": self.config.get("chip_policy", {}),
            "fixture_input": raw_data.get("fixtures", []),
            "ruleset": raw_data.get("ruleset"),
        }
        write_json_atomic(run_paths.model_inputs, model_inputs)

        if analysis_output and decision_obj:
            serializable_analysis = {
                'schema_version': "1.0.0",
                'run_id': run_id,
                'gameweek': current_gw,
                'season': season,
                'generated_at': now.isoformat(),
                'decision': {
                    'primary_decision': decision_obj.primary_decision,
                    'reasoning': decision_obj.reasoning,
                    'tilt_armor_threshold': decision_obj.tilt_armor_threshold,
                    'risk_scenarios': [
                        {
                            'condition': r.condition,
                            'expected_loss_range': r.expected_loss_range,
                            'risk_level': r.risk_level.value,
                            'probability_estimate': r.probability_estimate,
                            'mitigation_action': r.mitigation_action
                        } for r in decision_obj.risk_scenarios
                    ],
                    'lineup_focus': decision_obj.lineup_focus,
                    'next_gw_prep': decision_obj.next_gw_prep,
                    'variance_expectations': decision_obj.variance_expectations,
                    'captaincy': decision_obj.captaincy,
                    'transfer_recommendations': decision_obj.transfer_recommendations,
                    'decision_status': decision_obj.decision_status,
                    'confidence_score': decision_obj.confidence_score,
                    'block_reason': decision_obj.block_reason,
                    'risk_posture': decision_obj.risk_posture,  # CRITICAL: Include risk posture!
                    'chip_guidance': (
                        decision_obj.chip_guidance.__dict__
                        if getattr(decision_obj, "chip_guidance", None) else None
                    ),
                    'free_hit_context': getattr(decision_obj, "free_hit_context", None),
                    'free_hit_plan': getattr(decision_obj, "free_hit_plan", None),
                    'post_free_hit_plan': getattr(decision_obj, "post_free_hit_plan", None),
                },
                'analysis_timestamp': analysis_output['analysis_timestamp']
            }
            write_json_atomic(run_paths.analysis, serializable_analysis)
            logger.info(f"Analysis output saved to {run_paths.analysis}")

            summary_text = analysis_output['formatted_summary']
            write_text_atomic(run_paths.report, summary_text)
            logger.info(f"Formatted summary saved to {run_paths.report}")
        else:
            serializable_analysis = {
                'schema_version': "1.0.0",
                'run_id': run_id,
                'gameweek': current_gw,
                'season': season,
                'generated_at': now.isoformat(),
                'decision': {},
                'formatted_summary': "No analysis available.",
                'analysis_timestamp': now.isoformat()
            }
            summary_text = "# FPL Analysis\n\nNo analysis available."
            write_json_atomic(run_paths.analysis, serializable_analysis)
            write_text_atomic(run_paths.report, summary_text)

        # Compatibility mirrors (legacy file names)
        mirror_raw = Path(f"outputs/data_collections/enhanced_fpl_data_{timestamp}.json")
        mirror_analysis = Path(f"outputs/processed_data/fpl_analysis_{timestamp}.json")
        mirror_summary = Path(f"outputs/processed_data/fpl_summary_{timestamp}.md")
        write_json_atomic(mirror_raw, raw_with_meta)
        if analysis_output:
            write_json_atomic(mirror_analysis, serializable_analysis)
            write_text_atomic(mirror_summary, summary_text)

        # Update pointer + summary
        try:
            bundle_manager.update_latest_pointer(run_paths)
        except FileNotFoundError as exc:
            logger.error(f"Pointer update skipped: {exc}")
        try:
            bundle_manager.update_data_summary(run_paths, season, current_gw)
        except (IOError, json.JSONDecodeError, KeyError, TypeError) as exc:
            logger.error(f"DATA_SUMMARY update failed: {exc}")

    def _load_injury_payload(self, path: Optional[Path]) -> Dict[str, Any]:
        """Read an injury artifact payload safely."""
        if path and path.exists():
            try:
                return json.loads(path.read_text())
            except (json.JSONDecodeError, IOError) as exc:
                logger.warning("Failed to load injury artifact %s: %s", path, exc)
        return {"schema_version": "1.0.0", "reports": []}

    def _prepare_injury_artifacts(self, team_data: Dict, bundle_paths, run_id: str) -> Optional[Dict[str, Any]]:
        """Build manual/resolved injury payloads and summary metadata."""
        if not bundle_paths:
            return None

        manual_overrides = self.config.get("manual_injury_overrides", {}) or {}
        squad_players = team_data.get("current_squad", []) if isinstance(team_data, dict) else []

        manual_reports = build_manual_injury_reports(
            manual_overrides,
            squad_players,
            self.config.get("last_manual_update"),
        )

        fpl_payload = self._load_injury_payload(bundle_paths.injury_fpl)
        secondary_payload = self._load_injury_payload(bundle_paths.injury_secondary)

        manual_payload = build_injury_artifact_payload(
            manual_reports,
            run_id=run_id,
            label="manual_overrides",
        )

        expected_ids = []
        for player in squad_players:
            player_id = player.get("player_id")
            if player_id is None:
                continue
            try:
                expected_ids.append(int(player_id))
            except (TypeError, ValueError):
                continue

        resolved_reports, resolution_traces = resolve_injury_payloads(
            fpl_payload,
            secondary_payload,
            manual_reports,
            expected_player_ids=expected_ids,
        )

        resolved_objects = [InjuryReport.from_dict(report) for report in resolved_reports]
        resolved_payload = build_injury_artifact_payload(
            resolved_objects,
            run_id=run_id,
            label="injury_resolved",
            extra={"resolution_traces": resolution_traces},
        )

        status_counts: Dict[str, int] = {}
        low_confidence = 0
        for report in resolved_reports:
            status = (report.get("status") or "UNKNOWN").upper()
            status_counts[status] = status_counts.get(status, 0) + 1
            if (report.get("confidence") or "").upper() == "LOW":
                low_confidence += 1

        return {
            "manual_payload": manual_payload,
            "resolved_payload": resolved_payload,
            "resolved_reports": resolved_reports,
            "resolution_traces": resolution_traces,
            "summary": {
                "status_counts": status_counts,
                "low_confidence": low_confidence
            }
        }

    def run_quick_team_check(self) -> Dict:
        """Quick synchronous check of team status (no full analysis)"""
        if not self.team_id:
            return {'error': 'No team ID configured'}
        
        async def _quick_check():
            async with EnhancedFPLCollector(team_id=self.team_id) as collector:
                return await collector.get_team_data()
        
        return asyncio.run(_quick_check())
    
    def update_config(self, **kwargs):
        """Update configuration values"""
        self.config.update(kwargs)
        
        # Save updated config
        with open(self.config_file, 'w') as f:
            json.dump(self.config, f, indent=2)
        
        logger.info(f"Configuration updated and saved to {self.config_file}")

    def _display_current_team_for_verification(self, team_data: Dict):
        """Display the team that FPL API sees for manual verification"""
        print("\n📋 CURRENT TEAM STATE (from FPL API):")
        print("=" * 50)
        
        squad = team_data.get('current_squad', [])
        starters = [p for p in squad if p.get('is_starter')]
        bench = [p for p in squad if not p.get('is_starter')]
        
        print("🥅 STARTERS:")
        for player in starters:
            status = ""
            if player.get('status_flag') == 'OUT':
                status = " ❌"
            elif player.get('status_flag') == 'DOUBT':
                status = " ⚠️"
            
            captain_info = ""
            if player.get('is_captain'):
                captain_info = " (C)"
            elif player.get('is_vice'):
                captain_info = " (VC)"
                
            print(f"  • {player.get('name')} ({player.get('team')}) - £{player.get('current_price', 0):.1f}m{captain_info}{status}")
        
        print("\n🪑 BENCH:")
        for player in bench:
            print(f"  • {player.get('name')} ({player.get('team')}) - £{player.get('current_price', 0):.1f}m")
        
        bank_value = team_data.get('team_info', {}).get('bank_value', 0)
        print(f"\n💰 Bank: £{bank_value:.1f}m")
        print("\n⚠️  Note: This reflects your team from the last completed gameweek.")
        print("💡 If you've made transfers since then, this won't show your current team.")
        print("🔄 For updated analysis, share your current team with GPT along with this analysis.")
        print("=" * 50)

    def _position_code(self, element_type: int) -> str:
        return {1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD'}.get(element_type, 'UNK')

    def _parse_status_flag(self, status: str, chance: Optional[int]) -> str:
        if status in {'u', 'i', 's', 'n'}:
            return 'OUT'
        if status == 'd':
            return 'DOUBT'
        if chance is not None and chance <= 25:
            return 'DOUBT'
        return 'FIT'

    def _get_captain_info_from_picks(self, picks_payload: Dict, bootstrap: Dict) -> Dict:
        picks = picks_payload.get('picks', []) or picks_payload.get('team_picks', [])
        elements = {p['id']: p for p in bootstrap.get('elements', [])}
        teams = {t['id']: t for t in bootstrap.get('teams', [])}
        captain_pick = next((p for p in picks if p.get('is_captain')), None)
        vice_pick = next((p for p in picks if p.get('is_vice_captain')), None)

        def fmt_pick(pick):
            if not pick:
                return None
            element = elements.get(pick.get('element'))
            if not element:
                return None
            team = teams.get(element.get('team'))
            return {
                'player_id': element.get('id'),
                'name': element.get('web_name'),
                'team': team.get('short_name') if team else 'UNK',
                'position': self._position_code(element.get('element_type')),
            }

        return {
            'captain': fmt_pick(captain_pick),
            'vice_captain': fmt_pick(vice_pick),
        }

    def _build_team_from_bundle(
        self,
        team_picks: Dict,
        bootstrap: Dict,
        events: List[Dict],
        identity_info: Optional[Dict] = None,
    ) -> Dict:
        """Construct team_data structure from bundled team picks + bootstrap."""
        elements = {p['id']: p for p in bootstrap.get('elements', [])}
        teams = {t['id']: t for t in bootstrap.get('teams', [])}
        picks = team_picks.get('picks', []) or team_picks.get('team_picks', [])
        entry_info = self._ensure_dict(team_picks.get("entry_info", {}) or {}, "entry_info")
        identity_info = identity_info or {}
        identity_team_id = (
            identity_info.get("team_id")
            or identity_info.get("entry_id")
            or identity_info.get("id")
            or identity_info.get("entry")
        )
        identity_team_name = (
            identity_info.get("team_name")
            or identity_info.get("name")
            or identity_info.get("entry_name")
        )
        identity_manager_name = identity_info.get("manager_name")
        if not identity_manager_name:
            first_name = identity_info.get("player_first_name") or identity_info.get("first_name") or ""
            last_name = identity_info.get("player_last_name") or identity_info.get("last_name") or ""
            combined_manager = f"{first_name} {last_name}".strip()
            identity_manager_name = combined_manager if combined_manager else None
        current_squad = []
        for pick in picks:
            element = elements.get(pick.get('element') or pick.get('id'))
            if not element:
                continue
            team = teams.get(element.get('team'))
            chance = element.get('chance_of_playing_next_round')
            status_flag = self._parse_status_flag(element.get('status', ''), chance)
            current_squad.append({
                'player_id': element.get('id'),
                'name': element.get('web_name'),
                'team': team.get('short_name') if team else 'UNK',
                'team_id': element.get('team'),
                'position': self._position_code(element.get('element_type')),
                'current_price': element.get('now_cost', 0) / 10,
                'is_starter': pick.get('position', 99) <= 11,
                'is_captain': pick.get('is_captain', False),
                'is_vice': pick.get('is_vice_captain', False),
                'bench_order': pick.get('position', 0) - 11 if pick.get('position', 0) > 11 else 0,
                'status_flag': status_flag,
                'news': element.get('news', ''),
                'chance_of_playing_next_round': chance,
            })

        entry_history = self._ensure_dict(team_picks.get('entry_history', {}) or {}, "entry_history")
        active_chip = team_picks.get('active_chip')
        chip_status = self._normalize_chip_status_map(
            self._ensure_dict(self.config.get('manual_chip_status', {}), "manual_chip_status")
        )
        manual_free_transfers = self.config.get('manual_free_transfers')
        current_gw = 0
        next_gw = 0
        for ev in events or []:
            if ev.get("is_current"):
                current_gw = ev.get("id") or current_gw
            if ev.get("is_next"):
                next_gw = ev.get("id") or next_gw

        entry_id = (
            team_picks.get('entry')
            or entry_info.get("team_id")
            or identity_team_id
            or self.team_id
            or self.config.get("team_id")
        )
        team_name = (
            entry_info.get("team_name")
            or identity_team_name
            or self.config.get('team_name')
            or (f"Team {entry_id}" if entry_id else "Team")
        )
        manager_name = (
            identity_manager_name
            or entry_info.get("manager_name")
            or self.config.get('manager_name')
        )
        
        # If manager name is still missing, try to get it from enhanced FPL data
        if not manager_name or manager_name == "Unknown Manager":
            try:
                # Try to load enhanced FPL data to get the proper manager name
                enhanced_data_path = self.bundle_paths.data_directory / "enhanced_fpl_data.json"
                if enhanced_data_path and enhanced_data_path.exists():
                    enhanced_data = self._load_json(enhanced_data_path)
                    if enhanced_data and "my_team" in enhanced_data and "team_info" in enhanced_data["my_team"]:
                        enhanced_manager_name = enhanced_data["my_team"]["team_info"].get("manager_name")
                        if enhanced_manager_name and enhanced_manager_name != "Unknown Manager":
                            manager_name = enhanced_manager_name
            except (AttributeError, json.JSONDecodeError, KeyError, TypeError):
                pass  # Fallback to Unknown Manager
        
        # Final fallback
        if not manager_name:
            manager_name = "Unknown Manager"
        overall_rank = entry_info.get("overall_rank") or entry_history.get('overall_rank')
        total_points = entry_info.get("total_points") or entry_history.get('total_points')

        # CRITICAL FIX: Use framework's risk_posture to ensure consistency
        # The framework was already initialized with the correct risk_posture from config
        # DO NOT derive from rank or look elsewhere - use single source of truth
        risk_posture = self.decision_framework.risk_posture
        logger.info(f"Using framework risk_posture for team_data: {risk_posture}")
        
        # Update manager context with rank for future reference
        if overall_rank and overall_rank > 0:
            from cheddar_fpl_sage.utils.sprint3_5_config_manager import Sprint35ConfigManager
            config_manager = Sprint35ConfigManager()
            config_manager.update_manager_context(overall_rank=overall_rank)

        team_info = {
            'team_info': {
                'team_id': entry_id,
                'manager_id': entry_id,
                'team_name': team_name,
                'manager_name': manager_name,
                'overall_rank': overall_rank,
                'total_points': total_points,
                'bank_value': entry_history.get('bank', 0) / 10 if entry_history else 0,
                'team_value': entry_history.get('value', 0) / 10 if entry_history else 0,
                'free_transfers': entry_history.get('event_transfers', 0),
                'hits_taken': entry_history.get('event_transfers_cost', 0) / 4 if entry_history else 0,
                'free_transfers_source': 'bundle',
                'risk_posture': risk_posture,  # Add risk posture to team_info
            },
            'chip_status': chip_status,
            'chip_data_source': 'bundle_manual' if chip_status else 'bundle',
            'current_squad': current_squad,
            'recent_transfers': [],
            'active_chip': active_chip,
            'captain_info': self._get_captain_info_from_picks(team_picks, bootstrap),
            'last_updated': datetime.now(timezone.utc).isoformat(),
            'picks_gameweek': team_picks.get('event') or next_gw or current_gw,
            'current_gameweek': current_gw,
            'next_gameweek': next_gw,
            'lineup_source': 'bundle_team_picks',
            'manual_overrides_applied': False
        }
        if manual_free_transfers is not None:
            team_info['team_info']['free_transfers'] = manual_free_transfers
            team_info['team_info']['free_transfers_source'] = 'manual'
        return team_info

    def _resolve_chip_authority_source(self, team_data: Dict) -> str:
        """Determine and cache the chip data source authority for the run."""
        if self._chip_authority_source:
            return self._chip_authority_source

        override_source = self.config.get('chip_data_source')
        if isinstance(override_source, str) and override_source.lower() == 'manual':
            authority = 'bundle_manual'
        else:
            authority = team_data.get('chip_data_source', 'bundle')
        self._chip_authority_source = authority
        return authority

    def _build_basic_projections(self, raw_data: Dict, current_gw: int) -> CanonicalProjectionSet:
        """Build a basic projection set from available player data."""
        players = raw_data.get("players", []) or []
        fixtures = raw_data.get("fixtures", []) or []
        fixture_lookup = self._build_fixture_lookup(fixtures, current_gw)
        team_map = {}
        for team in raw_data.get("teams") or []:
            if isinstance(team, dict):
                team_id = team.get("id")
                if team_id is not None:
                    team_map[team_id] = team.get("short_name") or team.get("name") or str(team_id)

        projections = []
        created_at = datetime.now(timezone.utc).isoformat()
        pos_map = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}

        def clamp(value: float, minimum: float, maximum: float) -> float:
            return max(minimum, min(maximum, value))

        for player in players:
            if not isinstance(player, dict):
                continue
            try:
                player_id = int(player.get("player_id") or player.get("id") or 0)
            except (ValueError, TypeError):
                player_id = 0
            if player_id == 0:
                continue

            raw_pos = player.get("position") or player.get("element_type") or player.get("position_id")
            if isinstance(raw_pos, int):
                position = pos_map.get(raw_pos, "UNK")
            elif isinstance(raw_pos, str) and raw_pos.isdigit():
                position = pos_map.get(int(raw_pos), "UNK")
            elif isinstance(raw_pos, str):
                position = raw_pos.upper()
            else:
                position = "UNK"

            now_cost = player.get("now_cost", 0)
            current_price = player.get("current_price", 0)
            if now_cost:
                price = float(now_cost) / 10.0
            elif current_price:
                price = float(current_price)
            else:
                price = 0.0

            form_score = self._safe_float(player.get("form"))
            season_ppg = self._safe_float(player.get("points_per_game"))
            recent_weight = 0.7
            base_points = max(0.1, recent_weight * form_score + (1 - recent_weight) * season_ppg)

            xg = self._safe_float(player.get("expected_goals"))
            xa = self._safe_float(player.get("expected_assists"))
            xgi = self._safe_float(player.get("expected_goal_involvements"))
            advanced_signal = xgi if xgi > 0 else (xg + xa)
            advanced_offset = (advanced_signal - 0.45) * 0.15
            advanced_modifier = clamp(1 + advanced_offset, 0.85, 1.15)

            team_id = player.get("team")
            team_name = team_map.get(team_id)
            if not team_name:
                team_name = f"Team {team_id}" if team_id is not None else "UNK"

            fixture_info = fixture_lookup.get(team_id)
            fixture_modifier = 1.0
            if fixture_info:
                diff_delta = 3 - fixture_info["difficulty"]
                venue_adj = 0.05 if fixture_info["is_home"] else -0.05
                fixture_modifier = clamp(1 + diff_delta * 0.04 + venue_adj, 0.7, 1.2)

            next_gw_pts = max(0, base_points * fixture_modifier * advanced_modifier)
            next6_pts = max(0, next_gw_pts * 5)

            chance_next = player.get("chance_of_playing_next_round")
            if chance_next is None:
                minutes_recorded = self._safe_float(player.get("minutes"))
                divisor = max(1, current_gw - 1) if current_gw > 1 else 1
                observed_minutes = minutes_recorded / divisor if divisor else minutes_recorded
                raw_minutes = observed_minutes if observed_minutes > 0 else 75
                xmins = clamp(raw_minutes, 45, 90)
            else:
                xmins = clamp(0.9 * chance_next, 0, 90)

            status_flag = player.get("status_flag", "").upper()
            tags = []
            if status_flag == "OUT":
                tags.append("injury_risk")
            if status_flag == "DOUBT":
                tags.append("rotation_risk")
            # Tag as injury_risk if chance of playing is low (< 50%)
            if chance_next is not None and chance_next < 50:
                if "injury_risk" not in tags:
                    tags.append("injury_risk")
            if fixture_info:
                if fixture_info["difficulty"] >= 4:
                    tags.append("tough_fixture")
                elif fixture_info["difficulty"] <= 2:
                    tags.append("favorable_fixture")

            consistency = clamp(base_points / 10, 0.0, 1.0)
            volatility = clamp(0.3 + (1 - consistency) * 0.45, 0.2, 0.75)
            ceiling = next_gw_pts * 1.4
            floor = max(0, next_gw_pts * 0.6)

            coverage_signals = sum(
                1 if signal > 0 else 0
                for signal in (form_score, advanced_signal)
            ) + (1 if fixture_info else 0)
            confidence = clamp(
                0.35 + 0.1 * coverage_signals + 0.05 * consistency + (0.05 if fixture_info else 0),
                0.3,
                0.95
            )

            ownership_pct = self._safe_float(player.get("ownership") or player.get("selected_by_percent"))
            
            # Extract fixture difficulty if available
            fixture_diff = fixture_info.get("difficulty") if fixture_info else None

            projections.append(
                CanonicalPlayerProjection(
                    player_id=player_id,
                    name=player.get("name") or player.get("web_name", "Unknown"),
                    position=position,
                    team=team_name,
                    current_price=price,
                    nextGW_pts=next_gw_pts,
                    next6_pts=next6_pts,
                    xMins_next=xmins,
                    volatility_score=volatility,
                    ceiling=ceiling,
                    floor=floor,
                    tags=tags,
                    confidence=confidence,
                    ownership_pct=ownership_pct,
                    captaincy_rate=None,
                    fixture_difficulty=fixture_diff,
                )
            )

        avg_confidence = (
            sum(p.confidence for p in projections) / len(projections)
            if projections else 0.0
        )
        if avg_confidence >= 0.6:
            confidence_level = "high"
        elif avg_confidence >= 0.45:
            confidence_level = "medium"
        else:
            confidence_level = "low"

        return CanonicalProjectionSet(
            projections=projections,
            gameweek=current_gw,
            created_timestamp=created_at,
            confidence_level=confidence_level,
        )


async def main():
    """Main execution function"""
    
    # Initialize integration
    sage = FPLSageIntegration()
    
    # Run full analysis
    try:
        results = await sage.run_full_analysis(save_data=True)
        
        if 'my_team' in results['raw_data']:
            team_info = results['raw_data']['my_team'].get('team_info', {})
            print(f"\n✅ Analysis complete for {team_info.get('team_name', 'your team')}")
            overall_rank = team_info.get('overall_rank')
            if isinstance(overall_rank, (int, float)):
                rank_text = f"{overall_rank:,}"
            else:
                rank_text = overall_rank if overall_rank is not None else "N/A"
            print(f"📊 Overall rank: {rank_text}")
            print(f"💰 Team value: £{team_info.get('team_value', 0):.1f}m")
            print(f"🔄 Free transfers: {team_info.get('free_transfers', 0)}")
            
            # Show chip status
            chip_status = sage._normalize_chip_status_map(
                sage._ensure_dict(results['raw_data']['my_team'].get('chip_status', {}), "chip_status")
            )
            available_chips = [
                chip for chip, status in chip_status.items()
                if isinstance(status, dict) and status.get('available', False)
            ]
            if available_chips:
                print(f"🎯 Available chips: {', '.join(available_chips)}")
        
        return results

    except (KeyError, ValueError, TypeError, IOError, json.JSONDecodeError, AttributeError) as e:
        logger.error(f"Analysis failed: {e}")
        raise

    def _basic_fallback_analysis(self, team_data: Dict, fixture_data: Dict, current_gw: int):
        """Basic fallback analysis when canonical projections fail"""
        from cheddar_fpl_sage.analysis.enhanced_decision_framework import DecisionOutput, RiskScenario, RiskLevel
        
        return DecisionOutput(
            primary_decision="HOLD - Use GPT Integration",
            reasoning="Analysis system encountered errors. Please use GPT integration with this team data.",
            decision_status="BLOCKED",
            block_reason="Canonical projection system failed",
            confidence_score=0.0,
            risk_scenarios=[
                RiskScenario(
                    condition="System error encountered",
                    expected_loss_range=(0, 0),
                    risk_level=RiskLevel.CRITICAL,
                    mitigation_action="Use GPT integration method described in README"
                )
            ],
            risk_posture=self.decision_framework.risk_posture,
        )


if __name__ == "__main__":
    # Example usage
    results = asyncio.run(main())
