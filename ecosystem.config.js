module.exports = {
  apps: [
    {
      name: 'cheddar-web',
      cwd: '/opt/cheddar-logic/web',
      script: 'node_modules/.bin/next',
      args: 'start',
      env_file: '/opt/cheddar-logic/.env.production',
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
        ENABLE_NHL_MODEL: 'true',
        ENABLE_NBA_MODEL: 'true',
        ENABLE_MLB_MODEL: 'true',
        ENABLE_NFL_MODEL: 'false',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      kill_timeout: 5000,
    },
  ],
};
