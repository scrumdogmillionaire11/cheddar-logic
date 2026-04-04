module.exports = {
  apps: [
    {
      name: 'cheddar-web',
      cwd: '/opt/cheddar-logic/web',
      script: '../scripts/start-web.sh',
      interpreter: 'bash',
      env_file: '/opt/cheddar-logic/.env.production',
      // Explicit env block so CHEDDAR_DB_PATH is always visible to the web
      // process even when the PM2 daemon env already has NODE_ENV=production
      // (env_file alone does NOT override vars already in PM2 daemon's env).
      env: {
        CHEDDAR_DB_PATH: '/opt/data/cheddar-prod.db',
      },
      instances: 1,
      autorestart: true,
      watch: false,
    },
    {
      name: 'cheddar-worker',
      cwd: '/opt/cheddar-logic/apps/worker',
      script: 'src/schedulers/main.js',
      env_file: '/opt/cheddar-logic/.env.production',
      // Explicit env block overrides any inherited daemon environment.
      // env_file alone does NOT override vars already in PM2 daemon's env.
      env: {
        CHEDDAR_DB_PATH: '/opt/data/cheddar-prod.db',
        ENABLE_NHL_MODEL: 'true',
        ENABLE_NBA_MODEL: 'true',
        ENABLE_MLB_MODEL: 'true',
        ENABLE_NFL_MODEL: 'false',
        // ── Odds API quota conservation (April 2026 emergency budget: 2,000 tokens) ──
        // 180-min slots = 8 fetches/day × 4 tokens = 32 tokens/day → 896/28 days
        // Leaves ~1,104 tokens for testing and manual runs.
        ODDS_FETCH_SLOT_MINUTES: '180',
        ODDS_MONTHLY_LIMIT: '2000',
        ODDS_BUDGET_RESERVE_PCT: '10',
        ENABLE_ODDS_BACKSTOP: 'false',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      kill_timeout: 5000,
    },
  ],
};
