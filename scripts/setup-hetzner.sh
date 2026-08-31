#!/usr/bin/env bash
# =============================================================================
# Grit&Gigs — Hetzner one-time server setup (always-on, never sleeps)
#
# Run ONCE on a fresh Ubuntu 22.04/24.04 Hetzner VPS as root:
#     bash -c "$(curl -fsSL <url-of-this-script-or-paste-it>)"
#
# BEFORE running, place your production .env in one of these locations:
#     /root/grit-gigs.env       (recommended — scp it up first)
#     or /root/grit-gigs/.env   (inside the clone)
#
# The app is kept alive forever with PM2 (auto-restart on reboot, never sleeps).
# HTTPS is handled separately by Caddy (see Caddyfile at repo root).
# =============================================================================
set -euo pipefail

APP_DIR="/root/grit-gigs"
ENV_FILE="${1:-/root/grit-gigs.env}"   # pass a custom env path as arg if needed
PORT="${PORT:-5000}"
NODE_MAJOR=22

echo "==> 1/6 Installing Node $NODE_MAJOR + build tools"
curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
apt-get install -y nodejs build-essential git curl

echo "==> 2/6 Installing PM2 (process manager)"
npm install -g pm2

echo "==> 3/6 Cloning repository"
rm -rf "$APP_DIR"
git clone https://github.com/techcodric-ship-it/grit-gigs.git "$APP_DIR"
cd "$APP_DIR"

echo "==> 4/6 Writing .env from $ENV_FILE"
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$APP_DIR/.env"
  echo "   .env written. (Ensure DATABASE_URL, JWT_SECRET, ADMIN_API_KEY etc. are present.)"
else
  echo "   WARNING: no env file at $ENV_FILE — copy one manually before starting."
fi

echo "==> 5/6 Installing dependencies"
npm install --production || npm install

echo "==> 6/6 Starting with PM2 (auto-restart, survives reboot)"
# PORT is REQUIRED by the app (src/index.ts throws if missing).
pm2 delete swiftexchange 2>/dev/null || true
PORT="$PORT" NODE_ENV=production pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root | tail -n1
pm2 status

echo
echo "✔ Done. The app is running on port $PORT and will NEVER sleep."
echo "  - Test:      curl http://127.0.0.1:$PORT/health"
echo "  - View logs: pm2 logs swiftexchange"
echo "  - Follow the Caddyfile at $APP_DIR/Caddyfile to enable HTTPS with a domain."
