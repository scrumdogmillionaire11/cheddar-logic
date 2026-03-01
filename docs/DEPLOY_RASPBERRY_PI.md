# Deploy cheddarlogic.com on Raspberry Pi

Self-host the entire stack on your Pi using PM2, nginx, and systemd.

---

## Prerequisites

- Raspberry Pi 4 or 5 (4GB+ RAM recommended)
- Raspberry Pi OS (64-bit)
- Domain `cheddarlogic.com` with DNS control
- Port 80/443 open (or Cloudflare Tunnel as alternative)

---

## Architecture

All services run on the Pi:
- **Web (Next.js)**: Port 3000, managed by PM2
- **FPL Backend (FastAPI)**: Port 8000, managed by PM2
- **Worker**: Managed by systemd (`cheddar-worker.service`)
- **Nginx**: Reverse proxy + SSL (ports 80/443)
- **SQLite**: Local database at `/opt/cheddar-logic/packages/data/cheddar.db`

---

## 1) Initial Pi Setup

### Install Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install Python 3.11+ (if not already present)
sudo apt install -y python3 python3-pip python3-venv

# Install nginx
sudo apt install -y nginx

# Install PM2 globally
sudo npm install -g pm2

# Setup PM2 to start on boot
pm2 startup
# Follow the command it outputs
```

### Create Deployment Directory

```bash
sudo mkdir -p /opt/cheddar-logic
sudo chown $USER:$USER /opt/cheddar-logic
```

---

## 2) Deploy Code to Pi

### Option A: Git Clone (Recommended)

```bash
cd /opt
git clone https://github.com/your-username/cheddar-logic.git
cd cheddar-logic
```

### Option B: rsync from Dev Machine

```bash
# From your dev machine
rsync -avz --exclude node_modules --exclude .git \
  /Users/ajcolubiale/projects/cheddar-logic/ \
  pi@your-pi-ip:/opt/cheddar-logic/
```

---

## 3) Setup Environment Variables

Create production env file:

```bash
cd /opt/cheddar-logic
cp env.example .env.production
nano .env.production
```

Set these values:

```env
# Production settings
NODE_ENV=production
APP_ENV=production
PUBLIC_DOMAIN=https://cheddarlogic.com

# Database (SQLite on Pi)
DATABASE_URL=file:/opt/cheddar-logic/packages/data/cheddar.db
DATABASE_PATH=/opt/cheddar-logic/packages/data/cheddar.db

# API routing
FPL_API_BASE_URL=http://localhost:8000/api/v1
NEXT_PUBLIC_FPL_API_URL=https://cheddarlogic.com/api/v1

# Auth (generate with: openssl rand -base64 32)
AUTH_SECRET=<your-secret-here>

# Odds API
ODDS_API_KEY=<your-key>

# FPL Backend
FPL_SAGE_REDIS_URL=redis://localhost:6379
FPL_SAGE_UNLIMITED_ACCESS_ENABLED=true
FPL_SAGE_UNLIMITED_TEAMS=711511,1930561
```

---

## 4) Build & Install

### Web

```bash
cd /opt/cheddar-logic/web
npm install --production
npm run build
```

### Worker

```bash
cd /opt/cheddar-logic/apps/worker
npm install --production
```

### FPL Backend

```bash
cd /opt/cheddar-logic/cheddar-fpl-sage
python3 -m venv venv
source venv/bin/activate
pip install -r config/requirements.txt
```

### Database

```bash
cd /opt/cheddar-logic
npm --prefix packages/data install --production
npm --prefix packages/data run migrate
```

---

## 5) Configure PM2

Create PM2 ecosystem file:

```bash
nano /opt/cheddar-logic/ecosystem.config.js
```

```javascript
module.exports = {
  apps: [
    {
      name: 'cheddar-web',
      cwd: '/opt/cheddar-logic/web',
      script: 'npm',
      args: 'start',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      env_file: '/opt/cheddar-logic/.env.production',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
    },
    {
      name: 'cheddar-fpl-api',
      cwd: '/opt/cheddar-logic/cheddar-fpl-sage',
      script: '/opt/cheddar-logic/cheddar-fpl-sage/venv/bin/uvicorn',
      args: 'backend.main:app --host 0.0.0.0 --port 8000',
      env: {
        PYTHONPATH: '/opt/cheddar-logic/cheddar-fpl-sage:/opt/cheddar-logic/cheddar-fpl-sage/src',
      },
      env_file: '/opt/cheddar-logic/.env.production',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
    },
  ],
};
```

Start services:

```bash
cd /opt/cheddar-logic
pm2 start ecosystem.config.js
pm2 save
```

Verify:

```bash
pm2 status
pm2 logs cheddar-web --lines 50
pm2 logs cheddar-fpl-api --lines 50
```

---

## 6) Setup Worker (systemd)

```bash
# Copy service file
sudo cp /opt/cheddar-logic/cheddar-worker.service /etc/systemd/system/

# Edit paths if needed
sudo nano /etc/systemd/system/cheddar-worker.service

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable cheddar-worker
sudo systemctl start cheddar-worker

# Check status
sudo systemctl status cheddar-worker
sudo journalctl -u cheddar-worker -f
```

---

## 7) Configure Nginx Reverse Proxy

### Install SSL Certificate (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d cheddarlogic.com -d www.cheddarlogic.com
```

### Nginx Config

```bash
sudo nano /etc/nginx/sites-available/cheddarlogic.com
```

```nginx
# HTTP -> HTTPS redirect
server {
    listen 80;
    listen [::]:80;
    server_name cheddarlogic.com www.cheddarlogic.com;
    return 301 https://cheddarlogic.com$request_uri;
}

# HTTPS
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name cheddarlogic.com www.cheddarlogic.com;

    # SSL managed by certbot
    ssl_certificate /etc/letsencrypt/live/cheddarlogic.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cheddarlogic.com/privkey.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # FPL API backend (direct route)
    location /api/v1/ {
        proxy_pass http://localhost:8000/api/v1/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
    }

    # Next.js web app (everything else)
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Increase max body size for uploads
    client_max_body_size 10M;
}
```

Enable and restart:

```bash
sudo ln -s /etc/nginx/sites-available/cheddarlogic.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

## 8) DNS Configuration

Point your domain to the Pi's public IP:

| Record | Type | Value |
|--------|------|-------|
| `@` | A | `your-pi-public-ip` |
| `www` | CNAME | `@` |

**Alternative: Cloudflare Tunnel (if behind NAT)**

If you can't open ports 80/443:

```bash
# Install cloudflared
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared.deb

# Authenticate
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create cheddar-logic

# Configure tunnel
nano ~/.cloudflared/config.yml
```

```yaml
tunnel: <your-tunnel-id>
credentials-file: /home/pi/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: cheddarlogic.com
    service: http://localhost:80
  - hostname: www.cheddarlogic.com
    service: http://localhost:80
  - service: http_status:404
```

```bash
# Route DNS
cloudflared tunnel route dns cheddar-logic cheddarlogic.com
cloudflared tunnel route dns cheddar-logic www.cheddarlogic.com

# Run as service
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

---

## 9) Deploy Updates via Git

After pushing changes to GitHub:

```bash
cd /opt/cheddar-logic
git pull origin main

# Rebuild web
cd web
npm install --production
npm run build

# Restart services
pm2 restart cheddar-web

# Restart backend if Python changed
cd ../cheddar-fpl-sage
source venv/bin/activate
pip install -r config/requirements.txt
pm2 restart cheddar-fpl-api

# Restart worker if changed
sudo systemctl restart cheddar-worker
```

Or create a deploy script:

```bash
nano /opt/cheddar-logic/deploy.sh
```

```bash
#!/bin/bash
set -e

cd /opt/cheddar-logic
git pull origin main

echo "Building web..."
cd web
npm install --production
npm run build

echo "Updating backend..."
cd ../cheddar-fpl-sage
source venv/bin/activate
pip install -r config/requirements.txt

echo "Restarting services..."
pm2 restart all
sudo systemctl restart cheddar-worker

echo "✓ Deploy complete"
pm2 status
```

```bash
chmod +x /opt/cheddar-logic/deploy.sh
```

---

## 10) Monitoring

### Check Services

```bash
# PM2 apps
pm2 status
pm2 logs cheddar-web --lines 100
pm2 logs cheddar-fpl-api --lines 100

# Worker
sudo systemctl status cheddar-worker
sudo journalctl -u cheddar-worker -f

# Nginx
sudo systemctl status nginx
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# System resources
htop
df -h
```

### PM2 Monitoring

```bash
pm2 monit  # Real-time monitoring
pm2 logs   # Tail all logs
```

---

## Troubleshooting

### Web won't start
```bash
cd /opt/cheddar-logic/web
npm run build  # Check for build errors
PORT=3000 npm start  # Test manually
pm2 logs cheddar-web --lines 200
```

### Backend API errors
```bash
cd /opt/cheddar-logic/cheddar-fpl-sage
source venv/bin/activate
PYTHONPATH=.:$PWD/src uvicorn backend.main:app --host 0.0.0.0 --port 8000
# Check errors, then restart PM2
pm2 restart cheddar-fpl-api
```

### Worker not pulling data
```bash
sudo journalctl -u cheddar-worker -n 200
# Check ODDS_API_KEY in .env.production
```

### SSL certificate renewal
```bash
sudo certbot renew --dry-run  # Test renewal
sudo systemctl status certbot.timer  # Auto-renewal timer
```

### Out of disk space
```bash
# Clean old PM2 logs
pm2 flush

# Clean apt cache
sudo apt clean
sudo apt autoremove

# Check large files
sudo du -h /opt/cheddar-logic | sort -h | tail -20
```

---

## Performance Tips

### Optimize Next.js Build

```bash
# In web/.env.production
NEXT_TELEMETRY_DISABLED=1
```

### Reduce PM2 Memory

Edit `ecosystem.config.js`:
```javascript
max_memory_restart: '512M',  // Lower for Pi 4GB
```

### Add Swap (if Pi has <4GB RAM)

```bash
sudo dphys-swapfile swapoff
sudo nano /etc/dphys-swapfile
# Set: CONF_SWAPSIZE=2048
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

---

## Backup Strategy

```bash
# Backup script
nano /opt/cheddar-logic/backup.sh
```

```bash
#!/bin/bash
BACKUP_DIR="/home/pi/backups"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

# Backup database
cp /opt/cheddar-logic/packages/data/cheddar.db "$BACKUP_DIR/cheddar_$DATE.db"

# Backup env
cp /opt/cheddar-logic/.env.production "$BACKUP_DIR/env_$DATE.txt"

# Keep only last 7 days
find "$BACKUP_DIR" -name "cheddar_*.db" -mtime +7 -delete

echo "✓ Backup complete: $BACKUP_DIR/cheddar_$DATE.db"
```

```bash
chmod +x /opt/cheddar-logic/backup.sh

# Add to crontab (daily at 2am)
crontab -e
# Add: 0 2 * * * /opt/cheddar-logic/backup.sh
```

---

## Quick Reference

| Service | Command | Port |
|---------|---------|------|
| Web | `pm2 restart cheddar-web` | 3000 |
| FPL API | `pm2 restart cheddar-fpl-api` | 8000 |
| Worker | `sudo systemctl restart cheddar-worker` | - |
| Nginx | `sudo systemctl restart nginx` | 80/443 |
| Deploy | `/opt/cheddar-logic/deploy.sh` | - |
| Logs | `pm2 logs` | - |

**Test URLs:**
- http://localhost:3000 (web direct)
- http://localhost:8000/api/v1/health (API direct)
- https://cheddarlogic.com (public)
