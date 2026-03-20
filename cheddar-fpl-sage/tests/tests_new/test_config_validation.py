"""
Tests for config serialization and validation.

Covers edge cases identified in CONCERNS.md:
- Stringified JSON in config fields
- Malformed JSON
- Missing required fields
- Config corruption recovery
- Round-trip consistency
"""
import pytest
import json

from cheddar_fpl_sage.analysis.decision_framework import (
    TeamConfig, ChipStatus, ConfigurationError
)
from cheddar_fpl_sage.utils.sprint3_5_config_manager import Sprint35ConfigManager


class TestTeamConfigValidation:
    """Tests for TeamConfig Pydantic model."""

    def test_basic_config_creation(self):
        """Config creates with required fields."""
        config = TeamConfig(manager_id=123, manager_name="Test")
        assert config.manager_id == 123
        assert config.manager_name == "Test"
        assert config.risk_posture == "BALANCED"  # default

    def test_invalid_manager_id_rejected(self):
        """Invalid manager_id type raises validation error."""
        with pytest.raises(Exception) as exc_info:
            TeamConfig(manager_id="not_an_int", manager_name="Test")
        # ValidationError should mention the field
        assert "manager_id" in str(exc_info.value).lower() or "int" in str(exc_info.value).lower()

    def test_risk_posture_normalization(self):
        """Risk posture normalizes legacy values to canonical CONSERVATIVE/BALANCED/AGGRESSIVE."""
        # CHASE -> AGGRESSIVE (legacy mapping)
        config1 = TeamConfig(manager_id=123, risk_posture="CHASE")
        assert config1.risk_posture == "AGGRESSIVE"

        # DEFEND -> CONSERVATIVE (legacy mapping)
        config2 = TeamConfig(manager_id=123, risk_posture="DEFEND")
        assert config2.risk_posture == "CONSERVATIVE"

        # Valid canonical values pass through unchanged
        config3 = TeamConfig(manager_id=123, risk_posture="BALANCED")
        assert config3.risk_posture == "BALANCED"

        config4 = TeamConfig(manager_id=123, risk_posture="AGGRESSIVE")
        assert config4.risk_posture == "AGGRESSIVE"

        config5 = TeamConfig(manager_id=123, risk_posture="CONSERVATIVE")
        assert config5.risk_posture == "CONSERVATIVE"

    def test_stringified_json_chip_status(self):
        """Handles legacy stringified JSON in chip status."""
        legacy_data = {
            "manager_id": 123,
            "manual_chip_status": '{"Wildcard": {"available": false, "played_gw": 10}}'
        }
        config = TeamConfig.model_validate(legacy_data)
        assert config.manual_chip_status["Wildcard"].available == False
        assert config.manual_chip_status["Wildcard"].played_gw == 10

    def test_boolean_chip_status_legacy(self):
        """Handles legacy boolean chip status."""
        legacy_data = {
            "manager_id": 123,
            "manual_chip_status": {"Wildcard": True, "Free Hit": False}
        }
        config = TeamConfig.model_validate(legacy_data)
        assert config.manual_chip_status["Wildcard"].available == True
        assert config.manual_chip_status["Free Hit"].available == False

    def test_missing_chips_get_defaults(self):
        """Missing chips in status get default values."""
        config = TeamConfig(manager_id=123, manual_chip_status={})
        assert "Wildcard" in config.manual_chip_status
        assert "Free Hit" in config.manual_chip_status
        assert config.manual_chip_status["Bench Boost"].available == True
        assert config.manual_chip_status["Triple Captain"].available == True

    def test_round_trip_consistency(self):
        """Config survives JSON round-trip unchanged."""
        original = TeamConfig(
            manager_id=456,
            manager_name="Round Trip Test",
            risk_posture="CHASE"
        )
        # Set chip status after creation to test specific values
        original.manual_chip_status["Wildcard"] = ChipStatus(available=False, played_gw=5)

        # Serialize and deserialize
        json_str = original.model_dump_json()
        reloaded = TeamConfig.model_validate_json(json_str)

        assert reloaded.manager_id == original.manager_id
        assert reloaded.manager_name == original.manager_name
        assert reloaded.risk_posture == original.risk_posture
        # The Wildcard should preserve its values after round-trip
        assert reloaded.manual_chip_status["Wildcard"].available == False
        assert reloaded.manual_chip_status["Wildcard"].played_gw == 5

    def test_extra_fields_ignored(self):
        """Unknown fields don't break validation (forward compat)."""
        future_data = {
            "manager_id": 123,
            "manager_name": "Future",
            "new_field_from_v2": "should be ignored",
            "another_new_field": {"nested": "data"}
        }
        config = TeamConfig.model_validate(future_data)
        assert config.manager_id == 123
        # No error raised

    def test_manual_overrides_with_transfers(self):
        """Manual overrides with planned transfers validates correctly."""
        data = {
            "manager_id": 123,
            "manual_overrides": {
                "planned_transfers": [
                    {"out_name": "Player A", "in_name": "Player B", "cost": 0}
                ],
                "last_updated": "2026-01-23T12:00:00"
            }
        }
        config = TeamConfig.model_validate(data)
        assert config.manual_overrides is not None
        assert len(config.manual_overrides.planned_transfers) == 1

    def test_empty_manual_overrides(self):
        """Empty manual overrides becomes None."""
        data = {
            "manager_id": 123,
            "manual_overrides": {}
        }
        config = TeamConfig.model_validate(data)
        assert config.manual_overrides is None


class TestConfigManagerIntegration:
    """Tests for Sprint35ConfigManager with Pydantic validation."""

    @pytest.fixture
    def temp_config_dir(self, tmp_path):
        """Create temp directory for config tests."""
        return tmp_path

    def test_load_valid_config(self, temp_config_dir):
        """Valid config file loads successfully."""
        config_file = temp_config_dir / "team_config.json"
        config_file.write_text(json.dumps({
            "manager_id": 789,
            "manager_name": "Valid Test",
            "risk_posture": "CONSERVATIVE"
        }))

        manager = Sprint35ConfigManager(config_file=config_file)
        config = manager.get_config()

        assert config["manager_id"] == 789
        assert config["risk_posture"] == "CONSERVATIVE"

    def test_load_missing_file_uses_defaults(self, temp_config_dir):
        """Missing config file falls back to defaults."""
        config_file = temp_config_dir / "nonexistent.json"

        manager = Sprint35ConfigManager(config_file=config_file)
        config = manager.get_config()

        # Should get defaults, not crash
        assert "manager_id" in config
        assert config["manager_id"] == 0

    def test_load_malformed_json_raises_error(self, temp_config_dir):
        """Malformed JSON raises ConfigurationError."""
        config_file = temp_config_dir / "team_config.json"
        config_file.write_text("{ this is not valid json }")

        manager = Sprint35ConfigManager(config_file=config_file)

        # Should raise ConfigurationError for malformed JSON
        with pytest.raises(ConfigurationError):
            manager.get_config()

    def test_save_validates_before_write(self, temp_config_dir):
        """Invalid config data rejected on save."""
        config_file = temp_config_dir / "team_config.json"
        manager = Sprint35ConfigManager(config_file=config_file)

        # Try to save invalid config
        with pytest.raises(ConfigurationError):
            manager._save_to_disk({"manager_id": "not_an_int"})

    def test_atomic_write_preserves_on_failure(self, temp_config_dir):
        """Failed write doesn't corrupt existing config."""
        config_file = temp_config_dir / "team_config.json"
        original_content = json.dumps({"manager_id": 100, "manager_name": "Original"})
        config_file.write_text(original_content)

        manager = Sprint35ConfigManager(config_file=config_file)

        # Attempt invalid save
        try:
            manager._save_to_disk({"manager_id": "invalid"})
        except ConfigurationError:
            pass

        # Original should be preserved
        assert json.loads(config_file.read_text())["manager_id"] == 100

    def test_round_trip_with_real_config(self, temp_config_dir):
        """Config round-trips through manager without data loss."""
        config_file = temp_config_dir / "team_config.json"
        original = {
            "manager_id": 12345,
            "manager_name": "Test Manager",
            "risk_posture": "CHASE",
            "manual_chip_status": {
                "Wildcard": {"available": True, "played_gw": None}
            },
            "manual_free_transfers": 2
        }
        config_file.write_text(json.dumps(original))

        manager = Sprint35ConfigManager(config_file=config_file)

        # Load
        loaded = manager.get_config(force_reload=True)
        assert loaded["manager_id"] == 12345
        assert loaded["manager_name"] == "Test Manager"

        # Save
        manager._save_to_disk(loaded)

        # Reload and verify
        reloaded = manager.get_config(force_reload=True)
        assert reloaded["manager_id"] == 12345
        assert reloaded["manual_free_transfers"] == 2

    def test_path_object_accepted(self, temp_config_dir):
        """Config manager accepts Path objects."""
        config_file = temp_config_dir / "team_config.json"
        config_file.write_text(json.dumps({"manager_id": 999}))

        # Should work with Path object
        manager = Sprint35ConfigManager(config_file=config_file)
        config = manager.get_config()
        assert config["manager_id"] == 999

    def test_string_path_accepted(self, temp_config_dir):
        """Config manager accepts string paths."""
        config_file = temp_config_dir / "team_config.json"
        config_file.write_text(json.dumps({"manager_id": 888}))

        # Should work with string path
        manager = Sprint35ConfigManager(config_file=str(config_file))
        config = manager.get_config()
        assert config["manager_id"] == 888
