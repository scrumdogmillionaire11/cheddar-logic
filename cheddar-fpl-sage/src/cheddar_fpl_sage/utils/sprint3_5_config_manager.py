#!/usr/bin/env python3
"""
Sprint 3.5: Config Persistence Fix
Addresses Issues 1-4 identified in live run feedback:
- Issue 1: Manual chip config ignored
- Issue 2: Manual FT input ignored
- Issue 3: Contradictory override status
- Issue 4: Config write ≠ read (cache issue)
- Issue 9: Manager identity missing

This module provides:
1. Unified config manager with atomic read/write and validation
2. Cache invalidation to ensure fresh reads
3. Unambiguous override status reporting
4. Manager identity extraction and storage
"""

import json
from pathlib import Path
from typing import Dict, Optional, Any, Tuple, Union
from datetime import datetime, timedelta
import logging

from cheddar_fpl_sage.analysis.decision_framework import TeamConfig, ConfigurationError

logger = logging.getLogger(__name__)

MANUAL_CHIP_NAMES = ["Wildcard", "Free Hit", "Bench Boost", "Triple Captain"]
MANUAL_OVERRIDE_EXPIRY_HOURS = 12


def normalize_manual_chip_status(chip_status: Dict) -> Dict:
    """Ensure manual chip bundle includes every chip with sane defaults."""
    if chip_status is None:
        chip_status = {}
    normalized = {}
    missing = []
    for chip_name in MANUAL_CHIP_NAMES:
        entry = chip_status.get(chip_name, {})
        if chip_name not in chip_status:
            missing.append(chip_name)
        available = entry.get("available")
        if available is None:
            available = True
        normalized[chip_name] = {
            "available": bool(available),
            "played_gw": entry.get("played_gw")
        }
    if missing:
        logger.warning(
            "Manual chip bundle missing entries %s – defaulting them to available=True",
            missing
        )
    return normalized


class Sprint35ConfigManager:
    """
    Centralized config management for Sprint 3.5
    
    Guarantees:
    - Write path = Read path (same keys, same schema)
    - Config reloaded fresh on each analysis (no stale cache)
    - Override status never contradictory
    - Manager identity preserved
    """
    
    # Schema version for validation
    SCHEMA_VERSION = "2.0.0"
    
    # Standardized keys (ensures write == read)
    KEYS = {
        'manual_chip_status': 'manual_chip_status',
        'manual_free_transfers': 'manual_free_transfers',
        'manual_injury_overrides': 'manual_injury_overrides',
        'manual_overrides': 'manual_overrides',
        'team_id': 'team_id',
        'manager_id': 'manager_id',
        'manager_name': 'manager_name',
        'chip_data_source': 'chip_data_source',
        'chip_policy': 'chip_policy',
        'risk_posture': 'risk_posture',
        'manager_context': 'manager_context',
    }
    
    def __init__(self, config_file: Union[str, Path] = "team_config.json"):
        self.config_file = Path(config_file) if isinstance(config_file, str) else config_file
        self._last_reload_time = None
        self._config_cache = None
    
    def reload_config(self, force: bool = False) -> Dict:
        """
        Load and validate config from disk using Pydantic.

        Args:
            force: If True, reload even if recently loaded

        Returns:
            Dict: Current validated config
        """
        if not force and self._config_cache is not None:
            # Allow caller to force reload if needed, but normally use cache
            return self._config_cache

        if not self.config_file.exists():
            # Return default config
            logger.warning(f"Config file {self.config_file} not found. Using defaults.")
            default = TeamConfig(manager_id=0, manager_name="Unknown")
            self._config_cache = self._team_config_to_dict(default)
            self._last_reload_time = datetime.now()
            return self._config_cache

        try:
            with open(self.config_file, 'r') as f:
                raw_content = f.read()

            # Handle double-encoded JSON (legacy issue)
            try:
                raw = json.loads(raw_content)
                if isinstance(raw, str):
                    raw = json.loads(raw)
            except json.JSONDecodeError as e:
                raise ConfigurationError(f"Invalid JSON in config file: {e}")

            # Validate with Pydantic
            validated = TeamConfig.model_validate(raw)
            self._config_cache = self._team_config_to_dict(validated)
            self._last_reload_time = datetime.now()
            return self._config_cache

        except ConfigurationError:
            raise
        except Exception as e:
            logger.warning(f"Config load failed, using defaults: {e}")
            default = TeamConfig(manager_id=0, manager_name="Unknown")
            self._config_cache = self._team_config_to_dict(default)
            self._last_reload_time = datetime.now()
            return self._config_cache

    def _ensure_complete_manual_chips(self, config: Dict):
        """Enforce the normalized complete manual chip bundle."""
        normalized = normalize_manual_chip_status(config.get(self.KEYS['manual_chip_status']))
        config[self.KEYS['manual_chip_status']] = normalized
    
    def invalidate_cache(self):
        """Force cache to be reloaded on next access"""
        self._config_cache = None
        self._last_reload_time = None
    
    def get_config(self, force_reload: bool = False) -> Dict:
        """
        Get current config (reloaded from disk if needed).
        
        Args:
            force_reload: Force reload from disk even if cached
        
        Returns:
            Dict: Current config
        """
        if force_reload or self._config_cache is None:
            return self.reload_config(force=True)
        return self._config_cache
    
    def _ensure_dict(self, value: Any, default: Optional[Dict] = None) -> Dict:
        """Ensure value is a dict."""
        if default is None:
            default = {}
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass
        return default
    
    def get_manual_chips(self, config: Optional[Dict] = None) -> Optional[Dict]:
        """Get manual chip status from config"""
        if config is None:
            config = self.get_config()
        return config.get(self.KEYS['manual_chip_status'])
    
    def get_manual_free_transfers(self, config: Optional[Dict] = None) -> Optional[int]:
        """Get manual free transfers from config"""
        if config is None:
            config = self.get_config()
        return config.get(self.KEYS['manual_free_transfers'])
    
    def get_manager_identity(self, config: Optional[Dict] = None) -> Tuple[Optional[int], Optional[str]]:
        """
        Get manager ID and name from config.
        
        Returns:
            Tuple of (manager_id, manager_name)
        """
        if config is None:
            config = self.get_config()
        manager_id = config.get(self.KEYS['manager_id'])
        manager_name = config.get(self.KEYS['manager_name'])
        return manager_id, manager_name
    
    def update_manual_chips(self, chip_status: Dict) -> bool:
        """
        Save manual chip status to config (atomic write).
        
        Args:
            chip_status: Dict with chip availability
        
        Returns:
            bool: True if successful
        """
        try:
            config = self.get_config(force_reload=True)  # Fresh read
            normalized = normalize_manual_chip_status(chip_status)
            config[self.KEYS['manual_chip_status']] = normalized
            config[self.KEYS['chip_data_source']] = 'manual'
            config['last_manual_update'] = datetime.now().isoformat()
            
            self._commit_config(config)
            logger.info("Manual chips updated in config")
            return True
        except Exception as e:
            logger.error(f"Failed to update manual chips: {e}")
            return False
    
    def update_manual_free_transfers(self, ft_count: int) -> bool:
        """
        Save manual free transfers to config (atomic write).
        
        Args:
            ft_count: Number of free transfers available
        
        Returns:
            bool: True if successful
        """
        try:
            config = self.get_config(force_reload=True)  # Fresh read
            config[self.KEYS['manual_free_transfers']] = ft_count
            config['last_manual_update'] = datetime.now().isoformat()
            
            self._commit_config(config)
            logger.info(f"Manual FT updated to {ft_count} in config")
            return True
        except Exception as e:
            logger.error(f"Failed to update manual FT: {e}")
            return False
    
    def update_manager_identity(self, manager_id: Optional[int] = None, manager_name: Optional[str] = None) -> bool:
        """
        Save manager identity to config (atomic write).
        
        Args:
            manager_id: FPL manager ID
            manager_name: Manager display name
        
        Returns:
            bool: True if successful
        """
        try:
            config = self.get_config(force_reload=True)  # Fresh read
            if manager_id is not None:
                config[self.KEYS['manager_id']] = manager_id
            if manager_name is not None:
                config[self.KEYS['manager_name']] = manager_name
            
            self._commit_config(config)
            logger.info(f"Manager identity updated: {manager_name} ({manager_id})")
            return True
        except Exception as e:
            logger.error(f"Failed to update manager identity: {e}")
            return False
    
    def update_manual_overrides(self, manual_overrides: Optional[Dict]) -> bool:
        """
        Save manual overrides (transfers, captaincy, lineup) to config atomically.
        """
        try:
            config = self.get_config(force_reload=True)
            if manual_overrides:
                config[self.KEYS['manual_overrides']] = manual_overrides
                config['manual_data_source'] = 'user_input'
            else:
                config.pop(self.KEYS['manual_overrides'], None)
                config.pop('manual_data_source', None)
            config['last_manual_update'] = datetime.now().isoformat()
            self._commit_config(config)
            logger.info("Manual overrides updated in config")
            return True
        except Exception as e:
            logger.error(f"Failed to update manual overrides: {e}")
            return False

    def update_manual_injury_overrides(self, overrides: Dict) -> bool:
        """
        Save manual injury overrides to config atomically.
        """
        try:
            config = self.get_config(force_reload=True)
            if overrides:
                config[self.KEYS['manual_injury_overrides']] = overrides
                config['injury_data_source'] = 'manual'
            else:
                config.pop(self.KEYS['manual_injury_overrides'], None)
                config.pop('injury_data_source', None)
            config['last_manual_update'] = datetime.now().isoformat()
            self._commit_config(config)
            logger.info("Manual injury overrides updated in config")
            return True
        except Exception as e:
            logger.error(f"Failed to update manual injury overrides: {e}")
            return False
    
    def get_risk_posture(self) -> str:
        """
        Get manager risk tolerance from config.
        
        Returns:
            str: Risk posture (CONSERVATIVE|BALANCED|AGGRESSIVE), defaults to BALANCED
        """
        from cheddar_fpl_sage.analysis.decision_framework.constants import (
            normalize_risk_posture,
            DEFAULT_RISK_POSTURE
        )
        
        config = self.get_config()
        posture = config.get(self.KEYS['risk_posture'], DEFAULT_RISK_POSTURE)
        
        # Validate and normalize
        try:
            return normalize_risk_posture(posture)
        except ValueError:
            logger.warning(f"Invalid risk_posture in config: {posture}, using {DEFAULT_RISK_POSTURE}")
            return DEFAULT_RISK_POSTURE
    
    def set_risk_posture(self, posture: str, persist: bool = False) -> bool:
        """
        Set manager risk tolerance.
        
        Args:
            posture: Risk posture (CONSERVATIVE|BALANCED|AGGRESSIVE)
            persist: If True, save to team_config.json; else runtime only
        
        Returns:
            bool: True if successful
        """
        from cheddar_fpl_sage.analysis.decision_framework.constants import normalize_risk_posture
        
        try:
            # Validate first
            validated_posture = normalize_risk_posture(posture)
            
            if persist:
                config = self.get_config(force_reload=True)
                config[self.KEYS['risk_posture']] = validated_posture
                config['last_manual_update'] = datetime.now().isoformat()
                self._commit_config(config)
                logger.info(f"Risk posture set to {validated_posture} (persisted to config)")
            else:
                # Runtime only - update cache but don't save
                if self._config_cache is None:
                    self._config_cache = self.get_config()
                self._config_cache[self.KEYS['risk_posture']] = validated_posture
                logger.info(f"Risk posture set to {validated_posture} (runtime only)")
            
            return True
        except ValueError as e:
            logger.error(f"Invalid risk posture: {e}")
            return False
        except Exception as e:
            logger.error(f"Failed to set risk posture: {e}")
            return False
    
    def _team_config_to_dict(self, config: TeamConfig) -> Dict[str, Any]:
        """Convert TeamConfig to dict, preserving structure for backward compatibility."""
        result = config.model_dump(mode='json')
        # Convert ChipStatus objects back to dicts for compatibility
        if 'manual_chip_status' in result:
            chip_status = {}
            for name, status in result['manual_chip_status'].items():
                if isinstance(status, dict):
                    chip_status[name] = status
                else:
                    chip_status[name] = {"available": True, "played_gw": None}
            result['manual_chip_status'] = chip_status
        return result

    def _save_to_disk(self, config: Dict[str, Any]) -> None:
        """Validate and save config to disk atomically."""
        # Validate before writing
        try:
            validated = TeamConfig.model_validate(config)
        except Exception as e:
            raise ConfigurationError(f"Cannot save invalid config: {e}")

        # Atomic write
        temp_file = self.config_file.with_suffix('.tmp')
        try:
            with open(temp_file, 'w') as f:
                f.write(validated.model_dump_json(indent=2))
            temp_file.replace(self.config_file)
        except Exception as e:
            if temp_file.exists():
                temp_file.unlink()
            raise ConfigurationError(f"Failed to write config: {e}")

    def _write_config_atomic(self, config: Dict):
        """Write config atomically (write to temp, then rename). Legacy method - uses _save_to_disk."""
        self._save_to_disk(config)
    
    def _commit_config(self, config: Dict):
        """Persist config changes and invalidate cache cleanly."""
        self._write_config_atomic(config)
        self.invalidate_cache()
    
    def has_any_overrides(self, config: Optional[Dict] = None) -> bool:
        """
        Check if ANY manual overrides are set.
        
        Returns:
            bool: True if chips, FT, injuries, or other overrides exist
        """
        if config is None:
            config = self.get_config()
        
        has_chips = bool(config.get(self.KEYS['manual_chip_status']))
        has_ft = config.get(self.KEYS['manual_free_transfers']) is not None
        has_injuries = bool(config.get(self.KEYS['manual_injury_overrides']))
        has_transfers = bool(config.get(self.KEYS['manual_overrides']))
        
        return any([has_chips, has_ft, has_injuries, has_transfers])
    
    def format_override_status(self, config: Optional[Dict] = None) -> str:
        """
        Generate unambiguous override status message.
        
        Never contradictory: either "Active: X, Y, Z" or "No overrides set"
        
        Returns:
            str: Status message
        """
        if config is None:
            config = self.get_config()
        
        if not self.has_any_overrides(config):
            return "No manual overrides set"
        
        active_overrides = []
        
        chips = config.get(self.KEYS['manual_chip_status'])
        if chips:
            available = [name for name, status in chips.items() if status.get('available')]
            if available:
                active_overrides.append(f"Chips: {', '.join(available)}")
        
        ft = config.get(self.KEYS['manual_free_transfers'])
        if ft is not None:
            active_overrides.append(f"FT: {ft}")
        
        injuries = config.get(self.KEYS['manual_injury_overrides'])
        if injuries:
            active_overrides.append(f"Injuries: {len(injuries)} players")
        
        transfers = config.get(self.KEYS['manual_overrides'])
        if transfers:
            active_overrides.append("Transfers/Captain: set")
        
        if active_overrides:
            return "✅ Manual overrides active: " + " | ".join(active_overrides)
        
        return "No manual overrides set"

    def _manual_override_expiry(self, config: Dict) -> Optional[str]:
        """Compute the approximate expiry timestamp for manual overrides."""
        last_update = config.get('last_manual_update')
        if not last_update:
            return None
        try:
            parsed = datetime.fromisoformat(last_update)
        except (TypeError, ValueError):
            return None
        expires_at = parsed + timedelta(hours=MANUAL_OVERRIDE_EXPIRY_HOURS)
        return expires_at.strftime("%Y-%m-%dT%H:%M")

    def _format_manual_injury_name(self, name: str) -> str:
        """Normalize manual override keys into readable names."""
        if not name:
            return "Unknown player"
        return name.replace("_", " ").title()

    def _format_manual_injury_entries(self, overrides: Dict[str, Dict], config: Dict) -> Optional[str]:
        if not overrides:
            return None
        entries = []
        source_label = config.get('injury_data_source') or 'manual'
        expiry = self._manual_override_expiry(config)

        for key in sorted(overrides.keys()):
            override = overrides[key]
            status = (override.get('status_flag') or override.get('status') or 'UNKNOWN').upper()
            chance = override.get('chance_of_playing_next_round')
            if chance is None:
                chance = override.get('chance')
            note = override.get('injury_note') or override.get('reason')

            details = [source_label]
            if expiry:
                details.append(f"expires {expiry}")
            if note:
                details.insert(0, note)
            if chance is not None:
                details.insert(0, f"{chance}% chance")

            name = self._format_manual_injury_name(key)
            entry = f"{name}={status}"
            if details:
                entry += f" ({', '.join(details)})"
            entries.append(entry)

        return "Injury overrides: " + ", ".join(entries)

    def get_manual_override_summary(self, config: Optional[Dict] = None) -> str:
        """
        Provide a human-readable summary of manual overrides (chips, FT, injuries).
        """
        if config is None:
            config = self.get_config()

        summary_lines = [self.format_override_status(config)]
        injury_line = self._format_manual_injury_entries(
            config.get(self.KEYS['manual_injury_overrides'], {}), config
        )
        if injury_line:
            summary_lines.append(injury_line)

        return "\n".join(line for line in summary_lines if line)

    def derive_risk_posture_from_rank(self, overall_rank: int, total_managers: int = 10000000) -> str:
        """
        Derive risk posture from league position.

        Args:
            overall_rank: Current overall rank
            total_managers: Approximate total FPL managers

        Returns:
            str: CONSERVATIVE, AGGRESSIVE, or BALANCED
        """
        if not overall_rank or overall_rank <= 0:
            return "BALANCED"  # Default when rank unknown

        # Calculate percentile (lower rank = better = higher percentile)
        percentile = max(0, min(100, (total_managers - overall_rank) / total_managers * 100))

        # Risk posture based on position - more aggressive thresholds
        if percentile >= 80:  # Top 20%
            return "CONSERVATIVE"   # Protect lead
        elif percentile <= 50:  # Bottom 50%
            return "AGGRESSIVE"    # Need to catch up
        else:
            return "BALANCED" # Middle 30%
    
    def update_manager_context(self,
                             risk_posture: Optional[str] = None,
                             overall_rank: Optional[int] = None,
                             force_derivation: bool = False) -> bool:
        """
        Update manager context including risk posture.

        Args:
            risk_posture: Explicit risk posture (CONSERVATIVE/BALANCED/AGGRESSIVE)
            overall_rank: Current rank for auto-derivation
            force_derivation: Derive from rank even if manual posture exists

        Returns:
            bool: True if config updated successfully
        """
        try:
            from cheddar_fpl_sage.analysis.decision_framework.constants import RISK_POSTURES

            config = self.get_config(force_reload=True)

            # Handle risk posture
            current_posture = config.get(self.KEYS['risk_posture'])

            if risk_posture:
                # Explicit manual setting - validate against canonical postures
                normalized = risk_posture.upper()
                if normalized in RISK_POSTURES:
                    config[self.KEYS['risk_posture']] = normalized
                    config[self.KEYS['manager_context']] = normalized
            elif not current_posture or force_derivation:
                # Auto-derive from rank if no manual setting or forced
                if overall_rank:
                    derived_posture = self.derive_risk_posture_from_rank(overall_rank)
                    config[self.KEYS['risk_posture']] = derived_posture
                    config[self.KEYS['manager_context']] = derived_posture

            self._commit_config(config)
            return True
            
        except Exception as e:
            logger.error(f"Error updating manager context: {e}")
            return False
    
    def get_manager_context(self) -> Dict[str, Any]:
        """
        Get complete manager context.
        
        Returns:
            Dict with manager_name, risk_posture, etc.
        """
        config = self.get_config()
        
        return {
            'manager_name': config.get(self.KEYS['manager_name']),
            'risk_posture': config.get(self.KEYS['risk_posture'], 'BALANCED'),
            'manager_context': config.get(self.KEYS['manager_context'], 'BALANCED')
        }


def inject_sprint3_5_config_manager(integration_instance):
    """
    Inject Sprint 3.5 config manager into FPLSageIntegration.
    
    This ensures:
    1. Config is reloaded fresh before each analysis
    2. Override messages are never contradictory
    3. Manager identity is preserved
    
    Args:
        integration_instance: FPLSageIntegration instance
    """
    config_manager = Sprint35ConfigManager(integration_instance.config_file)
    
    # Replace config loading with fresh manager-controlled load
    original_load = integration_instance._load_config
    
    def fresh_load():
        # Always reload from disk
        return config_manager.get_config(force_reload=True)
    
    integration_instance._load_config = fresh_load
    integration_instance.config_manager = config_manager
