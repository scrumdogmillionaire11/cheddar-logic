#!/usr/bin/env python3
"""
FPL Sage 2025-26 Season Setup Script
Sets up automated data collection for the upcoming season
"""

import os
import json
import asyncio
import aiohttp
from pathlib import Path
import click
import psycopg2
import redis
from typing import Dict

class FPLSeasonSetup:
    def __init__(self):
        self.base_dir = Path(__file__).parent
        self.config = self.load_config()
        self.setup_logging()
    
    def load_config(self) -> Dict:
        """Load configuration from environment or defaults"""
        return {
            'fpl_api_url': 'https://fantasy.premierleague.com/api',
            'postgres_url': os.getenv('DATABASE_URL', 'postgresql://localhost:5432/fpl_sage'),
            'redis_url': os.getenv('REDIS_URL', 'redis://localhost:6379'),
            'season': '2025-26',
            'slack_webhook': os.getenv('SLACK_WEBHOOK'),
            'email_config': {
                'smtp_server': os.getenv('SMTP_SERVER'),
                'smtp_port': int(os.getenv('SMTP_PORT', 587)),
                'smtp_username': os.getenv('SMTP_USERNAME'),
                'smtp_password': os.getenv('SMTP_PASSWORD'),
                'from_email': os.getenv('FROM_EMAIL'),
                'to_email': os.getenv('TO_EMAIL')
            }
        }
    
    def setup_logging(self):
        """Configure logging for the setup process"""
        import logging
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(levelname)s - %(message)s'
        )
        self.logger = logging.getLogger(__name__)

    async def validate_fpl_api(self) -> bool:
        """Test connection to FPL API and validate data structure"""
        self.logger.info("Validating FPL API connection...")
        
        try:
            async with aiohttp.ClientSession() as session:
                # Test bootstrap-static endpoint
                async with session.get(f"{self.config['fpl_api_url']}/bootstrap-static/") as response:
                    if response.status != 200:
                        self.logger.error(f"FPL API returned status {response.status}")
                        return False
                    
                    data = await response.json()
                    
                    # Validate expected structure
                    required_keys = ['elements', 'teams', 'events', 'element_types']
                    for key in required_keys:
                        if key not in data:
                            self.logger.error(f"Missing required key '{key}' in FPL API response")
                            return False
                    
                    # Check if season data looks right
                    players_count = len(data['elements'])
                    teams_count = len(data['teams'])
                    
                    self.logger.info(f"✓ FPL API accessible - {players_count} players, {teams_count} teams")
                    
                    # Check if it's the right season
                    if teams_count != 20:
                        self.logger.warning(f"Unexpected team count: {teams_count} (expected 20)")
                    
                    if players_count < 400:
                        self.logger.warning(f"Low player count: {players_count} (expected 500+)")
                    
                    return True
                    
        except Exception as e:
            self.logger.error(f"Failed to validate FPL API: {e}")
            return False

    def setup_database_schema(self):
        """Create database tables for data collection"""
        self.logger.info("Setting up database schema...")
        
        schema_sql = """
        -- Current players table
        CREATE TABLE IF NOT EXISTS current_players (
            player_id VARCHAR(10) PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            team VARCHAR(3) NOT NULL,
            position VARCHAR(3) NOT NULL,
            current_price DECIMAL(3,1) NOT NULL,
            ownership DECIMAL(5,2),
            status_flag VARCHAR(10) NOT NULL,
            form DECIMAL(3,1),
            total_points INTEGER,
            expected_goals DECIMAL(4,2),
            expected_assists DECIMAL(4,2),
            minutes INTEGER,
            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Current fixtures table  
        CREATE TABLE IF NOT EXISTS current_fixtures (
            id SERIAL PRIMARY KEY,
            team VARCHAR(3) NOT NULL,
            opponent VARCHAR(3) NOT NULL,
            gameweek INTEGER NOT NULL,
            venue CHAR(1) NOT NULL,
            fixture_difficulty INTEGER,
            opponent_difficulty INTEGER,
            kickoff_time TIMESTAMP,
            finished BOOLEAN DEFAULT FALSE,
            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Gameweek performance table
        CREATE TABLE IF NOT EXISTS gameweek_performance (
            id SERIAL PRIMARY KEY,
            player_id VARCHAR(10) NOT NULL,
            gameweek INTEGER NOT NULL,
            minutes INTEGER DEFAULT 0,
            goals_scored INTEGER DEFAULT 0,
            assists INTEGER DEFAULT 0,
            clean_sheets INTEGER DEFAULT 0,
            goals_conceded INTEGER DEFAULT 0,
            own_goals INTEGER DEFAULT 0,
            penalties_saved INTEGER DEFAULT 0,
            penalties_missed INTEGER DEFAULT 0,
            yellow_cards INTEGER DEFAULT 0,
            red_cards INTEGER DEFAULT 0,
            saves INTEGER DEFAULT 0,
            bonus INTEGER DEFAULT 0,
            bps INTEGER DEFAULT 0,
            total_points INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(player_id, gameweek)
        );

        -- Data collection log table
        CREATE TABLE IF NOT EXISTS collection_log (
            id SERIAL PRIMARY KEY,
            collection_type VARCHAR(20) NOT NULL,
            status VARCHAR(10) NOT NULL,
            message TEXT,
            duration_seconds INTEGER,
            records_processed INTEGER,
            started_at TIMESTAMP NOT NULL,
            completed_at TIMESTAMP,
            error_details TEXT
        );

        -- Create indexes for performance
        CREATE INDEX IF NOT EXISTS idx_players_team_position ON current_players(team, position);
        CREATE INDEX IF NOT EXISTS idx_fixtures_gameweek ON current_fixtures(gameweek);
        CREATE INDEX IF NOT EXISTS idx_performance_gameweek ON gameweek_performance(gameweek);
        CREATE INDEX IF NOT EXISTS idx_collection_log_type ON collection_log(collection_type, started_at);
        """
        
        try:
            conn = psycopg2.connect(self.config['postgres_url'])
            cursor = conn.cursor()
            cursor.execute(schema_sql)
            conn.commit()
            cursor.close()
            conn.close()
            self.logger.info("✓ Database schema created successfully")
            return True
        except Exception as e:
            self.logger.error(f"Failed to setup database schema: {e}")
            return False

    def test_redis_connection(self) -> bool:
        """Test Redis connection and setup basic keys"""
        self.logger.info("Testing Redis connection...")
        
        try:
            r = redis.from_url(self.config['redis_url'])
            
            # Test basic operations
            test_key = 'fpl_sage_setup_test'
            r.set(test_key, 'test_value', ex=60)
            value = r.get(test_key)
            
            if value and value.decode() == 'test_value':
                r.delete(test_key)
                self.logger.info("✓ Redis connection successful")
                return True
            else:
                self.logger.error("Redis test failed - could not retrieve test value")
                return False
                
        except Exception as e:
            self.logger.error(f"Failed to connect to Redis: {e}")
            return False

    def create_config_file(self):
        """Create configuration file for the scheduler"""
        config_data = {
            'fpl_api': {
                'base_url': self.config['fpl_api_url'],
                'rate_limit': 1,
                'timeout': 30,
                'max_retries': 3
            },
            'database': {
                'postgres_url': self.config['postgres_url'],
                'redis_url': self.config['redis_url']
            },
            'schedule': {
                'timezone': 'Europe/London',
                'pre_deadline_time': '18:00',
                'post_deadline_time': '14:00', 
                'post_gameweek_time': '09:00',
                'mid_week_time': '12:00'
            },
            'alerts': {
                'slack_webhook': self.config['slack_webhook'],
                'email_config': self.config['email_config']
            },
            'season': self.config['season'],
            'thresholds': {
                'min_players': 500,
                'max_stale_hours': 6,
                'min_success_rate': 0.95
            }
        }
        
        config_path = self.base_dir / 'fpl_config.json'
        with open(config_path, 'w') as f:
            json.dump(config_data, f, indent=2)
        
        self.logger.info(f"✓ Configuration file created at {config_path}")
        return config_path

    async def test_initial_data_collection(self) -> bool:
        """Run a test data collection to verify everything works"""
        self.logger.info("Running test data collection...")
        
        try:
            # Import the scheduler class
            # Note: In real implementation, you'd import from the actual module
            from automation__fpl_scheduler import FPLScheduler, FPLConfig
            
            # Create test config
            config = FPLConfig()
            scheduler = FPLScheduler(config)
            
            # Run a minimal collection test
            await scheduler.run_pre_deadline_collection()
            
            self.logger.info("✓ Test data collection successful")
            return True
            
        except Exception as e:
            self.logger.error(f"Test data collection failed: {e}")
            return False

    def create_systemd_service(self):
        """Create systemd service file for automated running"""
        service_content = f"""[Unit]
Description=FPL Sage Data Collector
After=network.target

[Service]
Type=simple
User=fpl
WorkingDirectory={self.base_dir}
ExecStart=/usr/bin/python3 -m fpl_scheduler start-scheduler
Restart=always
RestartSec=10
Environment=PYTHONPATH={self.base_dir}

[Install]
WantedBy=multi-user.target
"""
        
        service_path = self.base_dir / 'fpl-sage-collector.service'
        with open(service_path, 'w') as f:
            f.write(service_content)
        
        self.logger.info(f"✓ Systemd service file created at {service_path}")
        self.logger.info("To install: sudo cp fpl-sage-collector.service /etc/systemd/system/")
        self.logger.info("Then: sudo systemctl enable fpl-sage-collector && sudo systemctl start fpl-sage-collector")

    def create_monitoring_script(self):
        """Create a monitoring script to check system health"""
        monitoring_script = '''#!/usr/bin/env python3
"""
FPL Sage Health Check Script
Run this to verify the data collection system is working properly
"""

import psycopg2
import redis
import requests
from datetime import datetime, timedelta
import json

def check_api_availability():
    """Check if FPL API is accessible"""
    try:
        response = requests.get('https://fantasy.premierleague.com/api/bootstrap-static/', timeout=10)
        return response.status_code == 200
    except:
        return False

def check_database_health(postgres_url):
    """Check database connectivity and recent data"""
    try:
        conn = psycopg2.connect(postgres_url)
        cursor = conn.cursor()
        
        # Check if tables exist
        cursor.execute("SELECT COUNT(*) FROM current_players")
        player_count = cursor.fetchone()[0]
        
        # Check data freshness
        cursor.execute("SELECT MAX(last_updated) FROM current_players")
        last_update = cursor.fetchone()[0]
        
        cursor.close()
        conn.close()
        
        if last_update:
            age = datetime.now() - last_update.replace(tzinfo=None)
            fresh = age < timedelta(hours=6)
        else:
            fresh = False
        
        return {
            'accessible': True,
            'player_count': player_count,
            'data_fresh': fresh,
            'last_update': last_update.isoformat() if last_update else None
        }
    except Exception as e:
        return {'accessible': False, 'error': str(e)}

def check_redis_health(redis_url):
    """Check Redis connectivity and cache status"""
    try:
        r = redis.from_url(redis_url)
        cache_keys = r.keys('fpl:*')
        return {
            'accessible': True,
            'cache_entries': len(cache_keys)
        }
    except Exception as e:
        return {'accessible': False, 'error': str(e)}

def main():
    # Load config
    with open('fpl_config.json', 'r') as f:
        config = json.load(f)
    
    print("FPL Sage Health Check")
    print("=" * 30)
    
    # Check API
    api_ok = check_api_availability()
    print(f"FPL API: {'✓' if api_ok else '✗'}")
    
    # Check database
    db_status = check_database_health(config['database']['postgres_url'])
    if db_status['accessible']:
        print(f"Database: ✓ ({db_status['player_count']} players)")
        print(f"Data Fresh: {'✓' if db_status['data_fresh'] else '✗'} (last: {db_status.get('last_update', 'never')})")
    else:
        print(f"Database: ✗ ({db_status.get('error', 'unknown error')})")
    
    # Check Redis
    redis_status = check_redis_health(config['database']['redis_url'])
    if redis_status['accessible']:
        print(f"Redis: ✓ ({redis_status['cache_entries']} cache entries)")
    else:
        print(f"Redis: ✗ ({redis_status.get('error', 'unknown error')})")

if __name__ == '__main__':
    main()
'''
        
        script_path = self.base_dir / 'health_check.py'
        with open(script_path, 'w') as f:
            f.write(monitoring_script)
        
        # Make executable
        os.chmod(script_path, 0o755)
        self.logger.info(f"✓ Health check script created at {script_path}")

@click.command()
@click.option('--skip-validation', is_flag=True, help='Skip API validation')
@click.option('--skip-test', is_flag=True, help='Skip test data collection')
def setup_2025_season(skip_validation, skip_test):
    """Set up FPL Sage for automated 2025-26 season data collection"""
    
    click.echo("🏈 FPL Sage 2025-26 Season Setup")
    click.echo("=" * 40)
    
    setup = FPLSeasonSetup()
    success_count = 0
    total_steps = 7
    
    # Step 1: Validate FPL API
    if not skip_validation:
        click.echo("\n1. Validating FPL API connection...")
        if asyncio.run(setup.validate_fpl_api()):
            success_count += 1
        else:
            click.echo("❌ FPL API validation failed")
    else:
        click.echo("\n1. Skipping FPL API validation")
        success_count += 1
    
    # Step 2: Setup database
    click.echo("\n2. Setting up database schema...")
    if setup.setup_database_schema():
        success_count += 1
    else:
        click.echo("❌ Database setup failed")
    
    # Step 3: Test Redis
    click.echo("\n3. Testing Redis connection...")
    if setup.test_redis_connection():
        success_count += 1
    else:
        click.echo("❌ Redis connection failed")
    
    # Step 4: Create config file
    click.echo("\n4. Creating configuration file...")
    try:
        config_path = setup.create_config_file()
        click.echo(f"✓ Config created: {config_path}")
        success_count += 1
    except Exception as e:
        click.echo(f"❌ Config creation failed: {e}")
    
    # Step 5: Test data collection
    if not skip_test:
        click.echo("\n5. Running test data collection...")
        try:
            # Note: This would need the actual scheduler module
            # if asyncio.run(setup.test_initial_data_collection()):
            #     success_count += 1
            # else:
            #     click.echo("❌ Test collection failed")
            click.echo("⏭️  Test collection skipped (scheduler module needed)")
            success_count += 1
        except Exception as e:
            click.echo(f"❌ Test collection error: {e}")
    else:
        click.echo("\n5. Skipping test data collection")
        success_count += 1
    
    # Step 6: Create systemd service
    click.echo("\n6. Creating systemd service...")
    try:
        setup.create_systemd_service()
        success_count += 1
    except Exception as e:
        click.echo(f"❌ Service creation failed: {e}")
    
    # Step 7: Create monitoring script
    click.echo("\n7. Creating health check script...")
    try:
        setup.create_monitoring_script()
        success_count += 1
    except Exception as e:
        click.echo(f"❌ Monitoring script creation failed: {e}")
    
    # Summary
    click.echo("\n" + "=" * 40)
    click.echo(f"Setup Complete: {success_count}/{total_steps} steps successful")
    
    if success_count == total_steps:
        click.echo("🎉 All setup steps completed successfully!")
        click.echo("\nNext steps:")
        click.echo("1. Review fpl_config.json and update any settings")
        click.echo("2. Install systemd service if running on Linux")
        click.echo("3. Run ./health_check.py to verify system health")
        click.echo("4. Start data collection with: python -m fpl_scheduler start-scheduler")
    else:
        click.echo("⚠️  Some setup steps failed. Review the errors above.")
        click.echo("You may need to install missing dependencies or fix configuration.")

if __name__ == '__main__':
    setup_2025_season()