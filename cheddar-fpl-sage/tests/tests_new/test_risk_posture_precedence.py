"""
Test risk posture precedence and validation.

Tests validate:
1. normalize_risk_posture() validation
2. get_volatility_multiplier() values
3. Config manager get/set methods
4. Orchestrator distribution to modules
5. Tri-state precedence: CLI > Runtime > Config > Default
"""
import pytest
from cheddar_fpl_sage.analysis.decision_framework.constants import (
    normalize_risk_posture,
    get_volatility_multiplier,
    DEFAULT_RISK_POSTURE
)
from cheddar_fpl_sage.analysis.enhanced_decision_framework import EnhancedDecisionFramework
from cheddar_fpl_sage.utils.sprint3_5_config_manager import Sprint35ConfigManager
import tempfile
import json
import os


class TestRiskPostureValidation:
    """Test normalize_risk_posture() validation logic"""
    
    def test_valid_postures_uppercase(self):
        """Valid uppercase postures pass through"""
        assert normalize_risk_posture("CONSERVATIVE") == "CONSERVATIVE"
        assert normalize_risk_posture("BALANCED") == "BALANCED"
        assert normalize_risk_posture("AGGRESSIVE") == "AGGRESSIVE"
    
    def test_valid_postures_lowercase(self):
        """Lowercase postures are normalized to uppercase"""
        assert normalize_risk_posture("conservative") == "CONSERVATIVE"
        assert normalize_risk_posture("balanced") == "BALANCED"
        assert normalize_risk_posture("aggressive") == "AGGRESSIVE"
    
    def test_valid_postures_mixedcase(self):
        """Mixed case postures are normalized to uppercase"""
        assert normalize_risk_posture("Conservative") == "CONSERVATIVE"
        assert normalize_risk_posture("BaLaNcEd") == "BALANCED"
        assert normalize_risk_posture("AgGrEsSiVe") == "AGGRESSIVE"
    
    def test_none_returns_default(self):
        """None returns DEFAULT_RISK_POSTURE"""
        assert normalize_risk_posture(None) == DEFAULT_RISK_POSTURE
        assert normalize_risk_posture() == DEFAULT_RISK_POSTURE
    
    def test_empty_string_returns_default(self):
        """Empty string returns DEFAULT_RISK_POSTURE"""
        assert normalize_risk_posture("") == DEFAULT_RISK_POSTURE
        assert normalize_risk_posture("   ") == DEFAULT_RISK_POSTURE
    
    def test_invalid_posture_raises_valueerror(self):
        """Invalid postures raise ValueError"""
        with pytest.raises(ValueError, match="Invalid risk_posture"):
            normalize_risk_posture("INVALID")
        
        with pytest.raises(ValueError, match="Invalid risk_posture"):
            normalize_risk_posture("CHASE")  # Old value
        
        with pytest.raises(ValueError, match="Invalid risk_posture"):
            normalize_risk_posture("DEFEND")  # Old value


class TestVolatilityMultiplier:
    """Test get_volatility_multiplier() returns correct values"""
    
    def test_conservative_multiplier(self):
        """CONSERVATIVE returns 1.25x (higher penalty for volatility)"""
        assert get_volatility_multiplier("CONSERVATIVE") == 1.25
    
    def test_balanced_multiplier(self):
        """BALANCED returns 1.0x (standard volatility)"""
        assert get_volatility_multiplier("BALANCED") == 1.0
    
    def test_aggressive_multiplier(self):
        """AGGRESSIVE returns 0.8x (lower penalty for volatility)"""
        assert get_volatility_multiplier("AGGRESSIVE") == 0.8
    
    def test_multiplier_accepts_lowercase(self):
        """Multiplier works with lowercase inputs (after normalization)"""
        normalized = normalize_risk_posture("conservative")
        assert get_volatility_multiplier(normalized) == 1.25


class TestConfigManagerRiskPosture:
    """Test Sprint35ConfigManager get/set_risk_posture methods"""
    
    def setup_method(self):
        """Create temp config file for testing"""
        self.temp_dir = tempfile.mkdtemp()
        self.config_file = os.path.join(self.temp_dir, "team_config.json")
        self.config_manager = Sprint35ConfigManager(self.config_file)
    
    def teardown_method(self):
        """Clean up temp files"""
        if os.path.exists(self.config_file):
            os.remove(self.config_file)
        os.rmdir(self.temp_dir)
    
    def test_get_risk_posture_default_when_missing(self):
        """Returns DEFAULT_RISK_POSTURE when config has no risk_posture"""
        # Empty config file
        with open(self.config_file, 'w') as f:
            json.dump({}, f)
        
        posture = self.config_manager.get_risk_posture()
        assert posture == DEFAULT_RISK_POSTURE
    
    def test_get_risk_posture_from_config(self):
        """Returns risk_posture from config when present"""
        with open(self.config_file, 'w') as f:
            json.dump({"risk_posture": "AGGRESSIVE"}, f)

        self.config_manager.invalidate_cache()  # Force reload after file write
        posture = self.config_manager.get_risk_posture()
        assert posture == "AGGRESSIVE"
    
    def test_get_risk_posture_normalizes_invalid(self):
        """Returns default when config has invalid risk_posture"""
        with open(self.config_file, 'w') as f:
            json.dump({"risk_posture": "INVALID_VALUE"}, f)

        self.config_manager.invalidate_cache()  # Force reload after file write
        posture = self.config_manager.get_risk_posture()
        assert posture == DEFAULT_RISK_POSTURE
    
    def test_set_risk_posture_runtime_only(self):
        """set_risk_posture with persist=False updates cache only"""
        # Start with empty config
        with open(self.config_file, 'w') as f:
            json.dump({}, f)

        self.config_manager.invalidate_cache()  # Force reload after file write
        success = self.config_manager.set_risk_posture("CONSERVATIVE", persist=False)
        assert success is True
        
        # Runtime value should be set
        posture = self.config_manager.get_risk_posture()
        assert posture == "CONSERVATIVE"
        
        # File should not be updated
        with open(self.config_file, 'r') as f:
            config = json.load(f)
        assert "risk_posture" not in config
    
    def test_set_risk_posture_persisted(self):
        """set_risk_posture with persist=True saves to config"""
        with open(self.config_file, 'w') as f:
            json.dump({}, f)

        self.config_manager.invalidate_cache()  # Force reload after file write
        success = self.config_manager.set_risk_posture("AGGRESSIVE", persist=True)
        assert success is True
        
        # File should be updated
        with open(self.config_file, 'r') as f:
            config = json.load(f)
        assert config["risk_posture"] == "AGGRESSIVE"
        
        # Reload should reflect persisted value
        self.config_manager.invalidate_cache()
        posture = self.config_manager.get_risk_posture()
        assert posture == "AGGRESSIVE"
    
    def test_set_risk_posture_invalid_raises_error(self):
        """set_risk_posture with invalid value returns False"""
        success = self.config_manager.set_risk_posture("INVALID", persist=False)
        assert success is False


class TestOrchestratorDistribution:
    """Test EnhancedDecisionFramework distributes risk_posture to modules"""
    
    def test_orchestrator_accepts_risk_posture(self):
        """Orchestrator accepts risk_posture in __init__"""
        framework = EnhancedDecisionFramework(risk_posture="CONSERVATIVE")
        assert framework.risk_posture == "CONSERVATIVE"
    
    def test_orchestrator_defaults_to_balanced(self):
        """Orchestrator defaults to BALANCED when not specified"""
        framework = EnhancedDecisionFramework()
        assert framework.risk_posture == "BALANCED"
    
    def test_orchestrator_normalizes_posture(self):
        """Orchestrator normalizes risk_posture to uppercase"""
        framework = EnhancedDecisionFramework(risk_posture="conservative")
        assert framework.risk_posture == "CONSERVATIVE"
    
    def test_orchestrator_validates_posture(self):
        """Orchestrator raises ValueError for invalid posture"""
        with pytest.raises(ValueError, match="Invalid risk_posture"):
            EnhancedDecisionFramework(risk_posture="INVALID")
    
    def test_modules_receive_risk_posture(self):
        """All domain modules receive risk_posture from orchestrator"""
        framework = EnhancedDecisionFramework(risk_posture="AGGRESSIVE")
        
        # Check module instances have correct risk_posture
        assert framework._chip_analyzer.risk_posture == "AGGRESSIVE"
        assert framework._transfer_advisor.risk_posture == "AGGRESSIVE"
        assert framework._captain_selector.risk_posture == "AGGRESSIVE"


class TestPrecedenceContract:
    """Test tri-state precedence: CLI > Runtime > Config > Default
    
    Note: Full precedence testing requires integration test with actual CLI/config flow.
    These tests validate the building blocks work correctly.
    """
    
    def test_cli_override_precedence(self):
        """CLI argument should override config value (tested via config_manager)"""
        # Simulate: config has CONSERVATIVE, CLI provides AGGRESSIVE
        temp_dir = tempfile.mkdtemp()
        config_file = os.path.join(temp_dir, "team_config.json")
        
        try:
            with open(config_file, 'w') as f:
                json.dump({"risk_posture": "CONSERVATIVE"}, f)
            
            config_manager = Sprint35ConfigManager(config_file)
            
            # Simulate CLI override by setting runtime value
            config_manager.set_risk_posture("AGGRESSIVE", persist=False)
            
            # Runtime should win
            assert config_manager.get_risk_posture() == "AGGRESSIVE"
        finally:
            os.remove(config_file)
            os.rmdir(temp_dir)
    
    def test_config_over_default(self):
        """Config value should override default"""
        temp_dir = tempfile.mkdtemp()
        config_file = os.path.join(temp_dir, "team_config.json")
        
        try:
            with open(config_file, 'w') as f:
                json.dump({"risk_posture": "CONSERVATIVE"}, f)
            
            config_manager = Sprint35ConfigManager(config_file)
            
            # Config value should override default (BALANCED)
            assert config_manager.get_risk_posture() == "CONSERVATIVE"
        finally:
            os.remove(config_file)
            os.rmdir(temp_dir)
    
    def test_default_when_no_config(self):
        """Default is used when no config exists"""
        temp_dir = tempfile.mkdtemp()
        config_file = os.path.join(temp_dir, "team_config_nonexistent.json")
        
        try:
            config_manager = Sprint35ConfigManager(config_file)
            
            # Should return default when no config
            assert config_manager.get_risk_posture() == DEFAULT_RISK_POSTURE
        finally:
            # Clean up temp dir only
            os.rmdir(temp_dir)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
