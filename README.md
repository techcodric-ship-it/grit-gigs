# SwiftExchange

Skill-exchange + freelance marketplace — combined frontend + backend.

## Quick Start

### 1. Install dependencies
```
npm install
```

### 2. Set up environment
```
copy .env.example .env
```
Edit `.env` and set:
- `DATABASE_URL` — your PostgreSQL connection string
- `JWT_SECRET` — any long random string

Get a free database at https://neon.tech (30 seconds, free tier)

### 3. Create database tables (REQUIRED before first run)
```
npx drizzle-kit push --config=drizzle.config.js
```

### 4. Start
```
npm start
```

Open http://localhost:5000

---

## Troubleshooting

**500 errors on all API routes?**
You haven't pushed the database schema yet. Run:
`npx drizzle-kit push --config=drizzle.config.js`

**DATABASE_URL error on startup?**
Make sure you copied `.env.example` to `.env` and filled in your database URL.

**Login says "Signing in..." forever?**
Open browser DevTools (F12) → Console tab and check for red errors.

---

## API — base path /api

| Route | Description |
|---|---|
| POST /api/auth/register | Create account |
| POST /api/auth/login | Login, get JWT |
| GET  /api/auth/me | Current user |
| GET  /api/services | Browse gigs |
| POST /api/services | Create a gig |
| GET  /api/barter/requests | Browse barter posts |
| POST /api/barter/requests | Post a barter request |
| POST /api/orders | Place an order |
| GET  /api/messages/conversations | Inbox |
| GET  /api/gritscore/scans | List the signed-in user's scorecards |
| POST /api/gritscore/scan | Run a scan and compute a 300–900 score |
| GET  /api/gritscore/scan/:id | Owner view of one scorecard |
| GET  /api/gritscore/score/:slug | Public card (opt-in only) |
| POST /api/gritscore/pro/order | Create a GritScore Pro order |
| POST /api/gritscore/pro/verify | Verify a captured payment and unlock Pro |
| GET  /api/gritscore/pro/status | Current Pro entitlement |

## Real-time (Socket.io)
Connect with `io({ auth: { token: '<accessToken>' } })`
Events: `message:send` → `message:new`, `notification:new`

## Deployment (Railway)
Deploy config lives in `railway.json` (Nixpacks + `npm start`). Connect the `main` branch of this repo to a Railway project and every push triggers a new deploy.
