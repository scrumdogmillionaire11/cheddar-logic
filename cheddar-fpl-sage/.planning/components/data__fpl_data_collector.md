# FPL Data Collector v1.0

**Scope:** Automated weekly data collection from official FPL API and other sources for 2025-26 season

---

## 1. Data Sources

### 1.1 Official FPL API
- **Base URL:** `https://fantasy.premierleague.com/api/`
- **Key Endpoints:**
  - `/bootstrap-static/` - Static data (players, teams, gameweeks, chip usage)
  - `/fixtures/` - All fixture data with results and difficulty ratings
  - `/element-summary/{player_id}/` - Individual player history and fixtures
  - `/entry/{manager_id}/` - Manager team data
  - `/entry/{manager_id}/event/{gw}/picks/` - GW-specific picks
  - `/entry/{manager_id}/transfers/` - Transfer history
  - `/event/{gw}/live/` - Live gameweek data with bonus points

### 1.2 Supplementary Data Sources
- **FPL Review API:** Advanced analytics and projections
- **Fantasy Football Scout:** xG/xA data and player projections  
- **Understat.com:** Expected stats scraping
- **FBRef.com:** Detailed player and team statistics

---

## 2. Data Collection Schedule

### 2.1 Weekly Collection Windows
```text
DataCollectionSchedule {
  pre_deadline_pull: {
    day: "Friday"
    time: "18:00 GMT"
    sources: ["fpl_api", "scout_projections", "injury_updates"]
  }
  post_deadline_pull: {
    day: "Saturday" 
    time: "14:00 GMT"
    sources: ["fpl_api", "lineup_confirmations"]
  }
  post_gameweek_pull: {
    day: "Monday"
    time: "09:00 GMT"  
    sources: ["fpl_api", "xg_data", "performance_stats"]
  }
  mid_week_pull: {
    day: "Wednesday"
    time: "12:00 GMT"
    sources: ["injury_updates", "press_conferences"]
  }
}
```

### 2.2 Season-Long Collection
- **August:** Pre-season setup, player prices, initial ownership
- **Weekly:** During active season (August - May)
- **June-July:** Off-season data archival and analysis

---

## 3. Core Data Structures

### 3.1 Raw FPL API Response Mapping
```text
FplBootstrapResponse {
  elements: FplPlayer[]           # All players
  teams: FplTeam[]               # All PL teams
  events: FplGameweek[]          # All gameweeks
  element_types: FplPosition[]   # Positions with scoring rules
  game_settings: FplGameSettings # Wildcards, transfers, etc.
}

FplPlayer {
  id: int                        # Official FPL player ID
  web_name: string               # Display name
  team: int                      # Team ID (1-20)
  element_type: int              # Position (1=GK, 2=DEF, 3=MID, 4=FWD)
  now_cost: int                  # Price in 0.1m units (75 = £7.5m)
  selected_by_percent: float     # Ownership percentage
  total_points: int              # Season points
  event_points: int              # Last GW points
  form: float                    # 5-game rolling average
  points_per_game: float         # Season PPG
  minutes: int                   # Total minutes played
  goals_scored: int
  assists: int
  clean_sheets: int
  goals_conceded: int
  own_goals: int
  penalties_saved: int
  penalties_missed: int
  yellow_cards: int
  red_cards: int
  saves: int
  bonus: int
  bps: int                       # Bonus point system score
  influence: float
  creativity: float  
  threat: float
  ict_index: float              # Combined ICT score
  starts: int
  expected_goals: float
  expected_assists: float
  expected_goal_involvements: float
  expected_goals_conceded: float
  value_form: float
  value_season: float
  cost_change_start: int         # Price change from season start
  cost_change_event: int         # Price change from last GW
  cost_change_start_fall: int
  cost_change_event_fall: int
  in_dreamteam: boolean
  dreamteam_count: int
  transfers_in: int
  transfers_out: int
  transfers_in_event: int        # Transfers in this GW
  transfers_out_event: int       # Transfers out this GW
  loans_in: int
  loans_out: int
  loaned_in: int
  loaned_out: int
  status: string                 # "a" = available, "d" = doubtful, "i" = injured, "u" = unavailable
  chance_of_playing_this_round: int | null  # 0-100%
  chance_of_playing_next_round: int | null
  news: string                   # Injury/suspension news
  news_added: string             # Timestamp of news
}

FplFixture {
  id: int
  code: int
  event: int | null              # Gameweek number
  finished: boolean
  finished_provisional: boolean
  kickoff_time: string
  minutes: int
  provisional_start_time: boolean
  started: boolean
  team_a: int                    # Away team ID
  team_a_score: int | null
  team_h: int                    # Home team ID  
  team_h_score: int | null
  stats: FplFixtureStats[]       # Player stats for the match
  team_h_difficulty: int         # 1-5 difficulty rating
  team_a_difficulty: int         # 1-5 difficulty rating
  pulse_id: int
}
```

### 3.2 Enhanced Data Structures (Post-Processing)
```text
EnhancedPlayerData {
  fpl_data: FplPlayer
  xg_data: XGData | null
  fixture_data: PlayerFixtures
  ownership_data: OwnershipData
  projection_data: ProjectionData | null
  last_updated: timestamp
}

XGData {
  player_id: string
  gameweek: int
  npxG: float                    # Non-penalty expected goals
  xA: float                      # Expected assists
  xGI: float                     # Expected goal involvements
  xGChain: float                 # Expected goal chain
  xGBuildup: float               # Expected goal buildup
  source: "understat" | "fbref" | "scout"
  match_date: string
}

PlayerFixtures {
  player_id: string
  next_fixtures: FixtureProjection[]  # Next 6 fixtures
  difficulty_rating: {
    attack: float                # 1-5 scale
    defense: float               # 1-5 scale
  }
  dgw_flags: boolean[]          # Next 6 GWs, true if double gameweek
  blank_flags: boolean[]        # Next 6 GWs, true if blank
}

OwnershipData {
  player_id: string
  gameweek: int
  overall_ownership: float       # 0-100%
  top10k_ownership: float | null # If available
  top1k_ownership: float | null  # If available
  captaincy_percentage: float    # 0-100%
  effective_ownership: float     # Ownership - template overlap
  ownership_change: float        # Change from previous GW
}
```

---

## 4. Data Collection Workflows

### 4.1 Pre-Deadline Collection (Friday 18:00)
```text
PreDeadlineWorkflow {
  steps: [
    {
      name: "fetch_bootstrap_static"
      api: "fpl_official"
      endpoint: "/bootstrap-static/"
      priority: "HIGH"
      timeout: 30
      retry_attempts: 3
    },
    {
      name: "fetch_fixtures"
      api: "fpl_official" 
      endpoint: "/fixtures/"
      priority: "HIGH"
      timeout: 30
      retry_attempts: 3
    },
    {
      name: "fetch_xg_projections"
      api: "fantasy_scout"
      endpoint: "/api/projections"
      priority: "MEDIUM"
      timeout: 60
      retry_attempts: 2
    },
    {
      name: "scrape_injury_updates"
      api: "web_scraper"
      source: "premierleague.com/news"
      priority: "MEDIUM"
      timeout: 45
      retry_attempts: 2
    },
    {
      name: "process_ownership_data"
      type: "internal_processing"
      dependencies: ["fetch_bootstrap_static"]
      priority: "HIGH"
    },
    {
      name: "generate_fixture_profiles"
      type: "internal_processing"
      dependencies: ["fetch_fixtures"]
      priority: "HIGH"
      calls_model: "models__fpl_fixture_model"
    }
  ]
  success_criteria: {
    min_successful_steps: 4
    required_steps: ["fetch_bootstrap_static", "fetch_fixtures"]
  }
  notification_settings: {
    on_failure: "email + slack"
    on_success: "log_only"
    on_partial_success: "slack"
  }
}
```

### 4.2 Post-Gameweek Collection (Monday 09:00)
```text  
PostGameweekWorkflow {
  steps: [
    {
      name: "fetch_live_gameweek_data"
      api: "fpl_official"
      endpoint: "/event/{gw}/live/"
      priority: "HIGH"
      timeout: 60
      retry_attempts: 3
    },
    {
      name: "scrape_understat_xg"
      api: "web_scraper"
      source: "understat.com"
      priority: "MEDIUM"
      timeout: 120
      retry_attempts: 2
      rate_limit: "1_request_per_5_seconds"
    },
    {
      name: "fetch_fbref_advanced_stats" 
      api: "web_scraper"
      source: "fbref.com"
      priority: "LOW"
      timeout: 180
      retry_attempts: 1
      rate_limit: "1_request_per_10_seconds"
    },
    {
      name: "update_player_projections"
      type: "internal_processing"
      dependencies: ["fetch_live_gameweek_data", "scrape_understat_xg"]
      priority: "HIGH"
      calls_model: "models__fpl_projection_engine"
    },
    {
      name: "archive_gameweek_data"
      type: "data_storage"
      dependencies: ["update_player_projections"]
      priority: "LOW"
    }
  ]
}
```

---

## 5. Error Handling & Resilience

### 5.1 API Failure Modes
```text
ErrorHandlingStrategy {
  fpl_api_down: {
    fallback: "cached_data"
    max_age_hours: 6
    notification: "immediate"
    retry_schedule: [5, 15, 30, 60] # minutes
  }
  rate_limiting: {
    backoff_strategy: "exponential"
    base_delay: 5 # seconds
    max_delay: 300 # seconds
    max_retries: 5
  }
  partial_data_loss: {
    min_viable_data_percentage: 80
    fallback_to_projection: true
    notify_missing_players: true
  }
  complete_collection_failure: {
    use_last_successful_run: true
    max_stale_hours: 24
    emergency_notification: "phone + email"
  }
}
```

### 5.2 Data Quality Validation
```text
DataQualityChecks {
  player_count_validation: {
    expected_range: [500, 700]  # Total players in FPL
    alert_threshold_percent: 10
  }
  price_validation: {
    min_price: 3.5
    max_price: 15.0
    price_change_max_per_gw: 0.3
  }
  fixture_validation: {
    matches_per_gw_range: [8, 12]  # Including potential DGWs
    future_fixtures_required: 6
  }
  projection_validation: {
    points_range: [0, 25]        # Per gameweek
    minutes_range: [0, 90]
    negative_values_allowed: false
  }
}
```

---

## 6. Integration Points

### 6.1 Model Integration
The data collector feeds directly into existing models:

- **FPL Fixture Model:** Receives `FixtureRow[]` from fixture processing
- **FPL Projection Engine:** Receives `PlayerProjectionRow[]` from enhanced player data  
- **FPL Team Model:** Receives updated `FplProjectionSet` after each collection
- **Transfer Advisor:** Triggered after successful data collection with fresh projections

### 6.2 Orchestrator Integration  
```text
OrchestratorIntegration {
  data_collection_trigger: {
    command: "fpl_collect_data"
    schedule: "automatic" # Based on DataCollectionSchedule
    manual_override: "fpl_force_update"
  }
  success_callback: {
    auto_trigger: ["fpl_team", "fpl_projections"]
    notification: "data_refresh_complete"
  }
  failure_callback: {
    auto_trigger: ["fpl_status"]
    use_stale_data: true
    notification: "data_collection_failed"  
  }
}
```

---

## 7. Storage & Caching

### 7.1 Data Persistence
```text
StorageStrategy {
  current_gameweek_data: {
    storage: "redis_cache"
    ttl: "7_days"
    backup: "postgres_table"
  }
  historical_data: {
    storage: "postgres_partitioned"
    partition_by: "gameweek"
    retention_policy: "2_seasons"
  }
  raw_api_responses: {
    storage: "s3_bucket"
    compression: "gzip"
    retention_policy: "1_season"
  }
  processed_projections: {
    storage: "redis_cache"
    ttl: "3_days"
    versioning: true
  }
}
```

### 7.2 Cache Management
```text
CacheStrategy {
  player_data_cache: {
    key_pattern: "player:{player_id}:gw:{gameweek}"
    ttl: 86400 # 24 hours
    refresh_on_access: true
  }
  fixture_cache: {
    key_pattern: "fixtures:gw:{gameweek}:team:{team_id}"
    ttl: 604800 # 7 days  
    refresh_on_gameweek_advance: true
  }
  ownership_cache: {
    key_pattern: "ownership:gw:{gameweek}"
    ttl: 43200 # 12 hours
    high_frequency_refresh: true
  }
}
```

---

## 8. Monitoring & Alerting

### 8.1 Collection Metrics
```text
MonitoringMetrics {
  collection_success_rate: {
    target: 95
    warning_threshold: 90
    critical_threshold: 85
  }
  api_response_time: {
    target_p95: 5000 # ms
    warning_threshold: 8000
    critical_threshold: 15000
  }
  data_freshness: {
    max_age_hours: 6
    warning_age_hours: 4
    critical_age_hours: 8
  }
  processing_time: {
    target_minutes: 10
    warning_minutes: 15
    critical_minutes: 30
  }
}
```

### 8.2 Alert Channels
```text
AlertingStrategy {
  critical_alerts: ["email", "slack", "phone"]
  warning_alerts: ["slack", "email"]
  info_alerts: ["log_only"]
  
  gameweek_deadline_alerts: {
    t_minus_2_hours: "warning_if_no_fresh_data"  
    t_minus_30_minutes: "critical_if_collection_failed"
    t_minus_5_minutes: "emergency_if_system_down"
  }
}
```

---

## 9. 2025-26 Season Setup

### 9.1 Pre-Season Preparation (July 2025)
1. **Data Source Validation:** Test all API endpoints and scraping targets
2. **Schema Updates:** Verify FPL hasn't changed their API structure  
3. **Player Database:** Initialize with new player IDs and team assignments
4. **Fixture Calendar:** Import complete 2025-26 fixture list
5. **Ownership Tracking:** Set up tracking for new season ownership patterns

### 9.2 Season Launch (August 2025)
1. **Initial Collection:** Full bootstrap data pull on season launch
2. **Gameweek 1 Setup:** Establish baseline projections and fixture ratings
3. **Validation Run:** Ensure all data flows correctly through existing models
4. **Monitoring Setup:** Activate all alerts and health checks
5. **Backup Systems:** Ensure fallback data sources are operational

### 9.3 Integration Testing Commands
```text
SeasonSetupCommands {
  validate_data_sources: "fpl_validate_sources"
  test_collection_flow: "fpl_test_collection" 
  verify_model_integration: "fpl_verify_models"
  check_storage_capacity: "fpl_check_storage"
  run_end_to_end_test: "fpl_e2e_test"
}
```

---

## 10. Behavior Guarantees

- **Reliability:** Data collection succeeds ≥95% of scheduled runs
- **Freshness:** Player data never more than 6 hours stale during active gameweeks
- **Completeness:** All registered players have basic data (price, ownership, status)  
- **Consistency:** Data format matches existing model contracts exactly
- **Performance:** Full collection completes within 15 minutes
- **Resilience:** System degrades gracefully with partial data loss
- **Integration:** Seamless handoff to existing FPL Sage models without code changes