module.exports = {
  apps: [
    {
      name: 'cheddar-web',
      cwd: '/opt/cheddar-logic/web',
      script: '../scripts/start-web.sh',
      interpreter: 'bash',
      exec_mode: 'fork',
      instances: 1,
      env_file: '/opt/cheddar-logic/.env.production',
      // Explicit env block so CHEDDAR_DB_PATH is always visible to the web
      // process even when the PM2 daemon env already has NODE_ENV=production
      // (env_file alone does NOT override vars already in PM2 daemon's env).
      env: {
        CHEDDAR_DB_PATH: '/opt/data/cheddar-prod.db',
      },
      autorestart: true,
      watch: false,
      // Never stop retrying — restart indefinitely with a 10s backoff.
      // max_restarts: 0 means unlimited in PM2.
      max_restarts: 0,
      min_uptime: '10s',
      restart_delay: 10000,
    },
    {
      name: 'cheddar-worker',
      cwd: '/opt/cheddar-logic/apps/worker',
      script: 'src/schedulers/main.js',
      exec_mode: 'fork',
      instances: 1,
      env_file: '/opt/cheddar-logic/.env.production',
      // Explicit env block overrides any inherited daemon environment.
      // env_file alone does NOT override vars already in PM2 daemon's env.
      env: {
        CHEDDAR_DB_PATH: '/opt/data/cheddar-prod.db',
        ENABLE_NHL_MODEL: 'true',
        ENABLE_NBA_MODEL: 'true',
        ENABLE_MLB_MODEL: 'true',
        ENABLE_NFL_MODEL: 'false',
        // Spin-wait up to 15s for the previous worker to release the DB lock
        // before throwing. Prevents the SIGINT → restart race where PM2 starts
        // the new process while the old one is still in its exit cleanup.
        CHEDDAR_DB_LOCK_TIMEOUT_MS: '15000',
      },
      autorestart: true,
      watch: false,
      kill_timeout: 5000,
      // Never stop retrying — restart indefinitely with a 30s backoff.
      max_restarts: 0,
      min_uptime: '10s',
      restart_delay: 30000,
    },
  ],
};
