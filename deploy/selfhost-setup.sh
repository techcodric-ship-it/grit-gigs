#!/usr/bin/env bash
set -e
# Grit&Gigs self-host setup — run as root on a fresh Ubuntu 22.04/24.04 VPS
# Usage: bash setup-server.sh

export DEBIAN_FRONTEND=noninteractive

echo "==> [1/7] System update + build tools"
apt-get update -y
apt-get install -y curl git build-essential python3 ca-certificates gnupg ufw

echo "==> [2/7] Node.js 22"
if ! command -v node >/dev/null || [ "$(node -v)" != "v22"* ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v) / npm: $(npm -v)"

echo "==> [3/7] PostgreSQL"
if ! command -v psql >/dev/null; then
  apt-get install -y postgresql postgresql-contrib
fi
DB_USER=gritgigs
DB_NAME=gritgigs
DB_PASS=$(openssl rand -hex 16)
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  sudo -u postgres psql -c "CREATE ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS';"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
fi
echo "DB ready: postgres://$DB_USER:***@localhost:5432/$DB_NAME"

echo "==> [4/7] Clone repo"
APP_DIR=/opt/gritgigs
mkdir -p "$APP_DIR"
REPO_URL="${GIT_REPO_URL:-https://github.com/techcodric-ship-it/grit-gigs.git}"
if [ ! -d "$APP_DIR/.git" ]; then
  if [ -n "$GITHUB_TOKEN" ]; then
    git clone "https://x-access-token:${GITHUB_TOKEN}@${REPO_URL#https://}" "$APP_DIR"
  else
    # try plain clone; if repo is private this will fail and ask for a token
    git clone "$REPO_URL" "$APP_DIR" 2>/dev/null || {
      echo "Clone failed (private repo?). Paste a GitHub Personal Access Token (repo scope):"
      read -r -s TOK
      git clone "https://x-access-token:${TOK}@${REPO_URL#https://}" "$APP_DIR"
    }
  fi
fi
cd "$APP_DIR"

echo "==> [5/7] .env"
if [ ! -f .env ]; then
  cat > .env <<EOF
DATABASE_URL=postgres://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME
NODE_ENV=production
PORT=3000
APP_URL=https://www.gritandgigs.in
CORS_ORIGIN=https://www.gritandgigs.in,https://gritandgigs.in
JWT_SECRET=$(openssl rand -hex 32)
JWT_EXPIRES_IN=15m
ADMIN_API_KEY=$(openssl rand -hex 24)
LOG_LEVEL=info
# --- Supabase (required for file/proof uploads) ---
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
# --- Email (optional; skip = no emails) ---
RESEND_API_KEY=
EMAIL_FROM=Grit&Gigs <team@gritandgigs.in>
REPLY_TO_EMAIL=gritandgigsofficial@gmail.com
# --- Google OAuth (optional) ---
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=https://www.gritandgigs.in/api/auth/google/callback
# --- Razorpay (required for wallet/recharge/subscriptions) ---
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_ACCOUNT_NUMBER=
RAZORPAY_WEBHOOK_SECRET=
# --- Groq AI (optional, powers AI matching/support) ---
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-120b
EOF
  echo "Created .env — OPEN /opt/gritgigs/.env and fill service keys before start."
  echo "Skipping service start until .env is reviewed (run the next step again after editing)."
  echo "  -> nano /opt/gritgigs/.env"
  exit 0
fi

echo "==> [6/7] Install deps + schema"
npm install --omit=dev 2>&1 | tail -3 || npm install 2>&1 | tail -3
npx drizzle-kit push --config=drizzle.config.js --force 2>&1 | tail -5 || echo "(schema push skipped — auto-migrate on boot will handle it)"

echo "==> [7/7] Start with PM2"
npm i -g pm2
pm2 start src/index.ts --name gritgigs --interpreter none 2>/dev/null || pm2 start "npm start" --name gritgigs
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 || true
pm2 restart gritgigs

sleep 4
echo ""
echo "=========================================================="
echo " DONE. Status:"
pm2 status gritgigs
IP=$(curl -4 -s ifconfig.me || hostname -I | awk '{print $1}')
echo " Test locally: curl http://localhost:3000/api/health"
echo " Point gritandgigs.in -> $IP (A record) then open https://gritandgigs.in"
echo "=========================================================="