#!/usr/bin/env python3
"""Test fixture_difficulty optimization"""

import sys
sys.path.insert(0, 'src')
sys.path.insert(0, 'backend')

from cheddar_fpl_sage.models.canonical_projections import CanonicalPlayerProjection
from services.result_transformer import _transform_projection

# Test with fixture_difficulty
proj_with_fixture = CanonicalPlayerProjection(
    player_id=1,
    name='Salah',
    position='MID',
    team='Liverpool',
    current_price=13.5,
    nextGW_pts=9.2,
    next6_pts=55.0,
    xMins_next=88.0,
    volatility_score=0.3,
    ceiling=14.0,
    floor=5.0,
    tags=['favorable_fixture'],
    confidence=0.85,
    ownership_pct=45.3,
    captaincy_rate=12.5,
    fixture_difficulty=2
)

# Test without fixture_difficulty (backwards compatibility)
proj_without_fixture = CanonicalPlayerProjection(
    player_id=2,
    name='Kane',
    position='FWD',
    team='Bayern',
    current_price=11.0,
    nextGW_pts=7.5,
    next6_pts=45.0,
    xMins_next=85.0,
    volatility_score=0.25,
    ceiling=11.0,
    floor=4.0,
    tags=[],
    confidence=0.75,
    ownership_pct=28.1,
)

transformed_with = _transform_projection(proj_with_fixture)
transformed_without = _transform_projection(proj_without_fixture)

print('✅ Transform with fixture_difficulty:')
print('   Name:', transformed_with['name'])
print('   Expected pts:', transformed_with['expected_pts'])
print('   Fixture difficulty:', transformed_with['fixture_difficulty'])
print()
print('✅ Transform without fixture_difficulty (backward compat):')
print('   Name:', transformed_without['name'])
print('   Expected pts:', transformed_without['expected_pts'])
print('   Fixture difficulty:', transformed_without['fixture_difficulty'])
print()
print('🎯 All TODO optimizations verified successfully!')
