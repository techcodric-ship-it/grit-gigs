# Prep / Company Report — Phase 0 Audit

Method: grep for `barter`, route registrations, schema exports, nav markup, wallet/credits
service functions, rate-limit and auth patterns. Every name below was read from the
codebase, not assumed. Files under **READ-ONLY** are locked by `docs/prep-barter-lock.json`
and enforced by `scripts/prep-guard.mjs` (wired into `npm run guard:prep` and the deploy
workflow).

## 0. Baseline gates (Phase 0, recorded before any change)

- `npx tsc --noEmit` → **0 errors**
- `npx vitest run` → **446 tests / 12 files, all passing**
  (The build prompt says "519 tests today"; the actual suite at Phase 0 is 446.
  The 446 number is the baseline any later phase must match or exceed.)
- Barter-related test files and pass counts (run unedited, forever):
  - `src/lib/demo-data.test.ts` — **22 tests** (barter assertions: 4 completed BARTER
    demo listings L98-105, "keeps every barter listing stating what it wants in return" L147)
  - `src/lib/wallet-guards.test.ts` — **9 tests** (barter assertion: "never asks a client
    to pay for a barter" L38 → `resolveGigAmount("BARTER", …)` must return null)

## 1. Barter feature — READ-ONLY inventory

### 1.1 Barter-exclusive source files (hash-locked)

Hashes are SHA-256 of the **committed git blob at HEAD** (stable across
Windows/Linux line-ending settings; enforced by `scripts/prep-guard.mjs`).

| File | Role | SHA-256 (committed blob) |
|---|---|---|
| `src/routes/barter.ts` | Barter router (85 barter refs) | `efb169ad008df2cda4d47811d770d616a4ef29c8dbe7f6e11d058e64f7d7cb0b` |
| `src/routes/barter-review.ts` | `POST /barter/matches/:id/review` (raw `pool` SQL) | `0d4cda2b950c7ed7020b5f6be1655b63275571bff973b60903193033e1c763a9` |
| `src/routes/match-complete.ts` | Match lifecycle: complete / deliver / accept-delivery / request-revision / cancel | `2bdc9ad98ada96344261d3cf254c9cd0a808519715210de6db5a58abca90aab1` |
| `src/db/schema/barter.ts` | Drizzle schema: tables + enums (below) | `551fd6735c5f79b47a532348132ec19d5bdca53557a5eb8f3f0270ac1608fc4c` |
| `public/barter.html` | Barter page template | `b70e257d1fb5bec2ba0943f95e2775c0df37b6b3abe4cada3b227928371b8b6d` |

### 1.2 Barter routes (real names)

- `src/routes/barter.ts`:
  `GET /barter/requests`, `GET /barter/requests/mine`, `GET /barter/requests/:id`,
  `POST /barter/requests` (multer `barterUpload.single("image")`),
  `PUT /barter/requests/:id`, `DELETE /barter/requests/:id`,
  `PATCH /barter/requests/:id/toggle-pause`, `GET /barter/trending`,
  `GET /barter/matches`, `POST /barter/matches`, `PUT /barter/matches/:id/respond`,
  `GET /barter/ai-suggestions`
- `src/routes/barter-review.ts`: `POST /barter/matches/:id/review`
- `src/routes/match-complete.ts`: `PUT /barter/matches/:id/complete`,
  `POST /barter/matches/:id/deliver`, `PUT /barter/matches/:id/accept-delivery`,
  `PUT /barter/matches/:id/request-revision`, `PUT /barter/matches/:id/cancel`
- Mounted in `src/routes/index.ts` (`barterRouter`, `matchCompleteRouter`,
  `barterReviewRouter` — shared file, additive changes only).

### 1.3 Barter tables and enums (real names)

- Tables: `barter_requests`, `barter_matches`, `barter_deliveries` (Drizzle,
  `src/db/schema/barter.ts`), `barter_reviews` (DDL inline in `src/index.ts` L357,
  accessed with raw SQL from `barter-review.ts` — no Drizzle schema exists).
- Enums: `barter_status` (ACTIVE/MATCHED/IN_PROGRESS/COMPLETED/…),
  `match_status` (`src/db/schema/barter.ts`).
- Shared enums that carry a `BARTER` member (never altered; adding a member would
  change existing behavior): `saved_item_type`, `dispute_target`, `invite_target_type`,
  `report_target_type` (`src/db/schema/extras.ts`).
- Bootstrap DDL for barter lives inline in `src/index.ts` (L154, L357, L417…).
  `src/index.ts` is shared (currently carries in-progress Focus Rooms edits) — its
  barter DDL sections must never be edited even though the file itself is not hash-locked.

### 1.4 Barter templates, CSS, client JS

- Template: `public/barter.html` (hash-locked).
- CSS (shared files, additive-only; the `.barter-*` blocks are barter-owned and must not
  be edited): `public/css/main.css` L348-374 (`.barter-grid`, `.barter-card`, …),
  L550/L562 (responsive), L629-631 (`.barter-cards-grid`); `public/assets/feed.css`
  (2 barter mentions, card kind labels).
- Client JS (shared file): `public/js/main.js` — `loadLiveBarterCards` (L370),
  `loadBarterPage` (L594), match creation (L423), request detail (L654),
  `GET /barter/ai-suggestions` (L730).

### 1.5 Barter read-only rule

Barter files, tables, enums, routes and tests must not be modified, renamed, moved or
deleted in any Prep phase. Barter tests run unedited. CI guard:
`node scripts/prep-guard.mjs` fails if (a) any locked file's SHA-256 differs from this
baseline, or (b) the diff under test touches a locked path.

## 2. Shared code map (additive-only; every touch listed in the PR + regression test)

| Concern | Real names | Rule for Prep |
|---|---|---|
| Auth | `src/middlewares/authenticate.ts` (Bearer JWT from localStorage; **no cookie CSRF surface — no CSRF middleware exists anywhere**, pattern = Authorization header), `adminAuth` (`x-admin-key` or admin JWT) | no signature changes; Prep write routes use `authenticate`, admin routes use `adminAuth` |
| Rate limits | `express-rate-limit` per-route (see `auth.ts` L32-34, `ai-support.ts` L7) and app-level in `src/app.ts` L63-64 | new Prep limiters are new `rateLimit()` instances, no shared config change |
| Wallet | `freelanceWalletsTable`, `transactionsTable`, `transaction_type` enum (`src/db/schema/wallet.ts`); crediting pattern = `creditReferrerReward(tx, …)` in `src/lib/referrals.ts` (UPDATE balance + INSERT transactions row inside caller tx) | commission/withdrawal/fee logic untouched; `transaction_type` enum **cannot gain values** (would alter an existing enum) — Prep earnings insert wallet credit rows reusing the existing mechanism, and per-spec credit amounts are tracked in new `prep_credit_awards` |
| Credits | There is **no separate credits ledger**: "credits" are wallet top-ups via Razorpay (`src/routes/credits.ts`, type `CREDIT_PURCHASE` → `freelance_wallets.balance`) | earn/spend Prep credits = wallet credit/debit via existing insert/update pattern + `prep_credit_awards` for idempotency |
| Subscriptions | `PLANS`, `getActivePlanForUser`, `getOrCreateSubscription`, `consumeGigCreation` (`src/lib/subscriptions.ts`); `plan_id` enum = `starter/pro/squad` only | `plan_id` enum cannot gain `prep_pro` (no enum alteration) → Prep pro entitlement lives in a new `prep_` table (§5), per-report purchase via wallet |
| Messaging / notifications | `notificationsTable` (`src/db/schema/users.ts`), `sendNotificationEmail` (`src/lib/email.ts`) | additive calls only |
| Nav | Inline icon row per page (e.g. `public/feed.html` L23-27: Feed, Explore, Messages, Inbox, Orders …); `src/lib/nav-badge.test.ts` (49 tests) asserts anchor shape/order/badge classes across 9 pages | Prep icon injected **client-side** by new `public/js/prep-nav.js` after `/api/prep/flag` says enabled, so flag-off HTML and icon order are unchanged (nav-badge test stays green); pages get one additive `<script>` tag |
| Styles | `public/css/main.css` tokens (`--purple` `#6C3FE8`, rounded cards) + `public/assets/feed.css` | new prep styles go in a **new** `public/prep/prep.css` using existing tokens; main.css only if unavoidable (additive rules at end + regression test) |
| AI | Groq chat completions, `GROQ_API_KEY` / `GROQ_MODEL` env, pattern in `src/routes/ai-support.ts` (server-side only) | PrepAiService wraps same provider in `src/prep/` |
| Uploads | `uploadToSupabase(buffer, originalName, subfolder)` (`src/lib/storage.ts`), bucket `uploads` | Prep evidence uses a **new private** storage path with own helper (no change to existing function) |
| Router registration | `src/routes/index.ts` mounts routers (currently carries in-progress Focus Rooms edits) | Prep routers mounted from `src/app.ts` instead (additive `app.use("/api/prep", …)`), avoiding that file |
| Validation | zod is a dependency but routes mostly hand-check | Prep endpoints validate with zod schemas in `src/prep/` |
| Static/clean URLs | clean-URL redirect + SPA-ish fallback in `src/app.ts` (L79-84, L128+); redirects block L91-121 | add `/prep*` page serving/redirects additively |

## 3. Feature flag

- Name: `FEATURE_PREP` (env). **Default off everywhere**, including production; on only
  when set to `1|true|on`. Helper: `src/prep/feature.ts` → `isPrepEnabled()`.
- With flag off: no nav icon (prep-nav.js fetches `GET /api/prep/flag` → { enabled:false },
  injects nothing), `/api/prep/*` and `/api/proof/*` answer `404 { success:false }`
  ("Not found"), `/prep*` pages redirect to `/feed`. Page HTML for Prep exists only under
  `public/prep/` (linked only when flag is on).

## 4. Deviations / gaps vs. the build prompt (decided in Phase 0)

1. Test baseline is **446**, not 519.
2. No CSRF middleware exists; "consistent with the existing pattern" = Bearer-header auth
   (no cookies), so no CSRF token layer is introduced.
3. No credits ledger table; credits = wallet balance. Prep uses wallet service pattern +
   `prep_credit_awards` (unique per record) for one-time awards.
4. `transaction_type` and `plan_id` enums must not gain values (migrations may not alter
   existing enums) → Prep pro entitlement = `prep_entitlements` table; wallet purchase
   rows reuse existing transaction types only where semantically true, otherwise the
   purchase is recorded in `prep_` tables and the wallet debit uses the existing
   generic amount update + a `SUBSCRIPTION`-typed row only if it is genuinely a
   subscription-like charge (decided at Phase 9, with tests).
5. Routers mount from `src/app.ts`, not `src/routes/index.ts`, because the latter carries
   in-progress Focus Rooms work that must not be staged.
6. `prep_companies` etc. get a new SQL migration file under `migrations/` (existing
   migrations are additive SQL files; `src/index.ts` inline DDL is off-limits for Prep).

## 5. Barter lock enforcement

- `docs/prep-barter-lock.json` — machine-readable { path: sha256 }.
- `scripts/prep-guard.mjs` — hash check + diff-path check (used by CI and
  `npm run guard:prep`). Deploy workflow runs it before any code is pulled to the server.

## Phase 7 deviation note (evidence storage)
- Spec wants raw evidence private + deleted after 30 days. The existing `uploads` bucket is public (Supabase `public: true`, served at `/uploads/*` with `X-Robots-Tag: noindex`). Evidence is therefore uploaded under an unguessable `proof-evidence/<timestamp>-<uuid8>` path, the URL is stored **server-side only** (never returned by any API � enforced by `publicSubmission()` + tests), and `runEvidenceRetention()` deletes the object after exactly 30 days (6-hour sweep, retries on failure, `file_path` nulled only after confirmed deletion).
- Follow-up hardening (non-blocking): move evidence to a private bucket with signed admin-only URLs when bucket config is touched next.

## Phase 9 decision note (monetization)
- Prep Pro = 30-day entitlement in `prep_entitlements` (partial unique index on `(user_id, kind) WHERE status = 'ACTIVE'`), price Rs 199, funded from the existing wallet balance (Razorpay top-up flows untouched). The charge posts a `SUBSCRIPTION`-typed `transactions` row - an existing enum value, no enum changes. Concurrent purchase races are handled atomically (`balance >= price` in the UPDATE WHERE + 23505 unique-violation fallback).
- Contributor earnings: approving a proof credits the submitter Rs 25 exactly once, keyed by `prep_credit_awards.reason = proof-award:<submissionId>` (UNIQUE) inside the same transaction as the status flip; the wallet credit mirrors the referral pattern (`balance` + `total_earned`) and the ledger row uses the existing `SERVICE_EARNING` enum value (closest existing 'earning to the user' semantic; no enum can be added).
- Free tier: `PREP_FREE_DAILY_REPORTS` (default 3, cap 100, 0 = block) enforced server-side on BOTH creation routes (POST `/reports` and GET `/companies/:slug/report`); cached report reads and anonymous aptitude/interview practice stay free.

## Phase 11 note (final polish + prod wiring fix)
- **Critical fix (519032e):** `src/routes/index.ts` ends in a terminal 404 catch-all. It was mounted at `app.use('/api', router)` BEFORE `app.use('/api/prep', prepRouter)`, so every prep API route answered `Route not found` in production while all unit tests stayed green (they never boot the app). The prep mount now precedes the shared router; `src/prep/mount.test.ts` boots the real Express app on an ephemeral port and locks the ordering (flag probe 200, gate `Not found` vs catch-all `Route not found`, flag-off pages 302, flag-on reaches the prep gate).
- **Hardening already live before Phase 11:** X-Robots-Tag on all prep pages, meta noindex on all 5 pages, `Disallow: /prep/` in robots.txt, sitemap clean, href scheme guards, RSS parser scheme/date robustness.
- **Production state:** deploys green through 519032e; `GET /api/prep/flag` = `{enabled:false}` (FEATURE_PREP off in prod - feature fully hidden: API 404s at the gate, pages 302 to /feed, nav icon absent).
