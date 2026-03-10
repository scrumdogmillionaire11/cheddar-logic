"""
Transfer recommendation module for FPL decision framework.
Handles transfer suggestions, manual transfers, and player evaluation.
"""
import logging
import unicodedata
from typing import Dict, Any, List

from .constants import (
    is_manual_player,
    MANUAL_PLAYER_ID_START,
    FALLBACK_PROJECTION_PTS,
    FALLBACK_NEXT_3GW_PTS,
    FALLBACK_NEXT_5GW_PTS,
    get_transfer_threshold_base,
    get_volatility_multiplier,
)

logger = logging.getLogger(__name__)


class TransferAdvisor:
    """Recommends optimal transfers based on projections and constraints."""

    def __init__(self, risk_posture: str = "BALANCED", horizon_gws: int = 5):
        self.risk_posture = risk_posture
        self.horizon_gws = horizon_gws
        self.strategy_mode = "BALANCED"
        self.last_transfer_audit: Dict[str, Any] = {}
        self.fixture_horizon_context: Dict[str, Any] = {}

    @staticmethod
    def _clamp(value: float, minimum: float, maximum: float) -> float:
        return max(minimum, min(maximum, value))

    @staticmethod
    def _normalize_name(name: str) -> str:
        if not name:
            return ""
        name_no_accents = unicodedata.normalize('NFD', name).encode('ascii', 'ignore').decode('ascii')
        return name_no_accents.lower().strip()

    def _get_horizon_summary(self, candidate: Any) -> Dict[str, Any]:
        ctx = self.fixture_horizon_context if isinstance(self.fixture_horizon_context, dict) else {}
        summary_by_id = ctx.get("player_summary_by_id") or {}
        candidate_id = getattr(candidate, "player_id", None)
        if candidate_id is None:
            return {}
        return summary_by_id.get(candidate_id) or summary_by_id.get(str(candidate_id)) or {}

    def _horizon_transfer_adjustment(self, candidate: Any) -> float:
        """
        DGW/BGW transfer adjustment with deterministic caps.
        Formula:
        clamp((0.55*near_dgw + 0.30*far_dgw) - (1.10*near_bgw + 0.60*far_bgw), -1.20, +0.90)
        """
        summary = self._get_horizon_summary(candidate)
        if not summary:
            return 0.0

        near_dgw = float(summary.get("near_dgw") or 0.0)
        far_dgw = float(summary.get("far_dgw") or 0.0)
        near_bgw = float(summary.get("near_bgw") or 0.0)
        far_bgw = float(summary.get("far_bgw") or 0.0)

        # DGW bonus gate: minutes >= 60 and not injury-risk.
        xmins = float(getattr(candidate, "xMins_next", 0.0) or 0.0)
        is_injury_risk = bool(getattr(candidate, "is_injury_risk", False))
        if xmins < 60 or is_injury_risk:
            near_dgw = 0.0
            far_dgw = 0.0

        raw_adj = (0.55 * near_dgw + 0.30 * far_dgw) - (1.10 * near_bgw + 0.60 * far_bgw)
        return self._clamp(raw_adj, -1.20, 0.90)

    def _required_gain(self, context_mode: str, free_transfers: int = 1) -> float:
        """Calculate required gain threshold with FT multiplier."""
        base_required = get_transfer_threshold_base(context_mode)

        if free_transfers >= 5:
            ft_multiplier = 0.4
        elif free_transfers >= 4:
            ft_multiplier = 0.5
        elif free_transfers >= 3:
            ft_multiplier = 0.6
        elif free_transfers >= 2:
            ft_multiplier = 0.75
        else:
            ft_multiplier = 1.0

        return round(base_required * ft_multiplier, 2)

    def _score_candidate_for_strategy(self, candidate, strategy_mode: str) -> float:
        """Rank transfer/captain candidates according to strategy profile."""
        strategy = (strategy_mode or "BALANCED").upper()
        next_pts = float(getattr(candidate, "nextGW_pts", 0.0) or 0.0)
        floor = float(getattr(candidate, "floor", next_pts * 0.8) or (next_pts * 0.8))
        ceiling = float(getattr(candidate, "ceiling", next_pts * 1.2) or (next_pts * 1.2))
        ownership = float(getattr(candidate, "ownership_pct", 25.0) or 25.0)
        volatility = float(getattr(candidate, "volatility_score", 0.5) or 0.5)
        ppm = float(getattr(candidate, "points_per_million", 0.0) or 0.0)

        if strategy == "RECOVERY":
            # Rank-chasing mode: allow volatility and reward leverage + upside.
            base_score = (
                (next_pts * 1.00)
                + ((100.0 - ownership) * 0.04)
                + ((ceiling - next_pts) * 0.60)
                - (volatility * (0.20 * get_volatility_multiplier(self.risk_posture)))
            )
        elif strategy == "DEFEND":
            # Protect rank: stronger floor/template bias.
            base_score = (
                (next_pts * 1.00)
                + (floor * 0.30)
                + (ownership * 0.02)
                - (volatility * (1.20 * get_volatility_multiplier(self.risk_posture)))
            )
        elif strategy == "CONTROLLED":
            base_score = (
                (next_pts * 1.00)
                + (ppm * 0.80)
                + (floor * 0.20)
                - (volatility * (0.80 * get_volatility_multiplier(self.risk_posture)))
            )
        else:
            # BALANCED default
            base_score = (
                (next_pts * 1.00)
                + (ppm * 0.90)
                + ((ceiling - floor) * 0.10)
                - (volatility * (0.60 * get_volatility_multiplier(self.risk_posture)))
            )

        horizon_adj = self._horizon_transfer_adjustment(candidate)
        dominance_cap = 0.2 * abs(base_score)
        if dominance_cap <= 0:
            return base_score
        capped_adj = self._clamp(horizon_adj, -dominance_cap, dominance_cap)
        return base_score + capped_adj

    def _build_strategy_paths(
        self,
        squad: List[Dict],
        projections,
        bank_value: float,
        free_transfers: int,
    ) -> Dict[str, Any]:
        """
        Build strategy alternatives (safe/balanced/aggressive) for user override UX.
        """
        if not projections or not squad:
            return {}

        starters = [p for p in squad if p.get("is_starter")]
        if not starters:
            return {}

        # Choose weakest starter as the swap-out reference.
        weakest = None
        weakest_proj = None
        for player in starters:
            proj = projections.get_by_id(player.get("player_id") or player.get("id", 0))
            if not proj:
                continue
            if weakest_proj is None or proj.nextGW_pts < weakest_proj.nextGW_pts:
                weakest = player
                weakest_proj = proj

        if weakest is None or weakest_proj is None:
            return {}

        # Collect current squad identifiers to exclude from transfer-in targets
        squad_player_ids = {
            p.get("player_id") or p.get("id")
            for p in squad
            if (p.get("player_id") or p.get("id")) is not None
        }
        squad_player_names = {
            self._normalize_name(p.get("name", ""))
            for p in squad
            if p.get("name")
        }

        pos = weakest.get("position")
        alternatives = [
            p for p in projections.get_by_position(pos)
            if p.player_id != weakest_proj.player_id
            and p.player_id not in squad_player_ids
            and self._normalize_name(getattr(p, "name", "")) not in squad_player_names
            and p.current_price <= (weakest_proj.current_price + bank_value + 0.5)
            and not p.is_injury_risk
            and p.xMins_next >= 60
        ]
        if not alternatives:
            return {}

        _MODE_RATIONALE: Dict[str, str] = {
            "DEFEND": "Reliable upgrade — stronger floor and minutes certainty, lower ceiling.",
            "BALANCED": "Standard value move — best projected gain within budget.",
            "RECOVERY": "Differential target — upside and rank-gaining leverage over template.",
        }

        def pick_for_mode(mode: str, excluded_player_ids: set) -> Dict[str, Any]:
            pool = [c for c in alternatives if c.player_id not in excluded_player_ids]
            if not pool:
                return {}
            ranked = sorted(
                pool,
                key=lambda c: self._score_candidate_for_strategy(c, mode),
                reverse=True,
            )
            choice = ranked[0]
            delta_pts_4gw = round((choice.nextGW_pts - weakest_proj.nextGW_pts) * 4.0, 1)
            return {
                "out": weakest_proj.name,
                "in": choice.name,
                "player_id_in": choice.player_id,
                "hit_cost": 0 if free_transfers > 0 else 4,
                "delta_pts_4gw": delta_pts_4gw,
                "delta_pts_6gw": round((choice.next6_pts - weakest_proj.next6_pts), 1),
                "confidence": "MEDIUM",
                "rationale": _MODE_RATIONALE.get(mode, f"{mode.title()} strategy path."),
            }

        # Build each mode path with deduplication: each mode picks a distinct "in" player.
        used_ids: set = set()
        defend_pick = pick_for_mode("DEFEND", used_ids)
        if defend_pick.get("player_id_in"):
            used_ids.add(defend_pick["player_id_in"])

        balanced_pick = pick_for_mode("BALANCED", used_ids)
        if balanced_pick.get("player_id_in"):
            used_ids.add(balanced_pick["player_id_in"])

        recovery_pick = pick_for_mode("RECOVERY", used_ids)

        # Strip internal dedup key before returning
        for pick in (defend_pick, balanced_pick, recovery_pick):
            if isinstance(pick, dict):
                pick.pop("player_id_in", None)

        return {
            "safe": defend_pick or None,
            "balanced": balanced_pick or None,
            "aggressive": recovery_pick or None,
        }

    def _simulate_primary_transfer_squad(
        self,
        squad: List[Dict],
        enriched_recs: List[Dict],
        projections,
    ) -> List[Dict]:
        """Apply the primary recommended transfer in-memory for downstream diagnostics."""
        if not squad:
            return squad
        if not enriched_recs:
            return squad

        primary = enriched_recs[0]
        transfer_out = primary.get("transfer_out") or {}
        transfer_in = primary.get("transfer_in") or {}
        out_name = self._normalize_name(transfer_out.get("name", ""))
        in_name = transfer_in.get("name")

        if not out_name or not in_name:
            return squad

        simulated = [dict(player) for player in squad]
        replaced_idx = None
        replaced_player = None
        for idx, player in enumerate(simulated):
            if self._normalize_name(player.get("name", "")) == out_name:
                replaced_idx = idx
                replaced_player = player
                break

        if replaced_idx is None or replaced_player is None:
            return squad

        player_in_id = transfer_in.get("player_id")
        player_in_proj = projections.get_by_id(player_in_id) if player_in_id and projections else None
        new_player = {
            **replaced_player,
            "name": in_name,
            "status_flag": "FIT",
            "news": "",
        }
        if player_in_id:
            new_player["player_id"] = player_in_id
            new_player["id"] = player_in_id
        if player_in_proj is not None:
            new_player["team"] = getattr(player_in_proj, "team", replaced_player.get("team"))
            new_player["position"] = getattr(player_in_proj, "position", replaced_player.get("position"))
            new_player["current_price"] = getattr(player_in_proj, "current_price", replaced_player.get("current_price"))

        simulated[replaced_idx] = new_player
        return simulated

    def _build_near_threshold_moves(
        self,
        squad: List[Dict],
        projections,
        bank_value: float,
        free_transfers: int,
        strategy_mode: str,
    ) -> List[Dict[str, Any]]:
        """
        Provide transparency for moves that almost met thresholds.
        """
        if not projections:
            return []

        required = self._required_gain(strategy_mode, free_transfers)
        candidates: List[Dict[str, Any]] = []

        starters = [p for p in squad if p.get("is_starter")]
        starters_with_proj = []
        for starter in starters:
            starter_proj = projections.get_by_id(starter.get("player_id") or starter.get("id", 0))
            if starter_proj:
                starters_with_proj.append((starter, starter_proj))

        starters_with_proj.sort(key=lambda item: item[1].nextGW_pts)
        for starter, starter_proj in starters_with_proj[:3]:
            alternatives = [
                p for p in projections.get_by_position(starter.get("position"))
                if p.player_id != starter_proj.player_id
                and p.current_price <= (starter_proj.current_price + bank_value + 0.5)
                and p.xMins_next >= 60
            ]
            if not alternatives:
                continue

            best = sorted(
                alternatives,
                key=lambda c: self._score_candidate_for_strategy(c, strategy_mode),
                reverse=True,
            )[0]
            gain = round(best.nextGW_pts - starter_proj.nextGW_pts, 2)
            if gain >= required:
                continue
            if (required - gain) > 1.25:
                continue

            hit_cost = 0 if free_transfers > 0 else 4
            candidates.append({
                "out": starter_proj.name,
                "in": best.name,
                "hit_cost": hit_cost,
                "delta_pts_4gw": round(gain * 4.0, 1),
                "delta_pts_6gw": round(best.next6_pts - starter_proj.next6_pts, 1),
                "threshold_required": required,
                "rejection_reason": (
                    f"Projected gain {gain:.2f} below required {required:.2f} "
                    f"for {strategy_mode.upper()} mode."
                ),
            })

        return candidates[:3]

    def _build_squad_issues(self, squad: List[Dict], projections) -> List[Dict[str, Any]]:
        """Surface structural issues for dashboard diagnostics."""
        issues: List[Dict[str, Any]] = []
        if not squad:
            return issues

        starters = [p for p in squad if p.get("is_starter")]
        bench = [p for p in squad if not p.get("is_starter")]
        fwd_starters = [p for p in starters if p.get("position") == "FWD"]

        if fwd_starters and projections:
            weak_fwd = []
            for fwd in fwd_starters:
                proj = projections.get_by_id(fwd.get("player_id") or fwd.get("id", 0))
                if proj and proj.next6_pts < 20:
                    weak_fwd.append(fwd.get("name"))
            if weak_fwd:
                issues.append({
                    "category": "lineup",
                    "severity": "MEDIUM",
                    "title": "Forward line weak",
                    "detail": "Low 6-GW projection in current FWD starters.",
                    "players": weak_fwd,
                })

        if bench and projections:
            bench_low_minutes = []
            for player in bench:
                proj = projections.get_by_id(player.get("player_id") or player.get("id", 0))
                if proj and proj.xMins_next < 60:
                    bench_low_minutes.append(player.get("name"))
            if bench_low_minutes:
                issues.append({
                    "category": "bench",
                    "severity": "MEDIUM",
                    "title": "Bench minutes risk",
                    "detail": "Bench depth includes low-minute players.",
                    "players": bench_low_minutes,
                })

        flagged = [p.get("name") for p in squad if p.get("status_flag") in {"OUT", "DOUBT"}]
        if flagged:
            issues.append({
                "category": "availability",
                "severity": "HIGH" if any(p.get("status_flag") == "OUT" for p in squad) else "MEDIUM",
                "title": "Availability flags",
                "detail": "Injury/doubt concerns present in squad.",
                "players": flagged,
            })

        return issues

    def apply_manual_transfers(self, team_data: Dict) -> Dict:
        """
        Apply manual transfers to the squad BEFORE analysis begins.
        This fixes the core bug where transfers are saved but not applied.
        """
        # Get manual overrides from team_data
        manual_overrides = team_data.get('manual_overrides', {})
        planned_transfers = manual_overrides.get('planned_transfers', [])
        
        logger.info(f"=== APPLY_MANUAL_TRANSFERS: Found {len(planned_transfers)} planned transfers ===")
        logger.info(f"Manual overrides keys: {list(manual_overrides.keys())}")
        
        if not planned_transfers:
            logger.info("No manual transfers to apply")
            return team_data
        
        # Create a copy preserving ALL keys from original team_data
        # Use dict() constructor to do a shallow copy that includes all keys
        team_data_copy = dict(team_data)
        current_squad = list(team_data_copy.get('current_squad', []))
        
        logger.info(f"Applying {len(planned_transfers)} manual transfers to squad of {len(current_squad)} players")
        
        # Debug: Show original squad structure
        if current_squad:
            sample_player = current_squad[0]
            logger.info(f"DEBUG: Sample original player structure: {list(sample_player.keys())}")
            logger.info(f"DEBUG: Sample player details: web_name='{sample_player.get('web_name')}', team_name='{sample_player.get('team_name')}'")
        
        # Normalize name matching function (strip accents, lowercase, trim)
        def normalize_name(name: str) -> str:
            if not name:
                return ""
            # Strip accents: Rúben → Ruben 
            name_no_accents = unicodedata.normalize('NFD', name).encode('ascii', 'ignore').decode('ascii')
            return name_no_accents.lower().strip()
        
        # Apply each transfer
        for transfer in planned_transfers:
            # Handle both field name conventions:
            # - CLI/ManualTransferManager uses: out_name/in_name
            # - Pydantic serialization uses: player_out/player_in (primary fields)
            out_name = transfer.get('out_name') or transfer.get('player_out', '')
            in_name = transfer.get('in_name') or transfer.get('player_in', '')
            in_price = transfer.get('in_price', 0.0) or transfer.get('player_in_price', 0.0)
            in_position = transfer.get('in_position', '') or transfer.get('player_in_position', '')
            
            if not out_name or not in_name:
                logger.warning(f"Invalid transfer: out_name='{out_name}', in_name='{in_name}', transfer_keys={list(transfer.keys())} - skipping")
                continue
                
            # Find player to remove (normalized matching)
            out_normalized = normalize_name(out_name)
            player_removed = False
            
            for i, player in enumerate(current_squad):
                player_name_normalized = normalize_name(player.get('name', ''))
                if player_name_normalized == out_normalized:
                    logger.info(f"Removing player: {player.get('name')} (matched '{out_name}')")
                    removed_player = current_squad.pop(i)
                    player_removed = True
                    break
            
            if not player_removed:
                logger.warning(f"Could not find player to remove: '{out_name}' (normalized: '{out_normalized}')")
                continue
                
            # Look up the incoming player from all_players database
            all_players = team_data_copy.get('all_players', [])
            in_normalized = normalize_name(in_name)
            matched_player = None
            
            for player in all_players:
                # Try multiple name fields (web_name, name, second_name)
                web_name = normalize_name(player.get('web_name', ''))
                full_name = normalize_name(player.get('name', ''))
                second_name = normalize_name(player.get('second_name', ''))
                first_name = normalize_name(player.get('first_name', ''))
                
                # Match: exact web_name, exact second_name, or contains in full name
                if (web_name == in_normalized or 
                    second_name == in_normalized or
                    full_name == in_normalized or
                    in_normalized in web_name or
                    in_normalized in f"{first_name} {second_name}"):
                    matched_player = player
                    display_name = player.get('web_name') or player.get('name') or in_name
                    logger.info(f"Matched '{in_name}' to player: {display_name} (ID: {player.get('id', 'unknown')})")
                    break
            
            if not matched_player:
                logger.warning(f"Could not find incoming player '{in_name}' in database - using fallback data")
                # Fallback to minimal player structure
                new_player = {
                    'player_id': MANUAL_PLAYER_ID_START,
                    'name': in_name,
                    'team': 'UNK',
                    'team_id': 0,
                    'position': in_position or removed_player.get('position', 'DEF'),
                    'current_price': in_price or 0.0,
                    'is_starter': removed_player.get('is_starter', False),
                    'is_captain': False,
                    'is_vice': False,
                    'bench_order': removed_player.get('bench_order', None),
                    'status_flag': 'a',
                    'news': '',
                    'chance_of_playing_next_round': 100,
                }
            else:
                # Use matched player data from FPL API structure
                # Map element_type: 1=GK, 2=DEF, 3=MID, 4=FWD
                element_type_map = {1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD'}
                position = element_type_map.get(matched_player.get('element_type'), 'DEF')
                
                # Look up team short name from teams data
                teams_data = team_data_copy.get('teams', [])
                team_id = matched_player.get('team', 0)
                team_short = 'UNK'
                for team in teams_data:
                    if team.get('id') == team_id:
                        team_short = team.get('short_name', 'UNK')
                        break
                
                new_player = {
                    'player_id': matched_player.get('id', MANUAL_PLAYER_ID_START),
                    'name': matched_player.get('web_name') or matched_player.get('second_name') or in_name,
                    'team': team_short,
                    'team_id': team_id,
                    'position': position,
                    'current_price': (matched_player.get('now_cost', 0) / 10.0) if matched_player.get('now_cost') else (in_price or 0.0),
                    'is_starter': removed_player.get('is_starter', False),
                    'is_captain': False,
                    'is_vice': False,
                    'bench_order': removed_player.get('bench_order', None),
                    'status_flag': matched_player.get('status', 'a'),
                    'news': matched_player.get('news', ''),
                    'chance_of_playing_next_round': matched_player.get('chance_of_playing_next_round'),
                }
            
            current_squad.append(new_player)
            logger.info(f"Added new player: {new_player['name']} ({new_player['team']}, {new_player['position']}, £{new_player['current_price']}m)")
        
        # Update the squad in team_data copy
        team_data_copy['current_squad'] = current_squad
        
        return team_data_copy

    def assess_critical_transfer_needs(self, squad: List[Dict]) -> int:
        """Count players that critically need transferring out"""
        critical_count = 0
        for player in squad:
            if not player.get('is_starter'):
                continue  # Only check starters
            
            status_flag = player.get('status_flag', 'FIT')
            price = player.get('current_price', 0)
            news = player.get('news', '')
            chance_this_round = player.get('chance_of_playing_this_round')
            chance_next_round = player.get('chance_of_playing_next_round')
            
            # Critical status flags - definite transfers needed
            if status_flag == 'OUT':
                critical_count += 1
            elif status_flag == 'DOUBT':
                # Expensive doubts are critical, cheap ones may be tolerable
                if price > 8.0:
                    critical_count += 1
                elif chance_next_round is not None and chance_next_round == 0:
                    # 0% chance next round is critical regardless of price
                    critical_count += 1
                else:
                    critical_count += 0.5  # Moderate priority
            
            # Additional analysis for players with news but no clear status
            elif news and 'injury' in news.lower():
                # News mentions injury but status isn't OUT/DOUBT
                if price > 10.0:  # Expensive player with injury news
                    critical_count += 0.5
                    
            # Check for long-term unavailability based on chance of playing
            elif chance_this_round == 0 and chance_next_round == 0:
                # 0% chance for both rounds indicates serious issue
                critical_count += 1
            elif chance_next_round == 0 and price > 8.0:
                # No chance next round for expensive player
                critical_count += 0.5
                
            # Performance-based assessment (fallback when no status info)
            elif status_flag == 'FIT' and not news:
                total_points = player.get('total_points', 0)
                # Very expensive underperformers might need replacing
                if price > 10.0 and total_points < (price * 8):  # Rule of thumb: 8pts per £1m
                    critical_count += 0.5  # Half weight since no injury flag
                    
        return int(critical_count)

    def recommend_transfers(
        self,
        team_data: Dict,
        free_transfers: int = 1,
        projections=None
    ) -> List[Dict]:
        """Suggest transfer actions using canonical projections only"""
        # CRITICAL DEBUG: Check if team_data is None
        if team_data is None:
            logger.error("CRITICAL: team_data is None in recommend_transfers!")
            return [{"action": "No transfer recommendations", "reason": "team_data is None"}]
        
        # DEFENSIVE FIX: Auto-apply manual transfers if they haven't been applied yet
        manual_overrides = team_data.get('manual_overrides', {})
        planned_transfers = manual_overrides.get('planned_transfers', [])
        if planned_transfers:
            squad = team_data.get('current_squad', [])
            current_player_names = {p.get('name', '').lower().strip() for p in squad}
            
            # Check if any 'out' players are still in the squad (meaning transfers weren't applied)
            unapplied = []
            for transfer in planned_transfers:
                out_name = transfer.get('out_name', '').lower().strip()
                if out_name in current_player_names:
                    unapplied.append(out_name)
            
            if unapplied:
                logger.warning(f"⚠️ Auto-applying {len(unapplied)} manual transfers that were not yet applied: {unapplied}")
                team_data = self.apply_manual_transfers(team_data)
                # Update squad reference since team_data was replaced
                squad = team_data.get('current_squad', [])
        
        logger.info(f"DEBUG: team_data keys in recommend_transfers: {list(team_data.keys())}")
        
        if not projections:
            return [{"action": "No transfer recommendations", "reason": "Missing projection data"}]
            
        # Use the potentially updated squad
        if 'squad' not in locals():
            squad = team_data.get('current_squad', [])
        manager_context = self._get_manager_context_mode(team_data)
        strategy_mode = (
            (team_data.get("manager_state") or {}).get("strategy_mode")
            or manager_context
            or self.strategy_mode
            or "BALANCED"
        )
        self.strategy_mode = str(strategy_mode).upper()
        self.fixture_horizon_context = (
            team_data.get("fixture_horizon_context")
            if isinstance(team_data.get("fixture_horizon_context"), dict)
            else {}
        )
        bank_value = team_data.get('team_info', {}).get('bank_value', 0.0)
        recommendations = []
        context_block_reason = None

        # Build set of current squad player IDs to avoid recommending owned players
        squad_player_ids = set()
        for p in squad:
            pid = p.get('player_id') or p.get('id')
            if pid:
                squad_player_ids.add(pid)
        logger.info(f"Squad has {len(squad_player_ids)} players - will exclude from transfer targets")

        # Track players already recommended as "in" transfers to avoid duplicates
        recommended_in_ids = set()

        # Flagged players to replace - PRIORITIZE ALL injured/doubtful (bench OR starters)
        # Starters get higher priority but bench injuries should still be addressed
        injured_players = [
            p for p in squad 
            if p.get('status_flag') == 'OUT'
        ]
        
        doubtful_players = [
            p for p in squad 
            if p.get('status_flag') == 'DOUBT'
        ]
        
        # Sort injured players - starters first, then by severity (lower chance = higher priority)
        injured_players.sort(key=lambda p: (
            not p.get('is_starter', False),  # False (starters) sorts before True (bench)
            -(p.get('chance_of_playing_next_round') or 0)  # Lower chance = higher priority
        ))
        
        doubtful_players.sort(key=lambda p: (
            not p.get('is_starter', False),
            -(p.get('chance_of_playing_next_round') or 100)  # Lower chance = higher priority
        ))
        
        # Handle injured/unavailable players first - these are unacceptable risks
        for player in injured_players:
            player_proj = projections.get_by_id(player.get('player_id') or player.get('id', 0))
            if not player_proj:
                continue
                
            news = player.get('news', '')
            position = player.get('position', '')
            news_text = f" - {news}" if news else ""
            
            # Find replacement using canonical projections
            position_alternatives = projections.get_by_position(position)
            price_limit = player_proj.current_price + 0.5
            
            # Filter viable alternatives (exclude squad, already-recommended, and injured players)
            viable_replacements = [
                p for p in position_alternatives
                if (p.current_price <= price_limit and
                    p.nextGW_pts > player_proj.nextGW_pts and
                    p.player_id not in squad_player_ids and
                    p.player_id not in recommended_in_ids and
                    not p.is_injury_risk and
                    p.xMins_next >= 60)  # Only recommend available players (60+ expected mins)
            ]

            if viable_replacements:
                # Provide strategic alternatives while choosing primary by strategy profile.
                viable_replacements.sort(
                    key=lambda x: self._score_candidate_for_strategy(x, self.strategy_mode),
                    reverse=True
                )
                best_strategy = viable_replacements[0]
                viable_replacements.sort(key=lambda x: x.points_per_million, reverse=True)
                
                # Best value option (highest points per million)
                best_value = viable_replacements[0]
                
                # Best premium option (highest raw points, even if expensive)
                viable_replacements.sort(key=lambda x: x.nextGW_pts, reverse=True)
                best_premium = viable_replacements[0]
                
                # If they're the same player, find the second-best premium
                if best_premium.player_id == best_value.player_id and len(viable_replacements) > 1:
                    best_premium = viable_replacements[1]
                
                # Build strategic options list
                strategic_options = [best_strategy]
                if best_value.player_id != best_strategy.player_id:
                    strategic_options.append(best_value)
                if best_premium.player_id != best_value.player_id:
                    strategic_options.append(best_premium)
                
                # Add one more balanced option if available
                if len(viable_replacements) > 2:
                    for p in viable_replacements:
                        if p.player_id not in [best_value.player_id, best_premium.player_id]:
                            strategic_options.append(p)
                            break
                
                # Format suggestion with strategy labels
                suggestions = []
                for p in strategic_options[:3]:
                    if p.player_id == best_value.player_id and p.player_id != best_premium.player_id:
                        label = "VALUE"
                    elif p.player_id == best_premium.player_id and p.player_id != best_value.player_id:
                        label = "PREMIUM"
                    else:
                        label = "BALANCED"
                    suggestions.append(f"{p.name} £{p.current_price:.1f}m ({p.nextGW_pts:.1f}pts, {label})")
                
                suggestion_text = f"Options: {' | '.join(suggestions)}"

                # Track the primary recommendation to avoid duplicates
                recommended_in_ids.add(strategic_options[0].player_id)

                plan = self.build_transfer_plan(
                    player,
                    player_proj,
                    strategic_options[0],
                    strategic_options[1:],
                    self.strategy_mode,
                    free_transfers,
                    bank_value
                )
            else:
                suggestion_text = f"Find reliable £{price_limit:.1f}m {position} - any starter better than 0 points"
                plan = self.build_general_plan(
                    self.strategy_mode,
                    bank_value,
                    f"No vetted replacement available for {player['name']}; hold until a plan emerges."
                )

            # CRITICAL: Injured/unavailable players BYPASS threshold checks
            # Getting guaranteed 0 points is worse than any replacement
            recommendations.append({
                "action": f"⚠️ URGENT: Transfer out {player['name']} immediately",
                "reason": f"Player unavailable (guaranteed 0 points){news_text}",
                "profile": suggestion_text,
                "plan": plan,
                "priority": "URGENT"  # Mark as urgent for sorting
            })
        
        # Handle doubtful players based on severity
        for player in doubtful_players:
            player_proj = projections.get_by_id(player.get('player_id') or player.get('id', 0))
            if not player_proj:
                continue
            news = player.get('news', '')
            chance_next = player.get('chance_of_playing_next_round')
            news_text = f" - {news}" if news else ""
            
            position = player.get('position', '')
            position_alternatives = projections.get_by_position(position)
            price_limit = player_proj.current_price + 0.4

            # Filter viable alternatives (exclude squad, already-recommended, and injured players)
            viable_replacements = [
                p for p in position_alternatives
                if (p.current_price <= price_limit and
                    p.player_id not in squad_player_ids and
                    p.player_id not in recommended_in_ids and
                    p.nextGW_pts >= player_proj.nextGW_pts - 0.5 and
                    not p.is_injury_risk and
                    p.xMins_next >= 60)  # Only recommend available players (60+ expected mins)
            ]

            if viable_replacements:
                viable_replacements.sort(
                    key=lambda x: self._score_candidate_for_strategy(x, self.strategy_mode),
                    reverse=True
                )
                top_options = viable_replacements[:2]
                replacement_names = [f"{p.name} (£{p.current_price:.1f}m, {p.nextGW_pts:.1f}pts)"
                                   for p in top_options]
                suggestion_text = f"Consider: {' or '.join(replacement_names)}"

                # Track the primary recommendation to avoid duplicates
                recommended_in_ids.add(top_options[0].player_id)

                plan = self.build_transfer_plan(
                    player,
                    player_proj,
                    top_options[0],
                    top_options[1:],
                    self.strategy_mode,
                    free_transfers,
                    bank_value
                )
            else:
                suggestion_text = f"Monitor closely - find £{price_limit:.1f}m {position} if news worsens"
                plan = self.build_general_plan(
                    self.strategy_mode,
                    bank_value,
                    f"Wait for clarity on {player['name']} before committing transfer."
                )

            # Doubtful players with very low chance (<30%) should bypass threshold like injured
            is_very_doubtful = chance_next is not None and chance_next < 30
            priority = "URGENT" if is_very_doubtful else "MONITOR"
            gain = 0.0
            if viable_replacements and top_options:
                gain = round(top_options[0].nextGW_pts - player_proj.nextGW_pts, 2)
            
            if is_very_doubtful:
                # Very low chance - treat as urgent, bypass threshold
                recommendations.append({
                    "action": f"⚠️ URGENT: Transfer out {player['name']} - very unlikely to play",
                    "reason": f"{player['name']} only {chance_next}% chance of playing{news_text}",
                    "profile": suggestion_text,
                    "plan": plan,
                    "priority": "URGENT"
                })
            else:
                if gain and not self.context_allows_transfer(self.strategy_mode, gain, free_transfers):
                    logger.info(
                        "Doubtful move near threshold skipped: %s gain %.2f < %.2f",
                        player.get("name"),
                        gain,
                        self._required_gain(self.strategy_mode, free_transfers),
                    )
                    continue
                # Monitor but not urgent
                recommendations.append({
                    "action": f"⚠️ MONITOR: {player['name']} flagged as doubtful",
                    "reason": f"{player['name']} injury concern{news_text}. Chance next GW: {chance_next or 'Unknown'}%",
                    "profile": suggestion_text,
                    "plan": plan,
                    "priority": "MONITOR"
                })

        # === BENCH UPGRADES ===
        # With multiple free transfers, suggest upgrading weak bench assets
        remaining_fts = free_transfers - len(recommendations)
        if remaining_fts > 0:
            bench_upgrades = self._identify_bench_upgrades(
                squad, projections, remaining_fts, bank_value,
                squad_player_ids, recommended_in_ids, self.strategy_mode
            )
            for upgrade in bench_upgrades:
                recommendations.append(upgrade)

        # Enrich recommendations with actual player data from plan
        enriched_recs = []
        for rec in recommendations:
            enriched_rec = rec.copy()
            plan = rec.get('plan', {})
            transfers_in = plan.get('transfers_in', [])
            transfers_out = plan.get('transfers_out', [])
            
            # Get OUT player details
            out_player_name = "Unknown"
            out_player_team = ""
            out_player_pos = ""
            out_player_price = 0
            out_reason = rec.get('reason', '')
            
            if transfers_out and projections:
                player_out_id = transfers_out[0]
                player_out = projections.get_by_id(player_out_id)
                if player_out:
                    out_player_name = player_out.name
                    out_player_team = player_out.team
                    out_player_pos = player_out.position
                    out_player_price = player_out.current_price
            
            # Get IN player details
            if transfers_in and projections:
                player_in_id = transfers_in[0]  # Get first transfer in
                player_in = projections.get_by_id(player_in_id)
                if player_in:
                    # Build reasoning for the replacement
                    gain = plan.get('projected_gain_horizon', 0)
                    ppm_value = player_in.points_per_million
                    
                    # Construct clear transfer description
                    enriched_rec['transfer_out'] = {
                        'name': out_player_name,
                        'team': out_player_team,
                        'position': out_player_pos,
                        'price': out_player_price,
                        'reason': out_reason
                    }
                    
                    enriched_rec['transfer_in'] = {
                        'player_id': player_in.player_id,
                        'name': player_in.name,
                        'team': player_in.team,
                        'position': player_in.position,
                        'price': player_in.current_price,
                        'expected_points': player_in.nextGW_pts,
                        'ppm': ppm_value,
                        'gain': gain
                    }
                    
                    # Also set flat fields for backward compatibility
                    enriched_rec['player_name'] = player_in.name
                    enriched_rec['team'] = player_in.team
                    enriched_rec['position'] = player_in.position
                    enriched_rec['price'] = player_in.current_price
                    enriched_rec['expected_points'] = player_in.nextGW_pts
                    
                    # Build better reasoning
                    reasons = []
                    if gain > 0:
                        reasons.append(f"+{gain:.1f} pts expected gain over {out_player_name}")
                    if ppm_value > 1.0:
                        reasons.append(f"Good value at {ppm_value:.2f} pts/£m")
                    
                    # Add fixture quality if available
                    if hasattr(player_in, 'fixture_difficulty') and player_in.fixture_difficulty:
                        if player_in.fixture_difficulty < 3:
                            reasons.append("Favorable fixtures ahead")

                    horizon_summary = self._get_horizon_summary(player_in)
                    near_bgw = int(horizon_summary.get("near_bgw") or 0)
                    near_dgw = int(horizon_summary.get("near_dgw") or 0)
                    if near_bgw > 0:
                        reasons.append("Improves projection without increasing near-term blank exposure")
                    elif near_dgw > 0:
                        reasons.append("Adds double-gameweek upside in the planning horizon")
                    else:
                        reasons.append("Neutral DGW/BGW horizon impact with short-term output gain")
                    
                    if reasons:
                        enriched_rec['in_reason'] = ' | '.join(reasons)
                    else:
                        enriched_rec['in_reason'] = f"Best available replacement in {player_in.position}"
            
            enriched_recs.append(enriched_rec)

        if context_block_reason and not enriched_recs:
            enriched_recs.append({
                "action": "Hold transfers this week",
                "reason": context_block_reason,
                "profile": "No immediate unacceptable risks; conserve transfer flexibility"
            })

        post_transfer_squad = self._simulate_primary_transfer_squad(
            squad=squad,
            enriched_recs=enriched_recs,
            projections=projections,
        )

        near_threshold_moves = self._build_near_threshold_moves(
            squad=squad,
            projections=projections,
            bank_value=bank_value,
            free_transfers=free_transfers,
            strategy_mode=self.strategy_mode,
        )
        strategy_paths = self._build_strategy_paths(
            squad=post_transfer_squad,
            projections=projections,
            bank_value=bank_value,
            free_transfers=free_transfers,
        )
        squad_issues = self._build_squad_issues(squad=post_transfer_squad, projections=projections)
        no_transfer_reason = None
        if not enriched_recs:
            required = self._required_gain(self.strategy_mode, free_transfers)
            no_transfer_reason = (
                f"No transfer met the {self.strategy_mode} threshold "
                f"(required gain {required:.2f} pts with {free_transfers} FT)."
            )

        self.last_transfer_audit = {
            "strategy_mode": self.strategy_mode,
            "threshold_required": self._required_gain(self.strategy_mode, free_transfers),
            "near_threshold_moves": near_threshold_moves,
            "strategy_paths": strategy_paths,
            "squad_issues": squad_issues,
            "no_transfer_reason": no_transfer_reason,
        }

        return enriched_recs

    def context_allows_transfer(self, context_mode: str, projected_gain: float, free_transfers: int = 1) -> bool:
        """Determine whether the requested transfer gain satisfies context thresholds.
        
        With multiple free transfers, we should be MORE aggressive as the cost is lower.
        Adjust thresholds based on available free transfers.
        """
        required = self._required_gain(context_mode, free_transfers)
        logger.info(
            "Transfer threshold check: %.2f vs %.2f (mode=%s, FTs=%s)",
            projected_gain,
            required,
            context_mode,
            free_transfers,
        )
        
        return projected_gain >= required

    def build_transfer_plan(
        self,
        player_out: Dict,
        player_proj,
        best_candidate,
        alternatives = None,
        context_mode: str = "BALANCED",
        free_transfers: int = 1,
        bank_value: float = 0.0
    ) -> Dict:
        """Return a lightweight plan object describing the transfer sequence."""
        if not best_candidate:
            return self.build_general_plan(context_mode, bank_value, "No replacement identified.")
        gain = max(0.0, best_candidate.nextGW_pts - (player_proj.nextGW_pts or 0))
        horizon = "LONG" if gain >= 3 else "MEDIUM" if gain >= 1.5 else "SHORT"
        transfers_out = [player_out.get('player_id')] if player_out.get('player_id') else []
        transfers_in = [best_candidate.player_id]
        
        # Format alternatives with strategic labels
        alternative_details = []
        if alternatives:
            # Determine strategic labels based on price and points
            all_options = [best_candidate] + list(alternatives)
            all_options_sorted_by_value = sorted(all_options, key=lambda p: p.points_per_million, reverse=True)
            all_options_sorted_by_points = sorted(all_options, key=lambda p: p.nextGW_pts, reverse=True)
            
            best_value_id = all_options_sorted_by_value[0].player_id
            best_premium_id = all_options_sorted_by_points[0].player_id
            
            for alt in alternatives[:2]:  # Max 2 alternatives
                if alt.player_id == best_value_id and alt.player_id != best_premium_id:
                    label = "VALUE"
                elif alt.player_id == best_premium_id and alt.player_id != best_value_id:
                    label = "PREMIUM"
                else:
                    label = "BALANCED"
                
                alternative_details.append({
                    'name': alt.name,
                    'price': round(alt.current_price, 1),
                    'points': round(alt.nextGW_pts, 1),
                    'strategy': label
                })
        
        # Derive why_now from outgoing player state and gain magnitude
        if getattr(player_proj, 'is_injury_risk', False):
            why_now = f"Injury risk on {getattr(player_proj, 'name', 'outgoing player')} — act before deadline."
        elif gain >= 3:
            why_now = "Strong projected gain over the horizon; act before price movement."
        elif gain >= 1.5:
            why_now = "Positive gain identified; good window to upgrade."
        else:
            why_now = "Marginal improvement — valid in context of balanced squad management."

        # Derive risk_note from incoming candidate availability
        if getattr(best_candidate, 'is_injury_risk', False):
            risk_note = "Target flagged as a fitness concern — monitor before deadline."
        elif getattr(best_candidate, 'xMins_next', 90) < 70:
            risk_note = "Target has minutes uncertainty — rotation risk in play."
        else:
            risk_note = "No material availability concerns on incoming player."

        return {
            "transfers_out": transfers_out,
            "transfers_in": transfers_in,
            "projected_gain_horizon": gain,
            "horizon": horizon,
            "budget_after": round(bank_value - (best_candidate.current_price - (player_proj.current_price or 0)), 2),
            "context": context_mode,
            "suggested_alternatives": alternative_details if alternative_details else [],
            "free_transfers_remaining": free_transfers,
            "why_now": why_now,
            "risk_note": risk_note,
            "horizon_gws": self.horizon_gws,
        }

    def build_general_plan(self, context_mode: str, bank_value: float, message: str) -> Dict:
        """Fallback plan when a confident replacement cannot be constructed."""
        return {
            "transfers_out": [],
            "transfers_in": [],
            "projected_gain_horizon": 0.0,
            "horizon": "WAIT",
            "budget_after": round(bank_value, 2),
            "context": context_mode,
            "notes": message,
            "why_now": message,
            "risk_note": "No transfer identified — squad management hold advised.",
            "horizon_gws": self.horizon_gws,
        }

    def _get_manager_context_mode(self, team_data: Dict) -> str:
        """Get manager context mode (CHASE/DEFEND/BALANCED)"""
        manager_context = team_data.get('manager_context') or {}
        # Ensure manager_context is a dict (it might be a string from config)
        if not isinstance(manager_context, dict):
            manager_context = {}
        return manager_context.get('mode', self.strategy_mode or 'BALANCED')

    def _create_fallback_projection(self, player: Dict) -> Dict:
        """
        Create conservative projection for manually added players.
        Uses constants rather than hardcoded values.
        """
        player_id = player.get('player_id', 0)
        if not is_manual_player(player_id):
            raise ValueError(f"Only call for manual players, got ID {player_id}")

        return {
            'player_id': player_id,
            'name': player.get('name', 'Manual Player'),  # Use actual name!
            'position': player.get('position', 'DEF'),
            'team': player.get('team', 'UNK'),
            'nextGW_pts': FALLBACK_PROJECTION_PTS,
            'next3GW_pts': FALLBACK_NEXT_3GW_PTS,
            'next5GW_pts': FALLBACK_NEXT_5GW_PTS,
            'is_manual': True,
        }

    def _ensure_projections(self, squad: List[Dict], projections: Dict[int, Any]) -> List[Dict]:
        """Ensure all squad members have projections, using fallback for manual players."""
        result = []
        for player in squad:
            player_id = player.get('player_id')
            if player_id in projections:
                merged = {**player, **projections[player_id]}
                result.append(merged)
            elif player_id and is_manual_player(player_id):
                fallback = self._create_fallback_projection(player)
                result.append(fallback)
            else:
                logger.warning("No projection for player %s", player_id)
                result.append(player)
        return result

    def _identify_bench_upgrades(
        self,
        squad: List[Dict],
        projections,
        remaining_fts: int,
        bank_value: float,
        squad_player_ids: set = None,
        recommended_in_ids: set = None,
        strategy_mode: str = "BALANCED",
    ) -> List[Dict]:
        """
        Identify bench players that could be upgraded with available free transfers.

        Args:
            squad: Current squad list
            projections: CanonicalProjectionSet with player projections
            remaining_fts: Number of free transfers still available
            bank_value: Available bank balance
            squad_player_ids: Set of player IDs already in squad (to exclude from targets)
            recommended_in_ids: Set of player IDs already recommended as "in" (to avoid duplicates)

        Returns:
            List of transfer recommendations for bench upgrades
        """
        # Build squad_player_ids if not provided
        if squad_player_ids is None:
            squad_player_ids = set()
            for p in squad:
                pid = p.get('player_id') or p.get('id')
                if pid:
                    squad_player_ids.add(pid)
        if recommended_in_ids is None:
            recommended_in_ids = set()
        if remaining_fts <= 0:
            return []

        recommendations = []

        # Get bench players (not starters)
        bench_players = [p for p in squad if not p.get('is_starter')]

        # Sort bench by projected points (worst first)
        bench_with_projections = []
        for player in bench_players:
            player_id = player.get('player_id') or player.get('id', 0)
            player_proj = projections.get_by_id(player_id)
            if player_proj:
                bench_with_projections.append((player, player_proj))
            else:
                # Create minimal projection for sorting
                bench_with_projections.append((player, type('MinProj', (), {
                    'nextGW_pts': 0,
                    'current_price': player.get('current_price', 5.0),
                    'player_id': player_id,
                    'name': player.get('name', 'Unknown'),
                    'position': player.get('position', 'DEF'),
                    'team': player.get('team', 'UNK'),
                    'points_per_million': 0
                })()))

        # Sort by projected points (lowest first - these are upgrade candidates)
        bench_with_projections.sort(key=lambda x: x[1].nextGW_pts)

        # Thresholds for considering an upgrade
        weak_thresholds = {
            "DEFEND": 2.5,
            "CONTROLLED": 3.0,
            "BALANCED": 3.2,
            "RECOVERY": 4.0,
        }
        WEAK_BENCH_THRESHOLD = weak_thresholds.get(strategy_mode, 3.2)
        MIN_UPGRADE_GAIN = max(0.6, self._required_gain(strategy_mode, remaining_fts))

        upgrades_suggested = 0

        for player, player_proj in bench_with_projections:
            if upgrades_suggested >= remaining_fts:
                break

            # Only target weak bench players
            if player_proj.nextGW_pts >= WEAK_BENCH_THRESHOLD:
                continue

            position = player.get('position', '')
            if not position:
                continue

            # Find better alternatives at this position
            position_alternatives = projections.get_by_position(position)
            price_limit = player_proj.current_price + bank_value + 0.5  # Allow slight overspend

            # Filter viable upgrades (exclude squad, already-recommended, and injured players)
            viable_upgrades = [
                p for p in position_alternatives
                if (p.current_price <= price_limit and
                    p.player_id not in squad_player_ids and
                    p.player_id not in recommended_in_ids and
                    p.nextGW_pts >= player_proj.nextGW_pts + MIN_UPGRADE_GAIN and
                    not p.is_injury_risk and
                    p.xMins_next >= 60)  # Only recommend available players (60+ expected mins)
            ]

            if not viable_upgrades:
                continue

            # Provide strategic alternatives: best value AND best premium option
            viable_upgrades.sort(key=lambda x: x.points_per_million, reverse=True)
            best_value = viable_upgrades[0]
            
            # Best premium option (highest raw points)
            viable_upgrades.sort(key=lambda x: x.nextGW_pts, reverse=True)
            best_premium = viable_upgrades[0]
            
            # If they're the same player, find second-best premium
            if best_premium.player_id == best_value.player_id and len(viable_upgrades) > 1:
                best_premium = viable_upgrades[1]
            
            # Build strategic options list
            strategic_options = [best_value]
            if best_premium.player_id != best_value.player_id:
                strategic_options.append(best_premium)
            
            # Add one more balanced option if available
            if len(viable_upgrades) > 2:
                for p in viable_upgrades:
                    if p.player_id not in [best_value.player_id, best_premium.player_id]:
                        strategic_options.append(p)
                        break

            gain = strategic_options[0].nextGW_pts - player_proj.nextGW_pts

            # Track the recommendation to avoid duplicates
            recommended_in_ids.add(strategic_options[0].player_id)

            # Build the transfer plan
            plan = self.build_transfer_plan(
                player,
                player_proj,
                strategic_options[0],
                strategic_options[1:],
                strategy_mode,
                remaining_fts - upgrades_suggested,
                bank_value
            )

            # Build recommendation
            alternative_names = [f"{p.name} (£{p.current_price:.1f}m)" for p in strategic_options[1:3]]
            best_upgrade = strategic_options[0]  # Primary recommendation
            suggestion_text = f"Upgrade to {best_upgrade.name} (£{best_upgrade.current_price:.1f}m, {best_upgrade.nextGW_pts:.1f}pts)"
            if alternative_names:
                suggestion_text += f" or consider: {', '.join(alternative_names)}"

            recommendations.append({
                "action": f"📈 UPGRADE BENCH: Replace {player['name']} ({player_proj.nextGW_pts:.1f}pts)",
                "reason": f"Weak bench asset - only {player_proj.nextGW_pts:.1f}pts projected. Free transfer available.",
                "profile": suggestion_text,
                "plan": plan,
                "priority": "OPTIONAL"  # Mark as optional, not urgent
            })

            upgrades_suggested += 1
            logger.info(f"Suggested bench upgrade: {player['name']} -> {best_upgrade.name} (+{gain:.1f}pts)")

        return recommendations
