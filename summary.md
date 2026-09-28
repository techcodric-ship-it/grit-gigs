# Session Summary — Orders/Reviews/Boost/Sockets/Wallet

## Objective (DONE, awaiting deploy)
Ship the 5-item request for Grit&Gigs: (1) real-time likes/comments/posts/followers/following via sockets on profile, (2) in-app (non-browser) withdrawal-request popup, (3) professional ₹50 boost wording (no "search tags"/"feed" phrasing), (4) Orders shows bids received AND bids I made (community orders already cover as-buyer/as-seller via scope), (5) auto-prompted ratings & reviews after completion (client + freelancer + barter + community-order), shown on profiles.

User decisions: sockets for live updates; Orders = "both"; reviews = auto-prompt both parties.

## Important Details
- Repo: `C:\Users\amuth\Downloads\swiftexchange-full\swiftexchange-full\swiftexchange`; branch `main`; remote `https://github.com/TechCodric-Ship-It/grit-gigs.git`.
- Deploy recipe: `git push origin main` → wait ~45–50s → `plink -P 20141 root@162.19.81.122` (`-pw Cdr7Km2Xp9QwErT4`, `-hostkey SHA256:VDy0CTDH2nWgcZSkao7JGdq8qpxu/9mY4wVFvJR/ZXY`) → `cd /opt/gritgigs && git pull && git rev-parse --short HEAD` → `pm2 restart gritgigs --update-env`. plink/pscp in `$env:TEMP\opencode\`.
- Server `.env` can't be sourced (EMAIL_FROM ampersand); read via `DB=$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')`. Local `.env` = same live Neon DB (can read OTPs / clean test data). `registerLimiter` max 5 regs/15min/IP (`src/routes/auth.ts:32`).
- Admin auth = `x-admin-key` header with raw `ADMIN_API_KEY` (`fa84fc5e18d3b7c7c1d7e8f2904fa58c80bbfa5e66284b30fc2d988f1eb967d8`). All 366 users are role USER.
- **Realtime:** client `window.communityStatsHooks` (array of fns fired on `community:stats`) + `window.communityFeedDelegates` (`{onChanged(postId,o), onPost(postId,authorId,kind), onStats}`) registered from feed-app.js. Socket connects `io({ auth: { token } })`; server auto-joins room `user:<id>`. Events: `community:changed {postId, likeCount?, commentCount?}` (global), `community:stats {userId}` (room `user:<id>`), `community:post {postId, authorId, kind}` (global), `profile:updated {userId}` (room, pre-existing server-wide). Browser lib `/socket.io/socket.io.js`.
- **Review endpoints + body shape:** `/orders/:id/review` (buyer→seller) & `/orders/:id/client-review` (seller→buyer, `client-review.ts`) & `/projects/:id/review` (`project-review.ts`) & `/barter/matches/:id/review` (`barter-review.ts`) all take `{ rating, reviewText }`. Community: `POST /community/orders/:id/review` takes `{ rating, review }` (NEW, participant + COMPLETED + unique per order+reviewer).
- **Review flags served:** `/orders` list + `/orders/:id` → `review` + `clientReview`; `/projects/mine` + `/projects/my-bids` → `myReview` per project; `/community/orders` list + `:id` → `hasReviewed`; barter `/barter/matches` → `hasReviewed`.
- `orders.html` is minified (huge line ~13 + readable sections later); edit with exact-substring `edit` calls and ALWAYS `node --check` each inline script after edits; the `edit` tool mis-matched one fragment this session (grouping block landed in `loadLegacy` instead of `loadCommunity`) — re-check both functions after multi-line template edits. `quotescan.js` in `$env:TEMP\opencode` flags quotes.
- Asset version bumps: `feed-app.js?v=21`, `onboarding.js?v=2` across all 9 HTML pages; socket.io tag added to the 8 non-messages pages (messages.html already had it). A past bump had produced malformed `<script <script` tags — repaired by `$env:TEMP\opencode\fix.js` (run + verified, zero leftovers).
- `toast()` falls back to native `alert()` when no `<div id="toast">` exists — wallet.html now has one (that was the source of the user's "browser popup" complaint).
- Withdrawal success response: `{ success, message, data: { amount, feePct, commission, netAmount, status: "PENDING" } }` — wallet modal uses `data.netAmount`.

## Work State
### Completed
- **Server:** `community_order_reviews` table (`src/db/schema/community.ts`, unique orderId+reviewerId) + auto-migrate in `src/index.ts`; `POST /community/orders/:id/review`; `hasReviewed` on community orders list+detail; users.ts reviews aggregation now includes `type:'community'`; `/orders` + `/orders/:id` attach `clientReview`; `/projects/mine` + `/projects/my-bids` attach `myReview`; `project-review.ts` participation fix (accepted bidder or active squad member).
- **Server sockets:** socket helpers `socketApp/emitToRoom/emitGlobal`; emits on like, comment, post create, follow toggle. Boost copy professionalized (24h, keywords, "featured in marketplace results", "Your boost is live for 24 hours!" / "Boost extended by 24 hours").
- **feed-app.js:** boost copy everywhere (idle bar "Boost your gig — rank it higher in marketplace results for 24 hours"/"Boost ₹50", active "✦ Boost active", modal "Boost this gig/project", "✦ Boost for ₹50", keyword picker); spot flag "✦ SPOTLIGHT"→"✦ BOOSTED"; comment-count fix (`[data-open="id"] .c`); socket client (hooks/delegates, connect retries 60s/15s, focus reconnect). `node --check` OK.
- **profile.html:** reviews card (`#pReviewsCard`/`#pReviews`) with avg + up to 10 reviews (labels: service→'Gig order', client→'Client rating', project→'Project', barter→'Exchange', community→'Gig order'); `applyStats(d)` + `refreshProfileRealtime()`; tile() sets `data-post-id`; `feedDelegates.onChanged`/`.onPost` + `communityStatsHooks.push` for live refresh; `loadReviews()` at end of loadProfile; restored accidentally-deleted `var bio` line.
- **Copy:** explore.html/profile.html ribbon "✦ BOOSTED"; admin.html label "Boost Earnings" (data-k `spotlightEarnings` unchanged).
- **wallet.html:** added `<div class="toast" id="toast"></div>` + `#wdDoneModal` in-app success popup (Requested ₹ / To UPI / You receive net after fees / Status Pending) wired into withdraw success; Close + backdrop handlers. No native alert/prompt.
- **orders.html:** native `confirm()`/`prompt()` fully removed (15 confirm + 4 prompt call sites) → in-app `#cfmModal` (`askConfirm`) + `#noteModal` (`askNoteModal`); review buttons: community 'Rate this order' (COMPLETED && !hasReviewed → POST /community/orders/:id/review), services 'Rate seller' (buyer, !review) / 'Rate buyer' (seller, !clientReview), projects 'Leave review' (owner COMPLETED !myReview via projCard; bidder ACCEPTED+COMPLETED !myReview via bidCard), barter 'Leave review' (COMPLETED && !hasReviewed) → all feed `#rvwModal` (star picker + text, bodyKey review vs reviewText per endpoint). Grouping: Community grouped by kind (Gig orders/Project proposals/Barter offers), Exchanges grouped Offers received / Offers sent / Your exchanges. All inline scripts `node --check` OK.
- **Typecheck:** `npm run typecheck` clean.
- **Asset bump + socket.io scripts:** all 9 pages at `feed-app.js?v=21`; 8 pages got `/socket.io/socket.io.js`; malformed tags from an earlier bump repaired and verified.

### Active / Not yet done
- NOT yet git-committed, NOT deployed, NOT live-verified (local verification only: typecheck + node --check + markers).
- Optional polish not done: review buttons inside community/legacy detail modals (card-level only), barter "Your exchanges" vs pending grouping is card-level only.

### Verified live
- (not yet — deploy pending)

### Blocked
- (none)

## Next Move
1. `git status`/`diff` review → commit (group: server review/sockets + client orders/wallet/profile + asset bumps/fix) → `git push origin main`.
2. `plink` pull on `162.19.81.122` (`/opt/gritgigs`), verify `git rev-parse --short HEAD` matches, then `pm2 restart gritgigs --update-env`.
3. Verify served pages (HTTP 200, feed-app.js?v=21 + socket.io 200), then live E2E: socket like→profile counter updates; community order → complete → Rate this order → review shows on profile card; services l-review/l-review-client; wallet withdraw modal (in-app popup, no alert); boost modal copy; confirm modals on orders (no native confirm).

## Relevant Files
- `src/db/schema/community.ts`, `src/index.ts` (table + migration)
- `src/routes/community.ts` (review endpoint, hasReviewed, socket emits, boost copy)
- `src/routes/users.ts` (reviews aggregation incl 'community'; withdraw returns netAmount)
- `src/routes/orders.ts` (clientReview on list/detail), `src/routes/projects.ts` (myReview), `src/routes/project-review.ts` (fix), `src/routes/client-review.ts`, `src/routes/barter-review.ts`
- `public/assets/feed-app.js` (sockets, boost copy, comment-count fix)
- `public/profile.html`, `public/wallet.html`, `public/orders.html`
- 9 HTML pages (`feed-app.js?v=21` + socket.io tag), `$env:TEMP\opencode\fix.js` (repair, already run), `verify_all.js`, `quotescan.js`