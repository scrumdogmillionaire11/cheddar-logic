"""
Tests for backend/config/risk_posture.py — the canonical posture config.

Covers:
  - Config loads and all three postures are present
  - Field ordering (aggressive most permissive, conservative most restrictive)
  - get_posture_config() normalisation and fallback behaviour
  - posture_hit_allowed() gate across all three postures
  - Ceiling/floor weights sum to 1.0 per posture
  - Hit time-horizon weights sum to 1.0 per posture
"""
import pytest

from backend.config.risk_posture import (
    RISK_POSTURE_CONFIGS,
    RiskPostureConfig,
    get_posture_config,
)
from backend.services.risk_aware_filter import posture_hit_allowed


# ─────────────────────────────────────────────────────────────────────────────
# Config presence and structure
# ─────────────────────────────────────────────────────────────────────────────

class TestConfigPresence:
    def test_all_three_postures_defined(self):
        for name in ("CONSERVATIVE", "BALANCED", "AGGRESSIVE"):
            assert name in RISK_POSTURE_CONFIGS, f"Missing posture: {name}"

    def test_all_configs_are_frozen_dataclasses(self):
        for posture, cfg in RISK_POSTURE_CONFIGS.items():
            assert isinstance(cfg, RiskPostureConfig)
            with pytest.raises((AttributeError, TypeError)):
                cfg.name = "MUTATED"  # type: ignore[misc]

    def test_ceiling_floor_weights_sum_to_one(self):
        for name, cfg in RISK_POSTURE_CONFIGS.items():
            total = cfg.transfer_ceiling_weight + cfg.transfer_floor_weight
            assert abs(total - 1.0) < 1e-9, (
                f"{name}: ceiling_weight + floor_weight = {total} (expected 1.0)"
            )

    def test_hit_horizon_weights_sum_to_one(self):
        for name, cfg in RISK_POSTURE_CONFIGS.items():
            total = cfg.hit_short_weight + cfg.hit_mid_weight
            assert abs(total - 1.0) < 1e-9, (
                f"{name}: hit_short_weight + hit_mid_weight = {total} (expected 1.0)"
            )

    def test_posture_signal_values_are_valid(self):
        valid = {"CHASE", "HOLD", "PROTECT"}
        for name, cfg in RISK_POSTURE_CONFIGS.items():
            assert cfg.posture_signal_default in valid, (
                f"{name}: invalid posture_signal_default '{cfg.posture_signal_default}'"
            )


# ─────────────────────────────────────────────────────────────────────────────
# Ordering: aggressive must be most permissive, conservative most restrictive
# ─────────────────────────────────────────────────────────────────────────────

class TestConfigOrdering:
    """Verify that parameter ordering is consistent with posture intent."""

    @property
    def agg(self): return RISK_POSTURE_CONFIGS["AGGRESSIVE"]

    @property
    def bal(self): return RISK_POSTURE_CONFIGS["BALANCED"]

    @property
    def con(self): return RISK_POSTURE_CONFIGS["CONSERVATIVE"]

    def test_hit_threshold_conservative_highest(self):
        assert self.con.hit_threshold_net_pts > self.bal.hit_threshold_net_pts > self.agg.hit_threshold_net_pts

    def test_ceiling_weight_aggressive_highest(self):
        assert self.agg.transfer_ceiling_weight > self.bal.transfer_ceiling_weight > self.con.transfer_ceiling_weight

    def test_floor_weight_conservative_highest(self):
        assert self.con.transfer_floor_weight > self.bal.transfer_floor_weight > self.agg.transfer_floor_weight

    def test_diff_captain_bias_aggressive_highest(self):
        assert self.agg.diff_captain_bias > self.bal.diff_captain_bias >= self.con.diff_captain_bias

    def test_conservative_diff_captain_bias_is_zero(self):
        assert self.con.diff_captain_bias == 0.0

    def test_bench_boost_threshold_conservative_highest(self):
        assert self.con.bench_boost_threshold_pts > self.bal.bench_boost_threshold_pts > self.agg.bench_boost_threshold_pts

    def test_posture_signals_correct(self):
        assert self.agg.posture_signal_default == "CHASE"
        assert self.bal.posture_signal_default == "HOLD"
        assert self.con.posture_signal_default == "PROTECT"

    def test_aggressive_does_not_use_template_tiebreak(self):
        assert self.agg.captain_template_tiebreak is False

    def test_conservative_uses_template_tiebreak(self):
        assert self.con.captain_template_tiebreak is True


# ─────────────────────────────────────────────────────────────────────────────
# get_posture_config() normalisation
# ─────────────────────────────────────────────────────────────────────────────

class TestGetPostureConfig:
    def test_exact_uppercase_match(self):
        for name in ("CONSERVATIVE", "BALANCED", "AGGRESSIVE"):
            cfg = get_posture_config(name)
            assert cfg.name == name

    def test_lowercase_normalised(self):
        cfg = get_posture_config("aggressive")
        assert cfg.name == "AGGRESSIVE"

    def test_mixed_case_normalised(self):
        cfg = get_posture_config("ConServaTive")
        assert cfg.name == "CONSERVATIVE"

    def test_none_falls_back_to_balanced(self):
        cfg = get_posture_config(None)
        assert cfg.name == "BALANCED"

    def test_empty_string_falls_back_to_balanced(self):
        cfg = get_posture_config("")
        assert cfg.name == "BALANCED"

    def test_unknown_value_falls_back_to_balanced(self):
        cfg = get_posture_config("YOLO")
        assert cfg.name == "BALANCED"


# ─────────────────────────────────────────────────────────────────────────────
# posture_hit_allowed()
# ─────────────────────────────────────────────────────────────────────────────

class TestPostureHitAllowed:
    """
    Verify the posture-aware hit gate across all three scenarios.

    Base case: 4-point hit, delta_next2=6, delta_next6=10.
    """

    def _run(self, posture: str, delta_next2: float, delta_next6: float, hit_cost: float):
        cfg = get_posture_config(posture)
        return posture_hit_allowed(cfg, delta_next2, delta_next6, hit_cost)

    # ── AGGRESSIVE ───────────────────────────────────────────────────────────

    def test_aggressive_allows_thin_positive_net_gain(self):
        # weighted = 0.70*6 + 0.30*10 - 4 = 4.2 + 3.0 - 4 = 3.2 >= 1.5 → allow
        allowed, net = self._run("AGGRESSIVE", delta_next2=6.0, delta_next6=10.0, hit_cost=4)
        assert allowed is True
        assert net == pytest.approx(3.2)

    def test_aggressive_allows_below_balanced_threshold(self):
        # weighted = 0.70*3.5 + 0.30*5.0 - 4 = 2.45 + 1.5 - 4 = -0.05 — below 1.5
        allowed, _ = self._run("AGGRESSIVE", delta_next2=3.5, delta_next6=5.0, hit_cost=4)
        assert allowed is False

    def test_aggressive_threshold_is_1_5(self):
        cfg = get_posture_config("AGGRESSIVE")
        assert cfg.hit_threshold_net_pts == pytest.approx(1.5)

    # ── BALANCED ─────────────────────────────────────────────────────────────

    def test_balanced_allows_clear_gain(self):
        # weighted = 0.50*6 + 0.50*10 - 4 = 3.0 + 5.0 - 4 = 4.0 >= 3.0 → allow
        allowed, net = self._run("BALANCED", delta_next2=6.0, delta_next6=10.0, hit_cost=4)
        assert allowed is True
        assert net == pytest.approx(4.0)

    def test_balanced_blocks_marginal_gain(self):
        # weighted = 0.50*4.0 + 0.50*6.0 - 4 = 2.0 + 3.0 - 4 = 1.0 < 3.0 → block
        allowed, _ = self._run("BALANCED", delta_next2=4.0, delta_next6=6.0, hit_cost=4)
        assert allowed is False

    # ── CONSERVATIVE ─────────────────────────────────────────────────────────

    def test_conservative_blocks_same_case_aggressive_allows(self):
        # AGGRESSIVE would allow delta_next2=6, delta_next6=10, cost=4 (net=3.2)
        # CONSERVATIVE requires >= 6.0
        # weighted = 0.30*6 + 0.70*10 - 4 = 1.8 + 7.0 - 4 = 4.8 < 6.0 → block
        allowed, net = self._run("CONSERVATIVE", delta_next2=6.0, delta_next6=10.0, hit_cost=4)
        assert allowed is False
        assert net == pytest.approx(4.8)

    def test_conservative_allows_only_very_clear_gain(self):
        # weighted = 0.30*8 + 0.70*15 - 4 = 2.4 + 10.5 - 4 = 8.9 >= 6.0 → allow
        allowed, net = self._run("CONSERVATIVE", delta_next2=8.0, delta_next6=15.0, hit_cost=4)
        assert allowed is True
        assert net == pytest.approx(8.9)

    def test_conservative_weights_long_horizon(self):
        # Conservative should weight mid-horizon (next6) more heavily.
        # This means a player with weak next2 but strong run can still qualify.
        # next2=1, next6=15: weighted = 0.30*1 + 0.70*15 - 4 = 0.3 + 10.5 - 4 = 6.8 >= 6.0
        allowed, net = self._run("CONSERVATIVE", delta_next2=1.0, delta_next6=15.0, hit_cost=4)
        assert allowed is True
        assert net == pytest.approx(6.8)

    def test_aggressive_weights_short_horizon(self):
        # Aggressive should weight next2 more heavily.
        # next2=7, next6=1: weighted = 0.70*7 + 0.30*1 - 4 = 4.9 + 0.3 - 4 = 1.2
        # 1.2 < 1.5 → blocks even AGGRESSIVE when immediate upside isn't clearly justified
        allowed, _ = self._run("AGGRESSIVE", delta_next2=7.0, delta_next6=1.0, hit_cost=4)
        # net_gain = 4.9+0.3-4=1.2, threshold=1.5: blocked
        assert allowed is False

    def test_hit_thresholds_are_strictly_ordered(self):
        con = get_posture_config("CONSERVATIVE").hit_threshold_net_pts
        bal = get_posture_config("BALANCED").hit_threshold_net_pts
        agg = get_posture_config("AGGRESSIVE").hit_threshold_net_pts
        assert con > bal > agg, f"C={con} B={bal} A={agg}"
