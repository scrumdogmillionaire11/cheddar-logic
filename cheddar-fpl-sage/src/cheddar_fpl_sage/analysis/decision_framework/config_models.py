"""
Pydantic models for FPL Sage configuration.
Provides schema validation and serialization for team_config.json.
"""
from pydantic import BaseModel, Field, field_validator, model_validator, ConfigDict
from typing import Optional, Dict, Any, Literal, List
from datetime import datetime


class ChipStatus(BaseModel):
    """Status of a single chip."""
    available: bool = True
    played_gw: Optional[int] = None

    model_config = ConfigDict(extra='ignore')  # Ignore unknown fields for forward compatibility


class ManualTransfer(BaseModel):
    """A single manual transfer specification."""
    player_out: Optional[str] = Field(default=None, alias='out_name')
    player_in: Optional[str] = Field(default=None, alias='in_name')
    player_in_id: Optional[int] = None
    player_in_team: Optional[str] = None
    player_in_position: Optional[str] = None
    player_in_price: Optional[float] = None
    cost: Optional[int] = None

    model_config = ConfigDict(extra='ignore', populate_by_name=True)


class InjuryOverride(BaseModel):
    """Manual injury status override."""
    player_name: str
    status: Literal["FIT", "DOUBT", "OUT", "SUSPENDED"] = "FIT"
    reason: Optional[str] = None

    model_config = ConfigDict(extra='ignore')


class ChipWindow(BaseModel):
    """Chip timing window configuration."""
    start_gw: int = Field(default=1, alias='startGW')
    end_gw: int = Field(default=38, alias='endGW')
    chip: str = ""
    name: Optional[str] = None
    reason: Optional[str] = None
    chips: Optional[List[str]] = None  # Legacy field

    model_config = ConfigDict(extra='ignore', populate_by_name=True)

    @model_validator(mode='before')
    @classmethod
    def normalize_fields(cls, data):
        """Handle legacy field names."""
        if isinstance(data, dict):
            # Handle startGW/endGW legacy names
            if 'startGW' in data and 'start_gw' not in data:
                data['start_gw'] = data['startGW']
            if 'endGW' in data and 'end_gw' not in data:
                data['end_gw'] = data['endGW']
            # If chip is missing but chips list exists, use first chip
            if not data.get('chip') and data.get('chips'):
                data['chip'] = data['chips'][0] if data['chips'] else ""
            # If chip is still missing, use name or empty string
            if not data.get('chip') and data.get('name'):
                data['chip'] = data['name']
        return data


class ChipPolicy(BaseModel):
    """Chip usage policy configuration."""
    chip_windows: List[ChipWindow] = Field(default_factory=list)
    bench_boost_threshold: float = 15.0
    triple_captain_threshold: float = 12.0

    model_config = ConfigDict(extra='ignore')

    @field_validator('chip_windows', mode='before')
    @classmethod
    def normalize_chip_windows(cls, v):
        """Handle legacy chip window formats."""
        if not isinstance(v, list):
            return []
        # Filter out invalid entries
        valid_windows = []
        for window in v:
            if isinstance(window, dict):
                # Check if it has minimum required fields (even with legacy names)
                has_start = 'start_gw' in window or 'startGW' in window
                has_end = 'end_gw' in window or 'endGW' in window
                if has_start and has_end:
                    valid_windows.append(window)
                # If it's a legacy format with just name/chips, skip it
                elif 'name' in window:
                    # Skip legacy entries that don't have proper GW fields
                    continue
        return valid_windows


class ManualOverrides(BaseModel):
    """Manual overrides for transfers, captain, lineup."""
    planned_transfers: List[ManualTransfer] = Field(default_factory=list)
    captain: Optional[str] = None
    vice_captain: Optional[str] = None
    last_updated: Optional[datetime] = None

    model_config = ConfigDict(extra='ignore')

    @field_validator('planned_transfers', mode='before')
    @classmethod
    def normalize_transfers(cls, v):
        """Handle list of dicts or empty values."""
        if not isinstance(v, list):
            return []
        return v


class TeamConfig(BaseModel):
    """
    Complete team configuration.

    Validates all fields on construction. Provides model_dump() for
    serialization and model_validate() for deserialization.
    """
    # Core identification
    manager_id: int = 0
    manager_name: str = "Unknown Manager"

    # Analysis settings - support both old (CHASE/DEFEND/BALANCED) and new terms
    risk_posture: str = "BALANCED"

    # Chip management
    manual_chip_status: Dict[str, ChipStatus] = Field(default_factory=dict)
    chip_policy: ChipPolicy = Field(default_factory=ChipPolicy)
    chip_data_source: Optional[str] = None

    # Override settings
    manual_free_transfers: Optional[int] = None
    manual_overrides: Optional[ManualOverrides] = None
    manual_injury_overrides: Dict[str, Any] = Field(default_factory=dict)
    manual_data_source: Optional[str] = None
    injury_data_source: Optional[str] = None

    # Context
    manager_context: Optional[str] = None

    # Metadata
    last_manual_update: Optional[datetime] = None
    config_version: str = "1.0"

    model_config = ConfigDict(
        extra='ignore',  # Forward compatibility: ignore unknown fields
        validate_assignment=True  # Validate on attribute changes
    )

    @field_validator('risk_posture', mode='before')
    @classmethod
    def normalize_risk_posture(cls, v):
        """Normalize risk posture to canonical values (CONSERVATIVE|BALANCED|AGGRESSIVE)."""
        if not v:
            return "BALANCED"
        v_upper = str(v).upper()
        # Map legacy names to canonical values
        mapping = {
            "DEFEND": "CONSERVATIVE",  # Legacy -> canonical
            "CHASE": "AGGRESSIVE",      # Legacy -> canonical
            "CONSERVATIVE": "CONSERVATIVE",
            "BALANCED": "BALANCED",
            "AGGRESSIVE": "AGGRESSIVE"
        }
        return mapping.get(v_upper, "BALANCED")

    @field_validator('manual_chip_status', mode='before')
    @classmethod
    def normalize_chip_status(cls, v):
        """Handle legacy formats: string JSON, empty values."""
        if isinstance(v, str):
            import json
            try:
                v = json.loads(v)
            except json.JSONDecodeError:
                v = {}
        if not isinstance(v, dict):
            v = {}
        # Ensure all chips have status
        result = {}
        for chip in ["Wildcard", "Free Hit", "Bench Boost", "Triple Captain"]:
            if chip not in v:
                result[chip] = {"available": True, "played_gw": None}
            elif isinstance(v[chip], bool):
                # Handle legacy format: chip: True/False
                result[chip] = {"available": v[chip], "played_gw": None}
            elif isinstance(v[chip], dict):
                result[chip] = v[chip]
            else:
                result[chip] = {"available": True, "played_gw": None}
        return result

    @field_validator('manual_overrides', mode='before')
    @classmethod
    def normalize_manual_overrides(cls, v):
        """Handle legacy formats for manual overrides."""
        if isinstance(v, str):
            import json
            try:
                v = json.loads(v)
            except json.JSONDecodeError:
                return None
        if not isinstance(v, dict):
            return None
        if not v:
            return None
        return v

    @field_validator('chip_policy', mode='before')
    @classmethod
    def normalize_chip_policy(cls, v):
        """Handle missing or malformed chip policy."""
        if isinstance(v, str):
            import json
            try:
                v = json.loads(v)
            except json.JSONDecodeError:
                v = {}
        if not isinstance(v, dict):
            v = {}
        return v

    @field_validator('last_manual_update', mode='before')
    @classmethod
    def parse_datetime(cls, v):
        """Handle ISO format datetime strings."""
        if v is None:
            return None
        if isinstance(v, datetime):
            return v
        if isinstance(v, str):
            try:
                return datetime.fromisoformat(v)
            except ValueError:
                return None
        return None
