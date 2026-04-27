# Deploy cheddarlogic.com on Raspberry Pi

Self-host the entire stack on your Pi using systemd and nginx.

---

## Prerequisites

- Raspberry Pi 4 or 5 (4GB+ RAM recommended)
- Raspberry Pi OS (64-bit)
- Domain `cheddarlogic.com` with DNS control
- Port 80/443 open (or Cloudflare Tunnel as alternative)

---

## Architecture

All services run on the Pi:
- **Web (Next.js)**: Port 3000, managed by systemd (`deploy/systemd/cheddar-web.service`)
- **FPL Backend (FastAPI)**: Port 8000, managed by systemd (`deploy/systemd/cheddar-fpl-sage.service`)
- **Worker**: Managed by systemd (`deploy/systemd/cheddar-worker.service`)
- **Nginx**: Reverse proxy + SSL (ports 80/443)
- **SQLite**: Production database at `/opt/data/cheddar-prod.db`

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
# Single source of truth for database path:
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db

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
CHEDDAR_DB_PATH=/opt/cheddar-logic/packages/data/cheddar.db npm --prefix packages/data run migrate

# Verify schema
sqlite3 /opt/data/cheddar-prod.db ".tables"

# Seed cards if the UI is empty
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db npm --prefix packages/data run seed:cards
```

---

## 5) Setup systemd services

```bash
# Copy service files
sudo cp /opt/cheddar-logic/deploy/systemd/cheddar-web.service /etc/systemd/system/
sudo cp /opt/cheddar-logic/deploy/systemd/cheddar-worker.service /etc/systemd/system/
sudo cp /opt/cheddar-logic/deploy/systemd/cheddar-fpl-sage.service /etc/systemd/system/

# Environment is loaded from /opt/cheddar-logic/.env.production
# Confirm the canonical production DB path is set there.
grep '^CHEDDAR_DB_PATH=' /opt/cheddar-logic/.env.production

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable cheddar-web
sudo systemctl enable cheddar-worker
sudo systemctl enable cheddar-fpl-sage

sudo systemctl start cheddar-worker
sudo systemctl start cheddar-web
sudo systemctl start cheddar-fpl-sage

# Check status
sudo systemctl status cheddar-worker cheddar-web cheddar-fpl-sage --no-pager
sudo journalctl -u cheddar-worker -n 50 --no-pager
sudo journalctl -u cheddar-web -n 50 --no-pager
sudo journalctl -u cheddar-fpl-sage -n 50 --no-pager
```

### Restart commands (current production)

```bash
# Preferred order after deploy or maintenance: writer first, then readers.
sudo systemctl restart cheddar-worker
sudo systemctl restart cheddar-web
sudo systemctl restart cheddar-fpl-sage

# Confirm all three are healthy
sudo systemctl status cheddar-worker cheddar-web cheddar-fpl-sage --no-pager
```

### Worker stale-lock recovery

Use this only when `cheddar-worker` is down and `/opt/data/cheddar-prod.db.lock` is stale.

```bash
sudo systemctl stop cheddar-worker.service
ps -fp <old-pid> || true
sudo rm -f /opt/data/cheddar-prod.db.lock
sudo systemctl reset-failed cheddar-worker.service
sudo systemctl start cheddar-worker
sudo systemctl status cheddar-worker.service --no-pager
journalctl -u cheddar-worker.service --since "2 minutes ago" --no-pager
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

If you can't open ports 80/443, use a **single production tunnel** in token mode and manage hostnames from **Published application routes** on that tunnel. Do **not** mix manual DNS edits, multiple production tunnels, or the Zero Trust **Networks → Routes** private-hostname/Gateway feature.

```bash
# Install cloudflared
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared.deb

# In Cloudflare Zero Trust:
# 1) Create exactly one tunnel for production
# 2) Open that tunnel and add Published application routes:
#    - cheddarlogic.com     -> HTTP 127.0.0.1:3000
#    - www.cheddarlogic.com -> HTTP 127.0.0.1:3000
#    - api.cheddarlogic.com -> HTTP 127.0.0.1:8000
# 3) Copy the tunnel token for that tunnel
```

```bash
# Install the token-based service from the Pi
sudo cloudflared service install <TUNNEL_TOKEN>
sudo systemctl start cloudflared
sudo systemctl enable cloudflared

# Verify the local origin before testing the public URL
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/cards
sudo systemctl status cloudflared --no-pager
```

Production notes:

- Prefer `127.0.0.1` in Published application routes instead of `localhost` to avoid IPv4/IPv6 ambiguity.
- Let **Published application routes** create/manage the public DNS records. If `A`, `AAAA`, or `CNAME` records already exist for `cheddarlogic.com`, `www`, or `api`, delete those conflicting records first and then re-save the tunnel routes.
- The correct UI is **Zero Trust → Networks → Connectors → your production tunnel → Published application routes**.
- The **Zero Trust → Networks → Routes** page is for private hostname/Gateway routing and is **not** the right place to publish the public website.
- After any tunnel change, smoke-test both the Pi origin and the public site before ending the maintenance window.

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
sudo systemctl restart cheddar-worker
sudo systemctl restart cheddar-web

# Restart backend if Python changed
cd ../cheddar-fpl-sage
source venv/bin/activate
pip install -r config/requirements.txt
sudo systemctl restart cheddar-fpl-sage

# Verify
sudo systemctl status cheddar-worker cheddar-web cheddar-fpl-sage --no-pager
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
sudo systemctl restart cheddar-worker
sudo systemctl restart cheddar-web
sudo systemctl restart cheddar-fpl-sage

echo "✓ Deploy complete"
sudo systemctl status cheddar-worker cheddar-web cheddar-fpl-sage --no-pager
```

```bash
chmod +x /opt/cheddar-logic/deploy.sh
```

---

## 10) Monitoring

### Check Services

```bash
# App services
sudo systemctl status cheddar-web cheddar-worker cheddar-fpl-sage --no-pager
sudo journalctl -u cheddar-web -n 100 --no-pager
sudo journalctl -u cheddar-fpl-sage -n 100 --no-pager

# Worker
sudo journalctl -u cheddar-worker -f

# Nginx
sudo systemctl status nginx
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# System resources
htop
df -h
```

### Service Monitoring

```bash
sudo journalctl -u cheddar-web -f
sudo journalctl -u cheddar-worker -f
sudo journalctl -u cheddar-fpl-sage -f
```

---

## Troubleshooting

### Web won't start
```bash
cd /opt/cheddar-logic/web
npm run build  # Check for build errors
PORT=3000 npm start  # Test manually
sudo journalctl -u cheddar-web -n 200 --no-pager
sudo systemctl restart cheddar-web
```

### Backend API errors
```bash
cd /opt/cheddar-logic/cheddar-fpl-sage
source venv/bin/activate
PYTHONPATH=.:$PWD/src uvicorn backend.main:app --host 0.0.0.0 --port 8000
# Check errors, then restart the service
sudo systemctl restart cheddar-fpl-sage
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
# Trim old systemd journals
sudo journalctl --vacuum-time=7d

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

### Service memory limits

Tune the systemd service units instead of PM2:

```bash
sudo systemctl edit cheddar-web
sudo systemctl edit cheddar-worker
```

Then set overrides such as `MemoryLimit=` and restart the affected service.

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
| Web | `sudo systemctl restart cheddar-web` | 3000 |
| FPL API | `sudo systemctl restart cheddar-fpl-sage` | 8000 |
| Worker | `sudo systemctl restart cheddar-worker` | - |
| Nginx | `sudo systemctl restart nginx` | 80/443 |
| Deploy | `/opt/cheddar-logic/deploy.sh` | - |
| Logs | `sudo journalctl -u <service> -f` | - |

**Test URLs:**
- http://localhost:3000 (web direct)
- http://localhost:8000/api/v1/health (API direct)
- https://cheddarlogic.com (public)
