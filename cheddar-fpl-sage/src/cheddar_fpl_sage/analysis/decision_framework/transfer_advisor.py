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
    FALLBACK_NEXT_5GW_PTS
)

logger = logging.getLogger(__name__)


class TransferAdvisor:
    """Recommends optimal transfers based on projections and constraints."""

    def __init__(self, risk_posture: str = "BALANCED", horizon_gws: int = 5):
        self.risk_posture = risk_posture
        self.horizon_gws = horizon_gws

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
                # Provide strategic alternatives: best value AND best premium option
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
                strategic_options = [best_value]
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
                    manager_context,
                    free_transfers,
                    bank_value
                )
            else:
                suggestion_text = f"Find reliable £{price_limit:.1f}m {position} - any starter better than 0 points"
                plan = self.build_general_plan(
                    manager_context,
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
                viable_replacements.sort(key=lambda x: x.points_per_million, reverse=True)
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
                    manager_context,
                    free_transfers,
                    bank_value
                )
            else:
                suggestion_text = f"Monitor closely - find £{price_limit:.1f}m {position} if news worsens"
                plan = self.build_general_plan(
                    manager_context,
                    bank_value,
                    f"Wait for clarity on {player['name']} before committing transfer."
                )

            # Doubtful players with very low chance (<30%) should bypass threshold like injured
            is_very_doubtful = chance_next is not None and chance_next < 30
            priority = "URGENT" if is_very_doubtful else "MONITOR"
            
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
                squad_player_ids, recommended_in_ids
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

        return enriched_recs

    def context_allows_transfer(self, context_mode: str, projected_gain: float, free_transfers: int = 1) -> bool:
        """Determine whether the requested transfer gain satisfies context thresholds.
        
        With multiple free transfers, we should be MORE aggressive as the cost is lower.
        Adjust thresholds based on available free transfers.
        """
        base_thresholds = {
            "CHASE": 1.2,
            "AGGRESSIVE": 1.2,      # LOWERED from 2.0 - more proactive
            "RISK_ON": 0.8,
            "DEFEND": 3.5,
            "FORCE_CHIP": 0.5,
            "TC_COMMITMENT": 0.0,
            "BALANCED": 2.0,        # LOWERED from 2.5
            "DEFAULT": 2.0,
            "CONSERVATIVE": 2.8
        }
        
        base_required = base_thresholds.get(context_mode, base_thresholds["DEFAULT"])
        
        # Apply free transfer multiplier - more FTs = lower threshold
        if free_transfers >= 5:
            ft_multiplier = 0.4  # With 5 FTs, accept 40% of normal threshold
        elif free_transfers >= 4:
            ft_multiplier = 0.5  # With 4 FTs, accept 50% of normal threshold
        elif free_transfers >= 3:
            ft_multiplier = 0.6  # With 3 FTs, accept 60% of normal threshold
        elif free_transfers >= 2:
            ft_multiplier = 0.75 # With 2 FTs, accept 75% of normal threshold
        else:
            ft_multiplier = 1.0  # Normal threshold with 1 FT
        
        required = base_required * ft_multiplier
        logger.info(f"Transfer threshold check: {projected_gain:.2f} vs {required:.2f} (base={base_required:.2f}, FTs={free_transfers})")
        
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
        
        return {
            "transfers_out": transfers_out,
            "transfers_in": transfers_in,
            "projected_gain_horizon": gain,
            "horizon": horizon,
            "budget_after": round(bank_value - (best_candidate.current_price - (player_proj.current_price or 0)), 2),
            "context": context_mode,
            "suggested_alternatives": alternative_details if alternative_details else [],
            "free_transfers_remaining": free_transfers
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
            "notes": message
        }

    def _get_manager_context_mode(self, team_data: Dict) -> str:
        """Get manager context mode (CHASE/DEFEND/BALANCED)"""
        manager_context = team_data.get('manager_context') or {}
        # Ensure manager_context is a dict (it might be a string from config)
        if not isinstance(manager_context, dict):
            manager_context = {}
        return manager_context.get('mode', 'BALANCED')

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
        recommended_in_ids: set = None
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
        WEAK_BENCH_THRESHOLD = 3.0  # Below 3 pts projected = weak
        MIN_UPGRADE_GAIN = 1.5      # Need at least 1.5 pts improvement

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
                self.risk_posture,
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
