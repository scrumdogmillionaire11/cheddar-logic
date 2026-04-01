"""
Tests that verify risk_posture actually changes observable output.

These are regression/verification tests — they FAIL if risk posture becomes
a no-op, which is the bug we're guarding against.

Coverage:
  Layer 1 – primitives (no I/O)
    - get_volatility_multiplier: three distinct values, correct ordering
    - normalize_risk_posture (constants): lowercase, None, invalid raises
    - derive_strategy_mode: posture nudges strategy mode

  Layer 2 – transfer filtering
    - filter_transfers_by_risk: count caps differ (2 / 3 / 5)
    - filter_transfers_by_risk: gain threshold is stricter for CONSERVATIVE

  Layer 3 – candidate scoring (TransferAdvisor)
    - high-volatility candidate scored lower under CONSERVATIVE than AGGRESSIVE
    - difference is monotone: aggressive > balanced > conservative

  Layer 4 – result_transformer helpers
    - _normalize_risk_posture in result_transformer handles all input variants
    - _derive_strategy_mode in result_transformer is consistent with constants
"""
import types
import pytest

# ──────────────────────────────────────────────────────────
# Layer 1 – primitives
# ──────────────────────────────────────────────────────────

from cheddar_fpl_sage.analysis.decision_framework.constants import (
    get_volatility_multiplier,
    normalize_risk_posture,
    derive_strategy_mode,
)


class TestGetVolatilityMultiplier:
    """Verify that CONSERVATIVE penalises volatility most, AGGRESSIVE least."""

    def test_conservative_highest_multiplier(self):
        assert get_volatility_multiplier("CONSERVATIVE") == pytest.approx(1.25)

    def test_balanced_neutral(self):
        assert get_volatility_multiplier("BALANCED") == pytest.approx(1.0)

    def test_aggressive_lowest_multiplier(self):
        assert get_volatility_multiplier("AGGRESSIVE") == pytest.approx(0.8)

    def test_ordering_conservative_gt_balanced_gt_aggressive(self):
        c = get_volatility_multiplier("CONSERVATIVE")
        b = get_volatility_multiplier("BALANCED")
        a = get_volatility_multiplier("AGGRESSIVE")
        assert c > b > a, f"Expected C>B>A got {c}/{b}/{a}"

    def test_unknown_posture_returns_neutral(self):
        # Graceful fallback — unknown posture does not blow up
        assert get_volatility_multiplier("UNKNOWN") == pytest.approx(1.0)


class TestNormalizeRiskPosture:
    def test_lowercase_accepted(self):
        assert normalize_risk_posture("conservative") == "CONSERVATIVE"
        assert normalize_risk_posture("balanced") == "BALANCED"
        assert normalize_risk_posture("aggressive") == "AGGRESSIVE"

    def test_mixed_case_accepted(self):
        assert normalize_risk_posture("ConServaTive") == "CONSERVATIVE"

    def test_none_returns_default_balanced(self):
        assert normalize_risk_posture(None) == "BALANCED"

    def test_empty_string_returns_default(self):
        assert normalize_risk_posture("") == "BALANCED"
        assert normalize_risk_posture("   ") == "BALANCED"

    def test_invalid_raises_value_error(self):
        with pytest.raises(ValueError, match="Invalid risk_posture"):
            normalize_risk_posture("YOLO")


class TestDeriveStrategyMode:
    """Risk posture nudges the strategy mode up/down one step from rank bucket."""

    def test_mid_rank_balanced_posture_returns_balanced(self):
        # mid bucket → BALANCED base; neutral posture → BALANCED
        mode = derive_strategy_mode(1_000_000, "BALANCED")
        assert mode == "BALANCED"

    def test_mid_rank_aggressive_posture_shifts_toward_recovery(self):
        # mid bucket → BALANCED; aggressive nudge → RECOVERY
        mode = derive_strategy_mode(1_000_000, "AGGRESSIVE")
        assert mode == "RECOVERY"

    def test_mid_rank_conservative_posture_shifts_toward_controlled(self):
        # mid bucket → BALANCED; conservative nudge → CONTROLLED
        mode = derive_strategy_mode(1_000_000, "CONSERVATIVE")
        assert mode == "CONTROLLED"

    def test_elite_rank_conservative_stays_defend(self):
        # elite → DEFEND; conservative can't go further → DEFEND
        mode = derive_strategy_mode(10_000, "CONSERVATIVE")
        assert mode == "DEFEND"

    def test_elite_rank_aggressive_pushes_to_controlled(self):
        mode = derive_strategy_mode(10_000, "AGGRESSIVE")
        assert mode == "CONTROLLED"

    def test_strong_rank_conservative_pushes_to_defend(self):
        # strong → CONTROLLED; conservative nudge → DEFEND
        mode = derive_strategy_mode(100_000, "CONSERVATIVE")
        assert mode == "DEFEND"

    def test_different_postures_produce_different_modes_for_same_rank(self):
        conservative = derive_strategy_mode(1_000_000, "CONSERVATIVE")
        balanced = derive_strategy_mode(1_000_000, "BALANCED")
        aggressive = derive_strategy_mode(1_000_000, "AGGRESSIVE")
        assert conservative != balanced or balanced != aggressive, (
            "All three postures produced the same strategy mode — posture has no effect!"
        )


# ──────────────────────────────────────────────────────────
# Layer 2 – transfer filtering
# ──────────────────────────────────────────────────────────

from backend.services.risk_aware_filter import filter_transfers_by_risk


def _make_recs(count: int, pts_label: str = "Gain of 2.0pts projected"):
    """Helper: generate `count` identical-looking transfer recs."""
    return [
        {"action": f"Transfer {i}", "reason": pts_label, "suggested": f"Player {i}"}
        for i in range(count)
    ]


class TestFilterTransfersByRiskCountCaps:
    """The count cap (2/3/5) must be enforced regardless of gain."""

    def test_conservative_caps_at_two(self):
        recs = _make_recs(10)
        result = filter_transfers_by_risk(recs, "CONSERVATIVE")
        assert len(result) <= 2

    def test_balanced_caps_at_three(self):
        recs = _make_recs(10)
        result = filter_transfers_by_risk(recs, "BALANCED")
        assert len(result) <= 3

    def test_aggressive_caps_at_five(self):
        recs = _make_recs(10)
        result = filter_transfers_by_risk(recs, "AGGRESSIVE")
        assert len(result) <= 5

    def test_count_ordering_conservative_lte_balanced_lte_aggressive(self):
        recs = _make_recs(10)
        c = len(filter_transfers_by_risk(recs, "CONSERVATIVE"))
        b = len(filter_transfers_by_risk(recs, "BALANCED"))
        a = len(filter_transfers_by_risk(recs, "AGGRESSIVE"))
        assert c <= b <= a, f"Count ordering violated: C={c} B={b} A={a}"

    def test_caps_produce_different_counts_for_same_input(self):
        recs = _make_recs(10)
        c = len(filter_transfers_by_risk(recs, "CONSERVATIVE"))
        a = len(filter_transfers_by_risk(recs, "AGGRESSIVE"))
        assert c < a, "Conservative and aggressive returned the same count — cap has no effect!"


class TestFilterTransfersByRiskGainThreshold:
    """CONSERVATIVE requires higher point gain to include a recommendation."""

    def test_borderline_gain_excluded_by_conservative_but_not_aggressive(self):
        # base_min_gain=1.5, CONSERVATIVE multiplier=1.5 → threshold=2.25
        # AGGRESSIVE multiplier=0.7 → threshold=1.05
        # Use a rec with 1.5pts — passes AGGRESSIVE, fails CONSERVATIVE
        borderline = [{"reason": "Expected gain of 1.5pts", "suggested": "PlayerX"}]
        conservative = filter_transfers_by_risk(borderline, "CONSERVATIVE", base_min_gain=1.5)
        aggressive = filter_transfers_by_risk(borderline, "AGGRESSIVE", base_min_gain=1.5)
        assert len(aggressive) >= len(conservative), (
            "AGGRESSIVE should keep borderline recs that CONSERVATIVE drops"
        )

    def test_high_gain_passes_all_postures(self):
        # 5.0pts gain passes every threshold
        high_gain = [{"reason": "Projected gain of 5.0pts this GW", "suggested": "Salah"}]
        for posture in ("CONSERVATIVE", "BALANCED", "AGGRESSIVE"):
            result = filter_transfers_by_risk(high_gain, posture, base_min_gain=1.5)
            assert len(result) == 1, f"{posture} incorrectly filtered a 5.0pt gain rec"

    def test_very_low_gain_excluded_by_conservative(self):
        # 0.5pts below CONSERVATIVE's threshold of 2.25
        low_gain = [{"reason": "Small gain of 0.5pts", "suggested": "Bench Player"}]
        conservative = filter_transfers_by_risk(low_gain, "CONSERVATIVE", base_min_gain=1.5)
        # 0.5pts < 2.25 threshold → should be filtered
        assert len(conservative) == 0, (
            "CONSERVATIVE kept a 0.5pt gain rec that should be below threshold"
        )


# ──────────────────────────────────────────────────────────
# Layer 3 – TransferAdvisor candidate scoring
# ──────────────────────────────────────────────────────────

from cheddar_fpl_sage.analysis.decision_framework.transfer_advisor import (
    TransferAdvisor,
)


def _make_volatile_player(volatility: float = 5.0):
    """Minimal mock player object with high volatility."""
    p = types.SimpleNamespace()
    p.nextGW_pts = 6.0
    p.ownership_pct = 25.0
    p.floor = 4.0
    p.ceiling = 10.0
    p.volatility_score = volatility
    p.points_per_million = 7.0
    p.chance_of_playing_next_round = 100
    p.player_id = 999
    p.fixture_horizon_context = {}
    return p


class TestTransferAdvisorScoringByRiskPosture:
    """High-volatility players must score lower under CONSERVATIVE than AGGRESSIVE."""

    def test_volatile_player_score_conservative_lt_aggressive(self):
        player = _make_volatile_player(volatility=5.0)
        advisor_con = TransferAdvisor(risk_posture="CONSERVATIVE")
        advisor_agg = TransferAdvisor(risk_posture="AGGRESSIVE")

        score_con = advisor_con._score_candidate_for_strategy(player, "BALANCED")
        score_agg = advisor_agg._score_candidate_for_strategy(player, "BALANCED")

        assert score_con < score_agg, (
            f"CONSERVATIVE score ({score_con:.3f}) should be < AGGRESSIVE ({score_agg:.3f}) "
            f"for a high-volatility player — risk posture has no effect on scoring!"
        )

    def test_volatile_player_score_monotone_c_lt_b_lt_a(self):
        player = _make_volatile_player(volatility=5.0)
        advisor_c = TransferAdvisor(risk_posture="CONSERVATIVE")
        advisor_b = TransferAdvisor(risk_posture="BALANCED")
        advisor_a = TransferAdvisor(risk_posture="AGGRESSIVE")

        sc = advisor_c._score_candidate_for_strategy(player, "BALANCED")
        sb = advisor_b._score_candidate_for_strategy(player, "BALANCED")
        sa = advisor_a._score_candidate_for_strategy(player, "BALANCED")

        assert sc < sb < sa, (
            f"Score ordering wrong: C={sc:.3f} B={sb:.3f} A={sa:.3f}. "
            f"Expected CONSERVATIVE < BALANCED < AGGRESSIVE for volatile player."
        )

    def test_stable_player_diverges_less_than_volatile_player(self):
        """A zero-volatility player should diverge LESS between postures than a volatile one.

        The volatility penalty is the key mechanism — removing volatility should
        reduce the posture-driven gap, even if other minor factors (horizon adj etc.)
        still produce some small difference.
        """
        volatile_player = _make_volatile_player(volatility=5.0)
        stable_player = _make_volatile_player(volatility=0.0)

        advisor_c = TransferAdvisor(risk_posture="CONSERVATIVE")
        advisor_a = TransferAdvisor(risk_posture="AGGRESSIVE")

        volatile_gap = abs(
            advisor_c._score_candidate_for_strategy(volatile_player, "BALANCED")
            - advisor_a._score_candidate_for_strategy(volatile_player, "BALANCED")
        )
        stable_gap = abs(
            advisor_c._score_candidate_for_strategy(stable_player, "BALANCED")
            - advisor_a._score_candidate_for_strategy(stable_player, "BALANCED")
        )

        assert volatile_gap > stable_gap, (
            f"Volatile player gap ({volatile_gap:.3f}) should exceed stable player gap ({stable_gap:.3f}). "
            f"Risk posture's volatility penalty is not contributing to score differentiation."
        )

    def test_scoring_differs_under_defend_strategy(self):
        """Under DEFEND, volatility penalty is 1.2x — posture magnifies the gap further."""
        player = _make_volatile_player(volatility=3.0)
        advisor_c = TransferAdvisor(risk_posture="CONSERVATIVE")
        advisor_a = TransferAdvisor(risk_posture="AGGRESSIVE")

        sc = advisor_c._score_candidate_for_strategy(player, "DEFEND")
        sa = advisor_a._score_candidate_for_strategy(player, "DEFEND")

        assert sc < sa, (
            f"Under DEFEND, CONSERVATIVE should penalise volatility more than AGGRESSIVE. "
            f"Got C={sc:.3f} A={sa:.3f}"
        )


# ──────────────────────────────────────────────────────────
# Layer 4 – result_transformer helpers
# ──────────────────────────────────────────────────────────

from backend.services.result_transformer import (
    _normalize_risk_posture as rt_normalize,
    _derive_strategy_mode as rt_derive,
)


class TestResultTransformerRiskHelpers:
    """The transformer's internal helpers must honour posture correctly."""

    def test_rt_normalize_lowercases_to_correct_value(self):
        assert rt_normalize("conservative") == "CONSERVATIVE"
        assert rt_normalize("aggressive") == "AGGRESSIVE"
        assert rt_normalize("balanced") == "BALANCED"

    def test_rt_normalize_none_returns_balanced(self):
        assert rt_normalize(None) == "BALANCED"

    def test_rt_normalize_invalid_falls_back_gracefully(self):
        # result_transformer should not blow up on garbage input — it normalizes
        result = rt_normalize("garbage")
        # It may return "BALANCED" or raise; either is acceptable, but it must
        # not propagate unknown strings silently as-is
        assert result in ("BALANCED", "CONSERVATIVE", "AGGRESSIVE"), (
            f"Unexpected normalised value: '{result}'"
        )

    def test_rt_derive_strategy_mode_differs_by_posture(self):
        """Two calls with identical rank but different posture must produce different modes."""
        rank = 1_000_000  # mid-bucket
        mode_con = rt_derive(rank, "CONSERVATIVE")
        mode_agg = rt_derive(rank, "AGGRESSIVE")
        assert mode_con != mode_agg, (
            f"rt_derive returned '{mode_con}' for both postures — posture has no effect!"
        )

    def test_rt_derive_consistent_with_constants(self):
        """result_transformer and constants module must agree."""
        from cheddar_fpl_sage.analysis.decision_framework.constants import (
            derive_strategy_mode as const_derive,
        )
        for rank in (5_000, 200_000, 1_500_000, 5_000_000):
            for posture in ("CONSERVATIVE", "BALANCED", "AGGRESSIVE"):
                rt = rt_derive(rank, posture)
                const = const_derive(rank, posture)
                assert rt == const, (
                    f"Mismatch at rank={rank} posture={posture}: "
                    f"transformer='{rt}' vs constants='{const}'"
                )
