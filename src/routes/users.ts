import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  pool,
  usersTable,
  notificationsTable,
  servicesTable,
  reviewsTable,
  clientReviewsTable,
  freelanceWalletsTable,
  transactionsTable,
  withdrawalRequestsTable,
} from "../db";
import { eq, ilike, or, desc, sql, and, gt, inArray } from "drizzle-orm";
import { authenticate, optionalAuth } from "../middlewares/authenticate";
import { getActivePlanForUser, getOrCreateSubscription, getPlan } from "../lib/subscriptions";
import { attachPlanBadge, attachPlanBadges } from "../lib/planBadge";
import { uploadToSupabase } from "../lib/storage";
import { createUpiPayout, createBankPayout } from "../lib/razorpay";
import { PROJECT_ROOT } from "../lib/root";
import { logger } from "../lib/logger";
import multer from "multer";
import path from "path";
import fs from "fs";

const router: IRouter = Router();

const uploadDir = path.join(PROJECT_ROOT, "uploads", "profiles");
fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

router.get("/users/search", optionalAuth, async (req, res): Promise<void> => {
  const { q, skill, city, page = "1", limit = "20" } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const conditions = [eq(usersTable.isActive, true)];
  if (q) {
    conditions.push(
      or(
        ilike(usersTable.firstName, `%${q}%`),
        ilike(usersTable.lastName, `%${q}%`),
        ilike(usersTable.bio, `%${q}%`),
      )!,
    );
  }
  if (city) conditions.push(ilike(usersTable.city, `%${city}%`));

  const allConditions = conditions.length > 1
    ? sql`${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
    : conditions[0];

  const users = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      profilePhoto: usersTable.profilePhoto,
      city: usersTable.city,
      skillsOffered: usersTable.skillsOffered,
      skillsNeeded: usersTable.skillsNeeded,
      reputationScore: usersTable.reputationScore,
    })
    .from(usersTable)
    .where(allConditions)
    .orderBy(desc(usersTable.reputationScore))
    .limit(parseInt(limit))
    .offset(skip);

  res.json({ success: true, data: { users, page: parseInt(page) } });
});

router.get("/users/me/notifications", authenticate, async (req, res): Promise<void> => {
  const notifications = await db
    .select()
    .from(notificationsTable)
    .where(eq(notificationsTable.userId, req.user!.id))
    .orderBy(desc(notificationsTable.createdAt))
    .limit(50);

  const unreadCount = notifications.filter((n) => !n.isRead).length;
  res.json({ success: true, data: { notifications, unreadCount } });
});

router.put("/users/me/notifications/all/read", authenticate, async (req, res): Promise<void> => {
  await db
    .update(notificationsTable)
    .set({ isRead: true })
    .where(eq(notificationsTable.userId, req.user!.id));
  res.json({ success: true, message: "All notifications marked as read" });
});

router.put("/users/me/notifications/:id/read", authenticate, async (req, res): Promise<void> => {
  await db
    .update(notificationsTable)
    .set({ isRead: true })
    .where(eq(notificationsTable.id, String(req.params.id)));
  res.json({ success: true, message: "Notification marked as read" });
});

router.get("/users/me/wallet", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [wallet] = await db.select().from(freelanceWalletsTable).where(eq(freelanceWalletsTable.userId, req.user!.id));
  const recentTransactions = await db
    .select()
    .from(transactionsTable)
    .where(eq(transactionsTable.userId, req.user!.id))
    .orderBy(desc(transactionsTable.createdAt))
    .limit(20);
  const recentWithdrawals = await db
    .select()
    .from(withdrawalRequestsTable)
    .where(eq(withdrawalRequestsTable.userId, req.user!.id))
    .orderBy(desc(withdrawalRequestsTable.createdAt))
    .limit(10);
  res.json({ success: true, data: { wallet, recentTransactions, recentWithdrawals } });
});

router.post("/users/me/wallet/withdraw", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { amount, upiId } = req.body;
  if (!amount || amount < 100) {
    res.status(400).json({ success: false, message: "Minimum withdrawal is ₹100" });
    return;
  }
  if (!upiId || !upiId.includes("@")) {
    res.status(400).json({ success: false, message: "Provide a valid UPI ID" });
    return;
  }
  const [wallet] = await db.select().from(freelanceWalletsTable).where(eq(freelanceWalletsTable.userId, req.user!.id));
  if (!wallet) {
    res.status(400).json({ success: false, message: "No wallet found. Please add funds to your wallet first." });
    return;
  }
  if (wallet.balance < amount) {
    res.status(400).json({ success: false, message: "Insufficient balance" });
    return;
  }

  const plan = await getActivePlanForUser(req.user!.id);
  const withdrawalFee = Math.round(amount * plan.serviceFeePercent / 100);
  const netAmount = amount - withdrawalFee;

  try {
    await db.transaction(async (tx) => {
      const deductResult = await tx.execute(
        sql`UPDATE ${freelanceWalletsTable} SET balance = balance - ${amount}, total_withdrawn = COALESCE(total_withdrawn, 0) + ${amount}, updated_at = NOW() WHERE id = ${wallet.id} AND balance >= ${amount}`
      );
      if (deductResult.rowCount === 0) throw new Error("Insufficient balance");

      await tx.insert(withdrawalRequestsTable).values({
        walletId: wallet.id,
        userId: req.user!.id,
        amount,
        upiId,
      });
    });

    await db.insert(notificationsTable).values({
      userId: req.user!.id,
      type: "WITHDRAWAL_REQUESTED",
      title: "Withdrawal request submitted",
      message: `Your withdrawal request for ₹${amount} has been submitted. Admin will process it shortly.`,
      linkUrl: "/dashboard.html",
    });

    res.json({ success: true, message: `Withdrawal request for ₹${amount} submitted. Admin will process it shortly.` });
  } catch (e) {
    if (e instanceof Error && e.message === "Insufficient balance") {
      res.status(400).json({ success: false, message: "Insufficient balance" });
    } else {
      res.status(500).json({ success: false, message: "Withdrawal failed. Please try again." });
    }
  }
});

router.post(
  "/users/me/photo",
  authenticate,
  upload.single("photo"),
  async (req, res): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, message: "No photo uploaded" });
        return;
      }

      const supabaseUrl = await uploadToSupabase(fs.readFileSync(req.file.path), req.file.originalname, "profiles");
      const photoUrl = supabaseUrl || `/uploads/profiles/${req.file.filename}`;
      await db
        .update(usersTable)
        .set({ profilePhoto: photoUrl })
        .where(eq(usersTable.id, req.user!.id));

      try { req.app?.get("io")?.emit("profile:updated", { userId: req.user!.id }); } catch {}

      res.json({ success: true, data: { profilePhoto: photoUrl } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, url: req.url, method: req.method }, "Profile photo upload error: " + msg);
      res.status(500).json({ success: false, message: msg });
    }
  },
);

router.put("/users/me/availability", authenticate, async (req, res): Promise<void> => {
  const { isAvailable } = req.body;
  await db.update(usersTable).set({ isAvailable: !!isAvailable }).where(eq(usersTable.id, req.user!.id));
  try { req.app?.get("io")?.emit("profile:updated", { userId: req.user!.id }); } catch {}
  res.json({ success: true, data: { isAvailable: !!isAvailable } });
});

router.put("/users/me", authenticate, async (req, res): Promise<void> => {
  try {
    const { firstName, lastName, bio, tagline, city, country, phone, hourlyRate, languages, skillsOffered, skillsNeeded, portfolioLinks, socialLinks } = req.body;

    const ADMIN_UUID = 'b5ad53bd-6c50-490b-8c3a-d77200f99383';
    if (req.user?.id !== ADMIN_UUID) {
      const fullName = ((firstName || '') + ' ' + (lastName || '')).trim().toLowerCase();
      if (fullName === 'grit&gigs admin' || fullName.indexOf('grit&gigs admin') !== -1) {
        res.status(400).json({ success: false, message: "This name is reserved for the platform administrator. Please choose a different name." });
        return;
      }
    }

    const updates: Partial<typeof usersTable.$inferInsert> = {};
    if (firstName !== undefined) updates.firstName = firstName;
    if (lastName !== undefined) updates.lastName = lastName;
    if (bio !== undefined) updates.bio = bio;
    if (tagline !== undefined) updates.tagline = tagline;
    if (city !== undefined) updates.city = city;
    if (country !== undefined) updates.country = country;
    if (hourlyRate !== undefined) {
      const hr = Number(hourlyRate);
      if (Number.isNaN(hr)) {
        res.status(400).json({ success: false, message: "Invalid hourly rate" });
        return;
      }
      updates.hourlyRate = hr;
    }
    if (languages !== undefined) updates.languages = Array.isArray(languages) ? languages : [languages];
    if (skillsOffered !== undefined) updates.skillsOffered = Array.isArray(skillsOffered) ? skillsOffered : [skillsOffered];
    if (skillsNeeded !== undefined) updates.skillsNeeded = Array.isArray(skillsNeeded) ? skillsNeeded : [skillsNeeded];
    if (portfolioLinks !== undefined) {
      const plan = await getActivePlanForUser(req.user!.id);
      const arr = Array.isArray(portfolioLinks) ? portfolioLinks : [portfolioLinks];
      if (plan.portfolioSlots !== -1 && arr.length > plan.portfolioSlots) {
        res.status(403).json({
          success: false,
          message: `Your ${plan.name} plan allows max ${plan.portfolioSlots} portfolio link${plan.portfolioSlots === 1 ? '' : 's'}. Upgrade your plan to add more.`,
          _planLimitExceeded: true,
        });
        return;
      }
      updates.portfolioLinks = arr;
    }
    if (socialLinks !== undefined) updates.socialLinks = socialLinks;
    const [updated] = await db
      .update(usersTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(usersTable.id, req.user!.id))
      .returning({
        id: usersTable.id,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        bio: usersTable.bio,
        tagline: usersTable.tagline,
        city: usersTable.city,
        country: usersTable.country,
        phone: usersTable.phone,
        hourlyRate: usersTable.hourlyRate,
        languages: usersTable.languages,
        skillsOffered: usersTable.skillsOffered,
        skillsNeeded: usersTable.skillsNeeded,
        portfolioLinks: usersTable.portfolioLinks,
        socialLinks: usersTable.socialLinks,
        profilePhoto: usersTable.profilePhoto,
      });

    try { req.app?.get("io")?.emit("profile:updated", { userId: req.user!.id }); } catch {}

    res.json({ success: true, data: { user: updated }, message: "Profile updated" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, url: req.url, method: req.method }, "Profile update error: " + msg);
    if (msg.includes("users_phone_key")) {
      res.status(409).json({ success: false, message: "This phone number is already registered with another account. Please use a different number." });
      return;
    }
    res.status(500).json({ success: false, message: msg });
  }
});

// -- GET /users/me/notifications/stream -- SSE real-time notifications
// IMPORTANT: this must be registered BEFORE /users/:id to avoid "me" being treated as an id
router.get('/users/me/notifications/stream', async (req, res): Promise<void> => {
  const token = req.query.token as string;
  if (!token) { res.status(401).end(); return; }
  // Verify token manually (same as authenticate middleware)
  let userId: string | null = null;
  try {
    const { verifyAccessToken } = await import('../lib/auth');
    const payload = verifyAccessToken(token);
    userId = (payload as any).id || (payload as any).sub || null;
  } catch (e) { res.status(401).end(); return; }
  if (!userId) { res.status(401).end(); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let lastSeen = new Date();
  // Send keep-alive heartbeat every 20s, check for new notifications
  const interval = setInterval(async () => {
    if (res.writableEnded) { clearInterval(interval); return; }
    try {
      const newNotifs = await db
        .select()
        .from(notificationsTable)
        .where(and(eq(notificationsTable.userId, userId!), gt(notificationsTable.createdAt, lastSeen)))
        .orderBy(desc(notificationsTable.createdAt))
        .limit(5);
      lastSeen = new Date();
      for (const n of newNotifs) {
        if (res.writableEnded) { clearInterval(interval); break; }
        res.write(`event: notification\ndata: ${JSON.stringify({ title: n.title, message: n.message })}\n\n`);
      }
      if (!res.writableEnded) res.write(': heartbeat\n\n');
    } catch (e) { /* DB error — keep alive */ }
  }, 20000);

  req.on('close', () => { clearInterval(interval); res.end(); });
});

// GET /users/by-ggid/:ggid — look up user by platform ID (G&G-XXXXXXXX or just XXXXXXXX)
router.get("/users/by-ggid/:ggid", optionalAuth, async (req, res): Promise<void> => {
  try {
    let raw = req.params.ggid as string;
    // Strip "G&G-" prefix if present
    const prefix = raw.toUpperCase().startsWith("G&G-") ? raw.slice(4) : raw;
    // The ggId is first 8 hex chars of the UUID (uppercased, no dashes)
    if (!/^[0-9A-Fa-f]{8}$/.test(prefix)) {
      res.status(400).json({ success: false, message: "Invalid ggId format. Use G&G-XXXXXXXX or just XXXXXXXX" }); return;
    }
    const hexLower = prefix.toLowerCase();
    // Find users whose UUID starts with those 8 hex chars
    const users = await db
      .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto })
      .from(usersTable)
      .where(sql`LOWER(REPLACE(id::text, '-', '')) LIKE ${hexLower + '%'}`)
      .limit(5);

    if (!users.length) { res.status(404).json({ success: false, message: "No user found with that ggId" }); return; }
    res.json({ success: true, data: { users } });
  } catch (err) {
    console.error("GET /users/by-ggid error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -- GET /users/:id -- public profile (must come AFTER all /users/me/* routes)
router.get("/users/:id", optionalAuth, async (req, res): Promise<void> => {
  try {
    const [user] = await db
      .select({
        id: usersTable.id,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        profilePhoto: usersTable.profilePhoto,
        bio: usersTable.bio,
        tagline: usersTable.tagline,
        city: usersTable.city,
        country: usersTable.country,
        skillsOffered: usersTable.skillsOffered,
        skillsNeeded: usersTable.skillsNeeded,
        languages: usersTable.languages,
        isAvailable: usersTable.isAvailable,
        hourlyRate: usersTable.hourlyRate,
        portfolioLinks: usersTable.portfolioLinks,
        socialLinks: usersTable.socialLinks,
        reputationScore: usersTable.reputationScore,
        emailVerified: usersTable.emailVerified,
        kycVerified: usersTable.kycVerified,
        createdAt: usersTable.createdAt,
        email: usersTable.email,
        phone: usersTable.phone,
      })
      .from(usersTable)
      .where(eq(usersTable.id, String(req.params.id)));

    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    // Active gigs
    const gigs = await db.select().from(servicesTable).where(and(eq(servicesTable.sellerId, user.id), eq(servicesTable.status, "ACTIVE")));

    // Review summary — fetch reviews from both tables
    const allReviews: { id: string; reviewerId: string; rating: number; reviewText: string | null; createdAt: Date; type: string }[] = [];

    // Regular reviews (buyer → seller)
    try {
      const rows = await db.select({
        id: reviewsTable.id,
        reviewerId: reviewsTable.reviewerId,
        rating: reviewsTable.rating,
        reviewText: reviewsTable.reviewText,
        createdAt: reviewsTable.createdAt,
      }).from(reviewsTable).where(eq(reviewsTable.revieweeId, user.id));
      for (const r of rows) {
        allReviews.push({ ...r, type: 'service' });
      }
    } catch (e) {
      console.error('reviews query error:', e);
    }

    // Client reviews (seller → buyer)
    try {
      const rows = await db.select({
        id: clientReviewsTable.id,
        reviewerId: clientReviewsTable.reviewerId,
        rating: clientReviewsTable.rating,
        reviewText: clientReviewsTable.reviewText,
        createdAt: clientReviewsTable.createdAt,
      }).from(clientReviewsTable).where(eq(clientReviewsTable.revieweeId, user.id));
      for (const r of rows) {
        allReviews.push({ ...r, type: 'client' });
      }
    } catch (e) {
      console.error('client_reviews query error:', e);
    }

    // Barter exchange reviews
    try {
      const barterRows = await pool.query(
        `SELECT id, reviewer_id, rating, comment, created_at FROM barter_reviews WHERE reviewee_id = $1`,
        [user.id]
      );
      for (const r of barterRows.rows) {
        allReviews.push({
          id: r.id,
          reviewerId: r.reviewer_id,
          rating: r.rating,
          reviewText: r.comment,
          createdAt: r.created_at,
          type: 'barter',
        });
      }
    } catch (e) {
      // barter_reviews table may not exist on older deployments
    }

    // Project reviews
    try {
      const projRows = await pool.query(
        `SELECT id, reviewer_id, rating, comment, created_at FROM project_reviews WHERE reviewee_id = $1`,
        [user.id]
      );
      for (const r of projRows.rows) {
        allReviews.push({
          id: r.id,
          reviewerId: r.reviewer_id,
          rating: r.rating,
          reviewText: r.comment,
          createdAt: r.created_at,
          type: 'project',
        });
      }
    } catch (e) {
      // project_reviews table may not exist on older deployments
    }

    const avgRating = allReviews.length ? allReviews.reduce((s, r) => s + r.rating, 0) / allReviews.length : null;
    // Fetch reviews with reviewer info
    let reviews: any[] = [];
    if (allReviews.length) {
      const reviewerIds = [...new Set(allReviews.map(r => r.reviewerId))];
      try {
        const reviewers = await db.select({
          id: usersTable.id,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          profilePhoto: usersTable.profilePhoto,
        }).from(usersTable).where(inArray(usersTable.id, reviewerIds));
        const reviewerMap: Record<string, any> = {};
        for (const r of reviewers) {
          reviewerMap[r.id] = { firstName: r.firstName, lastName: r.lastName, profilePhoto: r.profilePhoto };
        }
        allReviews.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        for (const r of allReviews) {
          reviews.push({
            id: r.id,
            rating: r.rating,
            reviewText: r.reviewText,
            createdAt: r.createdAt,
            type: r.type,
            fromUser: reviewerMap[r.reviewerId] || null,
            reviewerId: r.reviewerId,
          });
        }
      } catch (e) {
        console.error('reviewer query error:', e);
      }
    }

    // Plan badge
    const sub = await getOrCreateSubscription(user.id);
    const plan = getPlan(sub.planId);

    // Hide contact info from non-admin viewers
    const viewerIsAdmin = req.user?.role === "ADMIN";
    const viewerIsOwner = req.user?.id === user.id;
    const showContact = viewerIsAdmin || viewerIsOwner;
    const profileUser: Record<string, unknown> = {
      ...user,
      planBadge: plan.badge,
      planName: plan.name,
      ggId: 'G&G-' + user.id.replace(/-/g, '').slice(0, 8).toUpperCase(),
    };
    if (!showContact) {
      delete profileUser.email;
      delete profileUser.phone;
    }

    res.json({
      success: true,
      data: {
        user: profileUser,
        gigs,
        reviewCount: allReviews.length,
        avgRating,
        reviews,
      }
    });
  } catch (err) {
    console.error("GET /users/:id error:", err);
    res.status(500).json({ success: false, message: "Failed to load user profile" });
  }
});

export default router;