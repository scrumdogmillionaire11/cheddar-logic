#!/bin/bash
# Deploy FPL Sage to Raspberry Pi
# Run this on the Pi after rsync'ing the code to /opt/cheddar-logic

set -e

DEPLOY_DIR="/opt/cheddar-logic"

echo "=========================================="
echo "FPL Sage Pi Deployment Setup"
echo "=========================================="

cd "$DEPLOY_DIR"

# 1. Generate AUTH_SECRET if not set
if ! grep -q "REPLACE_WITH_GENERATED_SECRET" ".env.production"; then
    echo "✓ AUTH_SECRET already set"
else
    echo "⚙️  Generating AUTH_SECRET..."
    AUTH_SECRET=$(openssl rand -base64 32)
    sed -i "s/REPLACE_WITH_GENERATED_SECRET/$AUTH_SECRET/" .env.production
    echo "✓ AUTH_SECRET generated and set"
fi

# 2. Create data directory
echo "⚙️  Creating data directory..."
mkdir -p "$DEPLOY_DIR/packages/data"
chmod 755 "$DEPLOY_DIR/packages/data"
echo "✓ Data directory ready"

# 3. Build web
echo "⚙️  Building Next.js web app..."
cd "$DEPLOY_DIR/web"
npm install --production --no-save > /dev/null 2>&1
npm run build > /dev/null 2>&1
echo "✓ Web app built"

# 4. Setup FPL backend
echo "⚙️  Setting up FPL Sage backend..."
cd "$DEPLOY_DIR/cheddar-fpl-sage"
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi
source venv/bin/activate
pip install -q -r backend/requirements.txt
deactivate
echo "✓ FPL backend dependencies installed"

# 5. Install worker
echo "⚙️  Installing worker..."
cd "$DEPLOY_DIR/apps/worker"
npm install --production --no-save > /dev/null 2>&1
echo "✓ Worker dependencies installed"

# 6. Start/restart PM2 services
echo "⚙️  Starting PM2 services..."
cd "$DEPLOY_DIR"
pm2 restart ecosystem.config.js || pm2 start ecosystem.config.js
pm2 save
echo "✓ PM2 services running"

# 7. Summary
echo ""
echo "=========================================="
echo "✅ DEPLOYMENT COMPLETE"
echo "=========================================="
echo ""
echo "Services Status:"
pm2 status
echo ""
echo "Next steps:"
echo "1. Verify .env.production has your domain set to: https://cheddarlogic.com"
echo "2. Nginx should be configured with your domain"
echo "3. Check logs with: pm2 logs cheddar-fpl-api"
echo "4. Test with: curl http://localhost:8000/api/v1/health"
echo ""
