import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, count, countDistinct, sql, inArray, or, ilike, gt, gte, ne, not, notInArray, type SQL } from "drizzle-orm";
import { db, usersTable, notificationsTable, communityPostsTable, communityLikesTable, communityCommentsTable, communityFollowsTable, conversationsTable, messagesTable, communityOrdersTable, communityOrderDeliveriesTable, communityOrderReviewsTable, transactionsTable, freelanceWalletsTable, searchLogsTable, projectsTable, projectBidsTable, barterMatchesTable, barterRequestsTable } from "../db";
import { authenticate, optionalAuth } from "../middlewares/authenticate";
import { logger } from "../lib/logger";
import { uploadToSupabase } from "../lib/storage";
import { likeTerm, rankTerms } from "../lib/search-suggest";
import { PROJECT_ROOT } from "../lib/root";
import { getCommunityQuota, consumeProposal, grantQuotaBundle, QUOTA_PLANS, FREE_GIG_POSTS, FREE_PROPOSALS, type QuotaPlanId } from "../lib/community-quota";
import { resolveGigAmount, canAfford } from "../lib/wallet-guards";
import { areConnected } from "../lib/connections";
import { PLATFORM_COMMISSION_PCT } from "../lib/subscriptions";
import multer from "multer";
import path from "path";
import fs from "fs";

const router: IRouter = Router();

// ——— realtime helpers (socket.io) ———
const socketApp = (req: Request): any => {
  try {
    return (req.app as any)?.get("io") ?? null;
  } catch {
    return null;
  }
};
function emitToRoom(req: Request, room: string, event: string, payload: Record<string, unknown>): void {
  const io = socketApp(req);
  if (!io) return;
  try {
    io.to(room).emit(event, payload);
  } catch {
    /* noop */
  }
}
function emitGlobal(req: Request, event: string, payload: Record<string, unknown>): void {
  const io = socketApp(req);
  if (!io) return;
  try {
    io.emit(event, payload);
  } catch {
    /* noop */
  }
}

// ——— media uploads (images + short video reels) ———
const communityUploadsDir = path.join(PROJECT_ROOT, "uploads", "community");
if (!fs.existsSync(communityUploadsDir)) fs.mkdirSync(communityUploadsDir, { recursive: true });

const mediaStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, communityUploadsDir),
  filename: (_req, file, cb) => {
    cb(null, Date.now() + "-" + Math.random().toString(36).slice(2) + path.extname(file.originalname));
  },
});
const mediaUpload = multer({
  storage: mediaStorage,
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) || /^video\/(mp4|webm|quicktime)$/.test(file.mimetype);
    cb(null, !!ok);
  },
});

router.post("/community/upload", authenticate, mediaUpload.array("files", 10), async (req, res): Promise<void> => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) {
    res.status(400).json({ success: false, message: "No files uploaded" });
    return;
  }
  const results: { url: string; name: string; type: "image" | "video" }[] = [];
  for (const f of files) {
    const isVideo = /^video\//.test(f.mimetype);
    const url = await uploadToSupabase(fs.readFileSync(f.path), f.originalname, "community");
    if (url) {
      results.push({ url, name: f.originalname, type: isVideo ? "video" : "image" });
    } else {
      results.push({ url: `/uploads/community/${f.filename}`, name: f.originalname, type: isVideo ? "video" : "image" });
    }
  }
  res.status(201).json({ success: true, data: { files: results } });
});

// Deliverables are broader than feed media: sellers hand over source files,
// documents and archives, so they get their own endpoint and keep the post
// media route restricted to images/video.
const DELIVERABLE_MIME = /^(image\/(jpeg|png|webp|gif|svg\+xml|avif|heic|heif)|video\/(mp4|webm|quicktime|mov|x-m4v|avi)|application\/(pdf|msword|vnd\.openxmlformats-officedocument\.(wordprocessingml|presentationml|spreadsheetml)|zip|x-zip-compressed|x-rar-compressed|vnd\.rar|json|octet-stream)|text\/(plain|csv|markdown)|image\/svg)/i;
const deliverableUpload = multer({
  storage: mediaStorage,
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, DELIVERABLE_MIME.test(file.mimetype) || !file.mimetype);
  },
});

router.post("/community/upload-deliverable", authenticate, deliverableUpload.array("files", 10), async (req, res): Promise<void> => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) {
    res.status(400).json({ success: false, message: "No files uploaded" });
    return;
  }
  const results: { url: string; name: string; type: string }[] = [];
  for (const f of files) {
    const url = await uploadToSupabase(fs.readFileSync(f.path), f.originalname, "community");
    results.push({ url: url || `/uploads/community/${f.filename}`, name: f.originalname, type: f.mimetype || "application/octet-stream" });
  }
  res.status(201).json({ success: true, data: { files: results } });
});

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
function razorpayConfigured(): boolean {
  return !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
}

// ── GET /community/quota — current usage + available bundles ──
router.get("/community/quota", authenticate, async (req, res): Promise<void> => {
  const usage = await getCommunityQuota(req.user!.id);
  res.json({
    success: true,
    data: {
      // gigPosts stays in the payload for older cached clients that read it;
      // the gigs5 bundle itself is no longer offered.
      gigPosts: { used: usage.gigPostsUsed, free: usage.gigPostsFree, bonus: usage.gigPostsBonus, limit: FREE_GIG_POSTS },
      proposals: { used: usage.proposalsUsed, free: usage.proposalsFree, bonus: usage.proposalsBonus, limit: FREE_PROPOSALS },
      resetsInMs: usage.resetsInMs,
      plans: [
        { id: QUOTA_PLANS.props5.id, label: QUOTA_PLANS.props5.label, priceInr: QUOTA_PLANS.props5.priceInr },
      ],
    },
  });
});

// ── POST /community/quota/order — create a Razorpay order for a bundle ──
router.post("/community/quota/order", authenticate, async (req, res): Promise<void> => {
  const planId = String(req.body?.planId ?? "");
  if (!(planId in QUOTA_PLANS)) {
    res.status(400).json({ success: false, message: "Unknown quota bundle" });
    return;
  }
  if (planId === "gigs5") {
    res.status(400).json({ success: false, message: "Gig post bundles are no longer sold." });
    return;
  }
  if (!razorpayConfigured()) {
    res.status(503).json({ success: false, message: "Payment gateway not configured" });
    return;
  }
  const plan = QUOTA_PLANS[planId as QuotaPlanId];
  const receipt = `qt_${Date.now()}_${req.user!.id.substring(0, 4)}`;
  try {
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    const rzResp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: plan.priceInr * 100, currency: "INR", receipt }),
    });
    if (!rzResp.ok) {
      res.status(502).json({ success: false, message: "Razorpay error" });
      return;
    }
    const order = (await rzResp.json()) as { id: string };
    await db.insert(transactionsTable).values({
      userId: req.user!.id,
      type: "QUOTA_BUNDLE",
      amount: plan.priceInr,
      status: "PENDING",
      paymentMethod: "razorpay",
      gatewayOrderId: order.id,
      gatewayTxnId: order.id,
      description: `Pending ${plan.label} (₹${plan.priceInr})`,
    });
    res.json({ success: true, data: { order, key: RAZORPAY_KEY_ID, bundleId: plan.id } });
  } catch {
    res.status(502).json({ success: false, message: "Failed to create payment order" });
  }
});

// ── POST /community/quota/verify — verify Razorpay payment, credit the bundle ──
router.post("/community/quota/verify", authenticate, async (req, res): Promise<void> => {
  const { razorpayOrderId, razorpayPaymentId, bundleId } = req.body;
  if (!razorpayConfigured()) {
    res.status(503).json({ success: false, message: "Payment gateway not configured" });
    return;
  }
  if (!bundleId || !(bundleId in QUOTA_PLANS)) {
    res.status(400).json({ success: false, message: "Unknown quota bundle" });
    return;
  }
  if (!razorpayOrderId || !razorpayPaymentId) {
    res.status(400).json({ success: false, message: "Missing payment details" });
    return;
  }
  try {
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    const pmtResp = await fetch(`https://api.razorpay.com/v1/payments/${razorpayPaymentId}`, {
      headers: { "Authorization": `Basic ${auth}` },
    });
    if (!pmtResp.ok) {
      res.status(502).json({ success: false, message: "Unable to verify payment with Razorpay" });
      return;
    }
    const payment = (await pmtResp.json()) as { order_id?: string; status?: string };
    if (payment.order_id !== razorpayOrderId || (payment.status !== "captured" && payment.status !== "authorized")) {
      res.status(400).json({ success: false, message: "Payment verification failed" });
      return;
    }
    const [txn] = await db
      .select()
      .from(transactionsTable)
      .where(or(eq(transactionsTable.gatewayOrderId, razorpayOrderId), eq(transactionsTable.gatewayTxnId, razorpayOrderId)))
      .limit(1);
    if (!txn) {
      res.status(404).json({ success: false, message: "Order not found" });
      return;
    }
    if (txn.userId !== req.user!.id) {
      res.status(403).json({ success: false, message: "Payment does not belong to you" });
      return;
    }
    if (txn.type !== "QUOTA_BUNDLE") {
      res.status(400).json({ success: false, message: "Order is not a quota bundle" });
      return;
    }
    if (txn.status !== "PENDING") {
      res.json({ success: true, data: { already: true } });
      return;
    }
    const plan = QUOTA_PLANS[bundleId as QuotaPlanId];
    // Claim the order first so a concurrent/replayed callback cannot grant twice.
    const claim = await db
      .update(transactionsTable)
      .set({
        status: "COMPLETED",
        gatewayTxnId: razorpayPaymentId || "",
        description: `${plan.label} (₹${plan.priceInr})`,
        updatedAt: new Date(),
      })
      .where(and(eq(transactionsTable.id, txn.id), eq(transactionsTable.status, "PENDING")))
      .returning({ id: transactionsTable.id });
    if (claim.length === 0) {
      res.json({ success: true, data: { already: true } });
      return;
    }
    await grantQuotaBundle(req.user!.id, plan.gigBonus, plan.propBonus);
    res.json({ success: true, data: { bundleId: plan.id } });
  } catch {
    res.status(502).json({ success: false, message: "Failed to verify payment" });
  }
});

// â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Gig and project posts are retired platform-wide. The rows stay in the DB
// (orders, boosts and money records reference them) but they are hidden from
// every read surface and no longer accepted on create.
const RETIRED_KINDS = ["GIG", "PROJECT"] as const;
function visibleKindCond(): SQL {
  return notInArray(communityPostsTable.kind, RETIRED_KINDS as unknown as (typeof communityPostsTable.$inferSelect.kind)[]);
}

function kindWhitelist(kind: string | undefined, fallback: string): string {
  const allowed = ["POST", "BARTER", "WIN", "TIPS", "REEL"];
  if (kind && allowed.includes(kind)) return kind;
  return fallback;
}

function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const v = String(t).trim().replace(/^#/, "").slice(0, 30);
    if (!v) continue;
    // De-duplicate before counting against the 5 tag budget. The keyword editor
    // de-dupes client side, but that is bypassable, and a repeated tag would
    // otherwise silently eat one of the five slots.
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.slice(0, 5);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function avatarUrl(user: { profilePhoto?: string | null; email?: string | null }): string {
  if (user.profilePhoto) return user.profilePhoto;
  const email = user.email || "grit@gritandgigs.in";
  return `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(email)}&backgroundColor=ff5c1a,c8f522,0e0e0c&bold=true`;
}

async function notify(userId: string, type: string, title: string, message: string, linkUrl: string | null = null) {
  if (!userId) return;
  try {
    await db.insert(notificationsTable).values({ userId, type, title, message, linkUrl });
  } catch (err) {
    logger.warn({ err }, "Failed to insert community notification");
  }
}

interface PostRowShape {
  post: typeof communityPostsTable.$inferSelect;
  author: {
    id: string;
    firstName: string;
    lastName: string;
    profilePhoto: string | null;
    email: string | null;
    city: string | null;
    reputationScore: number;
  };
  likedByMe: boolean;
  followingAuthor: boolean;
  comments: {
    id: string;
    content: string;
    createdAt: Date;
    author: { id: string; firstName: string; lastName: string; profilePhoto: string | null };
  }[];
  // State of the work behind a BARTER / PROJECT post, so the UI can warn a
  // freelancer before they bid on something already finished or underway.
  // null for every other kind.
  workStatus: "OPEN" | "PENDING" | "IN_PROGRESS" | "REVISION" | "DELIVERED" | "COMPLETED" | null;
}

async function loadCommentCounts(postIds: string[]): Promise<Record<string, { count: number; rows: (typeof communityCommentsTable.$inferSelect)[] }>> {
  if (!postIds.length) return {};
  const comments = await db
    .select()
    .from(communityCommentsTable)
    .where(inArray(communityCommentsTable.postId, postIds))
    .orderBy(desc(communityCommentsTable.createdAt));
  const map: Record<string, { count: number; rows: (typeof communityCommentsTable.$inferSelect)[] }> = {};
  for (const c of comments) {
    if (!map[c.postId]) map[c.postId] = { count: 0, rows: [] };
    map[c.postId].count += 1;
    map[c.postId].rows.push(c);
  }
  return map;
}

async function loadLikedSet(userId: string | undefined, postIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!userId || !postIds.length) return out;
  const likes = await db
    .select({ postId: communityLikesTable.postId })
    .from(communityLikesTable)
    .where(and(eq(communityLikesTable.userId, userId), inArray(communityLikesTable.postId, postIds)));
  for (const l of likes) out.add(l.postId);
  return out;
}

async function loadFollowingSet(userId: string | undefined, authorIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!userId || !authorIds.length) return out;
  const follows = await db
    .select({ followingId: communityFollowsTable.followingId })
    .from(communityFollowsTable)
    .where(and(eq(communityFollowsTable.followerId, userId), inArray(communityFollowsTable.followingId, authorIds)));
  for (const f of follows) out.add(f.followingId);
  return out;
}

async function loadCommentAuthors(commentRows: (typeof communityCommentsTable.$inferSelect)[], postIds: string[]): Promise<Record<string, { id: string; firstName: string; lastName: string; profilePhoto: string | null }[]>> {
  const map: Record<string, { id: string; firstName: string; lastName: string; profilePhoto: string | null }[]> = {};
  for (const postId of postIds) map[postId] = [];
  if (!commentRows.length) return map;
  const userIds = [...new Set(commentRows.map((c) => c.userId))];
  let authors: { id: string; firstName: string; lastName: string; profilePhoto: string | null }[] = [];
  if (userIds.length) {
    authors = await db
      .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto })
      .from(usersTable)
      .where(inArray(usersTable.id, userIds));
  }
  const byId = new Map(authors.map((a) => [a.id, a]));
  for (const c of commentRows) {
    const a = byId.get(c.userId);
    if (a) map[c.postId]?.push({ ...a, id: c.userId });
  }
  return map;
}

// ── work status for BARTER / PROJECT posts ─────────────────────────────────
// A project or barter post is a standing ask for work. Freelancers were bidding
// on things that were already finished or already underway, so each post now
// reports the state of the work behind it and the client shows it on the post.
//
// States come from community_orders for that post: the most recently updated
// live order wins, so a post that is live again (a new proposal) reads as open
// even if an earlier order on it completed, and a post with work underway never
// looks biddable. A post with no live order is still open for offers.
type WorkStatus = "OPEN" | "PENDING" | "IN_PROGRESS" | "REVISION" | "DELIVERED" | "COMPLETED";
const WORK_LIVE: Record<string, WorkStatus> = {
  PENDING: "PENDING",
  IN_PROGRESS: "IN_PROGRESS",
  REVISION: "REVISION",
  DELIVERED: "DELIVERED",
  COMPLETED: "COMPLETED",
};

async function loadWorkStatus(
  posts: typeof communityPostsTable.$inferSelect[],
): Promise<Map<string, WorkStatus>> {
  const out = new Map<string, WorkStatus>();
  const ids = posts.filter((p) => p.kind === "BARTER" || p.kind === "PROJECT").map((p) => p.id);
  // No orders at all is the normal state for a fresh post: it is open for offers.
  for (const id of ids) out.set(id, "OPEN");
  if (!ids.length) return out;

  let rows: { postId: string; status: string; updatedAt: Date }[] = [];
  try {
    rows = await db
      .select({
        postId: communityOrdersTable.postId,
        status: communityOrdersTable.status,
        updatedAt: communityOrdersTable.updatedAt,
      })
      .from(communityOrdersTable)
      .where(inArray(communityOrdersTable.postId, ids));
  } catch (err) {
    // Never let a status lookup break the feed. These are the normal
    // "no orders yet" values, not a guess: nothing is underway.
    logger.warn({ err }, "work status lookup failed; posts render as open");
    return out;
  }

  const latest = new Map<string, number>();
  for (const r of rows) {
    // CANCELLED means nothing is happening, so it never counts towards the state.
    const live = WORK_LIVE[r.status];
    if (!live) continue;
    const at = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
    if (at >= (latest.get(r.postId) ?? -1)) {
      latest.set(r.postId, at);
      out.set(r.postId, live);
    }
  }
  return out;
}

async function renderPosts(rawPosts: typeof communityPostsTable.$inferSelect[], currentUserId: string | undefined, limitComments = 2): Promise<PostRowShape[]> {
  const postIds = rawPosts.map((p) => p.id);
  const authorIds = [...new Set(rawPosts.map((p) => p.userId))];

  const workStatusByPost = await loadWorkStatus(rawPosts);

  let authors: { id: string; firstName: string; lastName: string; profilePhoto: string | null; email: string | null; city: string | null; reputationScore: number }[] = [];
  if (authorIds.length) {
    authors = await db
      .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, email: usersTable.email, city: usersTable.city, reputationScore: usersTable.reputationScore })
      .from(usersTable)
      .where(inArray(usersTable.id, authorIds));
  }
  const authorById = new Map(authors.map((a) => [a.id, a]));

  const commentData = await loadCommentCounts(postIds);
  const commentAuthorMap = await loadCommentAuthors(
    postIds.flatMap((id) => commentData[id]?.rows ?? []),
    postIds,
  );
  const likedSet = await loadLikedSet(currentUserId, postIds);
  const followingSet = await loadFollowingSet(currentUserId, authorIds);

  const rows: PostRowShape[] = rawPosts.map((post) => {
    const author = authorById.get(post.userId) ?? {
      id: post.userId,
      firstName: "Hustler",
      lastName: "",
      profilePhoto: null,
      email: null,
      city: null,
      reputationScore: 0,
    };
    const allComments = commentData[post.id]?.rows ?? [];
    const authorsForPost = commentAuthorMap[post.id] ?? [];
    const comments = allComments.slice(0, limitComments).map((c, i) => {
      const a = authorsForPost[i] ?? { id: c.userId, firstName: "Hustler", lastName: "", profilePhoto: null };
      return { id: c.id, content: c.content, createdAt: c.createdAt, author: a };
    });
    return {
      post,
      author,
      likedByMe: likedSet.has(post.id),
      followingAuthor: followingSet.has(post.userId),
      comments,
      workStatus: workStatusByPost.get(post.id) ?? null,
    };
  });
  return rows;
}

/**
 * Turns one raw search-log term into clean suggestion chips.
 *
 * Search logs are free text typed by humans, so a single row can be a whole
 * phrase ("operation, communication, strategy"), contain typos ("profreading"),
 * or repeat a word already offered on its own. Surfacing those raw inside a
 * payment dialog makes the page look careless and erodes trust, so terms are
 * split on punctuation and de-duplicated across the whole list.
 */
// Short but real skill acronyms. A generic length floor would drop these and
// they are exactly the terms people search for.

// Spotlight boosting was retired. Cached clients still call the old
// spotlight/boost endpoints, so answer with a clear 410 instead of a silent 404.
const spotlightRetired = (_req: Request, res: Response): void => {
  res.status(410).json({
    success: false,
    message: "Spotlight boosting has been retired. Barter posts now reach people through search and the feed.",
  });
};
router.all("/community/spotlight", spotlightRetired);
router.all("/community/spotlight/*splat", spotlightRetired);
router.all("/community/posts/:id/spotlight", spotlightRetired);
router.all("/community/posts/:id/spotlight/*splat", spotlightRetired);
router.all("/community/boosts/:boostId/click", spotlightRetired);

/**
 * GET /community/search/suggest?q=
 *
 * Typeahead behind the nav search. Partial input has to work: typing "web" or
 * "web de" must surface "web development", so matching is substring on both
 * sides rather than a prefix test.
 *
 * Deliberately never writes to search_logs. /community/feed logs every query,
 * and a typeahead fires one request per few keystrokes, so reusing the feed
 * endpoint would record "w", "we", "web", "web d" as genuine searches and
 * quietly inflate the search-volume numbers the feed shows for a query.
 */
router.get("/community/search/suggest", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const q = String(req.query.q || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  // One character matches nearly everything and teaches the user nothing.
  if (q.length < 2) {
    res.json({ success: true, data: { q, terms: [], posts: [] } });
    return;
  }

  try {
    // Suggested terms come from tags people have actually used, so a suggestion
    // always leads somewhere. unnest flattens the text[] column.
    const tagRows = await db.execute(sql`
      SELECT t AS term, COUNT(*)::int AS n
      FROM community_posts, unnest(tags) AS t
      WHERE t ILIKE ${likeTerm(q)} ESCAPE '\\' AND community_posts.kind NOT IN ('GIG', 'PROJECT')
      GROUP BY t
      ORDER BY n DESC
      LIMIT 40
    `);
    const rawTags = (tagRows as unknown as { rows?: { term: string; n: number }[] }).rows ?? [];
    const terms = rankTerms(
      rawTags
        .map((r) => ({ term: String(r.term).trim(), n: Number(r.n) }))
        .filter((r) => r.term.length >= 2 && r.term.length <= 40),
      q,
      6,
    );

    // A couple of matching gigs, so the dropdown is useful before the user
    // commits to a full search.
    const posts = await db
      .select({
        id: communityPostsTable.id,
        kind: communityPostsTable.kind,
        content: communityPostsTable.content,
        userId: communityPostsTable.userId,
      })
      .from(communityPostsTable)
      .where(
        and(
          or(
            ilike(communityPostsTable.content, likeTerm(q)),
            ilike(sql`${communityPostsTable.tags}::text`, likeTerm(q)),
            ilike(communityPostsTable.location, likeTerm(q)),
          ) as SQL,
          visibleKindCond(),
        ),
      )
      .orderBy(desc(communityPostsTable.createdAt))
      .limit(4);

    res.json({
      success: true,
      data: {
        q,
        terms,
        posts: posts.map((p) => ({
          id: p.id,
          kind: p.kind,
          content: String(p.content || "").replace(/\s+/g, " ").trim().slice(0, 90),
          userId: p.userId,
        })),
      },
    });
  } catch {
    // A failed suggestion must never break typing in the search box.
    res.json({ success: true, data: { q, terms: [], posts: [] } });
  }
});

// ── GET /community/feed?kind=&filter=&cursor=&q= ──
router.get("/community/feed", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const meId = req.user?.id;
  const kind = kindWhitelist(String(req.query.kind || ""), "");
  const filter = String(req.query.filter || "for-you"); // for-you | following | local | top
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 20));
  const authorId = String(req.query.authorId || "").trim();
  const q = String(req.query.q || "").trim();

  if (q) {
    db.insert(searchLogsTable)
      .values({ userId: meId ?? null, term: q.toLowerCase().slice(0, 80) })
      .then(
        () => {},
        () => {},
      );
  }

  // Retired gig/project posts are excluded from every feed query.
  let where: SQL | undefined = visibleKindCond();
  if (kind) where = and(where, eq(communityPostsTable.kind, kind as typeof communityPostsTable.$inferSelect.kind)) as SQL;
  if (authorId) {
    const authorCond: SQL = eq(communityPostsTable.userId, authorId);
    where = where ? and(where, authorCond) : authorCond;
  }
  if (q) {
    const searchCond: SQL = or(
      ilike(communityPostsTable.content, likeTerm(q)),
      ilike(sql`${communityPostsTable.tags}::text`, likeTerm(q)),
      ilike(communityPostsTable.location, likeTerm(q)),
    ) as SQL;
    where = where ? and(where, searchCond) : searchCond;
  }

  let basePosts: (typeof communityPostsTable.$inferSelect)[];

  if (filter === "following" && meId) {
    const follows = await db
      .select({ followingId: communityFollowsTable.followingId })
      .from(communityFollowsTable)
      .where(eq(communityFollowsTable.followerId, meId));
    const ids = follows.map((f) => f.followingId);
    const followWhere: SQL | undefined = ids.length
      ? inArray(communityPostsTable.userId, ids)
      : sql`FALSE`;
    basePosts = await db
      .select()
      .from(communityPostsTable)
      .where(where ? and(where, followWhere) : followWhere)
      .orderBy(desc(communityPostsTable.createdAt))
      .limit(limit);
  } else if (filter === "local" && meId) {
    const [me] = await db
      .select({ city: usersTable.city })
      .from(usersTable)
      .where(eq(usersTable.id, meId))
      .limit(1);
    const city = me?.city || null;
    const localWhere: SQL = city
      ? sql`(${communityPostsTable.userId} = ANY((SELECT ARRAY_AGG(users.id) FROM users WHERE users.city = ${city})))`
      : sql`TRUE`;
    basePosts = await db
      .select()
      .from(communityPostsTable)
      .where(where ? and(where, localWhere) : localWhere)
      .orderBy(desc(communityPostsTable.createdAt))
      .limit(limit);
  } else if (filter === "top") {
    basePosts = await db
      .select()
      .from(communityPostsTable)
      .where(where)
      .orderBy(desc(communityPostsTable.likeCount), desc(communityPostsTable.createdAt))
      .limit(limit);
  } else {
    basePosts = await db
      .select()
      .from(communityPostsTable)
      .where(where)
      .orderBy(desc(communityPostsTable.createdAt))
      .limit(limit);
  }

  const rows = await renderPosts(basePosts, meId);
  res.status(200).json({ success: true, data: { posts: rows } });
});

// ── GET /community/activity ────────────────────────────────────────────────
// Real barter + project WORK, as opposed to posts asking for it. Explore used to
// list only posts, so a completed barter or a finished project was invisible.
// Barter and project activity is returned in its own buckets — never folded
// into the Gigs bucket, because a barter is not a gig and a project is not a gig.
//   ?kind=BARTER|PROJECT|ALL   &limit=..   &authorId=..
// Completed, in-progress and open work is included; only states that represent
// nothing happening (cancelled / rejected / declined) are left out.
router.get("/community/activity", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const wantKind = String(req.query.kind || "ALL").toUpperCase();
  const limit = Math.min(48, Math.max(1, Number(req.query.limit) || 24));
  const authorId = req.query.authorId ? String(req.query.authorId) : null;
  const activity: any[] = [];

  const people = async (ids: string[]) => {
    const out: Record<string, any> = {};
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return out;
    const rows = await db
      .select({
        id: usersTable.id,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        profilePhoto: usersTable.profilePhoto,
      })
      .from(usersTable)
      .where(inArray(usersTable.id, uniq));
    for (const u of rows) out[u.id] = { id: u.id, firstName: u.firstName, lastName: u.lastName ?? "", profilePhoto: u.profilePhoto ?? null };
    return out;
  };

  if (wantKind === "BARTER" || wantKind === "ALL") {
    const rows = await db
      .select({
        id: barterMatchesTable.id,
        status: barterMatchesTable.status,
        user1Id: barterMatchesTable.user1Id,
        user2Id: barterMatchesTable.user2Id,
        createdAt: barterMatchesTable.createdAt,
        updatedAt: barterMatchesTable.updatedAt,
        req1: barterRequestsTable,
      })
      .from(barterMatchesTable)
      .innerJoin(barterRequestsTable, eq(barterMatchesTable.request1Id, barterRequestsTable.id))
      .where(
        and(
          not(inArray(barterMatchesTable.status, ["REJECTED", "CANCELLED"])),
          ...(authorId
            ? [or(eq(barterMatchesTable.user1Id, authorId), eq(barterMatchesTable.user2Id, authorId))]
            : []),
        ) as SQL
      )
      .orderBy(desc(barterMatchesTable.updatedAt))
      .limit(limit);

    const peopleMap = await people(rows.flatMap((r) => [r.user1Id, r.user2Id]));
    for (const r of rows) {
      activity.push({
        type: "BARTER",
        id: r.id,
        status: r.status,
        title: r.req1?.skillOffered || "Barter exchange",
        subtitle: r.req1?.skillNeeded ? `Looking for: ${r.req1.skillNeeded}` : null,
        description: r.req1?.description ?? null,
        imageUrl: r.req1?.imageUrl ?? null,
        partner: peopleMap[r.user1Id === authorId ? r.user2Id : r.user1Id] ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        linkUrl: "/orders?tab=exchanges",
      });
    }
  }

  if (wantKind === "PROJECT" || wantKind === "ALL") {
    const rows = await db
      .select({
        id: projectsTable.id,
        title: projectsTable.title,
        description: projectsTable.description,
        category: projectsTable.category,
        status: projectsTable.status,
        budgetMin: projectsTable.budgetMin,
        budgetMax: projectsTable.budgetMax,
        imageUrl: projectsTable.imageUrl,
        userId: projectsTable.userId,
        acceptedBidId: projectsTable.acceptedBidId,
        createdAt: projectsTable.createdAt,
        updatedAt: projectsTable.updatedAt,
      })
      .from(projectsTable)
      .where(
        and(
          not(eq(projectsTable.status, "CANCELLED")),
          ...(authorId ? [eq(projectsTable.userId, authorId)] : []),
        ) as SQL
      )
      .orderBy(desc(projectsTable.updatedAt))
      .limit(limit);

    const winnerIds = rows.map((r) => r.acceptedBidId).filter(Boolean) as string[];
    let winners: Record<string, any> = {};
    const bidById = new Map<string, string>();
    if (winnerIds.length) {
      const bids = await db
        .select({ id: projectBidsTable.id, userId: projectBidsTable.userId })
        .from(projectBidsTable)
        .where(inArray(projectBidsTable.id, winnerIds));
      for (const b of bids) bidById.set(b.id, b.userId);
      winners = await people(bids.map((b) => b.userId));
    }
    const owners = await people(rows.map((r) => r.userId));

    for (const r of rows) {
      const winnerId = r.acceptedBidId ? bidById.get(r.acceptedBidId) : null;
      activity.push({
        type: "PROJECT",
        id: r.id,
        status: r.status,
        title: r.title,
        subtitle: r.category,
        description: r.description,
        budgetMin: r.budgetMin,
        budgetMax: r.budgetMax,
        imageUrl: r.imageUrl,
        partner: (winnerId ? winners[winnerId] : null) ?? owners[r.userId] ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        linkUrl: `/projects/${r.id}`,
      });
    }
  }

  activity.sort((a, b) => new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime());
  res.status(200).json({ success: true, data: { activity: activity.slice(0, limit) } });
});

// â”€â”€ GET /community/posts/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get("/community/posts/:id", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const [post] = await db
    .select()
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, String(req.params.id)))
    .limit(1);
  if (!post || post.kind === "GIG" || post.kind === "PROJECT") {
    res.status(404).json({ success: false, message: "Post not found" });
    return;
  }
  const [row] = await renderPosts([post], req.user?.id, 50);
  res.status(200).json({ success: true, data: row });
});

// â”€â”€ POST /community/posts â€” create a post â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post("/community/posts", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { kind, content, tags, media, priceInr, priceMaxInr, deliveryDays, revisions, wantInr, wantText, coverUrl, location, isRemote } = req.body ?? {};

  // Gig and project posts are retired — reject loudly instead of silently
  // falling back to a plain POST, which would misrepresent what was asked.
  const rawKind = String(kind || "POST").toUpperCase();
  if (rawKind === "GIG" || rawKind === "PROJECT") {
    res.status(400).json({ success: false, message: "Gig and project posts are no longer available on Grit&Gigs." });
    return;
  }

  const k = kindWhitelist(String(kind || "POST"), "POST");
  if (!content || !String(content).trim()) {
    res.status(400).json({ success: false, message: "Post content is required" });
    return;
  }

  const cleanMedia: { type: "image" | "video" | "embed"; url: string }[] = Array.isArray(media)
    ? (media as { url?: string; type?: string }[])
        .slice(0, 9)
        .map((m) => {
          if (!m || typeof m.url !== "string" || !m.url) return null;
          return { type: m.type === "video" ? ("video" as const) : ("image" as const), url: String(m.url) };
        })
        .filter((x): x is { type: "image" | "video"; url: string } => !!x)
    : [];

  // A cover is optional for every kind — text-only posts are fine. Clips are
  // the one exception: a REEL without a video is not a clip.
  const cover = coverUrl ? String(coverUrl) : cleanMedia.length ? cleanMedia[0]!.url : null;
  if (k === "REEL" && !cleanMedia.some((m) => m.type === "video")) {
    res.status(400).json({ success: false, message: "Clips need a short video — add one before posting." });
    return;
  }

  try {
    const [post] = await db
      .insert(communityPostsTable)
      .values({
        userId: req.user!.id,
        kind: k as typeof communityPostsTable.$inferSelect.kind,
        content: String(content).trim().slice(0, 5000),
        tags: cleanTags(tags),
        media: cleanMedia,
        coverUrl: cover,
        priceInr: null,
        priceMaxInr: null,
        deliveryDays: Number.isFinite(Number(deliveryDays)) && Number(deliveryDays) > 0 ? Math.round(Number(deliveryDays)) : null,
        revisions: k === "BARTER" ? Math.max(0, Math.min(10, Math.round(Number(revisions) || 0))) : 0,
        wantInr: k === "BARTER" && Number.isFinite(Number(wantInr)) && Number(wantInr) > 0 ? Math.round(Number(wantInr)) : null,
        wantText: k === "BARTER" && wantText ? String(wantText).trim().slice(0, 200) : null,
        location: location ? String(location).trim().slice(0, 100) : req.user!.city ?? null,
        isRemote: isRemote !== false,
      })
      .returning();

    const [row] = await renderPosts([post], req.user!.id);
    emitToRoom(req, `user:${req.user!.id}`, "community:stats", { userId: req.user!.id });
    emitGlobal(req, "community:post", { postId: post.id, authorId: req.user!.id, kind: post.kind });
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    logger.error({ err }, "Failed to create community post");
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
});

// â”€â”€ POST /community/posts/:id/like â€” toggle like â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post("/community/posts/:id/like", authenticate, async (req: Request, res: Response): Promise<void> => {
  const postId = String(req.params.id);
  const userId = req.user!.id;
  const [post] = await db
    .select({ id: communityPostsTable.id, userId: communityPostsTable.userId, likeCount: communityPostsTable.likeCount })
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, postId))
    .limit(1);
  if (!post) {
    res.status(404).json({ success: false, message: "Post not found" });
    return;
  }
  const [like] = await db
    .select({ id: communityLikesTable.id })
    .from(communityLikesTable)
    .where(and(eq(communityLikesTable.postId, postId), eq(communityLikesTable.userId, userId)))
    .limit(1);

  if (like) {
    await db.delete(communityLikesTable).where(eq(communityLikesTable.id, like.id));
    await db.update(communityPostsTable).set({ likeCount: sql`GREATEST(like_count - 1, 0)`, updatedAt: new Date() }).where(eq(communityPostsTable.id, postId));
  } else {
    await db.insert(communityLikesTable).values({ postId, userId });
    await db.update(communityPostsTable).set({ likeCount: sql`like_count + 1`, updatedAt: new Date() }).where(eq(communityPostsTable.id, postId));
  }

  const [updated] = await db
    .select({ likeCount: communityPostsTable.likeCount })
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, postId))
    .limit(1);

  if (!like && post.userId !== userId) {
    notify(post.userId, "COMMUNITY_LIKE", "Someone liked your post", `${req.user!.firstName} liked your post on the Hustle Feed.`, `/feed`);
  }

  emitGlobal(req, "community:changed", { postId, likeCount: updated?.likeCount ?? 0 });
  if (post.userId !== userId) {
    emitToRoom(req, `user:${post.userId}`, "community:stats", { userId: post.userId });
  }

  res.status(200).json({ success: true, data: { liked: !like, likeCount: updated?.likeCount ?? 0 } });
});

router.get("/community/posts/:id/likers", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const postId = String(req.params.id);
  const [post] = await db
    .select({ id: communityPostsTable.id })
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, postId))
    .limit(1);
  if (!post) {
    res.status(404).json({ success: false, message: "Post not found" });
    return;
  }
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const [totalRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(communityLikesTable)
    .where(eq(communityLikesTable.postId, postId));
  const users = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      profilePhoto: usersTable.profilePhoto,
      city: usersTable.city,
    })
    .from(communityLikesTable)
    .innerJoin(usersTable, eq(communityLikesTable.userId, usersTable.id))
    .where(eq(communityLikesTable.postId, postId))
    .orderBy(desc(communityLikesTable.createdAt))
    .limit(limit);
  res.status(200).json({ success: true, data: { users, total: totalRow?.n ?? 0 } });
});

// â”€â”€ POST /community/posts/:id/comment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post("/community/posts/:id/comment", authenticate, async (req: Request, res: Response): Promise<void> => {
  const content = String(req.body?.content || "").trim();
  if (!content) {
    res.status(400).json({ success: false, message: "Comment content is required" });
    return;
  }
  const [post] = await db
    .select({ id: communityPostsTable.id, commentCount: communityPostsTable.commentCount, userId: communityPostsTable.userId })
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, String(req.params.id)))
    .limit(1);
  if (!post) {
    res.status(404).json({ success: false, message: "Post not found" });
    return;
  }

  try {
    const [comment] = await db
      .insert(communityCommentsTable)
      .values({ postId: post.id, userId: req.user!.id, content: content.slice(0, 500) })
      .returning();
    await db.update(communityPostsTable).set({ commentCount: sql`comment_count + 1`, updatedAt: new Date() }).where(eq(communityPostsTable.id, post.id));

    const [author] = await db
      .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto })
      .from(usersTable)
      .where(eq(usersTable.id, req.user!.id))
      .limit(1);

    if (post.userId !== req.user!.id) {
      notify(post.userId, "COMMUNITY_COMMENT", "New comment on your post", `${req.user!.firstName} commented on your post: ${content.slice(0, 80)}`, `/feed`);
    }

    const newCommentCount = (post.commentCount ?? 0) + 1;
    emitGlobal(req, "community:changed", { postId: post.id, commentCount: newCommentCount });
    emitToRoom(req, `user:${post.userId}`, "community:stats", { userId: post.userId });

    res.status(201).json({
      success: true,
      data: {
        id: comment.id,
        content: comment.content,
        createdAt: comment.createdAt,
        commentCount: newCommentCount,
        author: author ?? { id: req.user!.id, firstName: req.user!.firstName, lastName: "", profilePhoto: null },
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to comment on community post");
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
});

// â”€â”€ GET /community/users/:id â€” public profile card for feed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get("/community/users/:id", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const [user] = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      profilePhoto: usersTable.profilePhoto,
      email: usersTable.email,
      bio: usersTable.bio,
      tagline: usersTable.tagline,
      city: usersTable.city,
      skillsOffered: usersTable.skillsOffered,
      skillsNeeded: usersTable.skillsNeeded,
      portfolioLinks: usersTable.portfolioLinks,
      sampleWorks: usersTable.sampleWorks,
      socialLinks: usersTable.socialLinks,
      seekingTo: usersTable.seekingTo,
      resumeUrl: usersTable.resumeUrl,
      resumeName: usersTable.resumeName,
      languages: usersTable.languages,
      reputationScore: usersTable.reputationScore,
      kycVerified: usersTable.kycVerified,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, String(req.params.id)))
    .limit(1);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }

  const [postStats] = await db
    .select({
      posts: count(communityPostsTable.id),
      likes: sql<number>`COALESCE(SUM(${communityPostsTable.likeCount}), 0)`,
      comments: sql<number>`COALESCE(SUM(${communityPostsTable.commentCount}), 0)`,
    })
    .from(communityPostsTable)
    .where(and(eq(communityPostsTable.userId, user.id), visibleKindCond()));

  // Likes given and comments made drive the LIKED / COMMENTED tabs, so the
  // header counters have to include them or those tabs look empty.
  const [likesGiven] = await db
    .select({ c: count() })
    .from(communityLikesTable)
    .where(eq(communityLikesTable.userId, user.id));

  const [commentsMade] = await db
    .select({ c: count() })
    .from(communityCommentsTable)
    .where(eq(communityCommentsTable.userId, user.id));

  const [followerCount] = await db
    .select({ c: count() })
    .from(communityFollowsTable)
    .where(eq(communityFollowsTable.followingId, user.id));

  const [followingCount] = await db
    .select({ c: count() })
    .from(communityFollowsTable)
    .where(eq(communityFollowsTable.followerId, user.id));

  let following: boolean | null = null;
  if (req.user?.id && req.user.id !== user.id) {
    const [f] = await db
      .select({ id: communityFollowsTable.id })
      .from(communityFollowsTable)
      .where(and(eq(communityFollowsTable.followerId, req.user.id), eq(communityFollowsTable.followingId, user.id)))
      .limit(1);
    following = !!f;
  }

  res.status(200).json({
    success: true,
    data: {
      user,
      posts: Number(postStats?.posts ?? 0),
      likes: Number(postStats?.likes ?? 0) + Number(likesGiven?.c ?? 0),
      comments: Number(postStats?.comments ?? 0) + Number(commentsMade?.c ?? 0),
      followers: Number(followerCount?.c ?? 0),
      followingCount: Number(followingCount?.c ?? 0),
      following,
    },
  });
});

router.get("/community/me/liked-posts", authenticate, async (req: Request, res: Response): Promise<void> => {
  const meId = req.user!.id;
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 30));
  const liked = await db
    .select({ id: communityPostsTable.id })
    .from(communityLikesTable)
    .innerJoin(communityPostsTable, eq(communityLikesTable.postId, communityPostsTable.id))
    .where(and(eq(communityLikesTable.userId, meId), visibleKindCond()))
    .orderBy(desc(communityLikesTable.createdAt))
    .limit(limit);
  if (!liked.length) {
    res.status(200).json({ success: true, data: { posts: [] } });
    return;
  }
  const ids = liked.map((r) => r.id);
  const rows = await db.select().from(communityPostsTable).where(inArray(communityPostsTable.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered: typeof rows = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r) ordered.push(r);
  }
  res.status(200).json({ success: true, data: { posts: await renderPosts(ordered, meId) } });
});

router.get("/community/me/commented-posts", authenticate, async (req: Request, res: Response): Promise<void> => {
  const meId = req.user!.id;
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 30));
  const commented = await db
    .select({ postId: communityCommentsTable.postId })
    .from(communityCommentsTable)
    .where(eq(communityCommentsTable.userId, meId))
    .groupBy(communityCommentsTable.postId)
    .orderBy(sql`MAX(${communityCommentsTable.createdAt}) DESC`)
    .limit(limit);
  if (!commented.length) {
    res.status(200).json({ success: true, data: { posts: [] } });
    return;
  }
  const ids = commented.map((r) => r.postId);
  const rows = await db.select().from(communityPostsTable).where(and(inArray(communityPostsTable.id, ids), visibleKindCond()));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered: typeof rows = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r) ordered.push(r);
  }
  res.status(200).json({ success: true, data: { posts: await renderPosts(ordered, meId) } });
});

// â”€â”€ POST /community/users/:id/follow â€” toggle follow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post("/community/users/:id/follow", authenticate, async (req: Request, res: Response): Promise<void> => {
  const targetId = String(req.params.id);
  const meId = req.user!.id;
  if (targetId === meId) {
    res.status(400).json({ success: false, message: "You can't follow yourself" });
    return;
  }

  const [target] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.id, targetId))
    .limit(1);
  if (!target) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }

  const [existing] = await db
    .select({ id: communityFollowsTable.id })
    .from(communityFollowsTable)
    .where(and(eq(communityFollowsTable.followerId, meId), eq(communityFollowsTable.followingId, targetId)))
    .limit(1);

  if (existing) {
    await db.delete(communityFollowsTable).where(eq(communityFollowsTable.id, existing.id));
    emitToRoom(req, `user:${meId}`, "community:stats", { userId: meId });
    emitToRoom(req, `user:${targetId}`, "community:stats", { userId: targetId });
    res.status(200).json({ success: true, data: { following: false } });
  } else {
    await db.insert(communityFollowsTable).values({ followerId: meId, followingId: targetId });
    notify(targetId, "COMMUNITY_FOLLOW", "New follower", `${req.user!.firstName} started following you on the Hustle Feed.`, null);
    emitToRoom(req, `user:${meId}`, "community:stats", { userId: meId });
    emitToRoom(req, `user:${targetId}`, "community:stats", { userId: targetId });
    res.status(200).json({ success: true, data: { following: true } });
  }
});

// ——— follow list helper ———
async function loadFollowRows(
  anchorId: string,
  mode: "followers" | "following",
  viewerId: string | undefined,
  limit: number,
  offset: number,
): Promise<{ users: Array<Record<string, unknown>>; total: number }> {
  const anchorCol = mode === "followers" ? communityFollowsTable.followingId : communityFollowsTable.followerId;
  const userCol = mode === "followers" ? communityFollowsTable.followerId : communityFollowsTable.followingId;
  const rows = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      profilePhoto: usersTable.profilePhoto,
      city: usersTable.city,
      tagline: usersTable.tagline,
      kycVerified: usersTable.kycVerified,
      followedAt: communityFollowsTable.createdAt,
    })
    .from(communityFollowsTable)
    .innerJoin(usersTable, eq(usersTable.id, userCol))
    .where(eq(anchorCol, anchorId))
    .orderBy(desc(communityFollowsTable.createdAt))
    .limit(limit)
    .offset(offset);
  const [totalRow] = await db
    .select({ c: count() })
    .from(communityFollowsTable)
    .where(eq(anchorCol, anchorId));

  const isFollowing = new Set<string>();
  const followsMe = new Set<string>();
  const ids = rows.map((r) => r.id);
  if (viewerId && ids.length) {
    const mine = await db
      .select({ followingId: communityFollowsTable.followingId })
      .from(communityFollowsTable)
      .where(and(eq(communityFollowsTable.followerId, viewerId), inArray(communityFollowsTable.followingId, ids)));
    for (const m of mine) isFollowing.add(m.followingId);
    const theirs = await db
      .select({ followerId: communityFollowsTable.followerId })
      .from(communityFollowsTable)
      .where(and(eq(communityFollowsTable.followingId, viewerId), inArray(communityFollowsTable.followerId, ids)));
    for (const m of theirs) followsMe.add(m.followerId);
  }

  return {
    users: rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      profilePhoto: r.profilePhoto,
      city: r.city,
      tagline: r.tagline,
      kycVerified: r.kycVerified,
      followedAt: r.followedAt,
      isFollowing: isFollowing.has(r.id),
      followsMe: followsMe.has(r.id),
    })),
    total: Number(totalRow?.c ?? 0),
  };
}

// ── GET /community/users/:id/followers — people who follow this user ──
router.get("/community/users/:id/followers", authenticate, async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await loadFollowRows(String(req.params.id), "followers", req.user!.id, limit, offset);
  res.status(200).json({ success: true, data });
});

// ── GET /community/users/:id/following — people this user follows ──
router.get("/community/users/:id/following", authenticate, async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await loadFollowRows(String(req.params.id), "following", req.user!.id, limit, offset);
  res.status(200).json({ success: true, data });
});

// ── DELETE /community/users/:id/follower — remove someone from my followers ──
router.delete("/community/users/:id/follower", authenticate, async (req: Request, res: Response): Promise<void> => {
  const followerId = String(req.params.id);
  const meId = req.user!.id;
  const [row] = await db
    .select({ id: communityFollowsTable.id })
    .from(communityFollowsTable)
    .where(and(eq(communityFollowsTable.followerId, followerId), eq(communityFollowsTable.followingId, meId)))
    .limit(1);
  if (!row) {
    res.status(404).json({ success: false, message: "This user does not follow you" });
    return;
  }
  await db.delete(communityFollowsTable).where(eq(communityFollowsTable.id, row.id));
  const [c] = await db
    .select({ c: count() })
    .from(communityFollowsTable)
    .where(eq(communityFollowsTable.followingId, meId));
  res.status(200).json({ success: true, data: { followers: Number(c?.c ?? 0) } });
});

// â”€â”€ GET /community/notifications â€” my feed notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get("/community/notifications", authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const unreadCount = await db
      .select({ c: count() })
      .from(notificationsTable)
      .where(and(eq(notificationsTable.userId, req.user!.id), eq(notificationsTable.isRead, false)));
    const rows = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.userId, req.user!.id))
      .orderBy(desc(notificationsTable.createdAt))
      .limit(limit);
    res.status(200).json({ success: true, data: { unread: Number(unreadCount?.[0]?.c ?? 0), notifications: rows } });
  } catch (err) {
    logger.error({ err }, "Failed to load community notifications");
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
});

// â”€â”€ POST /community/notifications/read â€” mark all as read â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post("/community/notifications/read", authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    await db.update(notificationsTable).set({ isRead: true }).where(eq(notificationsTable.userId, req.user!.id));
    res.status(200).json({ success: true, data: { read: true } });
  } catch (err) {
    logger.error({ err }, "Failed to mark notifications read");
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
});

// â”€â”€ POST /community/posts/:id/delete â€” author deletes post â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ── POST /community/posts/:id/order — create an order/proposal and DM the author ──
router.post("/community/posts/:id/order", authenticate, async (req: Request, res: Response): Promise<void> => {
  const postId = String(req.params.id);
  const meId = req.user!.id;
  const content = String(req.body?.content || "").trim().slice(0, 3000);
  const amount = Number(req.body?.amount);
  const shippingNote = req.body?.shippingNote ? String(req.body.shippingNote).trim().slice(0, 500) : null;

  if (!content) {
    res.status(400).json({ success: false, message: "Tell them what you need." });
    return;
  }
  if (postId === "undefined" || postId === "null") {
    res.status(400).json({ success: false, message: "Invalid post" });
    return;
  }

  const [post] = await db
    .select({ id: communityPostsTable.id, userId: communityPostsTable.userId, kind: communityPostsTable.kind, content: communityPostsTable.content, priceInr: communityPostsTable.priceInr })
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, postId))
    .limit(1);
  if (!post) {
    res.status(404).json({ success: false, message: "Post not found" });
    return;
  }
  if (post.kind !== "BARTER") {
    res.status(400).json({ success: false, message: "Only barter posts can take requests." });
    return;
  }
  if (post.userId === meId) {
    res.status(400).json({ success: false, message: "You can't request your own post." });
    return;
  }

  // Barter offers draw from the monthly proposal quota (freelancer quota).
  {
    const q = await consumeProposal(meId);
    if (!q.allowed) {
      res.status(402).json({
        success: false,
        code: "QUOTA_PROPOSAL",
        message: `You've used all ${FREE_PROPOSALS} free proposals this month. 5 more = just ₹60.`,
        usage: { proposals: { used: q.usage.proposalsUsed, free: q.usage.proposalsFree, bonus: q.usage.proposalsBonus, limit: FREE_PROPOSALS } },
      });
      return;
    }
  }

  // A client can only order a barter if their wallet can cover a quoted amount.
  // resolveGigAmount is shared with the unit tests so the amount we check is
  // exactly the amount we store — a client cannot lower one without the other.
  const gigPrice = resolveGigAmount(post.kind, post.priceInr, amount);
  if (gigPrice !== null && gigPrice > 0) {
    const [buyerWallet] = await db
      .select({ balance: freelanceWalletsTable.balance })
      .from(freelanceWalletsTable)
      .where(eq(freelanceWalletsTable.userId, meId))
      .limit(1);
    const walletBalance = buyerWallet?.balance ?? 0;
    if (!canAfford(walletBalance, gigPrice)) {
      res.status(400).json({
        success: false,
        code: "INSUFFICIENT_FUNDS",
        message: `You need ₹${Number(gigPrice).toLocaleString("en-IN")} in your wallet to send this request. You have ₹${Number(walletBalance).toLocaleString("en-IN")}. Please add funds first.`,
      });
      return;
    }
  }


  const [author] = await db
    .select({ id: usersTable.id, firstName: usersTable.firstName })
    .from(usersTable)
    .where(eq(usersTable.id, post.userId))
    .limit(1);
  if (!author) {
    res.status(404).json({ success: false, message: "Post author not found" });
    return;
  }

  // BARTER is free by definition, so it never stores a monetary amount.
  const finalAmount = null;

  try {
    const [order] = await db
      .insert(communityOrdersTable)
      .values({
        postId: post.id,
        buyerId: meId,
        sellerId: post.userId,
        kind: post.kind as "GIG" | "PROJECT" | "BARTER",
        status: "PENDING",
        requirements: content,
        amount: finalAmount,
        shippingNote,
      })
      .returning();

    const snippet = content.length > 240 ? content.slice(0, 240) + "…" : content;

    notify(
      author.id,
      "COMMUNITY_ORDER",
      "New barter offer",
      `${req.user!.firstName} sent you a request: ${snippet}`,
      `/orders`,
    );

    res.status(201).json({
      success: true,
      data: { orderId: order.id, conversationId: null, createdConversation: false, status: order.status },
    });
  } catch (err) {
    logger.error({ err }, "Failed to create community order");
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
});

router.get("/community/connected/:userId", authenticate, async (req: Request, res: Response): Promise<void> => {
  const otherId = String(req.params.userId);
  if (!otherId || otherId === req.user!.id) {
    res.status(200).json({ success: true, data: { connected: false } });
    return;
  }
  const connected = await areConnected(req.user!.id, otherId);
  res.status(200).json({ success: true, data: { connected } });
});

// ── GET /community/orders — orders I'm buyer or seller of ──
router.get("/community/orders", authenticate, async (req: Request, res: Response): Promise<void> => {
  const meId = req.user!.id;
  const scope = String(req.query.scope || "all"); // all | as-buyer | as-seller
  const status = String(req.query.status || "").toUpperCase();
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));

  const conditions: SQL[] = scope === "as-buyer" ? [eq(communityOrdersTable.buyerId, meId)] : scope === "as-seller" ? [eq(communityOrdersTable.sellerId, meId)] : [or(eq(communityOrdersTable.buyerId, meId), eq(communityOrdersTable.sellerId, meId)) as SQL];
  if (status) conditions.push(eq(communityOrdersTable.status, status as typeof communityOrdersTable.$inferSelect.status));

  const rows = await db
    .select()
    .from(communityOrdersTable)
    .where(and(...conditions))
    .orderBy(desc(communityOrdersTable.updatedAt))
    .limit(limit);

  if (!rows.length) {
    res.status(200).json({ success: true, data: { orders: [] } });
    return;
  }

  const postIds = [...new Set(rows.map(r => r.postId))];
  const userIds = [...new Set(rows.flatMap(r => [r.buyerId, r.sellerId]))];

  const posts: { id: string; kind: typeof communityPostsTable.$inferSelect.kind; content: string; coverUrl: string | null; priceInr: number | null }[] = postIds.length
    ? await db.select({ id: communityPostsTable.id, kind: communityPostsTable.kind, content: communityPostsTable.content, coverUrl: communityPostsTable.coverUrl, priceInr: communityPostsTable.priceInr }).from(communityPostsTable).where(inArray(communityPostsTable.id, postIds))
    : [];
  const users: { id: string; firstName: string; lastName: string; profilePhoto: string | null }[] = userIds.length
    ? await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto }).from(usersTable).where(inArray(usersTable.id, userIds))
    : [];

  const postById = new Map(posts.map(p => [p.id, p] as const));
  const userById = new Map(users.map(u => [u.id, u] as const));

  const reviewedRows = rows.length
    ? await db
        .select({ orderId: communityOrderReviewsTable.orderId })
        .from(communityOrderReviewsTable)
        .where(and(inArray(communityOrderReviewsTable.orderId, rows.map(r => r.id)), eq(communityOrderReviewsTable.reviewerId, meId)))
    : [];
  const reviewedOrderIds = new Set(reviewedRows.map(r => r.orderId));

  res.status(200).json({
    success: true,
    data: {
      orders: rows.map(r => ({
        ...r,
        hasReviewed: reviewedOrderIds.has(r.id),
        post: postById.get(r.postId) ?? null,
        buyer: userById.get(r.buyerId) ?? null,
        seller: userById.get(r.sellerId) ?? null,
      })),
    },
  });
});

// ── GET /community/orders/:id — detail with deliveries ──
router.get("/community/orders/:id", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [order] = await db
    .select()
    .from(communityOrdersTable)
    .where(eq(communityOrdersTable.id, String(req.params.id)))
    .limit(1);
  if (!order) {
    res.status(404).json({ success: false, message: "Order not found" });
    return;
  }
  const meId = req.user!.id;
  if (order.buyerId !== meId && order.sellerId !== meId && req.user!.role !== "ADMIN") {
    res.status(403).json({ success: false, message: "You're not part of this order" });
    return;
  }
  const [post] = await db
    .select()
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, order.postId))
    .limit(1);
  const [buyer, seller] = await Promise.all([
    db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto }).from(usersTable).where(eq(usersTable.id, order.buyerId)).limit(1),
    db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto }).from(usersTable).where(eq(usersTable.id, order.sellerId)).limit(1),
  ]);
  const deliveries = await db
    .select()
    .from(communityOrderDeliveriesTable)
    .where(eq(communityOrderDeliveriesTable.orderId, order.id))
    .orderBy(desc(communityOrderDeliveriesTable.createdAt));

  const deliveryUserIds = [...new Set(deliveries.map(d => d.senderId))];
  const deliveryUsers = deliveryUserIds.length
    ? await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto }).from(usersTable).where(inArray(usersTable.id, deliveryUserIds))
    : [];
  const userById = new Map(deliveryUsers.map(u => [u.id, u]));

  const [myReview] = await db
    .select({ id: communityOrderReviewsTable.id })
    .from(communityOrderReviewsTable)
    .where(and(eq(communityOrderReviewsTable.orderId, order.id), eq(communityOrderReviewsTable.reviewerId, meId)))
    .limit(1);

  res.status(200).json({
    success: true,
    data: {
      order,
      post: post ?? null,
      buyer: buyer[0] ?? null,
      seller: seller[0] ?? null,
      hasReviewed: !!myReview,
      deliveries: deliveries.map(d => ({ ...d, sender: userById.get(d.senderId) ?? null })),
    },
  });
});

// ── PUT /community/orders/:id/accept — seller accepts ──
router.put("/community/orders/:id/accept", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [order] = await db.select().from(communityOrdersTable).where(eq(communityOrdersTable.id, String(req.params.id))).limit(1);
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.sellerId !== req.user!.id && req.user!.role !== "ADMIN") { res.status(403).json({ success: false, message: "Only the seller can accept this order" }); return; }
  if (order.status !== "PENDING") { res.status(400).json({ success: false, message: "Only pending orders can be accepted" }); return; }

  const [updated] = await db
    .update(communityOrdersTable)
    .set({ status: "IN_PROGRESS", updatedAt: new Date() })
    .where(eq(communityOrdersTable.id, order.id))
    .returning();
  notify(order.buyerId, "COMMUNITY_ORDER_ACCEPTED", "Order accepted!", `${req.user!.firstName} accepted your order and started working on it.`, `/orders`);

  const [existingConv] = await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        or(
          and(eq(conversationsTable.user1Id, order.buyerId), eq(conversationsTable.user2Id, order.sellerId)),
          and(eq(conversationsTable.user1Id, order.sellerId), eq(conversationsTable.user2Id, order.buyerId)),
        ),
        sql`${conversationsTable.orderId} IS NULL AND ${conversationsTable.matchId} IS NULL AND ${conversationsTable.projectBidId} IS NULL AND ${conversationsTable.isGroup} = FALSE`,
      ),
    )
    .limit(1);
  let conv = existingConv;
  if (!conv) {
    [conv] = await db
      .insert(conversationsTable)
      .values({ user1Id: order.buyerId, user2Id: order.sellerId, lastMessageAt: new Date() })
      .returning();
  }
  const chatLabel = order.kind === "GIG" ? "✅ Gig order accepted" : order.kind === "PROJECT" ? "✅ Proposal accepted" : "✅ Barter offer accepted";
  await db
    .insert(messagesTable)
    .values({
      conversationId: conv.id,
      senderId: order.sellerId,
      messageText: `${chatLabel}${order.amount ? ` (₹${order.amount})` : ""}\nChat is open — discuss the work here.`,
      attachments: [],
    });
  await db.update(conversationsTable).set({ lastMessageAt: new Date() }).where(eq(conversationsTable.id, conv.id));

  res.status(200).json({ success: true, data: { ...updated, conversationId: conv.id } });
});

// ── PUT /community/orders/:id/deliver — seller delivers ──
router.put("/community/orders/:id/deliver", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [order] = await db.select().from(communityOrdersTable).where(eq(communityOrdersTable.id, String(req.params.id))).limit(1);
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.sellerId !== req.user!.id && req.user!.role !== "ADMIN") { res.status(403).json({ success: false, message: "Only the seller can deliver on this order" }); return; }
  if (order.status !== "IN_PROGRESS" && order.status !== "REVISION") { res.status(400).json({ success: false, message: "This order can't be delivered right now" }); return; }

  const note = req.body?.note ? String(req.body.note).trim().slice(0, 2000) : null;
  const rawLink = req.body?.link ? String(req.body.link).trim().slice(0, 2000) : "";
  let link: string | null = null;
  if (rawLink) {
    try {
      const u = new URL(/^https?:\/\//i.test(rawLink) ? rawLink : `https://${rawLink}`);
      if (u.protocol === "http:" || u.protocol === "https:") link = u.toString();
    } catch { link = null; }
    if (!link) { res.status(400).json({ success: false, message: "Invalid link" }); return; }
  }
  const files = Array.isArray(req.body?.files)
    ? (req.body.files as { url?: string; name?: string; type?: string }[])
        .map(f => ({ url: String(f.url || ""), name: f.name ? String(f.name).slice(0, 200) : undefined, type: f.type ? String(f.type).slice(0, 100) : undefined }))
        .filter(f => f.url)
        .slice(0, 10)
    : [];

  const [delivery] = await db
    .insert(communityOrderDeliveriesTable)
    .values({ orderId: order.id, senderId: req.user!.id, note, link, files, isRevision: false })
    .returning();
  const [updated] = await db
    .update(communityOrdersTable)
    .set({ status: "DELIVERED", deliveredAt: new Date(), updatedAt: new Date() })
    .where(eq(communityOrdersTable.id, order.id))
    .returning();
  notify(order.buyerId, "COMMUNITY_ORDER_DELIVERED", "Work delivered!", `${req.user!.firstName} delivered your order. Please review it.`, `/orders`);
  res.status(200).json({ success: true, data: { order: updated, delivery } });
});

// ── POST /community/orders/:id/review — rate the other party after completion ──
router.post("/community/orders/:id/review", authenticate, async (req: Request, res: Response): Promise<void> => {
  const meId = req.user!.id;
  const rating = Math.floor(Number(req.body?.rating) || 0);
  const review = String(req.body?.review || "").trim().slice(0, 1000);
  if (rating < 1 || rating > 5) {
    res.status(400).json({ success: false, message: "Rating must be between 1 and 5" });
    return;
  }
  const [order] = await db.select().from(communityOrdersTable).where(eq(communityOrdersTable.id, String(req.params.id))).limit(1);
  if (!order) {
    res.status(404).json({ success: false, message: "Order not found" });
    return;
  }
  if (order.buyerId !== meId && order.sellerId !== meId) {
    res.status(403).json({ success: false, message: "You're not part of this order" });
    return;
  }
  if (order.status !== "COMPLETED") {
    res.status(400).json({ success: false, message: "Reviews are available after the work is marked complete" });
    return;
  }
  const revieweeId = order.buyerId === meId ? order.sellerId : order.buyerId;
  const [existing] = await db
    .select({ id: communityOrderReviewsTable.id })
    .from(communityOrderReviewsTable)
    .where(and(eq(communityOrderReviewsTable.orderId, order.id), eq(communityOrderReviewsTable.reviewerId, meId)))
    .limit(1);
  if (existing) {
    res.status(400).json({ success: false, message: "You've already reviewed this order" });
    return;
  }
  const [created] = await db
    .insert(communityOrderReviewsTable)
    .values({ orderId: order.id, reviewerId: meId, revieweeId, rating, review: review || null })
    .returning();
  notify(revieweeId, "REVIEW_RECEIVED", "New review", `${req.user!.firstName} rated their order with you ${rating}/5.`, `/orders`);
  emitToRoom(req, `user:${revieweeId}`, "profile:updated", { userId: revieweeId });
  res.status(201).json({ success: true, data: { review: created } });
});

// ── PUT /community/orders/:id/complete — buyer confirms completed ──
router.put("/community/orders/:id/complete", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [order] = await db.select().from(communityOrdersTable).where(eq(communityOrdersTable.id, String(req.params.id))).limit(1);
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.buyerId !== req.user!.id && req.user!.role !== "ADMIN") { res.status(403).json({ success: false, message: "Only the buyer can complete this order" }); return; }
  if (order.status !== "DELIVERED") { res.status(400).json({ success: false, message: "Only delivered orders can be completed" }); return; }

  // Barter orders are a skill exchange, and a null/zero amount means there is
  // nothing to transfer. Everything else (GIG / PROJECT) is a paid order and
  // must move money, exactly like the service-order and project flows do.
  const gross = order.kind === "BARTER" ? 0 : Math.round(Number(order.amount ?? 0));
  const payout = Number.isFinite(gross) && gross > 0 ? gross : 0;

  let commissionPct = 0;
  let commission = 0;
  let netAmount = 0;
  if (payout > 0) {
    commissionPct = PLATFORM_COMMISSION_PCT;
    commission = Math.round(payout * commissionPct / 100);
    netAmount = payout - commission;
  }

  // Claim the DELIVERED→COMPLETED transition and move the money in ONE
  // transaction so a crash or retry can never double-pay or strand the order.
  let updated: typeof order | undefined;
  try {
    await db.transaction(async (tx) => {
      const claimResult = await tx.execute(
        sql`UPDATE ${sql.identifier("community_orders")} SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW() WHERE id = ${order.id} AND status = 'DELIVERED'`
      );
      if (claimResult.rowCount === 0) {
        throw new Error("ALREADY_COMPLETED");
      }
      const [claimed] = await tx
        .select()
        .from(communityOrdersTable)
        .where(eq(communityOrdersTable.id, order.id))
        .limit(1);
      updated = claimed;

      if (payout > 0) {
        const deductResult = await tx.execute(
          sql`UPDATE ${freelanceWalletsTable} SET balance = balance - ${payout}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${order.buyerId} AND balance >= ${payout}`
        );
        if (deductResult.rowCount === 0) {
          throw new Error("Insufficient funds");
        }

        if (netAmount > 0) {
          const creditResult = await tx.execute(
            sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${netAmount}, total_earned = COALESCE(total_earned, 0) + ${netAmount}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${order.sellerId}`
          );
          if (creditResult.rowCount === 0) {
            await tx.insert(freelanceWalletsTable).values({
              userId: order.sellerId,
              balance: netAmount,
              totalEarned: netAmount,
              updatedAt: new Date(),
            });
          }
        }

        await tx.insert(transactionsTable).values({
          userId: order.buyerId,
          type: "SERVICE_PAYMENT",
          amount: payout,
          description: `Payment for order #${order.id.slice(-8)}`,
          status: "COMPLETED",
        });
        await tx.insert(transactionsTable).values({
          userId: order.sellerId,
          type: "SERVICE_EARNING",
          amount: netAmount,
          description: `Payment received for order #${order.id.slice(-8)}`,
          status: "COMPLETED",
        });
        if (commission > 0) {
          await tx.insert(transactionsTable).values({
            userId: order.sellerId,
            type: "COMMISSION",
            amount: commission,
            description: `Platform commission (${commissionPct}%) on order #${order.id.slice(-8)}`,
            status: "COMPLETED",
          });
        }
      }
    });
  } catch (e) {
    if (e instanceof Error && e.message === "ALREADY_COMPLETED") {
      res.status(409).json({ success: false, message: "Order already completed" });
    } else if (e instanceof Error && e.message === "Insufficient funds") {
      res.status(400).json({ success: false, message: "You don't have enough funds in your wallet. Please add funds and try again." });
    } else {
      logger.error({ err: e, orderId: order.id }, "Failed to complete community order");
      res.status(500).json({ success: false, message: "Payment processing failed. Please try again." });
    }
    return;
  }

  await db.update(communityPostsTable).set({ status: "SOLD" }).where(eq(communityPostsTable.id, order.postId));
  notify(
    order.sellerId,
    "COMMUNITY_ORDER_COMPLETED",
    "Order completed!",
    payout > 0
      ? `${req.user!.firstName} approved your work. You received ₹${netAmount}${commissionPct > 0 ? ` (${commissionPct}% commission: ₹${commission})` : ""}.`
      : `${req.user!.firstName} marked your order as completed.`,
    `/orders`
  );
  res.status(200).json({
    success: true,
    data: updated,
    payout: payout > 0 ? { amount: payout, commission, commissionPct, netAmount } : null,
  });
});

// ── PUT /community/orders/:id/revise — buyer requests a revision ──
router.put("/community/orders/:id/revise", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [order] = await db.select().from(communityOrdersTable).where(eq(communityOrdersTable.id, String(req.params.id))).limit(1);
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.buyerId !== req.user!.id && req.user!.role !== "ADMIN") { res.status(403).json({ success: false, message: "Only the buyer can request a revision" }); return; }
  if (order.status !== "DELIVERED") { res.status(400).json({ success: false, message: "Only delivered work can get a revision request" }); return; }

  const [post] = await db.select({ revisions: communityPostsTable.revisions }).from(communityPostsTable).where(eq(communityPostsTable.id, order.postId)).limit(1);
  const limit = post?.revisions ?? 0;
  if (order.revisionsUsed >= limit && limit > 0) { res.status(400).json({ success: false, message: `This gig includes only ${limit} revision${limit === 1 ? "" : "s"}` }); return; }

  const note = req.body?.note ? String(req.body.note).trim().slice(0, 2000) : null;
  const [updated] = await db
    .update(communityOrdersTable)
    .set({ status: "REVISION", revisionsUsed: sql`revisions_used + 1`, updatedAt: new Date() })
    .where(eq(communityOrdersTable.id, order.id))
    .returning();
  await db
    .insert(communityOrderDeliveriesTable)
    .values({ orderId: order.id, senderId: req.user!.id, note: note ? `Revision request: ${note}` : "Revision requested", files: [], isRevision: true });
  notify(order.sellerId, "COMMUNITY_ORDER_REVISION", "Revision requested", note ? `${req.user!.firstName} requested a revision: ${note.slice(0, 120)}` : `${req.user!.firstName} requested a revision.`, `/orders`);
  res.status(200).json({ success: true, data: updated });
});

// ── PUT /community/orders/:id/cancel — either side cancels ──
router.put("/community/orders/:id/cancel", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [order] = await db.select().from(communityOrdersTable).where(eq(communityOrdersTable.id, String(req.params.id))).limit(1);
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  const meId = req.user!.id;
  if (order.buyerId !== meId && order.sellerId !== meId && req.user!.role !== "ADMIN") { res.status(403).json({ success: false, message: "You're not part of this order" }); return; }
  if (order.status === "COMPLETED" || order.status === "CANCELLED") { res.status(400).json({ success: false, message: "This order can't be cancelled anymore" }); return; }

  const [updated] = await db
    .update(communityOrdersTable)
    .set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() })
    .where(eq(communityOrdersTable.id, order.id))
    .returning();
  const other = order.buyerId === meId ? order.sellerId : order.buyerId;
  notify(other, "COMMUNITY_ORDER_CANCELLED", "Order cancelled", `${req.user!.firstName} cancelled the order.`, `/orders`);
  res.status(200).json({ success: true, data: updated });
});

router.put("/community/posts/:id", authenticate, async (req: Request, res: Response): Promise<void> => {
  // Editing a post after posting. The composer only sends tags on create, so
  // without this a post whose tags are wrong could only be fixed by deleting
  // and reposting it, which loses its likes and comments.
  const [post] = await db
    .select({
      id: communityPostsTable.id,
      userId: communityPostsTable.userId,
      kind: communityPostsTable.kind,
    })
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, String(req.params.id)))
    .limit(1);
  if (!post) {
    res.status(404).json({ success: false, message: "Post not found" });
    return;
  }
  if (post.userId !== req.user!.id && req.user!.role !== "ADMIN") {
    res.status(403).json({ success: false, message: "You can only edit your own posts" });
    return;
  }

  // Whitelist rather than spreading the body: this endpoint must not become a
  // way to reassign ownership, force a like count, or flip status.
  const patch: Partial<typeof communityPostsTable.$inferInsert> = {};
  if (typeof req.body?.content === "string") {
    const content = req.body.content.trim();
    if (!content) {
      res.status(400).json({ success: false, message: "Post content cannot be empty" });
      return;
    }
    if (content.length > 5000) {
      res.status(400).json({ success: false, message: "Post content is too long" });
      return;
    }
    patch.content = content;
  }
  if (req.body?.tags !== undefined) patch.tags = cleanTags(req.body.tags);
  if (!Object.keys(patch).length) {
    res.status(400).json({ success: false, message: "Nothing to update" });
    return;
  }
  patch.updatedAt = new Date();

  const [updated] = await db
    .update(communityPostsTable)
    .set(patch)
    .where(eq(communityPostsTable.id, post.id))
    .returning();
  emitGlobal(req, "community:changed", { postId: post.id });
  res.status(200).json({ success: true, data: updated });
});

router.post("/community/posts/:id/delete", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [post] = await db
    .select({ id: communityPostsTable.id, userId: communityPostsTable.userId })
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, String(req.params.id)))
    .limit(1);
  if (!post) {
    res.status(404).json({ success: false, message: "Post not found" });
    return;
  }
  if (post.userId !== req.user!.id && req.user!.role !== "ADMIN") {
    res.status(403).json({ success: false, message: "You can only delete your own posts" });
    return;
  }
  await db.delete(communityPostsTable).where(eq(communityPostsTable.id, post.id));
  res.status(200).json({ success: true, message: "Post deleted" });
});

export { avatarUrl, slugify };
export default router;