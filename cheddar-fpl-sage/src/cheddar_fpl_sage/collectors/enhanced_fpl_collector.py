#!/usr/bin/env python3
"""
Enhanced FPL Data Collector with Team-Specific Data
Extends the simple collector to include your personal team data and chip status
"""

import asyncio
import aiohttp
import json
import logging
from datetime import datetime
from typing import Dict, List, Optional

from ..utils.sprint3_5_config_manager import Sprint35ConfigManager

# DO NOT call logging.basicConfig here - it's configured in fpl_sage.py entry point
# Multiple basicConfig calls create duplicate handlers causing repeated log messages
logger = logging.getLogger(__name__)

class EnhancedFPLCollector:
    """FPL data collector with personal team data integration"""
    
    def __init__(self, team_id: Optional[int] = None):
        self.base_url = "https://fantasy.premierleague.com/api"
        self.team_id = team_id  # Your FPL team ID
        self.session = None
    
    async def __aenter__(self):
        self.session = aiohttp.ClientSession()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.session:
            await self.session.close()
    
    async def fetch_json(self, endpoint: str) -> Dict:
        """Fetch JSON from FPL API endpoint"""
        url = f"{self.base_url}{endpoint}"
        logger.info(f"Fetching {url}")
        
        async with self.session.get(url) as response:
            response.raise_for_status()
            return await response.json()
    
    async def get_team_data(self, team_id: Optional[int] = None, config: Dict = None) -> Dict:
        """Get your personal team data including chips and current squad"""
        if not team_id and not self.team_id:
            raise ValueError("Team ID required for personal team data")
        
        team_id = team_id or self.team_id
        
        # Get team overview
        team_data = await self.fetch_json(f"/entry/{team_id}/")
        # Get season history (contains chip usage)
        history_data = await self.fetch_json(f"/entry/{team_id}/history/")
        
        # Get current gameweek (in-progress) and next (upcoming) to pick freshest lineup
        bootstrap = await self.fetch_json("/bootstrap-static/")
        current_gw = 1
        next_gw = None
        for event in bootstrap['events']:
            if event.get('is_current'):
                current_gw = event['id']
            if event.get('is_next'):
                next_gw = event['id']
        picks_gw = next_gw or current_gw
        
        # Get team picks (use next GW if open, otherwise current; fallback if 404)
        try:
            picks_data = await self.fetch_json(f"/entry/{team_id}/event/{picks_gw}/picks/")
        except Exception:
            if next_gw and picks_gw == next_gw:
                # A5: Suppress 404 warning - lineup_source message in output handles it
                logger.debug(f"Next GW picks not available (GW{next_gw}), using current GW{current_gw}")
                picks_gw = current_gw
                picks_data = await self.fetch_json(f"/entry/{team_id}/event/{picks_gw}/picks/")
            else:
                raise
        
        # Get recent transfers
        transfers_data = await self.fetch_json(f"/entry/{team_id}/transfers/")
        
        # Process chip status (prefer manual when provided)
        manual_chip_status = None
        manual_free_transfers = None
        manual_injury_overrides = None
        if config:
            manual_chip_status = config.get('manual_chip_status')
            manual_free_transfers = config.get('manual_free_transfers')
            # Normalize injury overrides to carry status/note/chance
            raw_overrides = config.get('manual_injury_overrides', {})
            manual_injury_overrides = {}
            for name_key, override in raw_overrides.items():
                status = override.get('status_flag') or override.get('status') or ''
                chance = override.get('chance_of_playing_next_round') or override.get('chance')
                note = override.get('injury_note') or override.get('news') or ''
                manual_injury_overrides[name_key.lower()] = {
                    "status_flag": status,
                    "chance_of_playing_next_round": chance,
                    "injury_note": note
                }
        
        chip_status = self._process_chip_status(
            history_data.get('chips', []),
            manual_chip_status
        )
        chip_source = "manual" if manual_chip_status else "api_history"
        
        # Process current team
        current_squad = self._process_current_squad(picks_data, bootstrap)
        current_squad, transfers_applied = self._apply_pending_transfers(current_squad, transfers_data, bootstrap)
        current_squad, manual_overrides_applied = self._apply_manual_overrides(current_squad, config.get('manual_overrides', {}) if config else {}, bootstrap)
        # Apply manual injury overrides by name (case-insensitive)
        injury_source = 'api'
        applied_overrides = {}
        if manual_injury_overrides:
            injury_source = 'manual'
            name_map = {p.get('name', '').lower(): p for p in current_squad}
            for name_key, override in manual_injury_overrides.items():
                player = name_map.get(name_key.lower())
                if player:
                    if override.get('status_flag'):
                        player['status_flag'] = override['status_flag']
                    if override.get('chance_of_playing_next_round') is not None:
                        player['chance_of_playing_next_round'] = override['chance_of_playing_next_round']
                    if override.get('injury_note'):
                        player['news'] = override['injury_note']
                    player['injury_data_source'] = 'manual'
                    pid = player.get("player_id")
                    if pid is not None:
                        applied_overrides[pid] = {
                            "player_id": pid,
                            "name": player.get("name"),
                            "status_flag": player.get("status_flag"),
                            "chance": player.get("chance_of_playing_next_round"),
                            "injury_note": player.get("news"),
                            "source": "manual"
                        }
        
        # Build captain info from updated squad if we had to apply transfers manually
        captain_info = (self._get_captain_info_from_squad(current_squad)
                        if (transfers_applied or manual_overrides_applied) and picks_gw != next_gw
                        else self._get_captain_info(picks_data, bootstrap))
        
        # Process recent transfers
        recent_transfers = self._process_recent_transfers(transfers_data[-5:] if transfers_data else [])
        
        # Get manager context and derive risk posture if needed
        config_manager = Sprint35ConfigManager()
        overall_rank = team_data.get('summary_overall_rank', 0)
        
        # Auto-derive risk posture from league position
        if overall_rank and overall_rank > 0:
            derived_posture = config_manager.derive_risk_posture_from_rank(overall_rank)
            config_manager.update_manager_context(overall_rank=overall_rank)
        
        manager_context = config_manager.get_manager_context()
        
        # Construct manager name from API data
        first_name = team_data.get('player_first_name', '')
        last_name = team_data.get('player_last_name', '')
        combined_name = f"{first_name} {last_name}".strip()
        
        team_info = {
            'team_info': {
                'team_id': team_id,
                'team_name': team_data.get('name', ''),
                'manager_name': combined_name or 'Unknown Manager',
                'current_points': team_data.get('summary_event_points', 0),
                'total_points': team_data.get('summary_overall_points', 0),
                'overall_rank': team_data.get('summary_overall_rank', 0),
                'bank_value': (picks_data.get('entry_history', {}) or {}).get('bank', 0) / 10,  # Convert to millions
                'team_value': (picks_data.get('entry_history', {}) or {}).get('value', 0) / 10,
                'free_transfers': (picks_data.get('entry_history', {}) or {}).get('event_transfers', 0),
                'hits_taken': (picks_data.get('entry_history', {}) or {}).get('event_transfers_cost', 0) / 4,
                'risk_posture': manager_context.get('risk_posture', 'BALANCED'),
                'manager_context': manager_context.get('manager_context', 'BALANCED')
            },
            'chip_status': chip_status,
            'chip_data_source': config.get('chip_data_source', chip_source) if config else chip_source,
            'current_squad': current_squad,
            'recent_transfers': recent_transfers,
            'active_chip': picks_data.get('active_chip'),
            'captain_info': captain_info,
            'last_updated': datetime.now().isoformat(),
            'picks_gameweek': picks_gw,
            'current_gameweek': current_gw,
            'next_gameweek': next_gw,
            'lineup_source': (
                "next_gw_picks" if picks_gw == next_gw else
                "current_gw_picks_with_transfers_and_manual" if manual_overrides_applied else
                "current_gw_picks_with_transfers" if transfers_applied else
                "current_gw_picks"
            ),
            'manual_overrides_applied': manual_overrides_applied
        }
        # Override free transfers if user provided manual value
        if manual_free_transfers is not None:
            team_info['team_info']['free_transfers'] = manual_free_transfers
            team_info['team_info']['free_transfers_source'] = 'manual'
        else:
            team_info['team_info']['free_transfers_source'] = 'api'
        # Mark chip data source
        team_info['chip_data_source'] = 'manual' if manual_chip_status else chip_source
        team_info['injury_data_source'] = injury_source
        if injury_source == 'manual':
            team_info['manual_injury_overrides'] = applied_overrides

        return team_info
    
    def _process_chip_status(self, chips: List[Dict], manual_chip_status: Dict = None) -> Dict:
        """Process chip availability status, preferring manual status over API"""
        
        # Use manual chip status if available (more reliable)
        if manual_chip_status:
            return manual_chip_status
        
        # Fallback to API data (history endpoint)
        chip_mapping = {
            'wildcard': 'Wildcard',
            'freehit': 'Free Hit', 
            'bboost': 'Bench Boost',
            '3xc': 'Triple Captain'
        }
        
        chip_status = {}
        for chip_name, display_name in chip_mapping.items():
            chip_info = next((c for c in chips if c.get('name') == chip_name), None)
            if chip_info:
                chip_status[display_name] = {
                    'available': not chip_info.get('played'),
                    'played_gw': chip_info.get('event') if chip_info.get('played') else None
                }
            else:
                # No record -> treat as unavailable/unknown to avoid false positives
                chip_status[display_name] = {'available': False, 'played_gw': None}
        
        return chip_status
    
    def _process_current_squad(self, picks_data: Dict, bootstrap: Dict) -> List[Dict]:
        """Process current squad with player details"""
        picks = picks_data.get('picks', [])
        elements = {p['id']: p for p in bootstrap['elements']}
        teams = {t['id']: t for t in bootstrap['teams']}
        
        squad = []
        for pick in picks:
            element = elements.get(pick['element'])
            if element:
                team = teams.get(element['team'])
                squad.append({
                    'player_id': element['id'],
                    'name': element['web_name'],
                    'team': team['short_name'] if team else 'UNK',
                    'position': self._get_position_code(element['element_type']),
                    'current_price': element['now_cost'] / 10,
                    'is_starter': pick['position'] <= 11,
                    'is_captain': pick['is_captain'],
                    'is_vice': pick['is_vice_captain'],
                    'bench_order': pick['position'] - 11 if pick['position'] > 11 else 0,
                    'points_this_gw': 0,  # Will need separate API call for live points
                    'total_points': element['total_points'],
                    'status_flag': self._parse_status(element.get('status', 'a'), element.get('chance_of_playing_this_round')),
                    'news': element.get('news', ''),
                    'news_added': element.get('news_added', ''),
                    'chance_of_playing_this_round': element.get('chance_of_playing_this_round'),
                    'chance_of_playing_next_round': element.get('chance_of_playing_next_round')
                })
        
        return squad
    
    def _apply_pending_transfers(self, squad: List[Dict], transfers: List[Dict], bootstrap: Dict) -> (List[Dict], bool):
        """
        Apply latest transfers to squad snapshot when next-GW picks are unavailable.
        This keeps lineup closer to the upcoming GW after you make transfers.
        """
        if not transfers:
            return squad, False
        
        elements = {p['id']: p for p in bootstrap['elements']}
        updated = False
        # Process newest first
        for transfer in sorted(transfers, key=lambda t: t.get('time', ''), reverse=True):
            out_id = transfer.get('element_out')
            in_id = transfer.get('element_in')
            if out_id is None or in_id is None:
                continue
            
            # Find the player to replace
            for idx, player in enumerate(squad):
                if player.get('player_id') == out_id:
                    new_elem = elements.get(in_id)
                    if not new_elem:
                        continue
                    squad[idx] = {
                        **player,  # retain captaincy/bench order flags
                        'player_id': new_elem['id'],
                        'name': new_elem['web_name'],
                        'team': self._get_team_code(new_elem['team']),
                        'position': self._get_position_code(new_elem['element_type']),
                        'current_price': new_elem['now_cost'] / 10,
                        'total_points': new_elem['total_points'],
                    'status_flag': self._parse_status(new_elem.get('status', 'a'), new_elem.get('chance_of_playing_this_round')),
                    'news': new_elem.get('news', ''),
                    'chance_of_playing_this_round': new_elem.get('chance_of_playing_this_round'),
                    'chance_of_playing_next_round': new_elem.get('chance_of_playing_next_round')
                }
                updated = True
                break
        return squad, updated
    
    def _match_player(self, identifier, elements: Dict[int, Dict]) -> Optional[Dict]:
        """Match player by id or name with fuzzy matching capabilities."""
        if identifier is None:
            return None
        
        # Direct ID match
        if isinstance(identifier, int):
            return elements.get(identifier)
        
        name_input = str(identifier).strip().lower()
        if not name_input:
            return None
        
        # Strategy 1: Exact web_name match (case-insensitive)
        for player in elements.values():
            if player.get('web_name', '').lower() == name_input:
                return player
        
        # Strategy 2: Exact first/last name match
        for player in elements.values():
            first_name = player.get('first_name', '').lower()
            second_name = player.get('second_name', '').lower()
            if name_input in [first_name, second_name, f"{first_name} {second_name}"]:
                return player
        
        # Strategy 3: Partial match in web_name (contains)
        for player in elements.values():
            web_name_lower = player.get('web_name', '').lower()
            if name_input in web_name_lower or web_name_lower in name_input:
                return player
        
        # Strategy 4: Fuzzy matching with common variations
        name_variations = self._generate_name_variations(name_input)
        for player in elements.values():
            player_names = [
                player.get('web_name', '').lower(),
                player.get('first_name', '').lower(),
                player.get('second_name', '').lower(),
                f"{player.get('first_name', '')} {player.get('second_name', '')}".lower()
            ]
            
            for variation in name_variations:
                for player_name in player_names:
                    if variation == player_name or (len(variation) > 3 and variation in player_name):
                        return player
        
        return None
    
    def _generate_name_variations(self, name: str) -> List[str]:
        """Generate common variations of a player name for fuzzy matching."""
        variations = [name]
        
        # Common abbreviations and variations
        replacements = {
            'mohamed': ['mo', 'mohammed', 'muhammad'],
            'alexander': ['alex'],
            'benjamin': ['ben'],
            'christopher': ['chris'],
            'dominic': ['dom'],
            'gabriel': ['gabi'],
            'jonathan': ['jon'],
            'matthew': ['matt'],
            'michael': ['mike'],
            'nathaniel': ['nathan'],
            'ricardo': ['ricky'],
            'robert': ['rob', 'bobby'],
            'samuel': ['sam'],
            'sebastian': ['seb'],
            'william': ['will', 'billy']
        }
        
        # Add common replacements
        name_lower = name.lower()
        for full_name, short_names in replacements.items():
            if full_name in name_lower:
                for short in short_names:
                    variations.append(name_lower.replace(full_name, short))
            for short in short_names:
                if short in name_lower:
                    variations.append(name_lower.replace(short, full_name))
        
        # Remove accents and special characters
        try:
            import unicodedata
            name_no_accents = unicodedata.normalize('NFKD', name_lower).encode('ascii', 'ignore').decode('ascii')
            if name_no_accents != name_lower:
                variations.append(name_no_accents)
        except (ImportError, AttributeError):
            pass  # Skip if unicodedata not available
        
        # Add without hyphens/apostrophes
        if '-' in name or "'" in name:
            variations.append(name.replace('-', ' ').replace("'", ''))
        
        return list(set(variations))

    def _apply_manual_overrides(self, squad: List[Dict], overrides: Dict, bootstrap: Dict) -> (List[Dict], bool):
        """
        Apply manual structured overrides when next-GW picks are unavailable.
        Supported keys:
          - planned_transfers: [{in_id|in_name, out_id|out_name}]
          - planned_starters: [names] (set starters/bench + bench order)
          - captain: name/id
          - vice_captain: name/id
        """
        if not overrides:
            return squad, False
        
        updated = False
        elements = {p['id']: p for p in bootstrap['elements']}
        
        # Manual planned transfers
        transfer_results = []
        for transfer in overrides.get('planned_transfers', []):
            in_id = transfer.get('in_id')
            out_id = transfer.get('out_id')
            in_name = transfer.get('in_name')
            out_name = transfer.get('out_name')
            
            # Find the incoming player
            in_elem = self._match_player(in_id or in_name, elements)
            if not in_elem:
                transfer_results.append(f"⚠️  Could not find player '{in_name or in_id}' to transfer in")
                continue
            
            # Find the outgoing player in squad
            out_identifier = out_id or out_name
            if out_identifier is None:
                transfer_results.append("⚠️  No out player specified for transfer")
                continue
            
            player_found = False
            for idx, player in enumerate(squad):
                # Match by ID or name
                if (player.get('player_id') == out_id or 
                    (out_name and player.get('name', '').lower() == str(out_name).lower()) or
                    (out_name and self._match_player(out_name, {player['player_id']: {'web_name': player.get('name', ''), 'first_name': '', 'second_name': ''}}))):
                    
                    old_name = player.get('name', 'Unknown')
                    squad[idx] = {
                        **player,
                        'player_id': in_elem['id'],
                        'name': in_elem['web_name'],
                        'team': self._get_team_code(in_elem['team']),
                        'position': self._get_position_code(in_elem['element_type']),
                        'current_price': in_elem['now_cost'] / 10,
                        'total_points': in_elem['total_points'],
                        'status_flag': self._parse_status(in_elem.get('status', 'a'), in_elem.get('chance_of_playing_this_round')),
                        'news': in_elem.get('news', ''),
                        'chance_of_playing_this_round': in_elem.get('chance_of_playing_this_round'),
                        'chance_of_playing_next_round': in_elem.get('chance_of_playing_next_round')
                    }
                    transfer_results.append(f"✅ Applied transfer: {old_name} → {in_elem['web_name']}")
                    updated = True
                    player_found = True
                    break
            
            if not player_found:
                transfer_results.append(f"⚠️  Could not find player '{out_name or out_id}' in your current squad")
        
        # Print transfer results for user feedback
        if transfer_results:
            logger.info("Manual transfer processing results:")
            for result in transfer_results:
                logger.info(result)
        
        # Manual starters/bench ordering
        planned_starters = overrides.get('planned_starters') or []
        if planned_starters:
            starters_lower = [str(n).lower() for n in planned_starters]
            # First mark starters
            for player in squad:
                player['is_starter'] = player.get('name', '').lower() in starters_lower
            # Then build bench order sequentially for non-starters
            bench_order = 1
            for player in squad:
                if not player.get('is_starter'):
                    player['bench_order'] = bench_order
                    bench_order += 1
            updated = True
        
        # Manual captain/vice
        captain_id = overrides.get('captain')
        vice_id = overrides.get('vice_captain')
        if captain_id or vice_id:
            for player in squad:
                player['is_captain'] = False
                player['is_vice_captain'] = False
            if captain_id:
                cap_match = None
                for player in squad:
                    if player.get('player_id') == captain_id or player.get('name', '').lower() == str(captain_id).lower():
                        cap_match = player
                        break
                if cap_match:
                    cap_match['is_captain'] = True
                    updated = True
            if vice_id:
                vice_match = None
                for player in squad:
                    if player.get('player_id') == vice_id or player.get('name', '').lower() == str(vice_id).lower():
                        vice_match = player
                        break
                if vice_match:
                    vice_match['is_vice_captain'] = True
                    updated = True
        
        return squad, updated
    
    def _process_recent_transfers(self, transfers: List[Dict]) -> List[Dict]:
        """Process recent transfers"""
        return [{
            'gw': t.get('event'),
            'player_in': t.get('element_in'),
            'player_out': t.get('element_out'),
            'cost': t.get('element_in_cost', 0) / 10,
            'time': t.get('time')
        } for t in transfers]
    
    def _get_captain_info(self, picks_data: Dict, bootstrap: Dict) -> Dict:
        """Get captain and vice-captain info"""
        picks = picks_data.get('picks', [])
        elements = {p['id']: p for p in bootstrap['elements']}
        
        captain = next((p for p in picks if p['is_captain']), None)
        vice = next((p for p in picks if p['is_vice_captain']), None)
        
        captain_info = {}
        if captain:
            cap_element = elements.get(captain['element'])
            if cap_element:
                captain_info['captain'] = {
                    'name': cap_element['web_name'],
                    'team': self._get_team_code(cap_element['team']),
                    'position': self._get_position_code(cap_element['element_type'])
                }
        
        if vice:
            vice_element = elements.get(vice['element'])
            if vice_element:
                captain_info['vice_captain'] = {
                    'name': vice_element['web_name'],
                    'team': self._get_team_code(vice_element['team']),
                    'position': self._get_position_code(vice_element['element_type'])
                }
        
        return captain_info
    
    def _get_captain_info_from_squad(self, squad: List[Dict]) -> Dict:
        """Build captain/vice info from an already-processed squad snapshot"""
        captain = next((p for p in squad if p.get('is_captain')), None)
        vice = next((p for p in squad if p.get('is_vice_captain')), None)
        info = {}
        if captain:
            info['captain'] = {
                'name': captain.get('name'),
                'team': captain.get('team'),
                'position': captain.get('position')
            }
        if vice:
            info['vice_captain'] = {
                'name': vice.get('name'),
                'team': vice.get('team'),
                'position': vice.get('position')
            }
        return info
    
    async def get_enhanced_data(self, team_id: Optional[int] = None) -> Dict:
        """Get both general FPL data and your personal team data"""
        
        # Get general data (from original collector)
        general_data = await self.get_current_data()
        
        # Get team-specific data if team_id provided
        team_data = {}
        if team_id or self.team_id:
            try:
                team_data = await self.get_team_data(team_id)
            except Exception as e:
                logger.error(f"Failed to fetch team data: {e}")
                team_data = {'error': str(e)}
        
        return {
            **general_data,
            'my_team': team_data,
            'collection_type': 'enhanced_with_team_data'
        }
    
    # Include all the original collector methods
    async def get_current_data(self) -> Dict:
        """Get current gameweek data in format compatible with your models"""
        
        # Fetch bootstrap data
        bootstrap = await self.fetch_json("/bootstrap-static/")
        fixtures = await self.fetch_json("/fixtures/")
        
        # Process players into FplPlayerEntry format (ID-first, with legacy strings for compatibility)
        players = []
        for player in bootstrap['elements']:
            players.append({
                'player_id': int(player['id']),
                'name': player['web_name'],
                'team_id': player.get('team'),
                'team_short': self._get_team_code(player.get('team')),
                'team': self._get_team_code(player.get('team')),  # legacy string
                'position': self._get_position_code(player['element_type']),
                'buy_price': player['now_cost'] / 10,
                'sell_price': player['now_cost'] / 10,
                'current_price': player['now_cost'] / 10,
                'ownership': float(player.get('selected_by_percent', 0) or 0),
                'total_points': player.get('total_points', 0),
                'is_starter': False,
                'is_captain': False,
                'is_vice': False,
                'bench_order': 0,
                'status_flag': self._parse_status(player.get('status', 'a'), player.get('chance_of_playing_this_round')),
                'news': player.get('news', ''),
                'news_added': player.get('news_added', ''),
                'chance_of_playing_this_round': player.get('chance_of_playing_this_round'),
                'chance_of_playing_next_round': player.get('chance_of_playing_next_round')
            })
        
        # Process fixtures
        fixture_rows = []
        for fixture in fixtures:
            if not fixture.get('finished', True):  # Only upcoming fixtures
                fixture_id = fixture.get('id')
                team_h = fixture.get('team_h')
                team_a = fixture.get('team_a')
                gw = fixture.get('event') or 1
                kickoff = fixture.get('kickoff_time', '')
                # Home team fixture
                fixture_rows.append({
                    'fixture_id': fixture_id,
                    'player_id': None,
                    'gameweek': gw,
                    'team_id': team_h,
                    'opponent_team_id': team_a,
                    'team': self._get_team_code(team_h),
                    'opponent': self._get_team_code(team_a),
                    'team_short': self._get_team_code(team_h),
                    'opponent_short': self._get_team_code(team_a),
                    'kickoff_time': kickoff,
                    'date': kickoff,  # legacy
                    'venue': 'H',
                    'xG_for_team': None,
                    'xG_against_team': None,
                    'xG_for_opponent': None,
                    'xG_against_opponent': None,
                    'book_goals_for': None,
                    'book_cs_prob': None,
                    'competition': 'PL',
                    'is_dgw_leg': False,
                    'is_blank': False,
                    'context_tags': []
                })
                
                # Away team fixture  
                fixture_rows.append({
                    'fixture_id': fixture_id,
                    'player_id': None,
                    'gameweek': gw,
                    'team_id': team_a,
                    'opponent_team_id': team_h,
                    'team': self._get_team_code(team_a),
                    'opponent': self._get_team_code(team_h),
                    'team_short': self._get_team_code(team_a),
                    'opponent_short': self._get_team_code(team_h),
                    'kickoff_time': kickoff,
                    'date': kickoff,  # legacy
                    'venue': 'A',
                    'xG_for_team': None,
                    'xG_against_team': None,
                    'xG_for_opponent': None,
                    'xG_against_opponent': None,
                    'book_goals_for': None,
                    'book_cs_prob': None,
                    'competition': 'PL',
                    'is_dgw_leg': False,
                    'is_blank': False,
                    'context_tags': []
                })
        
        # Get current gameweek
        current_gw = 1
        for event in bootstrap['events']:
            if event['is_current']:
                current_gw = event['id']
                break
        
        return {
            'players': players,
            'fixtures': fixture_rows,
            'current_gameweek': current_gw,
            'teams': {team['id']: team['short_name'] for team in bootstrap['teams']},
            'last_updated': datetime.now().isoformat()
        }
    
    def _get_team_code(self, team_id: int) -> str:
        """Convert team ID to 3-letter code"""
        team_mapping = {
            1: 'ARS', 2: 'AVL', 3: 'BOU', 4: 'BRE', 5: 'BHA',
            6: 'CHE', 7: 'CRY', 8: 'EVE', 9: 'FUL', 10: 'IPS',
            11: 'LEI', 12: 'LIV', 13: 'MCI', 14: 'MUN', 15: 'NEW',
            16: 'NFO', 17: 'SOU', 18: 'TOT', 19: 'WHU', 20: 'WOL'
        }
        return team_mapping.get(team_id, 'UNK')
    
    def _get_position_code(self, element_type: int) -> str:
        """Convert element_type to position code"""
        return {1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD'}.get(element_type, 'UNK')
    
    def _parse_status(self, status: str, chance_of_playing: int = None) -> str:
        """Parse player status flag with enhanced chance of playing logic"""
        if status == 'u':  # unavailable
            return 'OUT'
        elif status == 'i':  # injured
            # Use chance of playing for more nuanced injury status
            if chance_of_playing is None or chance_of_playing == 0:
                return 'OUT'
            elif chance_of_playing <= 25:
                return 'DOUBT'
            elif chance_of_playing <= 50:
                return 'DOUBT'  
            else:
                return 'FIT'  # High chance despite injury flag
        elif status == 'd':  # doubtful
            return 'DOUBT'
        elif status == 's':  # suspended
            return 'OUT'
        elif status == 'n':  # not available
            return 'OUT'
        else:
            # Even for 'a' (available), check chance of playing
            if chance_of_playing is not None and chance_of_playing <= 25:
                return 'DOUBT'
            return 'FIT'


async def main():
    """Example usage with team data"""
    
    # You'll need to replace this with your actual FPL team ID
    # You can find it in the URL when you view your team: 
    # https://fantasy.premierleague.com/entry/YOUR_TEAM_ID/event/18
    TEAM_ID = None  # Replace with your team ID
    
    async with EnhancedFPLCollector(team_id=TEAM_ID) as collector:
        if TEAM_ID:
            # Get enhanced data with your team info
            data = await collector.get_enhanced_data()
            
            # Save enhanced data
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"enhanced_fpl_data_{timestamp}.json"
            
            with open(filename, 'w') as f:
                json.dump(data, f, indent=2)
            
            print(f"Enhanced data saved to {filename}")
            
            # Print team summary
            if 'my_team' in data and 'team_info' in data['my_team']:
                team_info = data['my_team']['team_info']
                print(f"\n=== {team_info['team_name']} ===")
                print(f"Manager: {team_info['manager_name']}")
                rank_val = team_info.get('overall_rank')
                rank_text = f"{rank_val:,}" if isinstance(rank_val, (int, float)) else (rank_val if rank_val is not None else "N/A")
                print(f"Overall Rank: {rank_text}")
                print(f"Total Points: {team_info['total_points']}")
                print(f"Team Value: £{team_info['team_value']:.1f}m")
                print(f"Bank: £{team_info['bank_value']:.1f}m")
                print(f"Free Transfers: {team_info['free_transfers']}")
                
                # Print chip status
                print("\n=== Chip Status ===")
                for chip, status in data['my_team']['chip_status'].items():
                    status_text = "✅ Available" if status['available'] else f"❌ Used (GW{status['played_gw']})"
                    print(f"{chip}: {status_text}")
                
                # Print captain info
                if 'captain_info' in data['my_team']:
                    cap_info = data['my_team']['captain_info']
                    if 'captain' in cap_info:
                        cap = cap_info['captain']
                        print("\n=== Captaincy ===")
                        print(f"Captain: {cap['name']} ({cap['team']} {cap['position']})")
                    if 'vice_captain' in cap_info:
                        vice = cap_info['vice_captain'] 
                        print(f"Vice: {vice['name']} ({vice['team']} {vice['position']})")
        else:
            print("No team ID provided - collecting general data only")
            data = await collector.get_current_data()
            
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"fpl_data_{timestamp}.json"
            
            with open(filename, 'w') as f:
                json.dump(data, f, indent=2)
            
            print(f"General data saved to {filename}")


if __name__ == "__main__":
    asyncio.run(main())
