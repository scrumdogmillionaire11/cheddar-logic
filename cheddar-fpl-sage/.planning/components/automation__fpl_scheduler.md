# FPL Automation Scheduler v1.0

**Scope:** Automated scheduling and execution of data collection workflows for 2025-26 season

---

## 1. Implementation Architecture

### 1.1 Technology Stack
```python
# Core Dependencies
import asyncio
import aiohttp
import schedule
from datetime import datetime, timedelta
from dataclasses import dataclass
from typing import List, Dict, Optional, Callable
import logging
import redis
import psycopg2
from sqlalchemy import create_engine
import pandas as pd
import json
from tenacity import retry, stop_after_attempt, wait_exponential
```

### 1.2 Configuration Management
```python
@dataclass
class FPLConfig:
    # API Endpoints
    FPL_BASE_URL: str = "https://fantasy.premierleague.com/api"
    SCOUT_API_URL: str = "https://www.fantasyfootballscout.co.uk/api" 
    UNDERSTAT_URL: str = "https://understat.com"
    FBREF_URL: str = "https://fbref.com"
    
    # Database
    POSTGRES_URL: str = "postgresql://user:pass@localhost:5432/fpl_sage"
    REDIS_URL: str = "redis://localhost:6379"
    
    # Scheduling
    TIMEZONE: str = "Europe/London"
    SEASON: str = "2025-26"
    
    # Collection Windows
    PRE_DEADLINE_TIME: str = "18:00"  # Friday
    POST_DEADLINE_TIME: str = "14:00"  # Saturday  
    POST_GW_TIME: str = "09:00"       # Monday
    MID_WEEK_TIME: str = "12:00"      # Wednesday
    
    # Rate Limiting
    FPL_RATE_LIMIT: int = 1  # requests per second
    UNDERSTAT_RATE_LIMIT: int = 0.2  # requests per second (1 per 5 sec)
    FBREF_RATE_LIMIT: int = 0.1      # requests per second (1 per 10 sec)
    
    # Retry Policy
    MAX_RETRIES: int = 3
    RETRY_BACKOFF: int = 2  # exponential backoff multiplier
    
    # Alerts
    SLACK_WEBHOOK: Optional[str] = None
    EMAIL_SMTP_CONFIG: Optional[Dict] = None
    
    # Thresholds
    MIN_PLAYERS_THRESHOLD: int = 500
    MAX_STALE_HOURS: int = 6
    MIN_SUCCESS_RATE: float = 0.95
```

---

## 2. Core Collection Classes

### 2.1 API Client Base Class
```python
class FPLAPIClient:
    def __init__(self, config: FPLConfig):
        self.config = config
        self.session = None
        self.redis_client = redis.from_url(config.REDIS_URL)
        self.logger = logging.getLogger(__name__)
        
    async def __aenter__(self):
        self.session = aiohttp.ClientSession()
        return self
        
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.session:
            await self.session.close()
    
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2))
    async def fetch_json(self, url: str, cache_key: str = None, cache_ttl: int = 3600) -> Dict:
        """Fetch JSON data with caching and retry logic"""
        
        # Check cache first
        if cache_key:
            cached = self.redis_client.get(cache_key)
            if cached:
                self.logger.info(f"Cache hit for {cache_key}")
                return json.loads(cached)
        
        # Fetch from API
        self.logger.info(f"Fetching {url}")
        async with self.session.get(url) as response:
            if response.status == 429:  # Rate limited
                retry_after = int(response.headers.get('Retry-After', 60))
                self.logger.warning(f"Rate limited, waiting {retry_after} seconds")
                await asyncio.sleep(retry_after)
                raise aiohttp.ClientError("Rate limited")
                
            response.raise_for_status()
            data = await response.json()
            
            # Cache the result
            if cache_key:
                self.redis_client.setex(cache_key, cache_ttl, json.dumps(data))
                
            return data

    async def fetch_bootstrap_static(self) -> Dict:
        """Fetch main FPL static data"""
        url = f"{self.config.FPL_BASE_URL}/bootstrap-static/"
        cache_key = f"fpl:bootstrap:{datetime.now().strftime('%Y-%m-%d-%H')}"
        return await self.fetch_json(url, cache_key, 1800)  # 30 min cache
    
    async def fetch_fixtures(self) -> List[Dict]:
        """Fetch all fixture data"""
        url = f"{self.config.FPL_BASE_URL}/fixtures/"
        cache_key = f"fpl:fixtures:{datetime.now().strftime('%Y-%m-%d')}"
        return await self.fetch_json(url, cache_key, 3600)  # 1 hour cache
    
    async def fetch_live_gameweek(self, gameweek: int) -> Dict:
        """Fetch live gameweek data"""
        url = f"{self.config.FPL_BASE_URL}/event/{gameweek}/live/"
        # Don't cache live data
        return await self.fetch_json(url)
    
    async def fetch_player_summary(self, player_id: int) -> Dict:
        """Fetch individual player history and fixtures"""
        url = f"{self.config.FPL_BASE_URL}/element-summary/{player_id}/"
        cache_key = f"fpl:player:{player_id}:{datetime.now().strftime('%Y-%m-%d')}"
        return await self.fetch_json(url, cache_key, 7200)  # 2 hour cache
```

### 2.2 Data Processor Class
```python
class FPLDataProcessor:
    def __init__(self, config: FPLConfig):
        self.config = config
        self.db_engine = create_engine(config.POSTGRES_URL)
        self.logger = logging.getLogger(__name__)
    
    def process_bootstrap_data(self, bootstrap_data: Dict) -> Dict:
        """Process and normalize bootstrap static data"""
        
        # Extract players
        players_df = pd.DataFrame(bootstrap_data['elements'])
        
        # Convert to FplPlayerEntry format for compatibility
        processed_players = []
        for _, player in players_df.iterrows():
            processed_player = {
                'player_id': str(player['id']),
                'name': player['web_name'],
                'team': self._get_team_code(player['team'], bootstrap_data['teams']),
                'position': self._get_position_code(player['element_type']),
                'current_price': player['now_cost'] / 10.0,  # Convert from 0.1m units
                'ownership': player['selected_by_percent'],
                'status_flag': self._parse_status_flag(player['status'], 
                                                     player.get('chance_of_playing_this_round')),
                'form': player['form'],
                'total_points': player['total_points'],
                'expected_goals': player.get('expected_goals', 0),
                'expected_assists': player.get('expected_assists', 0),
                'minutes': player['minutes']
            }
            processed_players.append(processed_player)
        
        # Extract current gameweek
        current_gw = None
        for event in bootstrap_data['events']:
            if event['is_current']:
                current_gw = event['id']
                break
        
        # Extract teams
        teams = {team['id']: team['short_name'] for team in bootstrap_data['teams']}
        
        return {
            'players': processed_players,
            'current_gameweek': current_gw,
            'teams': teams,
            'last_updated': datetime.now().isoformat()
        }
    
    def process_fixtures_data(self, fixtures_data: List[Dict]) -> List[Dict]:
        """Process fixtures into FixtureRow format"""
        
        processed_fixtures = []
        for fixture in fixtures_data:
            if fixture['event'] is None:  # Skip fixtures without GW assignment
                continue
                
            # Create fixture rows for both teams
            processed_fixtures.append({
                'team': self._get_team_code(fixture['team_h']),
                'opponent': self._get_team_code(fixture['team_a']),
                'gameweek': fixture['event'],
                'venue': 'H',
                'fixture_difficulty': fixture['team_h_difficulty'],
                'opponent_difficulty': fixture['team_a_difficulty'],
                'kickoff_time': fixture['kickoff_time'],
                'finished': fixture['finished']
            })
            
            processed_fixtures.append({
                'team': self._get_team_code(fixture['team_a']),
                'opponent': self._get_team_code(fixture['team_h']),
                'gameweek': fixture['event'],
                'venue': 'A',
                'fixture_difficulty': fixture['team_a_difficulty'],
                'opponent_difficulty': fixture['team_h_difficulty'],
                'kickoff_time': fixture['kickoff_time'],
                'finished': fixture['finished']
            })
        
        return processed_fixtures
    
    def _get_team_code(self, team_id: int, teams: List[Dict] = None) -> str:
        """Convert team ID to 3-letter code"""
        team_mapping = {
            1: 'ARS', 2: 'AVL', 3: 'BOU', 4: 'BRE', 5: 'BHA',
            6: 'CHE', 7: 'CRY', 8: 'EVE', 9: 'FUL', 10: 'IPS',
            11: 'LEI', 12: 'LIV', 13: 'MCI', 14: 'MUN', 15: 'NEW',
            16: 'NFO', 17: 'SOU', 18: 'TOT', 19: 'WHU', 20: 'WOL'
        }
        return team_mapping.get(team_id, 'UNK')
    
    def _get_position_code(self, element_type: int) -> str:
        """Convert element_type to position code"""
        position_mapping = {1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD'}
        return position_mapping.get(element_type, 'UNK')
    
    def _parse_status_flag(self, status: str, chance_of_playing: Optional[int]) -> str:
        """Parse player status into standardized flag"""
        if status == 'u':  # unavailable
            return 'OUT'
        elif status == 'i':  # injured
            return 'OUT'
        elif status == 'd':  # doubtful
            return 'DOUBT'
        elif status == 'a':  # available
            if chance_of_playing is not None and chance_of_playing < 75:
                return 'DOUBT'
            return 'FIT'
        else:
            return 'UNKNOWN'
    
    def save_to_database(self, data: Dict, table_name: str):
        """Save processed data to PostgreSQL"""
        try:
            df = pd.DataFrame(data)
            df.to_sql(table_name, self.db_engine, if_exists='replace', index=False)
            self.logger.info(f"Saved {len(df)} records to {table_name}")
        except Exception as e:
            self.logger.error(f"Failed to save to database: {e}")
            raise
```

### 2.3 Scheduler Class
```python
class FPLScheduler:
    def __init__(self, config: FPLConfig):
        self.config = config
        self.api_client = None
        self.processor = FPLDataProcessor(config)
        self.logger = logging.getLogger(__name__)
        self.is_running = False
        
    async def start_scheduler(self):
        """Start the automated collection scheduler"""
        self.is_running = True
        self.logger.info("FPL Scheduler started")
        
        # Schedule regular collections
        schedule.every().friday.at(self.config.PRE_DEADLINE_TIME).do(
            self._schedule_async_job, self.run_pre_deadline_collection
        )
        schedule.every().saturday.at(self.config.POST_DEADLINE_TIME).do(
            self._schedule_async_job, self.run_post_deadline_collection
        )
        schedule.every().monday.at(self.config.POST_GW_TIME).do(
            self._schedule_async_job, self.run_post_gameweek_collection
        )
        schedule.every().wednesday.at(self.config.MID_WEEK_TIME).do(
            self._schedule_async_job, self.run_mid_week_collection
        )
        
        # Run scheduler loop
        while self.is_running:
            schedule.run_pending()
            await asyncio.sleep(60)  # Check every minute
    
    def _schedule_async_job(self, job_func: Callable):
        """Helper to schedule async functions"""
        asyncio.create_task(job_func())
    
    async def run_pre_deadline_collection(self):
        """Friday 18:00 - Pre-deadline data collection"""
        self.logger.info("Starting pre-deadline collection")
        
        try:
            async with FPLAPIClient(self.config) as client:
                # Fetch core data
                bootstrap_data = await client.fetch_bootstrap_static()
                fixtures_data = await client.fetch_fixtures()
                
                # Process data
                processed_players = self.processor.process_bootstrap_data(bootstrap_data)
                processed_fixtures = self.processor.process_fixtures_data(fixtures_data)
                
                # Save to database
                self.processor.save_to_database(processed_players['players'], 'current_players')
                self.processor.save_to_database(processed_fixtures, 'current_fixtures')
                
                # Trigger model updates (integration with existing system)
                await self._trigger_model_updates()
                
                self.logger.info("Pre-deadline collection completed successfully")
                
        except Exception as e:
            self.logger.error(f"Pre-deadline collection failed: {e}")
            await self._send_alert(f"Pre-deadline collection failed: {str(e)}", "ERROR")
    
    async def run_post_gameweek_collection(self):
        """Monday 09:00 - Post-gameweek analysis"""
        self.logger.info("Starting post-gameweek collection")
        
        try:
            async with FPLAPIClient(self.config) as client:
                # Get current gameweek from bootstrap
                bootstrap_data = await client.fetch_bootstrap_static()
                current_gw = self._get_current_gameweek(bootstrap_data)
                
                # Fetch live data for completed gameweek
                if current_gw > 1:  # Don't try to fetch GW0
                    live_data = await client.fetch_live_gameweek(current_gw - 1)
                    
                    # Process and store live performance data
                    performance_data = self._process_live_data(live_data)
                    self.processor.save_to_database(performance_data, 'gameweek_performance')
                
                # Update projections based on new performance data
                await self._trigger_projection_updates()
                
                self.logger.info("Post-gameweek collection completed successfully")
                
        except Exception as e:
            self.logger.error(f"Post-gameweek collection failed: {e}")
            await self._send_alert(f"Post-gameweek collection failed: {str(e)}", "ERROR")
    
    async def run_post_deadline_collection(self):
        """Saturday 14:00 - Post-deadline lineup updates"""
        self.logger.info("Starting post-deadline collection")
        # Minimal collection focusing on lineup confirmations
        # Implementation similar to pre_deadline but focused on team news
    
    async def run_mid_week_collection(self):
        """Wednesday 12:00 - Mid-week injury updates"""
        self.logger.info("Starting mid-week collection")
        # Light collection focusing on injury updates and press conferences
        # Implementation focuses on status flag updates
    
    def _get_current_gameweek(self, bootstrap_data: Dict) -> int:
        """Extract current gameweek from bootstrap data"""
        for event in bootstrap_data['events']:
            if event['is_current']:
                return event['id']
        return 1  # Fallback
    
    def _process_live_data(self, live_data: Dict) -> List[Dict]:
        """Process live gameweek data into performance records"""
        performance_records = []
        
        for element_data in live_data['elements']:
            player_stats = element_data['stats']
            
            performance_record = {
                'player_id': str(element_data['id']),
                'gameweek': live_data.get('id', 0),
                'minutes': player_stats.get('minutes', 0),
                'goals_scored': player_stats.get('goals_scored', 0),
                'assists': player_stats.get('assists', 0),
                'clean_sheets': player_stats.get('clean_sheets', 0),
                'goals_conceded': player_stats.get('goals_conceded', 0),
                'own_goals': player_stats.get('own_goals', 0),
                'penalties_saved': player_stats.get('penalties_saved', 0),
                'penalties_missed': player_stats.get('penalties_missed', 0),
                'yellow_cards': player_stats.get('yellow_cards', 0),
                'red_cards': player_stats.get('red_cards', 0),
                'saves': player_stats.get('saves', 0),
                'bonus': player_stats.get('bonus', 0),
                'bps': player_stats.get('bps', 0),
                'total_points': player_stats.get('total_points', 0)
            }
            performance_records.append(performance_record)
        
        return performance_records
    
    async def _trigger_model_updates(self):
        """Trigger updates to existing FPL Sage models"""
        # This would integrate with your existing orchestrator
        # to trigger model refreshes after data collection
        self.logger.info("Triggering model updates (placeholder)")
        
    async def _trigger_projection_updates(self):
        """Trigger projection engine updates"""
        self.logger.info("Triggering projection updates (placeholder)")
    
    async def _send_alert(self, message: str, severity: str):
        """Send alerts via configured channels"""
        # Implement Slack/email alerting
        self.logger.warning(f"ALERT [{severity}]: {message}")
    
    def stop_scheduler(self):
        """Stop the scheduler"""
        self.is_running = False
        self.logger.info("FPL Scheduler stopped")
```

---

## 3. CLI Interface for Manual Control

```python
import click
from datetime import datetime

@click.group()
def fpl_cli():
    """FPL Sage Data Collection CLI"""
    pass

@fpl_cli.command()
@click.option('--config-file', default='config.json', help='Configuration file path')
def start_scheduler(config_file):
    """Start the automated collection scheduler"""
    config = FPLConfig()  # Load from config_file
    scheduler = FPLScheduler(config)
    
    click.echo("Starting FPL collection scheduler...")
    asyncio.run(scheduler.start_scheduler())

@fpl_cli.command()
@click.option('--collection-type', 
              type=click.Choice(['pre-deadline', 'post-deadline', 'post-gameweek', 'mid-week']),
              required=True, help='Type of collection to run')
def manual_collect(collection_type):
    """Manually trigger a specific collection"""
    config = FPLConfig()
    scheduler = FPLScheduler(config)
    
    click.echo(f"Running {collection_type} collection...")
    
    if collection_type == 'pre-deadline':
        asyncio.run(scheduler.run_pre_deadline_collection())
    elif collection_type == 'post-deadline':
        asyncio.run(scheduler.run_post_deadline_collection())
    elif collection_type == 'post-gameweek':
        asyncio.run(scheduler.run_post_gameweek_collection())
    elif collection_type == 'mid-week':
        asyncio.run(scheduler.run_mid_week_collection())
    
    click.echo("Collection completed")

@fpl_cli.command()
def validate_sources():
    """Validate all data sources are accessible"""
    config = FPLConfig()
    
    async def test_sources():
        async with FPLAPIClient(config) as client:
            try:
                bootstrap = await client.fetch_bootstrap_static()
                click.echo("✓ FPL API accessible")
                click.echo(f"  - Found {len(bootstrap['elements'])} players")
                
                fixtures = await client.fetch_fixtures()
                click.echo(f"  - Found {len(fixtures)} fixtures")
                
            except Exception as e:
                click.echo(f"✗ FPL API error: {e}")
    
    click.echo("Validating data sources...")
    asyncio.run(test_sources())

@fpl_cli.command()
def status():
    """Show current system status"""
    config = FPLConfig()
    redis_client = redis.from_url(config.REDIS_URL)
    
    # Check cache status
    cache_keys = redis_client.keys('fpl:*')
    click.echo(f"Cache entries: {len(cache_keys)}")
    
    # Check database connection
    try:
        engine = create_engine(config.POSTGRES_URL)
        with engine.connect() as conn:
            result = conn.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'")
            table_count = result.scalar()
            click.echo(f"Database tables: {table_count}")
    except Exception as e:
        click.echo(f"Database error: {e}")

if __name__ == '__main__':
    fpl_cli()
```

---

## 4. Integration Commands for Orchestrator

### 4.1 New Commands for core__fpl_orchestrator.md
```text
# Add these to the existing Supported Commands section:

- `fpl_start_collection` — Start automated weekly data collection
- `fpl_stop_collection` — Stop automated data collection  
- `fpl_manual_update` — Manually trigger data collection now
- `fpl_validate_sources` — Test all data source connections
- `fpl_collection_status` — Show data freshness and collection health
- `fpl_reset_cache` — Clear all cached data and force fresh collection
```

### 4.2 Orchestrator Integration Hook
```python
# Add this to orchestrator command processing:

elif command_token.lower() == "fpl_start_collection":
    scheduler = FPLScheduler(config)
    asyncio.create_task(scheduler.start_scheduler())
    return "✓ Automated data collection started"

elif command_token.lower() == "fpl_manual_update":
    scheduler = FPLScheduler(config)
    await scheduler.run_pre_deadline_collection()
    return "✓ Manual data collection completed"

elif command_token.lower() == "fpl_collection_status":
    # Check data freshness and system health
    status_info = await get_collection_status()
    return f"Collection Status:\n{status_info}"
```

---

## 5. Deployment Configuration

### 5.1 Docker Setup
```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Set up cron for scheduling (alternative to in-process scheduling)
RUN apt-get update && apt-get install -y cron
COPY crontab /etc/cron.d/fpl-scheduler
RUN chmod 0644 /etc/cron.d/fpl-scheduler
RUN crontab /etc/cron.d/fpl-scheduler

CMD ["python", "-m", "fpl_scheduler", "start-scheduler"]
```

### 5.2 Crontab Alternative
```bash
# /etc/cron.d/fpl-scheduler
# Pre-deadline collection (Fridays 18:00 GMT)
0 18 * * 5 /usr/local/bin/python /app/fpl_scheduler.py manual-collect --collection-type pre-deadline

# Post-deadline collection (Saturdays 14:00 GMT)  
0 14 * * 6 /usr/local/bin/python /app/fpl_scheduler.py manual-collect --collection-type post-deadline

# Post-gameweek collection (Mondays 09:00 GMT)
0 9 * * 1 /usr/local/bin/python /app/fpl_scheduler.py manual-collect --collection-type post-gameweek

# Mid-week collection (Wednesdays 12:00 GMT)
0 12 * * 3 /usr/local/bin/python /app/fpl_scheduler.py manual-collect --collection-type mid-week
```

---

## 6. Monitoring Dashboard

### 6.1 Health Check Endpoints
```python
from flask import Flask, jsonify

app = Flask(__name__)

@app.route('/health')
def health_check():
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'version': '1.0'
    })

@app.route('/collection-status')
def collection_status():
    # Check data freshness, cache status, DB connectivity
    status = check_system_health()
    return jsonify(status)

def check_system_health():
    return {
        'data_freshness': get_data_age_hours(),
        'cache_entries': get_cache_count(),
        'database_status': check_db_connectivity(),
        'last_successful_collection': get_last_collection_time(),
        'next_scheduled_collection': get_next_collection_time()
    }
```

---

This automation system provides:

1. **Reliable scheduled data collection** from FPL API and supplementary sources
2. **Seamless integration** with your existing FPL Sage models
3. **Robust error handling** with fallbacks and retry logic
4. **Manual override capabilities** for immediate data updates
5. **Comprehensive monitoring** and alerting
6. **Caching and performance optimization**
7. **Ready for 2025-26 season deployment**

The system will automatically feed fresh data to your existing fixture model, projection engine, team model, and transfer advisor workflows, keeping your FPL Sage system always up-to-date with the latest Premier League data.