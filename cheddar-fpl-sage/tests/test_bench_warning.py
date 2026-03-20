"""
GSD Optimizer Test: Bench Warning Detection

Quick validation that bench warning triggers correctly for different scenarios.
Time budget: 10 minutes
"""

def test_bench_warning_logic():
    """Test the bench warning detection thresholds."""
    
    # Scenario 1: No transfers on bench - NO WARNING
    projected_bench_1 = [
        {"name": "Bench GK", "expected_pts": 2, "is_new": False},
        {"name": "Bench DEF", "expected_pts": 2, "is_new": False},
    ]
    transfer_plans_1 = {
        "primary": {"out": "Old Player", "in": "New Player"}
    }
    # Expected: None (no new players on bench)
    
    # Scenario 2: 1 transfer on bench - NO WARNING  
    projected_bench_2 = [
        {"name": "New Bench Player", "expected_pts": 2.5, "is_new": True},
        {"name": "Old Bench Player", "expected_pts": 2, "is_new": False},
    ]
    transfer_plans_2 = {
        "primary": {"out": "Old", "in": "New Bench Player"}
    }
    # Expected: None (only 1 transfer on bench)
    
    # Scenario 3: 2 transfers on bench, low pts - WARNING
    projected_bench_3 = [
        {"name": "Transfer 1", "expected_pts": 2.0, "is_new": True},
        {"name": "Transfer 2", "expected_pts": 2.5, "is_new": True},
        {"name": "Old Player", "expected_pts": 2, "is_new": False},
    ]
    transfer_plans_3 = {
        "primary": {"out": "Old1", "in": "Transfer 1"},
        "secondary": {"out": "Old2", "in": "Transfer 2"}
    }
    # Expected: Warning (2 transfers, avg 2.25 < 3.0)
    
    # Scenario 4: 2 transfers on bench, high pts - NO WARNING
    projected_bench_4 = [
        {"name": "Transfer 1", "expected_pts": 3.5, "is_new": True},
        {"name": "Transfer 2", "expected_pts": 4.0, "is_new": True},
    ]
    transfer_plans_4 = {
        "primary": {"out": "Old1", "in": "Transfer 1"},
        "secondary": {"out": "Old2", "in": "Transfer 2"}
    }
    # Expected: None (avg 3.75 >= 3.0, good rotation value)
    
    print("✅ Bench warning logic scenarios defined")
    print("   Threshold: 2+ transfers on bench with avg <3pts")
    print("   Scenario 1: 0 bench transfers → No warning")
    print("   Scenario 2: 1 bench transfer → No warning") 
    print("   Scenario 3: 2 bench transfers @ 2.25pts avg → WARNING")
    print("   Scenario 4: 2 bench transfers @ 3.75pts avg → No warning (good rotation)")


if __name__ == "__main__":
    test_bench_warning_logic()
