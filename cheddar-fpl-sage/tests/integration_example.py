
# Integration example for your existing FPL Sage models
# Add this to your core__fpl_orchestrator.md command processing

async def update_with_fresh_fpl_data():
    """Update all models with fresh FPL data"""
    
    # Collect fresh data
    async with SimpleFPLCollector() as collector:
        fresh_data = await collector.get_current_data()
    
    # Convert to your model formats
    
    # 1. For FPL Team Model
    team_input = FplTeamInput(
        season="2025-26",
        gameweek=fresh_data['current_gameweek'],
        players=fresh_data['players'][:15],  # Your actual team
        bank_itb=0.0,  # Get from your team data
        free_transfers=1,
        chip_status={},  # Get from your team data
        hits_already_committed=0
    )
    
    # 2. For FPL Fixture Model  
    fixture_input = FixtureModelInput(
        season="2025-26",
        base_gameweek=fresh_data['current_gameweek'],
        rows=fresh_data['fixtures']
    )
    
    # 3. For FPL Projection Engine
    projection_input = ProjectionEngineInput(
        season="2025-26", 
        gameweek=fresh_data['current_gameweek'],
        player_rows=[],  # Convert from fresh_data['players']
        fixture_rows=fresh_data['fixtures'],
        team_rows=[]  # Add team-level data
    )
    
    # Run your models
    team_model_output = run_team_model(team_input)
    fixture_profiles = run_fixture_model(fixture_input) 
    projections = run_projection_engine(projection_input)
    
    # Run transfer advisor
    transfer_advice = run_transfer_advisor(
        team_input, team_model_output, fixture_profiles, projections
    )
    
    return transfer_advice

# Example of how to add to your orchestrator commands:
# elif command_token.lower() == "fpl_update_data":
#     advice = await update_with_fresh_fpl_data()
#     return f"✅ Data updated and analysis complete:\n{advice}"
