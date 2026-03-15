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
      instances: 1,
      autorestart: true,
      watch: false,
      kill_timeout: 5000,
      pre_start_script: 'rm -f /opt/data/cheddar-prod.db.lock',
    },
  ],
};
