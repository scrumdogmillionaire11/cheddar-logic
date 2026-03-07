#!/usr/bin/env python3
"""
ODDS API Token Quota Analysis
==============================

Analyzes monthly token consumption for The Odds API based on:
- Production scheduler frequency (hourly baseline)
- Integration test runs (variable frequency)
- Backstop refresh overhead (10-min intervals during game windows)

Outputs:
- Current quota utilization percentage
- Remaining buffer
- Risk zone classification
- Recommended mitigation strategies if quota insufficient
"""

import math
from dataclasses import dataclass
from typing import List, Tuple
from enum import Enum


# ============================================================================
# CONFIGURATION (Based on codebase analysis)
# ============================================================================

@dataclass
class SportConfig:
    """Sport-specific API configuration"""
    name: str
    tokens_per_fetch: int
    active: bool
    avg_games_per_day: float  # For backstop calculations


# Current sports configuration (March 2026)
# Source: packages/odds/src/config.js
SPORTS = [
    SportConfig("NHL", tokens_per_fetch=2, active=True, avg_games_per_day=8),
    SportConfig("NBA", tokens_per_fetch=3, active=True, avg_games_per_day=10),
    SportConfig("NCAAM", tokens_per_fetch=3, active=True, avg_games_per_day=15),
    SportConfig("MLB", tokens_per_fetch=2, active=False, avg_games_per_day=0),
    SportConfig("NFL", tokens_per_fetch=3, active=False, avg_games_per_day=0),
]

# API Quota
MONTHLY_QUOTA = 20_000  # User's paid tier

# Production scheduler (hourly, skips 2am-5am ET overnight)
# Source: apps/worker/src/schedulers/main.js
HOURS_PER_DAY = 21  # 24 hours - 3 overnight hours (2am-5am)
DAYS_PER_MONTH = 30

# Backstop refresh (every 10 minutes during T-6h game windows)
# Source: apps/worker/src/schedulers/main.js
BACKSTOP_ENABLED = True
BACKSTOP_INTERVAL_MINUTES = 10
BACKSTOP_WINDOW_HOURS = 6  # Only runs within 6 hours of game time

# Testing patterns (from user input: "daily or a few times per week")
# Tests use same API key as production
TEST_SCENARIOS = {
    "conservative": 3,   # 3 test runs per week × 4 weeks = 12 runs/month
    "moderate": 5,       # 5 test runs per week × 4 weeks = 20 runs/month
    "aggressive": 7,     # Daily testing = 30 runs/month (7 days × ~4 weeks)
}


# ============================================================================
# CALCULATIONS
# ============================================================================

def calculate_tokens_per_fetch() -> int:
    """Calculate total tokens consumed per fetch (all active sports)"""
    return sum(sport.tokens_per_fetch for sport in SPORTS if sport.active)


def calculate_baseline_production(tokens_per_fetch: int) -> int:
    """
    Calculate baseline production consumption (hourly scheduler)
    
    Source: apps/worker/src/jobs/pull_odds_hourly.js
    Runs every hour except 2am-5am ET (21 fetches/day)
    Skips overnight when no NHL/NBA/NCAAM games occur
    """
    fetches_per_day = HOURS_PER_DAY
    fetches_per_month = fetches_per_day * DAYS_PER_MONTH
    return tokens_per_fetch * fetches_per_month


def calculate_backstop_overhead(tokens_per_fetch: int) -> Tuple[int, int, int]:
    """
    Estimate backstop refresh overhead
    
    Source: apps/worker/src/schedulers/main.js (refresh_stale_odds job)
    - Runs every 10 minutes
    - Only fetches when games are within T-6h window
    - Variable consumption based on game schedule density
    
    Returns: (min_tokens, avg_tokens, max_tokens)
    """
    if not BACKSTOP_ENABLED:
        return (0, 0, 0)
    
    # Calculate total active game window hours per day (across all sports)
    total_game_window_hours = 0
    for sport in SPORTS:
        if sport.active:
            # Each game has 6-hour window, but games overlap
            # Conservative estimate: games spread across 4-6 hour evening block
            # Per sport, assume 5 peak hours with active games
            total_game_window_hours += 5
    
    # Backstop runs every 10 minutes = 6 times per hour
    backstop_runs_per_hour = 60 / BACKSTOP_INTERVAL_MINUTES
    
    # Not all backstop runs trigger fetches (only if odds are >20min stale)
    # Estimate fetch probability per run
    fetch_probability_min = 0.3   # 30% of runs fetch (many games have fresh data)
    fetch_probability_avg = 0.5   # 50% average
    fetch_probability_max = 0.8   # 80% during high-density periods
    
    # Daily backstop fetches
    daily_runs = total_game_window_hours * backstop_runs_per_hour
    daily_fetches_min = daily_runs * fetch_probability_min
    daily_fetches_avg = daily_runs * fetch_probability_avg
    daily_fetches_max = daily_runs * fetch_probability_max
    
    # Monthly overhead
    monthly_fetches_min = math.floor(daily_fetches_min * DAYS_PER_MONTH)
    monthly_fetches_avg = math.floor(daily_fetches_avg * DAYS_PER_MONTH)
    monthly_fetches_max = math.floor(daily_fetches_max * DAYS_PER_MONTH)
    
    return (
        tokens_per_fetch * monthly_fetches_min,
        tokens_per_fetch * monthly_fetches_avg,
        tokens_per_fetch * monthly_fetches_max,
    )


def calculate_test_consumption(tokens_per_fetch: int, scenario: str) -> int:
    """
    Calculate integration test token consumption
    
    Source: apps/worker/src/jobs/__tests__/pull_odds_hourly.test.js
    Tests call real API when ODDS_API_KEY is set
    Each test run executes full job = 1 fetch
    """
    weeks_per_month = 4
    runs_per_week = TEST_SCENARIOS[scenario]
    total_runs = runs_per_week * weeks_per_month
    return tokens_per_fetch * total_runs


class RiskZone(Enum):
    """Quota utilization risk zones"""
    GREEN = "green"    # ≤60% - Safe operation
    YELLOW = "yellow"  # 60-85% - Consider efficiency measures
    RED = "red"        # >85% - Urgent mitigation required


def classify_risk_zone(utilization_pct: float) -> RiskZone:
    """Classify quota utilization into risk zones"""
    if utilization_pct <= 60:
        return RiskZone.GREEN
    elif utilization_pct <= 85:
        return RiskZone.YELLOW
    else:
        return RiskZone.RED


# ============================================================================
# MITIGATION STRATEGIES
# ============================================================================

@dataclass
class MitigationStrategy:
    """Mitigation strategy recommendation"""
    name: str
    description: str
    token_savings_min: int
    token_savings_max: int
    implementation_effort: str  # Low, Medium, High
    data_quality_impact: str    # None, Low, Medium, High
    priority: int  # 1=highest priority


MITIGATION_STRATEGIES = [
    MitigationStrategy(
        name="Mock Integration Tests",
        description="Convert pull_odds_hourly.test.js to use mocked API responses (pattern from ingest-stable-game-ids.test.js). Keep 1 smoke test/week with real API.",
        token_savings_min=150,
        token_savings_max=240,
        implementation_effort="Low",
        data_quality_impact="None",
        priority=1,
    ),
    MitigationStrategy(
        name="Separate Test API Key",
        description="Acquire ODDS_API_KEY_TEST for development/CI. Move all test consumption off production quota.",
        token_savings_min=96,
        token_savings_max=240,
        implementation_effort="Low",
        data_quality_impact="None",
        priority=1,
    ),
    MitigationStrategy(
        name="Disable Backstop Refresh",
        description="Set ENABLE_ODDS_BACKSTOP=false. Rely only on hourly scheduler. Acceptable if hourly freshness is sufficient.",
        token_savings_min=450,
        token_savings_max=1920,
        implementation_effort="Low",
        data_quality_impact="Low",
        priority=2,
    ),
    MitigationStrategy(
        name="90-Minute Production Intervals",
        description="Change hourly scheduler to 90-minute intervals. Reduces fetches from 24/day to 16/day.",
        token_savings_min=1920,
        token_savings_max=1920,
        implementation_effort="Low",
        data_quality_impact="Low",
        priority=3,
    ),
    MitigationStrategy(
        name="Active Hours Only Scheduling",
        description="Only fetch odds during game hours (12pm-11pm ET = 11 hours). Skip overnight hours when no games occur.",
        token_savings_min=3120,
        token_savings_max=3120,
        implementation_effort="Medium",
        data_quality_impact="Low",
        priority=3,
    ),
    MitigationStrategy(
        name="Smart Cache Layer",
        description="Skip API calls if cached odds are <20min old and no games starting within 2 hours. Implement at job level.",
        token_savings_min=1152,
        token_savings_max=2880,
        implementation_effort="Medium",
        data_quality_impact="None",
        priority=2,
    ),
    MitigationStrategy(
        name="Selective Market Fetching",
        description="Only fetch h2h markets, skip totals/spreads. Reduces tokens/fetch from 8 to 3 (62.5% savings).",
        token_savings_min=3600,
        token_savings_max=3600,
        implementation_effort="Low",
        data_quality_impact="High",
        priority=4,
    ),
    MitigationStrategy(
        name="Upgrade API Tier",
        description="Upgrade to higher The Odds API tier (40,000+ tokens/month). Eliminates quota constraints.",
        token_savings_min=0,
        token_savings_max=0,
        implementation_effort="Low",
        data_quality_impact="None",
        priority=5,
    ),
]


# ============================================================================
# ANALYSIS & REPORTING
# ============================================================================

def print_header(title: str):
    """Print section header"""
    print(f"\n{'=' * 80}")
    print(f"{title:^80}")
    print(f"{'=' * 80}\n")


def print_baseline_analysis(tokens_per_fetch: int, baseline: int):
    """Print baseline production consumption"""
    print(f"Active Sports Configuration:")
    for sport in SPORTS:
        status = "✓ ACTIVE" if sport.active else "✗ inactive"
        print(f"  {sport.name:8} {status:12} {sport.tokens_per_fetch} tokens/fetch")
    
    print(f"\nTokens per fetch (all active sports): {tokens_per_fetch}")
    print(f"Hourly scheduler: {HOURS_PER_DAY} fetches/day × {DAYS_PER_MONTH} days")
    print(f"  (Skips 2am-5am ET overnight when no games occur)")
    print(f"Baseline production consumption: {baseline:,} tokens/month")


def print_backstop_analysis(backstop_min: int, backstop_avg: int, backstop_max: int):
    """Print backstop refresh overhead"""
    if not BACKSTOP_ENABLED:
        print("Backstop refresh: DISABLED")
        return
    
    print(f"Backstop refresh: ENABLED (every {BACKSTOP_INTERVAL_MINUTES} min during T-{BACKSTOP_WINDOW_HOURS}h game windows)")
    print(f"Estimated overhead:")
    print(f"  Conservative: {backstop_min:,} tokens/month")
    print(f"  Average:      {backstop_avg:,} tokens/month")
    print(f"  High-density: {backstop_max:,} tokens/month")


def print_test_analysis(tokens_per_fetch: int):
    """Print test consumption scenarios"""
    print("Integration test consumption (tests use production API key):")
    for scenario, runs_per_week in TEST_SCENARIOS.items():
        total_runs = runs_per_week * 4  # weeks per month
        tokens = calculate_test_consumption(tokens_per_fetch, scenario)
        print(f"  {scenario.capitalize():12} {runs_per_week} runs/week × 4 weeks = {total_runs:2} runs = {tokens:,} tokens/month")


def print_quota_analysis(
    total_min: int, 
    total_avg: int, 
    total_max: int, 
    risk_zone: RiskZone
):
    """Print quota utilization analysis"""
    utilization_min = (total_min / MONTHLY_QUOTA) * 100
    utilization_avg = (total_avg / MONTHLY_QUOTA) * 100
    utilization_max = (total_max / MONTHLY_QUOTA) * 100
    
    remaining_min = MONTHLY_QUOTA - total_max
    remaining_avg = MONTHLY_QUOTA - total_avg
    remaining_max = MONTHLY_QUOTA - total_min
    
    print(f"Monthly quota: {MONTHLY_QUOTA:,} tokens")
    print(f"\nProjected consumption:")
    print(f"  Best case:     {total_min:,} tokens ({utilization_min:.1f}% utilization)")
    print(f"  Average case:  {total_avg:,} tokens ({utilization_avg:.1f}% utilization)")
    print(f"  Worst case:    {total_max:,} tokens ({utilization_max:.1f}% utilization)")
    
    print(f"\nRemaining buffer:")
    print(f"  Best case:     {remaining_max:,} tokens")
    print(f"  Average case:  {remaining_avg:,} tokens")
    print(f"  Worst case:    {remaining_min:,} tokens")
    
    print(f"\nRisk Zone: {risk_zone.value.upper()}")
    
    if risk_zone == RiskZone.GREEN:
        print("  ✓ Current configuration is SUSTAINABLE")
        print("  ✓ Sufficient buffer for operational variance")
    elif risk_zone == RiskZone.YELLOW:
        print("  ⚠️  Quota utilization approaching limits")
        print("  ⚠️  Consider implementing efficiency measures")
    else:  # RED
        print("  ❌ URGENT: Projected to exceed quota")
        print("  ❌ Immediate mitigation required")


def print_max_test_frequency(baseline: int, backstop_avg: int, tokens_per_fetch: int):
    """Calculate and print maximum safe test frequency"""
    safe_threshold = MONTHLY_QUOTA * 0.85  # Stay under 85% utilization
    available_for_tests = safe_threshold - baseline - backstop_avg
    
    if available_for_tests <= 0:
        print("⚠️  WARNING: No budget available for tests without mitigation")
        return
    
    max_test_runs = math.floor(available_for_tests / tokens_per_fetch)
    max_runs_per_week = max_test_runs / 4  # 4 weeks per month
    
    print(f"\nMaximum safe test frequency (staying under 85% quota):")
    print(f"  {max_test_runs} total runs/month")
    print(f"  {max_runs_per_week:.1f} runs/week average")


def print_mitigation_strategies(risk_zone: RiskZone, current_consumption: int):
    """Print recommended mitigation strategies"""
    if risk_zone == RiskZone.GREEN:
        print("\n✓ No mitigation required - current state is sustainable")
        return
    
    print("\nRECOMMENDED MITIGATION STRATEGIES")
    print("(Ranked by priority - highest impact/lowest effort first)\n")
    
    # Sort by priority
    sorted_strategies = sorted(MITIGATION_STRATEGIES, key=lambda s: s.priority)
    
    for i, strategy in enumerate(sorted_strategies, 1):
        savings_range = f"{strategy.token_savings_min:,}-{strategy.token_savings_max:,}" if strategy.token_savings_min != strategy.token_savings_max else f"{strategy.token_savings_min:,}"
        
        print(f"{i}. {strategy.name}")
        print(f"   {strategy.description}")
        print(f"   Token savings: {savings_range} tokens/month")
        print(f"   Effort: {strategy.implementation_effort} | Data quality impact: {strategy.data_quality_impact}")
        
        # Show projected utilization after implementation
        new_consumption_min = current_consumption - strategy.token_savings_max
        new_consumption_max = current_consumption - strategy.token_savings_min
        new_utilization_min = (new_consumption_min / MONTHLY_QUOTA) * 100
        new_utilization_max = (new_consumption_max / MONTHLY_QUOTA) * 100
        
        print(f"   → New utilization: {new_utilization_min:.1f}%-{new_utilization_max:.1f}%")
        print()


def print_hybrid_recommendations(risk_zone: RiskZone, current_consumption: int):
    """Print hybrid strategy recommendations (combining multiple mitigations)"""
    if risk_zone != RiskZone.RED:
        return
    
    print("\nHYBRID STRATEGY RECOMMENDATIONS")
    print("For critical situations, combine multiple low-impact mitigations:\n")
    
    # Recommended combinations
    combos = [
        {
            "name": "Quick Wins (No Data Quality Impact)",
            "strategies": ["Mock Integration Tests", "Separate Test API Key", "Disable Backstop Refresh"],
        },
        {
            "name": "Production Optimization",
            "strategies": ["Mock Integration Tests", "90-Minute Production Intervals", "Smart Cache Layer"],
        },
        {
            "name": "Maximum Reduction",
            "strategies": ["Mock Integration Tests", "Separate Test API Key", "Active Hours Only Scheduling", "Smart Cache Layer"],
        },
    ]
    
    for combo in combos:
        print(f"COMBO: {combo['name']}")
        total_savings_min = 0
        total_savings_max = 0
        
        for strategy_name in combo["strategies"]:
            strategy = next(s for s in MITIGATION_STRATEGIES if s.name == strategy_name)
            total_savings_min += strategy.token_savings_min
            total_savings_max += strategy.token_savings_max
            print(f"  + {strategy.name}")
        
        savings_range = f"{total_savings_min:,}-{total_savings_max:,}"
        new_consumption = current_consumption - ((total_savings_min + total_savings_max) / 2)
        new_utilization = (new_consumption / MONTHLY_QUOTA) * 100
        
        print(f"  Total savings: {savings_range} tokens/month")
        print(f"  → Projected utilization: {new_utilization:.1f}%")
        print()


# ============================================================================
# MAIN ANALYSIS
# ============================================================================

def main():
    """Run complete quota analysis"""
    print_header("ODDS API Token Quota Analysis")
    print(f"Analysis Date: March 7, 2026")
    print(f"API Tier: {MONTHLY_QUOTA:,} tokens/month")
    print(f"Test Environment: Uses production API key (same quota)")
    
    # Calculate components
    tokens_per_fetch = calculate_tokens_per_fetch()
    baseline = calculate_baseline_production(tokens_per_fetch)
    backstop_min, backstop_avg, backstop_max = calculate_backstop_overhead(tokens_per_fetch)
    
    # Use moderate test scenario for primary analysis
    test_tokens = calculate_test_consumption(tokens_per_fetch, "moderate")
    
    # Total consumption
    total_min = baseline + backstop_min + calculate_test_consumption(tokens_per_fetch, "conservative")
    total_avg = baseline + backstop_avg + test_tokens
    total_max = baseline + backstop_max + calculate_test_consumption(tokens_per_fetch, "aggressive")
    
    # Risk assessment
    utilization_avg = (total_avg / MONTHLY_QUOTA) * 100
    risk_zone = classify_risk_zone(utilization_avg)
    
    # Print analysis sections
    print_header("1. BASELINE PRODUCTION CONSUMPTION")
    print_baseline_analysis(tokens_per_fetch, baseline)
    
    print_header("2. BACKSTOP REFRESH OVERHEAD")
    print_backstop_analysis(backstop_min, backstop_avg, backstop_max)
    
    print_header("3. INTEGRATION TEST CONSUMPTION")
    print_test_analysis(tokens_per_fetch)
    
    print_header("4. TOTAL QUOTA UTILIZATION")
    print_quota_analysis(total_min, total_avg, total_max, risk_zone)
    print_max_test_frequency(baseline, backstop_avg, tokens_per_fetch)
    
    print_header("5. MITIGATION STRATEGIES")
    print_mitigation_strategies(risk_zone, total_avg)
    print_hybrid_recommendations(risk_zone, total_avg)
    
    print_header("SUMMARY")
    print(f"Current State: {risk_zone.value.upper()} ({utilization_avg:.1f}% quota utilization)")
    
    if risk_zone == RiskZone.GREEN:
        print("✓ No action required - current configuration is sustainable")
    elif risk_zone == RiskZone.YELLOW:
        print("⚠️  Recommended: Implement top 1-2 mitigation strategies to increase buffer")
    else:
        print("❌ REQUIRED: Implement mitigation strategies immediately to avoid quota exhaustion")
    
    print("\n" + "=" * 80 + "\n")


if __name__ == "__main__":
    main()
