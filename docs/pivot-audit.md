# Pivot audit — Jobs, Companion, Prep, Grit Circle

Recorded before any pivot code changes. Baseline for the phased build.

## 1. Baseline (Phase 1, 2026-10-17)

- Branch: `main`, HEAD: `92f3694`
- Pre-existing unstaged work (NOT mine, leave untouched):
  `src/db/schema/focus.ts`, `src/routes/focus.ts` (untracked),
  modified: `src/db/schema/index.ts`, `src/index.ts`, `src/lib/socket.ts`, `src/routes/index.ts`
- `npx tsc --noEmit`: clean
- `npx vitest run`: **519 tests / 15 files, all green** (duration ~3.3s)
- Test files:
  `auth, blog-integrity, buy-more-quota, community-quota, demo-data, invoice,
  nav-badge, post-edit, search-suggest, search-ui, spotlight-suggestions,
  spotlight-ui, spotlight, wallet-guards (lib); health (routes)`

### Protected hashes (must be byte-identical at every phase end)

| File | SHA256 |
|---|---|
| `public/logo.svg` | `CB11EA31E6AC111E4EAD19A7ABCDDF64EDBB34545906FF184A96F02708C9205A` |
| `public/logo-og.png` | `7AC05B7EA435D1EC9D3615699378BADDF970A63D26D7CDA41F4E53D7B4CC7CF1` |

### Barter baseline (must pass without edits)

There are no files named `*barter*.test.ts`. Barter is covered inside:

| File | SHA256 | barter refs |
|---|---|---|
| `src/lib/demo-data.test.ts` | `82B76788FA421F347309B6F8215E63D4B7EE7A1E32A1BC5B4FD18F3264C9A691` | 5 |
| `src/lib/wallet-guards.test.ts` | `5ECD00689751000835BB7B09033D6AD00C6F04CA326B0BF6EFDD8C27DB2EE8D0` | 2 |

Barter source files (logic untouched, links only): `src/db/schema/barter.ts`,
`src/routes/barter.ts`, `src/routes/barter-review.ts`, `public/barter.html`,
blog posts `blog-skill-barter*.html`, `blog-why-barter-swaps-stall.html`.

## 2. Real route map (placeholders resolved)

Router: `src/routes/index.ts` (mounts 33 routers, 404 catch-all at end).
App/static: `src/app.ts` — order matters:
1. `.html` → extensionless clean-URL redirect
2. `express.static(publicPath)`
3. extensionless → `.html` fallback (`sendFile`)
4. SPA fallback → `index.html`
⇒ **All pivot 301s must register before step 2 (before `express.static`).**

| Spec placeholder | Real file |
|---|---|
| jobs routes | `src/routes/jobs.ts` (GET `/jobs`, GET `/jobs/applied`, POST `/jobs/:id/apply`) |
| jobs tables | `src/db/schema/jobs.ts` — `jobs`, `job_applications`, enum `job_application_status` |
| projects routes | `src/routes/projects.ts` (+ `src/routes/project-review.ts`) |
| projects tables | `src/db/schema/projects.ts` — `projects` (escrow cols), `project_bids`, `project_deliveries` |
| services (gigs) routes | `src/routes/services.ts` |
| spotlight | `src/lib/spotlight.ts` + tests `spotlight, spotlight-ui, spotlight-suggestions` ; routes inside `src/routes/community.ts` (~693–1038 spotlights, ~844–975 boost purchase wallet debits); page `public/spotlight-boost.html` |
| community/feed | `src/routes/community.ts` (create-post ~1382, order flow ~1921–1975) |
| community tables | `src/db/schema/community.ts` — `post_kind` enum, `community_order_kind` ["GIG","PROJECT","BARTER"], `community_orders`, quotas, boosts |
| explore | `public/explore.html`, `public/assets/feed-app.js`, `public/assets/feed.css` |
| orders (service orders) | `src/routes/orders.ts`, `src/db/schema/orders.ts` (no project refs) |
| milestones/disputes/invites/reports/saved | `src/routes/{milestones,disputes,invites,reports,saved}.ts`, `src/db/schema/extras.ts` (PROJECT enums) |
| admin | `src/routes/admin.ts` + `public/admin.html` |
| wallet/credits/subs/invoices | `src/lib/{wallet-guards,subscriptions,invoice,email}.ts`, `src/routes/{credits,payments,invoice,subscriptions}.ts`, `src/db/schema/wallet.ts` |
| static pages | `public/*.html` (73 pages), `public/sitemap.xml`, `public/js/main.js`, `public/assets/*` |
| legacy migrations | `src/db/migrate-project-type.ts`, `src/db/migrate-project-escrow.ts` (historical, keep) |

Jobs git history note: `8082fce feat(jobs): safe external apply-link endpoint +
public jobs board` was reverted by `ad428bb` at HEAD. Reusable reference only.

## 3. Pattern audit (word-boundary matches)

Totals (src+public, ts/html/js/css/xml): `spotlight` 173 hits/14 files;
`\bprojects?\b` 1536/126; `\bgigs?\b` 1738/121.

### Spotlight (delete targets)

| File | Hits |
|---|---|
| `src/lib/spotlight.test.ts` | 42 |
| `src/routes/community.ts` | 40 |
| `public/assets/feed-app.js` | 29 |
| `src/lib/spotlight.ts` | 16 |
| `src/lib/spotlight-ui.test.ts` | 12 |
| `public/profile.html` | 9 |
| `public/feed.html` | 8 |
| `public/explore.html` | 5 |
| `public/spotlight-boost.html` | 4 |
| `src/routes/admin.ts` | 3 |
| `public/assets/feed.css` | 2 |
| `src/lib/search-ui.test.ts`, `src/lib/spotlight-suggestions.test.ts`, `public/admin.html` | 1 each |

### Top project matches (code)

`src/routes/projects.ts` 187, `src/routes/community.ts` 29,
`src/routes/milestones.ts` 27, `src/index.ts` 23, `src/routes/admin.ts` 19,
`src/routes/project-review.ts` 17, `src/db/schema/extras.ts` 12,
`src/routes/disputes.ts` 12, `src/lib/wallet-guards.ts` 12,
`src/demo/dataset.ts` 10, `src/routes/saved.ts` 10, `src/lib/subscriptions.ts` 8,
`src/lib/email.ts` 8, `src/routes/ai-support.ts` 8, `src/routes/squads.ts` 7.
High-HTML: `design-system.html` 40, blog posts (client-trust 35,
post-project-gets-replies 33, my-circle-squad 28, refer-and-earn 20 …).

### Top gig matches (code)

`src/lib/email.ts` 23, `src/routes/community.ts` 25,
`public/assets/feed-app.js` 25, `src/lib/spotlight-ui.test.ts` 15,
`src/routes/admin.ts` 9, `src/lib/wallet-guards.test.ts` 8,
`src/routes/users.ts` 7, `src/routes/services.ts` 7,
`src/lib/community-quota.ts` 7, `src/index.ts` 7, `src/routes/auth.ts` 6.
High-HTML: `faq.html` 49, `feed.html` 47, `blog-client-trust-india.html` 46,
`index.html` 25, hire-* landing pages ~23 each.

Note: blog article *text* stays published (re-link CTAs only). Full per-file
lists regenerate with: `Select-String -Pattern '\bprojects?\b' src,public`.

## 4. Money-record dependency check

Never delete money rows; convert references to nullable legacy cols.

1. **Escrow lives on `projects` itself** (`src/db/schema/projects.ts:55-56`):
   `escrow_amount`, `escrow_held_at`. `src/lib/wallet-guards.ts`:
   `isEscrowHeld`, `escrowRefundAmount`, `resolveGigAmount` (GIG price),
   community gig-order afford check (`src/routes/community.ts:1956-1964`).
   Escrow hold/release found in `src/routes/projects.ts:626,855`.
2. **`community_orders`** (`kind` in GIG/PROJECT/BARTER) is a live money path
   (wallet debits at `community.ts:844+` are Spotlight boosts — removed with
   Spotlight; order debits ~1956 remain for BARTER).
3. **Enums carrying PROJECT/GIG** (`src/db/schema/extras.ts`):
   `saved_item_type ["SERVICE","PROJECT","BARTER"]`,
   `dispute_target ["ORDER","PROJECT","BARTER"]`,
   `invite_target_type ["PROJECT","SERVICE","BARTER"]`,
   `report_target_type`; `community_order_kind`.
   Additive enum surgery only (Postgres: add new values / keep old rows readable).
4. **Plans quotas** (`src/db/schema/plans.ts:25-35`): monthly gig/project
   creation counters + weekly project-bid credit bucket — reused for job-post
   quotas, do not drop columns.
5. **`orders`** (`src/db/schema/orders.ts`): service orders, no project refs —
   verify during Phase 3 whether "services/gigs" removal strands them.
6. **Wallet transactions** (`src/db/schema/wallet.ts`): no direct project/gig
   FK; `gateway_order_id` is Razorpay's, unrelated.

Pre-migration guard: abort if any project/community order escrow is in a
non-final state (report rows).

## 5. Sitemap snapshot (Phase 1)

`public/sitemap.xml`: 108 lines; direct-entry URLs to remove/redirect in Phase 3:
`/projects` (line 60), `/freelance` (line 59 — decide: keep as jobs landing?),
`/explore` absent; blog URLs with `project` in path:
`/blog-post-project-gets-replies` (historical blog text allowed to stay in body,
URL itself keep — redirects only for feature pages).

## 6. Existing infrastructure reusable by the pivot

- Auth/CSRF pattern: `src/lib/auth.ts` + route middleware usage
- Wallet/credits/subs/invoices: see §2; `proposal_credits_remaining` in
  `src/index.ts` (~line 247 per earlier recon — re-grep when touched)
- Messaging: `src/routes/messages.ts` (Companion/apply messaging must reuse)
- Notifications: `src/routes/notifications...` wait — `public/notifications.html`
  exists; backend notifications live in users/community routes (re-grep Phase 4)
- Email: `src/lib/email.ts` (contains gig/project templates to re-point)
- SEO/blog integrity: `src/lib/blog-integrity.test.ts` (binding rules:
  1 h1, canonical, JSON-LD, hrefs resolve, sitemap entry)
- Static design files: `public/css/main.css` (token home), `public/design-system.html`,
  `public/design-preview.html` (existing, to be superseded by `/styleguide`)

## 7. Pending re-greps (deferred to their phase)

- Phase 3: full `grep -rniE "spotlight|project|gig|kind=PROJECT|post a project|browse projects"`
  sweep incl. emails, seeds, docs; nav/footer inventory across all 73 HTML pages
- Phase 4: notification backend location; skills table existence (none yet)
- Phase 10: LLM provider/env config availability in repo (none found so far)

## 8. Redirect map snapshot (seed — implemented in Phase 3)

Current state captured before changes. Server-side 301s must register before
`express.static` in `src/app.ts`. Remove the JS stub pages when the 301 lands.

| URL | Current behavior (2026-10-17) | Target |
|---|---|---|
| `/projects` | JS stub → `/explore?kind=PROJECT` | `/jobs` |
| `/freelance` | JS stub → `/explore?kind=GIG` | `/jobs` |
| `/explore?kind=PROJECT` | Explore page (client filter) | `/jobs` |
| `/explore?kind=GIG` | Explore page (client filter) | `/jobs` |
| `/explore?kind=BARTER` | Explore page (client filter) | `/barter` (barter survive) |
| `/explore` (no kind) | Explore page, auth-gated client | `/jobs` |
| `/spotlight-boost` | Boost purchase page (wallet debit) | `/circle` |
| `/feed` | Logged-in feed (gigs/projects/barter) | `/circle` |
| `/dashboard` | JS stub → client dashboard | reworked in place (not removed) |
| `src/routes/projects.ts` paths | live API | `/api/jobs*` equivalents or 410 |
| `src/routes/services.ts` paths | live API (gig orders — verify Phase 3) | decide with money guard |

Blog URLs containing removed words (e.g. `/blog-post-project-gets-replies`)
keep their URLs; only in-page CTAs/links re-point. `freelance.html` also linked
from sitemap line 59 — sitemap rewritten in Phase 3/13.

Re-verify every row against implementation at Phase 3 and Phase 14.
