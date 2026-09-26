import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, count, sql, inArray, or, ilike, type SQL } from "drizzle-orm";
import { db, usersTable, notificationsTable, communityPostsTable, communityLikesTable, communityCommentsTable, communityFollowsTable, conversationsTable, messagesTable, communityOrdersTable, communityOrderDeliveriesTable, transactionsTable } from "../db";
import { authenticate, optionalAuth } from "../middlewares/authenticate";
import { logger } from "../lib/logger";
import { uploadToSupabase } from "../lib/storage";
import { PROJECT_ROOT } from "../lib/root";
import { getCommunityQuota, consumeGigPost, consumeProposal, grantQuotaBundle, QUOTA_PLANS, FREE_GIG_POSTS, FREE_PROPOSALS, type QuotaPlanId } from "../lib/community-quota";
import { areConnected } from "../lib/connections";
import multer from "multer";
import path from "path";
import fs from "fs";

const router: IRouter = Router();

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
  const results: { url: string; type: "image" | "video" }[] = [];
  for (const f of files) {
    const isVideo = /^video\//.test(f.mimetype);
    const url = await uploadToSupabase(fs.readFileSync(f.path), f.originalname, "community");
    if (url) {
      results.push({ url, type: isVideo ? "video" : "image" });
    } else {
      results.push({ url: `/uploads/community/${f.filename}`, type: isVideo ? "video" : "image" });
    }
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
      gigPosts: { used: usage.gigPostsUsed, free: usage.gigPostsFree, bonus: usage.gigPostsBonus, limit: FREE_GIG_POSTS },
      proposals: { used: usage.proposalsUsed, free: usage.proposalsFree, bonus: usage.proposalsBonus, limit: FREE_PROPOSALS },
      resetsInMs: usage.resetsInMs,
      plans: [
        { id: QUOTA_PLANS.gigs5.id, label: QUOTA_PLANS.gigs5.label, priceInr: QUOTA_PLANS.gigs5.priceInr },
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
      type: "CREDIT_PURCHASE",
      amount: plan.priceInr,
      status: "PENDING",
      paymentMethod: "razorpay",
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
      .where(eq(transactionsTable.gatewayTxnId, razorpayOrderId))
      .limit(1);
    if (txn && txn.userId !== req.user!.id) {
      res.status(403).json({ success: false, message: "Payment does not belong to you" });
      return;
    }
    if (txn && txn.status !== "PENDING") {
      res.json({ success: true, data: { already: true } });
      return;
    }
    const plan = QUOTA_PLANS[bundleId as QuotaPlanId];
    await grantQuotaBundle(req.user!.id, plan.gigBonus, plan.propBonus);
    if (txn) {
      await db
        .update(transactionsTable)
        .set({ status: "COMPLETED", gatewayTxnId: razorpayPaymentId || "", updatedAt: new Date() })
        .where(eq(transactionsTable.id, txn.id));
    }
    res.json({ success: true, data: { bundleId: plan.id } });
  } catch {
    res.status(502).json({ success: false, message: "Failed to verify payment" });
  }
});

// â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function kindWhitelist(kind: string | undefined, fallback: string): string {
  const allowed = ["POST", "GIG", "BARTER", "WIN", "TIPS", "REEL", "PROJECT"];
  if (kind && allowed.includes(kind)) return kind;
  return fallback;
}

function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => String(t).trim().replace(/^#/, "").slice(0, 30))
    .filter(Boolean)
    .slice(0, 5);
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

async function renderPosts(rawPosts: typeof communityPostsTable.$inferSelect[], currentUserId: string | undefined, limitComments = 2): Promise<PostRowShape[]> {
  const postIds = rawPosts.map((p) => p.id);
  const authorIds = [...new Set(rawPosts.map((p) => p.userId))];

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

  return rawPosts.map((post) => {
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
    };
  });
}

// â”€â”€ GET /community/feed?kind=&filter=&cursor= â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get("/community/feed", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const meId = req.user?.id;
  const kind = kindWhitelist(String(req.query.kind || ""), "");
  const filter = String(req.query.filter || "for-you"); // for-you | following | local | top
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 20));
  const authorId = String(req.query.authorId || "").trim();
  const q = String(req.query.q || "").trim();

  let where: SQL | undefined;
  if (kind) where = eq(communityPostsTable.kind, kind as typeof communityPostsTable.$inferSelect.kind);
  if (authorId) {
    const authorCond: SQL = eq(communityPostsTable.userId, authorId);
    where = where ? and(where, authorCond) : authorCond;
  }
  if (q) {
    const searchCond: SQL = or(
      ilike(communityPostsTable.content, `%${q}%`),
      ilike(sql`${communityPostsTable.tags}::text`, `%${q}%`),
      ilike(communityPostsTable.location, `%${q}%`),
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

// â”€â”€ GET /community/posts/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get("/community/posts/:id", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const [post] = await db
    .select()
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, String(req.params.id)))
    .limit(1);
  if (!post) {
    res.status(404).json({ success: false, message: "Post not found" });
    return;
  }
  const [row] = await renderPosts([post], req.user?.id, 50);
  res.status(200).json({ success: true, data: row });
});

// â”€â”€ POST /community/posts â€” create a post â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post("/community/posts", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { kind, content, tags, media, priceInr, priceMaxInr, deliveryDays, revisions, wantInr, wantText, coverUrl, location, isRemote } = req.body ?? {};

  const k = kindWhitelist(String(kind || "POST"), "POST");
  if (!content || !String(content).trim()) {
    res.status(400).json({ success: false, message: "Post content is required" });
    return;
  }

  let price: number | null = null;
  if (k === "GIG" || k === "PROJECT") {
    const p = Number(priceInr);
    if (!Number.isFinite(p) || p <= 0) {
      res.status(400).json({ success: false, message: "Gig and project posts need a price in ₹" });
      return;
    }
    price = Math.round(p);
  }

  if (k === "GIG") {
    const q = await consumeGigPost(req.user!.id);
    if (!q.allowed) {
      res.status(402).json({
        success: false,
        code: "QUOTA_GIG",
        message: `You've used all ${FREE_GIG_POSTS} free gig posts this month. 5 more = just ₹80.`,
        usage: { gigPosts: { used: q.usage.gigPostsUsed, free: q.usage.gigPostsFree, bonus: q.usage.gigPostsBonus, limit: FREE_GIG_POSTS } },
      });
      return;
    }
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

  try {
    const [post] = await db
      .insert(communityPostsTable)
      .values({
        userId: req.user!.id,
        kind: k as typeof communityPostsTable.$inferSelect.kind,
        content: String(content).trim().slice(0, 5000),
        tags: cleanTags(tags),
        media: cleanMedia,
        coverUrl: coverUrl ? String(coverUrl) : null,
        priceInr: price,
        priceMaxInr: Number.isFinite(Number(priceMaxInr)) && Number(priceMaxInr) > 0 ? Math.round(Number(priceMaxInr)) : null,
        deliveryDays: Number.isFinite(Number(deliveryDays)) && Number(deliveryDays) > 0 ? Math.round(Number(deliveryDays)) : null,
        revisions: k === "GIG" || k === "BARTER" || k === "PROJECT" ? Math.max(0, Math.min(10, Math.round(Number(revisions) || 0))) : 0,
        wantInr: k === "BARTER" && Number.isFinite(Number(wantInr)) && Number(wantInr) > 0 ? Math.round(Number(wantInr)) : null,
        wantText: k === "BARTER" && wantText ? String(wantText).trim().slice(0, 200) : null,
        location: location ? String(location).trim().slice(0, 100) : req.user!.city ?? null,
        isRemote: isRemote !== false,
      })
      .returning();

    const [row] = await renderPosts([post], req.user!.id);
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

  res.status(200).json({ success: true, data: { liked: !like, likeCount: updated?.likeCount ?? 0 } });
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

    res.status(201).json({
      success: true,
      data: {
        id: comment.id,
        content: comment.content,
        createdAt: comment.createdAt,
        commentCount: (post.commentCount ?? 0) + 1,
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
    })
    .from(communityPostsTable)
    .where(eq(communityPostsTable.userId, user.id));

  const [followerCount] = await db
    .select({ c: count() })
    .from(communityFollowsTable)
    .where(eq(communityFollowsTable.followingId, user.id));

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
      likes: Number(postStats?.likes ?? 0),
      followers: Number(followerCount?.c ?? 0),
      following,
    },
  });
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
    res.status(200).json({ success: true, data: { following: false } });
  } else {
    await db.insert(communityFollowsTable).values({ followerId: meId, followingId: targetId });
    notify(targetId, "COMMUNITY_FOLLOW", "New follower", `${req.user!.firstName} started following you on the Hustle Feed.`, null);
    res.status(200).json({ success: true, data: { following: true } });
  }
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
  if (post.kind !== "GIG" && post.kind !== "PROJECT" && post.kind !== "BARTER") {
    res.status(400).json({ success: false, message: "Only gig, project and barter posts can take requests." });
    return;
  }
  if (post.userId === meId) {
    res.status(400).json({ success: false, message: "You can't request your own post." });
    return;
  }

  // Clients ordering gigs is free forever; bids/proposals on projects and
  // barter offers draw from the monthly proposal quota (freelancer quota).
  if (post.kind === "PROJECT" || post.kind === "BARTER") {
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

  const [author] = await db
    .select({ id: usersTable.id, firstName: usersTable.firstName })
    .from(usersTable)
    .where(eq(usersTable.id, post.userId))
    .limit(1);
  if (!author) {
    res.status(404).json({ success: false, message: "Post author not found" });
    return;
  }

  // For a GIG post the price is fixed on the post (buyer may still send an amount for barter/projects)
  const finalAmount = post.kind === "GIG" ? post.priceInr ?? (Math.round(amount) || null) : Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null;

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
      `New ${post.kind === "GIG" ? "gig order" : post.kind === "PROJECT" ? "project proposal" : "barter offer"}`,
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

  res.status(200).json({
    success: true,
    data: {
      orders: rows.map(r => ({
        ...r,
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

  res.status(200).json({
    success: true,
    data: {
      order,
      post: post ?? null,
      buyer: buyer[0] ?? null,
      seller: seller[0] ?? null,
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
  const files = Array.isArray(req.body?.files) ? (req.body.files as { url?: string }[]).map(f => ({ url: String(f.url || "") })).filter(f => f.url).slice(0, 10) : [];

  const [delivery] = await db
    .insert(communityOrderDeliveriesTable)
    .values({ orderId: order.id, senderId: req.user!.id, note, files, isRevision: false })
    .returning();
  const [updated] = await db
    .update(communityOrdersTable)
    .set({ status: "DELIVERED", deliveredAt: new Date(), updatedAt: new Date() })
    .where(eq(communityOrdersTable.id, order.id))
    .returning();
  notify(order.buyerId, "COMMUNITY_ORDER_DELIVERED", "Work delivered!", `${req.user!.firstName} delivered your order. Please review it.`, `/orders`);
  res.status(200).json({ success: true, data: { order: updated, delivery } });
});

// ── PUT /community/orders/:id/complete — buyer confirms completed ──
router.put("/community/orders/:id/complete", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [order] = await db.select().from(communityOrdersTable).where(eq(communityOrdersTable.id, String(req.params.id))).limit(1);
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.buyerId !== req.user!.id && req.user!.role !== "ADMIN") { res.status(403).json({ success: false, message: "Only the buyer can complete this order" }); return; }
  if (order.status !== "DELIVERED") { res.status(400).json({ success: false, message: "Only delivered orders can be completed" }); return; }

  const [updated] = await db
    .update(communityOrdersTable)
    .set({ status: "COMPLETED", completedAt: new Date(), updatedAt: new Date() })
    .where(eq(communityOrdersTable.id, order.id))
    .returning();
  await db.update(communityPostsTable).set({ status: "SOLD" }).where(eq(communityPostsTable.id, order.postId));
  notify(order.sellerId, "COMMUNITY_ORDER_COMPLETED", "Order completed!", `${req.user!.firstName} marked your order as completed. 🎉`, `/orders`);
  res.status(200).json({ success: true, data: updated });
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