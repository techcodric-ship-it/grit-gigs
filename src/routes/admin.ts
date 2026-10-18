import { Router, type IRouter, type Request, type Response } from "express";
import { eq, like, desc, or, and, sql, isNull, inArray, count } from "drizzle-orm";
import {
  db, pool,
  usersTable, notificationsTable,
  freelanceWalletsTable, transactionsTable, withdrawalRequestsTable,
  servicesTable, servicePackagesTable,
  projectsTable, projectBidsTable,
  barterRequestsTable, barterMatchesTable, barterDeliveriesTable,
  ordersTable, orderDeliveriesTable, reviewsTable,
  savedItemsTable,
  reportsTable,
  disputesTable,
  kycDocumentsTable,
  userSubscriptionsTable,
  invitesTable,
  projectMilestonesTable,
  conversationsTable,
  messagesTable,
  clientReviewsTable,
  refreshTokensTable, passwordResetsTable,
  referralsTable,
  jobsTable, jobApplicationsTable,
  squadsTable, squadMembersTable, squadInvitesTable, squadServicesTable,
  communityPostsTable, postBoostsTable,
  communityOrdersTable,
} from "../db";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import multer from "multer";
import path from "path";
import fs from "fs";
import { uploadToSupabase, ensureBucketExists, UPLOADS_BUCKET } from "../lib/storage";
import { PROJECT_ROOT } from "../lib/root";
import { calcWithdrawFee } from "../lib/withdrawals";
import { grantQuotaBundle } from "../lib/community-quota";
import { sendAdminEmail, sendNotificationEmail, layout } from "../lib/email";
import { adminAuth } from "../middlewares/adminAuth";
import { waitlistTable } from "./equity";
import { creditReferrerReward, reverseReferrerReward } from "../lib/referrals";

const uploadsDir = path.join(PROJECT_ROOT, "uploads", "messages");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + "-" + Math.random().toString(36).slice(2) + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

const router: IRouter = Router();

// ── Admin login (standalone — no JWT, no main site auth) ──
router.post("/admin/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password required" });
  }
  if (email.toLowerCase() !== "amuthavananfl@gmail.com") {
    return res.status(401).json({ success: false, message: "Invalid credentials" });
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);
  if (!user) {
    return res.status(401).json({ success: false, message: "Invalid credentials" });
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ success: false, message: "Invalid credentials" });
  }
  const rawSecret = process.env["JWT_SECRET"];
  if (!rawSecret) {
    return res.status(500).json({ success: false, message: "JWT_SECRET not configured" });
  }
  const adminToken = jwt.sign({ userId: user.id, role: "admin" }, rawSecret, { expiresIn: "2h" });
  res.json({ success: true, data: { adminToken } });
});

// ── Admin password reset (uses ADMIN_API_KEY env var) ──
router.post("/admin/reset-password", async (req: Request, res: Response) => {
  const { adminKey, newPassword } = req.body;
  if (!adminKey || !newPassword) {
    return res.status(400).json({ success: false, message: "Admin key and new password required" });
  }
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({ success: false, message: "Invalid admin key" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
  }
  const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
  if (!admin) {
    return res.status(500).json({ success: false, message: "Admin user not found" });
  }
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.update(usersTable).set({ passwordHash, updatedAt: new Date() }).where(eq(usersTable.id, admin.id));
  res.json({ success: true, message: "Admin password reset successful" });
});

// All subsequent routes require the admin API key.
// Scoped to "/admin" on purpose. An unscoped router.use(adminAuth) also runs for
// every request that merely falls through this router, so any unknown /api path
// answered 401 "Invalid or missing admin key" instead of falling through to the
// real 404 handler and hiding typos in route paths.
router.use("/admin", adminAuth);

// ── Check Supabase storage status ──
router.get("/admin/storage/status", async (req: Request, res: Response) => {
  const supabaseUrl = process.env.SUPABASE_URL || "(not set)";
  const hasAnonKey = !!process.env.SUPABASE_ANON_KEY;
  const hasServiceKey = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucketOk = await ensureBucketExists();
  res.json({
    success: true,
    data: {
      supabaseUrl: supabaseUrl !== "(not set)" ? supabaseUrl.substring(0, 30) + "..." : "(not set)",
      anonKeyConfigured: hasAnonKey,
      serviceRoleKeyConfigured: hasServiceKey,
      bucketExists: bucketOk,
      bucketName: UPLOADS_BUCKET,
    },
  });
});

router.get("/admin/me", async (req: Request, res: Response) => {
  const [admin] = await db.select().from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
  if (!admin) return res.status(404).json({ success: false, message: "Admin user not found" });
  res.json({ success: true, data: { id: admin.id, email: admin.email, firstName: admin.firstName, lastName: admin.lastName, profilePhoto: admin.profilePhoto, role: admin.role } });
});

function _ggId(id: string): string {
  return 'G&G-' + id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

function escHtml(s: unknown): string {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Search users by GG ID, name, email, phone ──
router.get("/admin/users/search", async (req: Request, res: Response) => {
  const q = (req.query.q as string || '').trim().toLowerCase();
  if (!q) {
    return res.json({ success: true, data: [] });
  }
  const cleanId = q.replace(/^g&g-/i, '').toLowerCase();
  const cleanPhone = q.replace(/\D/g, '');
  const users = await db.select().from(usersTable).where(
    or(
      like(sql`LOWER(${usersTable.firstName})`, `%${q}%`),
      like(sql`LOWER(${usersTable.lastName})`, `%${q}%`),
      like(sql`LOWER(${usersTable.email})`, `%${q}%`),
      like(sql`LOWER(CAST(${usersTable.id} AS TEXT))`, `%${cleanId}%`),
      cleanPhone.length >= 3 ? like(sql`LOWER(${usersTable.phone})`, `%${cleanPhone}%`) : undefined,
    )
  ).limit(20);
  const data = users.map(u => ({ ...u, ggId: _ggId(u.id) }));
  res.json({ success: true, data });
});

// ── List all users (paginated) ──
router.get("/admin/users", async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
  const offset = (page - 1) * limit;
  const [users, [{ count }]] = await Promise.all([
    db.select().from(usersTable).orderBy(desc(usersTable.createdAt)).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(usersTable),
  ]);
  const data = users.map(u => ({ ...u, ggId: _ggId(u.id) }));
  res.json({ success: true, data, total: Number(count) });
});

// ── Get full user details ──
router.get("/admin/users/:id", async (req: Request, res: Response) => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.params.id as string)).limit(1);
  if (!user) return res.status(404).json({ success: false, message: "User not found" });

  const [wallet] = await db.select().from(freelanceWalletsTable).where(eq(freelanceWalletsTable.userId, user.id)).limit(1);

  const [subscription] = await db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user.id)).limit(1);

  const [kyc] = await db.select().from(kycDocumentsTable).where(eq(kycDocumentsTable.userId, user.id)).limit(1);

  const [{ services }] = await db.select({ services: sql<number>`count(*)` }).from(servicesTable).where(eq(servicesTable.sellerId, user.id));
  const [{ projects }] = await db.select({ projects: sql<number>`count(*)` }).from(projectsTable).where(eq(projectsTable.userId, user.id));
  const [{ barters }] = await db.select({ barters: sql<number>`count(*)` }).from(barterRequestsTable).where(eq(barterRequestsTable.userId, user.id));
  const [{ orders }] = await db.select({ orders: sql<number>`count(*)` }).from(ordersTable).where(or(eq(ordersTable.buyerId, user.id), eq(ordersTable.sellerId, user.id)));
  const [{ disputes }] = await db.select({ disputes: sql<number>`count(*)` }).from(disputesTable).where(eq(disputesTable.raisedById, user.id));

  res.json({
    success: true,
    data: {
      ...user,
      ggId: _ggId(user.id),
      wallet: wallet || null,
      subscription: subscription || null,
      kyc: kyc || null,
      stats: { services, projects, barters, orders, disputes },
    },
  });
});

// ── Admin: update a user's phone number (users cannot change their own) ──
router.put("/admin/users/:id/phone", async (req: Request, res: Response) => {
  const { phone } = req.body ?? {};
  if (!phone || typeof phone !== "string" || !phone.trim()) {
    res.status(400).json({ success: false, message: "A phone number is required" });
    return;
  }
  const normalized = phone.replace(/\D/g, "");
  if (normalized.length < 8 || normalized.length > 15) {
    res.status(400).json({ success: false, message: "Enter a valid phone number" });
    return;
  }
  const [target] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, req.params.id as string)).limit(1);
  if (!target) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  const allPhones = await db.select({ id: usersTable.id, phone: usersTable.phone }).from(usersTable).where(sql`${usersTable.phone} IS NOT NULL`);
  const dup = allPhones.find((p) => p.id !== target.id && p.phone && p.phone.replace(/\D/g, "") === normalized);
  if (dup) {
    res.status(409).json({ success: false, message: "This phone number is already registered to another account" });
    return;
  }
  await db
    .update(usersTable)
    .set({ phone: phone.trim(), phoneVerified: true, updatedAt: new Date() })
    .where(eq(usersTable.id, target.id));
  res.json({ success: true, message: "Phone number updated" });
});

// ── Ban / Unban user ──
router.put("/admin/users/:id/ban", async (req: Request, res: Response) => {
  await db.update(usersTable).set({ isActive: false, updatedAt: new Date() }).where(eq(usersTable.id, req.params.id as string));
  res.json({ success: true, message: "User banned" });
});
router.put("/admin/users/:id/unban", async (req: Request, res: Response) => {
  await db.update(usersTable).set({ isActive: true, updatedAt: new Date() }).where(eq(usersTable.id, req.params.id as string));
  res.json({ success: true, message: "User unbanned" });
});

// ── Delete user ──
router.delete("/admin/users/:id", async (req: Request, res: Response) => {
  const userId = req.params.id as string;
  const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) return res.status(404).json({ success: false, message: "User not found" });

  // Get user's orders, conversations, barter matches, projects
  const [userOrders, userConvs, userProjects] = await Promise.all([
    db.select({ id: ordersTable.id }).from(ordersTable).where(or(eq(ordersTable.buyerId, userId), eq(ordersTable.sellerId, userId))),
    db.select({ id: conversationsTable.id }).from(conversationsTable).where(or(eq(conversationsTable.user1Id, userId), eq(conversationsTable.user2Id, userId))),
    db.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.userId, userId)),
  ]);
  const orderIds = userOrders.map(o => o.id);
  const convIds = userConvs.map(c => c.id);
  const projectIds = userProjects.map(p => p.id);
  const [userBarterMatches] = await Promise.all([
    db.select({ id: barterMatchesTable.id }).from(barterMatchesTable).where(or(eq(barterMatchesTable.user1Id, userId), eq(barterMatchesTable.user2Id, userId))),
  ]);
  const barterMatchIds = userBarterMatches.map(b => b.id);

  // Clean up FK constraints in reverse dependency order
  if (convIds.length) {
    await db.delete(messagesTable).where(inArray(messagesTable.conversationId, convIds));
    await db.delete(conversationsTable).where(inArray(conversationsTable.id, convIds));
  }
  if (orderIds.length) {
    await db.delete(orderDeliveriesTable).where(inArray(orderDeliveriesTable.orderId, orderIds));
    await db.delete(reviewsTable).where(or(inArray(reviewsTable.orderId, orderIds), eq(reviewsTable.reviewerId, userId), eq(reviewsTable.revieweeId, userId)));
    await db.delete(ordersTable).where(inArray(ordersTable.id, orderIds));
  }
  if (projectIds.length) {
    await db.delete(projectBidsTable).where(inArray(projectBidsTable.projectId, projectIds));
    await db.delete(projectMilestonesTable).where(inArray(projectMilestonesTable.projectId, projectIds));
    await db.delete(projectsTable).where(inArray(projectsTable.id, projectIds));
  }
  if (barterMatchIds.length) {
    await db.delete(barterDeliveriesTable).where(inArray(barterDeliveriesTable.matchId, barterMatchIds));
    await db.delete(barterMatchesTable).where(inArray(barterMatchesTable.id, barterMatchIds));
  }
  await db.delete(projectBidsTable).where(eq(projectBidsTable.userId, userId));
  await db.delete(freelanceWalletsTable).where(eq(freelanceWalletsTable.userId, userId));
  await db.delete(withdrawalRequestsTable).where(eq(withdrawalRequestsTable.userId, userId));
  await db.delete(kycDocumentsTable).where(eq(kycDocumentsTable.userId, userId));
  await db.delete(notificationsTable).where(eq(notificationsTable.userId, userId));
  await db.delete(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, userId));
  await db.delete(refreshTokensTable).where(eq(refreshTokensTable.userId, userId));
  await db.delete(passwordResetsTable).where(eq(passwordResetsTable.userId, userId));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, userId));
  await db.delete(clientReviewsTable).where(or(eq(clientReviewsTable.reviewerId, userId), eq(clientReviewsTable.revieweeId, userId)));
  await db.delete(barterDeliveriesTable).where(eq(barterDeliveriesTable.userId, userId));
  await db.delete(savedItemsTable).where(eq(savedItemsTable.userId, userId));
  await db.delete(reportsTable).where(or(eq(reportsTable.reportedById, userId), and(eq(reportsTable.targetType, 'USER'), eq(reportsTable.targetId, userId))));
  await db.delete(invitesTable).where(or(eq(invitesTable.fromUserId, userId), eq(invitesTable.toUserId, userId)));
  await db.delete(projectMilestonesTable).where(inArray(projectMilestonesTable.projectId, projectIds));
  await db.delete(servicesTable).where(eq(servicesTable.sellerId, userId));

  await db.delete(usersTable).where(eq(usersTable.id, userId));
  res.json({ success: true, message: "User deleted" });
});

// ── User's services ──
router.get("/admin/users/:id/services", async (req: Request, res: Response) => {
  const rows = await       db.select().from(servicesTable).where(eq(servicesTable.sellerId, req.params.id as string)).orderBy(desc(servicesTable.createdAt));
  res.json({ success: true, data: rows });
});

// ── User's projects ──
router.get("/admin/users/:id/projects", async (req: Request, res: Response) => {
  const rows = await db.select().from(projectsTable).where(eq(projectsTable.userId, req.params.id as string)).orderBy(desc(projectsTable.createdAt));
  const data = await Promise.all(rows.map(async (p) => {
    const bids = await db.select().from(projectBidsTable).where(eq(projectBidsTable.projectId, p.id));
    return { ...p, bids };
  }));
  res.json({ success: true, data });
});

// ── User's barters ──
router.get("/admin/users/:id/barters", async (req: Request, res: Response) => {
  const rows = await db.select().from(barterRequestsTable).where(eq(barterRequestsTable.userId, req.params.id as string)).orderBy(desc(barterRequestsTable.createdAt));
  res.json({ success: true, data: rows });
});

// ── User's orders ──
router.get("/admin/users/:id/orders", async (req: Request, res: Response) => {
  const rows = await db.select().from(ordersTable).where(
    or(eq(ordersTable.buyerId, req.params.id as string), eq(ordersTable.sellerId, req.params.id as string))
  ).orderBy(desc(ordersTable.createdAt));
  res.json({ success: true, data: rows });
});

// ── User's wallet & transactions ──
router.get("/admin/users/:id/wallet", async (req: Request, res: Response) => {
  const [wallet] = await db.select().from(freelanceWalletsTable).where(eq(freelanceWalletsTable.userId, req.params.id as string)).limit(1);
  const txns = await db.select().from(transactionsTable).where(eq(transactionsTable.userId, req.params.id as string)).orderBy(desc(transactionsTable.createdAt)).limit(100);
  res.json({ success: true, data: { wallet: wallet || null, transactions: txns } });
});

// ── User's saved items ──
router.get("/admin/users/:id/saved", async (req: Request, res: Response) => {
  const rows = await db.select().from(savedItemsTable).where(eq(savedItemsTable.userId, req.params.id as string)).orderBy(desc(savedItemsTable.createdAt));
  res.json({ success: true, data: rows });
});

// ── User's reports ──
router.get("/admin/users/:id/reports", async (req: Request, res: Response) => {
  const rows = await db.select().from(reportsTable).where(eq(reportsTable.reportedById, req.params.id as string)).orderBy(desc(reportsTable.createdAt));
  res.json({ success: true, data: rows });
});

// ── User's disputes ──
router.get("/admin/users/:id/disputes", async (req: Request, res: Response) => {
  const rows = await db.select().from(disputesTable).where(eq(disputesTable.raisedById, req.params.id as string)).orderBy(desc(disputesTable.createdAt));
  res.json({ success: true, data: rows });
});

// ── User's KYC ──
router.get("/admin/users/:id/kyc", async (req: Request, res: Response) => {
  const rows = await db.select().from(kycDocumentsTable).where(eq(kycDocumentsTable.userId, req.params.id as string)).orderBy(desc(kycDocumentsTable.submittedAt));
  res.json({ success: true, data: rows });
});

// ── Pending KYC reviews (users who have submitted documents) ──
router.get("/admin/kyc/pending", async (req: Request, res: Response) => {
  const docs = await db.select({
    id: kycDocumentsTable.id, userId: kycDocumentsTable.userId,
    docType: kycDocumentsTable.docType, fileUrl: kycDocumentsTable.fileUrl,
    status: kycDocumentsTable.status, submittedAt: kycDocumentsTable.submittedAt,
    firstName: usersTable.firstName, lastName: usersTable.lastName,
    email: usersTable.email,
  }).from(kycDocumentsTable)
    .innerJoin(usersTable, eq(usersTable.id, kycDocumentsTable.userId))
    .where(eq(kycDocumentsTable.status, "PENDING"))
    .orderBy(desc(kycDocumentsTable.submittedAt));
  res.json({ success: true, data: docs });
});

// ── Review KYC ──
router.put("/admin/kyc/:userId/review", async (req: Request, res: Response) => {
  const { status, reviewNotes } = req.body;
  if (!status || !["APPROVED", "REJECTED"].includes(status)) {
    return res.status(400).json({ success: false, message: "Status must be APPROVED or REJECTED" });
  }
  const [doc] = await db.update(kycDocumentsTable).set({ status, reviewNotes: reviewNotes || null, reviewedAt: new Date() }).where(eq(kycDocumentsTable.userId, req.params.userId as string)).returning();
  if (status === "APPROVED") {
    await db.update(usersTable).set({ kycVerified: true }).where(eq(usersTable.id, req.params.userId as string));
    const [kycUser] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, req.params.userId as string)).limit(1);
    if (kycUser?.email) {
      sendNotificationEmail(kycUser.email, "KYC Approved — You're verified! ✅", "Your identity has been verified. A verified badge is now visible on your profile.", "/dashboard.html?tab=my-profile").catch(() => {});
    }
  }
  await db.insert(notificationsTable).values({
    userId: req.params.userId as string, type: "KYC",
    title: status === "APPROVED" ? "KYC Approved — You're verified!" : "KYC Review: Action required",
    message: status === "APPROVED"
      ? "Your identity has been verified. A verified badge is now visible on your profile."
      : `Your KYC was not approved. ${reviewNotes ? "Note: " + reviewNotes : "Please re-submit with a clearer document."}`,
    linkUrl: "/dashboard.html?tab=my-profile",
  });
  try { req.app?.get("io")?.emit("profile:updated", { userId: req.params.userId as string }); } catch {}
  res.json({ success: true, data: doc });
});

// ── User's subscription ──
router.get("/admin/users/:id/subscription", async (req: Request, res: Response) => {
  const [sub] = await db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, req.params.id as string)).limit(1);
  res.json({ success: true, data: sub || null });
});

// ── User's invites ──
router.get("/admin/users/:id/invites", async (req: Request, res: Response) => {
  const rows = await db.select().from(invitesTable).where(
    or(eq(invitesTable.fromUserId, req.params.id as string), eq(invitesTable.toUserId, req.params.id as string))
  ).orderBy(desc(invitesTable.createdAt));
  res.json({ success: true, data: rows });
});

// ── Delete any service ──
router.delete("/admin/services/:id", async (req: Request, res: Response) => {
  await db.delete(servicesTable).where(eq(servicesTable.id, req.params.id as string));
  res.json({ success: true, message: "Service deleted" });
});

// ── Delete any project ──
router.delete("/admin/projects/:id", async (req: Request, res: Response) => {
  await db.delete(projectsTable).where(eq(projectsTable.id, req.params.id as string));
  res.json({ success: true, message: "Project deleted" });
});

// ── Delete any barter ──
router.delete("/admin/barters/:id", async (req: Request, res: Response) => {
  await db.delete(barterRequestsTable).where(eq(barterRequestsTable.id, req.params.id as string));
  res.json({ success: true, message: "Barter deleted" });
});

// ── Edit any service ──
const ALLOWED_SERVICE_FIELDS = ["title", "description", "category", "subcategory", "tags", "status", "startingPrice", "deliveryDays", "revisionCount", "images", "thumbnail", "gallery"];
router.put("/admin/services/:id", async (req: Request, res: Response) => {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ALLOWED_SERVICE_FIELDS) {
    if (key in req.body) updates[key] = req.body[key];
  }
  const [updated] = await db.update(servicesTable).set(updates).where(eq(servicesTable.id, req.params.id as string)).returning();
  res.json({ success: true, data: updated });
});

// ── Edit any project ──
const ALLOWED_PROJECT_FIELDS = ["title", "description", "category", "skills", "budgetMin", "budgetMax", "status", "deadline", "imageUrl"];
router.put("/admin/projects/:id", async (req: Request, res: Response) => {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ALLOWED_PROJECT_FIELDS) {
    if (key in req.body) updates[key] = req.body[key];
  }
  const [updated] = await db.update(projectsTable).set(updates).where(eq(projectsTable.id, req.params.id as string)).returning();
  res.json({ success: true, data: updated });
});

// ── Dashboard stats ──
router.get("/admin/stats", async (req: Request, res: Response) => {
  const [[{ users }], [{ services }], [{ projects }], [{ barters }], [{ orders }], [{ disputes }], [{ kycPending }], [{ gmv }], [{ topups }], [{ commissionsPaid }], [{ walletBalance }], [{ totalWithdrawn }], [{ pendingWithdrawals }], [{ activeSubs }], [{ communityPosts }], [{ spotlightEarnings }]] = await Promise.all([
    db.select({ users: sql<number>`count(*)` }).from(usersTable),
    db.select({ services: sql<number>`count(*)` }).from(servicesTable),
    db.select({ projects: sql<number>`count(*)` }).from(projectsTable),
    db.select({ barters: sql<number>`count(*)` }).from(barterRequestsTable),
    db.select({ orders: sql<number>`count(*)` }).from(ordersTable),
    db.select({ disputes: sql<number>`count(*)` }).from(disputesTable),
    db.select({ kycPending: sql<number>`count(*)` }).from(kycDocumentsTable).where(eq(kycDocumentsTable.status, "PENDING")),
    db.select({ gmv: sql<number>`COALESCE(SUM(${ordersTable.priceInr}), 0)` }).from(ordersTable),
    db.select({ topups: sql<number>`COALESCE(SUM(${transactionsTable.amount}), 0)` }).from(transactionsTable).where(and(eq(transactionsTable.type, "CREDIT_PURCHASE"), eq(transactionsTable.status, "COMPLETED"))),
    db.select({ commissionsPaid: sql<number>`COALESCE(SUM(${transactionsTable.amount}), 0)` }).from(transactionsTable).where(and(eq(transactionsTable.type, "COMMISSION"), eq(transactionsTable.status, "COMPLETED"))),
    db.select({ walletBalance: sql<number>`COALESCE(SUM(${freelanceWalletsTable.balance}), 0)` }).from(freelanceWalletsTable),
    db.select({ totalWithdrawn: sql<number>`COALESCE(SUM(${freelanceWalletsTable.totalWithdrawn}), 0)` }).from(freelanceWalletsTable),
    db.select({ pendingWithdrawals: sql<number>`count(*)` }).from(withdrawalRequestsTable).where(eq(withdrawalRequestsTable.status, "PENDING")),
    db.select({ activeSubs: sql<number>`count(*)` }).from(userSubscriptionsTable).where(and(sql`${userSubscriptionsTable.planId} <> 'starter'`, sql`${userSubscriptionsTable.expiresAt} > NOW()`)),
    db.select({ communityPosts: sql<number>`count(*)` }).from(communityPostsTable),
    db.select({ spotlightEarnings: sql<number>`COALESCE(SUM(${transactionsTable.amount}), 0)` }).from(transactionsTable).where(and(eq(transactionsTable.type, "SERVICE_PAYMENT"), eq(transactionsTable.status, "COMPLETED"), sql`${transactionsTable.description} LIKE 'Spotlight%'`)),
  ]);
  res.json({
    success: true,
    data: {
      users, services, projects, barters, orders, disputes, kycPending,
      gmv, topups, commissionsPaid, walletBalance, totalWithdrawn,
      pendingWithdrawals, activeSubs, communityPosts, spotlightEarnings,
    },
  });
});

// ── List all reports (with reporter & basic target info) ──
router.get("/admin/reports", async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  const offset = (page - 1) * limit;
  const statusFilter = req.query.status as string | undefined;
  const conditions: ReturnType<typeof eq>[] = [];
  if (statusFilter && ["OPEN", "RESOLVED", "DISMISSED"].includes(statusFilter)) {
    conditions.push(eq(reportsTable.status, statusFilter as any));
  }
  const [rows, [{ count }]] = await Promise.all([
    db.select({
      id: reportsTable.id,
      targetType: reportsTable.targetType,
      targetId: reportsTable.targetId,
      reason: reportsTable.reason,
      status: reportsTable.status,
      adminNotes: reportsTable.adminNotes,
      createdAt: reportsTable.createdAt,
      reportedById: reportsTable.reportedById,
      reporterFirstName: usersTable.firstName,
      reporterLastName: usersTable.lastName,
      reporterEmail: usersTable.email,
    })
      .from(reportsTable)
      .leftJoin(usersTable, eq(reportsTable.reportedById, usersTable.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(reportsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(reportsTable)
      .where(conditions.length ? and(...conditions) : undefined),
  ]);
  res.json({ success: true, data: rows, total: Number(count) });
});

// ── Get single report detail ──
router.get("/admin/reports/:id", async (req: Request, res: Response) => {
  const [report] = await db.select({
    id: reportsTable.id,
    targetType: reportsTable.targetType,
    targetId: reportsTable.targetId,
    reason: reportsTable.reason,
    status: reportsTable.status,
    adminNotes: reportsTable.adminNotes,
    createdAt: reportsTable.createdAt,
    reportedById: reportsTable.reportedById,
    reporterFirstName: usersTable.firstName,
    reporterLastName: usersTable.lastName,
    reporterEmail: usersTable.email,
  })
    .from(reportsTable)
    .leftJoin(usersTable, eq(reportsTable.reportedById, usersTable.id))
    .where(eq(reportsTable.id, req.params.id as string))
    .limit(1);
  if (!report) return res.status(404).json({ success: false, message: "Report not found" });
  res.json({ success: true, data: report });
});

// ── Take action on a report ──
router.put("/admin/reports/:id/action", async (req: Request, res: Response) => {
  const { status, adminNotes } = req.body;
  if (!status || !["RESOLVED", "DISMISSED"].includes(status)) {
    return res.status(400).json({ success: false, message: "Status must be RESOLVED or DISMISSED" });
  }
  const [updated] = await db.update(reportsTable)
    .set({ status, adminNotes: adminNotes || null })
    .where(eq(reportsTable.id, req.params.id as string))
    .returning();
  // Send inbox message to reporter
  if (updated && updated.reportedById) {
    try {
      const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
      if (admin) {
        const msg = `Your report has been reviewed and ${status.toLowerCase()}.${adminNotes ? `\n\nAdmin notes: ${adminNotes}` : ''}`;
        await _adminSendMessage(admin.id, updated.reportedById, msg, req);
      }
    } catch {}
  }
  res.json({ success: true, data: updated });
});

// ── Upload files (admin) ──
const profileUploadsDir = path.join(PROJECT_ROOT, "uploads", "profiles");
if (!fs.existsSync(profileUploadsDir)) fs.mkdirSync(profileUploadsDir, { recursive: true });

const profileStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, profileUploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, "admin-" + Date.now() + ext);
  },
});
const profileUpload = multer({ storage: profileStorage, limits: { fileSize: 5 * 1024 * 1024 } });

router.post("/admin/profile/photo", profileUpload.single("photo"), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No photo uploaded" });
  }
  const supabaseUrl = await uploadToSupabase(fs.readFileSync(req.file.path), req.file.originalname, "profiles");
  const photoUrl = supabaseUrl || `/uploads/profiles/${req.file.filename}`;
  const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
  if (!admin) return res.status(500).json({ success: false, message: "Admin user not found" });
  await db.update(usersTable).set({ profilePhoto: photoUrl }).where(eq(usersTable.id, admin.id));
  res.json({ success: true, data: { profilePhoto: photoUrl } });
});

router.post("/admin/upload", upload.array("files", 10), async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) {
    return res.status(400).json({ success: false, message: "No files uploaded" });
  }
  const result: { name: string; url: string; size: number; mimeType: string }[] = [];
  for (const f of files) {
    const supabaseUrl = await uploadToSupabase(fs.readFileSync(f.path), f.originalname, "messages");
    if (!supabaseUrl) {
      result.push({ name: f.originalname, url: `/uploads/messages/${f.filename}`, size: f.size, mimeType: f.mimetype });
    } else {
      result.push({ name: f.originalname, url: supabaseUrl, size: f.size, mimeType: f.mimetype });
    }
  }
  res.json({ success: true, data: { files: result } });
});

// ── List all admin conversations ──
router.get("/admin/conversations", async (req: Request, res: Response) => {
  try {
    const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
    if (!admin) return res.status(500).json({ success: false, message: "Admin user not found" });
    const adminId = admin.id;
    const conversations = await db.select().from(conversationsTable).where(
      or(eq(conversationsTable.user1Id, adminId), eq(conversationsTable.user2Id, adminId)),
    ).orderBy(desc(conversationsTable.lastMessageAt));
    if (!conversations.length) return res.json({ success: true, data: [] });
    const otherIds = conversations.map(c => c.user1Id === adminId ? c.user2Id : c.user1Id);
    const convIds = conversations.map(c => c.id);
    const [users, lastMsgs, unreadCounts] = await Promise.all([
      db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, kycVerified: usersTable.kycVerified })
        .from(usersTable).where(inArray(usersTable.id, otherIds)),
      (async () => {
        const r = await pool.query(`SELECT DISTINCT ON (conversation_id) conversation_id AS "conversationId", id, sender_id AS "senderId", message_text AS "messageText", created_at AS "createdAt", attachments FROM messages WHERE conversation_id = ANY($1::uuid[]) ORDER BY conversation_id, created_at DESC`, [convIds]);
        return r.rows;
      })(),
      (async () => {
        const r = await pool.query(`SELECT conversation_id, COUNT(*)::int AS cnt FROM messages WHERE conversation_id = ANY($1::uuid[]) AND sender_id != $2 AND read_at IS NULL GROUP BY conversation_id`, [convIds, adminId]);
        return r.rows;
      })(),
    ]);
    const userMap = new Map(users.map(u => [u.id, u]));
    const lastMsgMap = new Map((lastMsgs || []).map(m => [m.conversationId, m]));
    const unreadMap = new Map((unreadCounts || []).map(r => [r.conversation_id, r.cnt]));
    const result = conversations.map(c => {
      const otherId = c.user1Id === adminId ? c.user2Id : c.user1Id;
      const other = userMap.get(otherId) ?? null;
      return { ...c, otherUser: other, lastMessage: lastMsgMap.get(c.id) ?? null, unreadCount: unreadMap.get(c.id) ?? 0 };
    });
    // Mark messages as read (by admin)
    for (const c of conversations) {
      await db.update(messagesTable).set({ readAt: new Date() }).where(and(eq(messagesTable.conversationId, c.id), sql`${messagesTable.senderId} != ${adminId}`, sql`${messagesTable.readAt} IS NULL`));
    }
    res.json({ success: true, data: result });
  } catch (err) { console.error("admin conversations error:", err); res.status(500).json({ success: false, message: "Failed to load conversations" }); }
});

// ── Get messages for a conversation ──
router.get("/admin/conversations/:id/messages", async (req: Request, res: Response) => {
  try {
    const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
    if (!admin) return res.status(500).json({ success: false, message: "Admin user not found" });
    const messages = await db.select().from(messagesTable).where(eq(messagesTable.conversationId, req.params.id as string)).orderBy(messagesTable.createdAt);
    const senderIds = [...new Set(messages.map(m => m.senderId))];
    const senders = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto }).from(usersTable).where(inArray(usersTable.id, senderIds));
    const senderMap = new Map(senders.map(s => [s.id, s]));
    // Add admin sender info for messages from admin
    const result = messages.map(m => ({
      ...m, sender: m.senderId === admin.id ? { id: admin.id, firstName: "Grit&Gigs", lastName: "Admin", profilePhoto: senders.find(s => s.id === admin.id)?.profilePhoto ?? null } : (senderMap.get(m.senderId) ?? null),
    }));
    res.json({ success: true, data: result });
  } catch (err) { console.error("admin messages error:", err); res.status(500).json({ success: false, message: "Failed to load messages" }); }
});

// ── Reply to a conversation ──
router.post("/admin/conversations/:id/reply", async (req: Request, res: Response) => {
  try {
    const { messageText, attachments } = req.body;
    if (!messageText?.trim()) return res.status(400).json({ success: false, message: "Message text required" });
    const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
    if (!admin) return res.status(500).json({ success: false, message: "Admin user not found" });
    const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, req.params.id as string)).limit(1);
    if (!conv) return res.status(404).json({ success: false, message: "Conversation not found" });
    const otherUserId = conv.user1Id === admin.id ? conv.user2Id : conv.user1Id;
    const msg = await _adminSendMessage(admin.id, otherUserId, messageText.trim(), req, attachments || []);
    res.json({ success: true, data: msg });
  } catch (err) { console.error("admin reply error:", err); res.status(500).json({ success: false, message: "Failed to send reply" }); }
});

// ── Send announcement to all users (in-app messages only) ──
router.post("/admin/announcement", async (req: Request, res: Response) => {
  try {
    const { messageText } = req.body;
    if (!messageText?.trim()) return res.status(400).json({ success: false, message: "Message text required" });
    const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
    if (!admin) return res.status(500).json({ success: false, message: "Admin user not found" });
    const allUsers = await db.select({ id: usersTable.id }).from(usersTable);
    let sent = 0;
    for (const user of allUsers) {
      if (user.id === admin.id) continue;
      await _adminSendMessage(admin.id, user.id, messageText.trim(), req, []);
      sent++;
    }
    res.json({ success: true, data: { total: allUsers.length - 1, sent } });
  } catch (err) { console.error("admin announcement error:", err); res.status(500).json({ success: false, message: "Failed to send announcement" }); }
});

// ── Send email to all users ──
router.post("/admin/email-all", async (req: Request, res: Response) => {
  try {
    const { subject, message, filter } = req.body;
    if (!subject?.trim() || !message?.trim()) return res.status(400).json({ success: false, message: "Subject and message required" });
    const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
    if (!admin) return res.status(500).json({ success: false, message: "Admin user not found" });
    const whereClause = filter === "no-kyc" ? and(eq(usersTable.isActive, true), eq(usersTable.kycVerified, false)) : eq(usersTable.isActive, true);
    const allUsers = await db.select({ email: usersTable.email }).from(usersTable).where(whereClause);
    const recipients = allUsers.filter(u => u.email !== "amuthavananfl@gmail.com").map(u => u.email);
    if (!recipients.length) return res.json({ success: true, data: { sent: 0 } });
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const FROM_EMAIL = process.env.EMAIL_FROM || "Grit&Gigs <team@gritandgigs.in>";
    if (!RESEND_API_KEY) return res.status(500).json({ success: false, message: "Resend API key not configured" });
    const html = `<p>${message.trim().replace(/\n/g, "<br/>")}</p>`;
    let sent = 0;
    for (const email of recipients) {
      try {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: FROM_EMAIL, to: email, subject: subject.trim(), html: layout(html) }),
        });
        if (r.ok) sent++;
        else {
          const body = await r.text();
          console.error("=== email-all individual error ===", { email, status: r.status, body: body.substring(0, 300) });
        }
      } catch (e) { console.error("=== email-all individual error ===", { email, error: e }); }
    }
    res.json({ success: sent > 0, data: { sent, total: recipients.length } });
  } catch (err) { console.error("admin email-all error:", err); res.status(500).json({ success: false, message: "Failed to send email" }); }
});

// ── Send a message from admin to any user ──
router.post("/admin/users/:id/message", async (req: Request, res: Response) => {
  const { messageText, attachments } = req.body;
  if (!messageText?.trim() && (!attachments || !attachments.length)) {
    return res.status(400).json({ success: false, message: "Message text or attachment required" });
  }
  const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
  if (!admin) return res.status(500).json({ success: false, message: "Admin user not found" });
  const msg = await _adminSendMessage(admin.id, req.params.id as string, (messageText || "").trim(), req, attachments || []);
  res.json({ success: true, data: msg });
});

// ── Helper: send a message from admin to a user ──
async function _adminSendMessage(adminId: string, userId: string, text: string, req: Request, attachments: any[] = []) {
  const [existing] = await db.select().from(conversationsTable).where(
    and(
      or(
        and(eq(conversationsTable.user1Id, adminId), eq(conversationsTable.user2Id, userId)),
        and(eq(conversationsTable.user1Id, userId), eq(conversationsTable.user2Id, adminId)),
      ),
      sql`${conversationsTable.orderId} IS NULL AND ${conversationsTable.matchId} IS NULL AND ${conversationsTable.projectBidId} IS NULL`,
    ),
  ).limit(1);
  let conv = existing;
  if (!conv) {
    [conv] = await db.insert(conversationsTable).values({
      user1Id: adminId, user2Id: userId, lastMessageAt: new Date(),
    }).returning();
  }
  const [message] = await db.insert(messagesTable).values({
    conversationId: conv.id, senderId: adminId, messageText: text, attachments,
  }).returning();
  await db.update(conversationsTable).set({ lastMessageAt: new Date() }).where(eq(conversationsTable.id, conv.id));
  try {
    const io = req.app?.get("io");
    if (io) {
      const [adminUser] = await db.select({ profilePhoto: usersTable.profilePhoto }).from(usersTable).where(eq(usersTable.id, adminId)).limit(1);
      const adminSender = { id: adminId, firstName: "Grit&Gigs", lastName: "Admin", profilePhoto: adminUser?.profilePhoto ?? null };
      io.to(`conv:${conv.id}`).emit("message:new", { ...message, sender: adminSender });
      io.to(`user:${userId}`).emit("notification:new", {
        type: "NEW_MESSAGE", title: "Grit&Gigs Admin",
        message: text.slice(0, 60), conversationId: conv.id,
      });
    }
  } catch {}
  return message;
}

// ── MicroEquity Waitlist ──
router.get("/admin/equity/waitlist", async (req: Request, res: Response) => {
  try {
    const entries = await db
      .select({
        id: waitlistTable.id,
        userId: waitlistTable.userId,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        email: usersTable.email,
        joinedAt: waitlistTable.createdAt,
      })
      .from(waitlistTable)
      .leftJoin(usersTable, eq(waitlistTable.userId, usersTable.id))
      .orderBy(desc(waitlistTable.createdAt));
    res.json({ success: true, data: entries });
  } catch (err) {
    console.error("admin equity waitlist error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch waitlist" });
  }
});

// ── Admin: pending withdrawals (manual payout) ──
router.get("/admin/withdrawals/pending", async (_req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        id: withdrawalRequestsTable.id,
        userId: withdrawalRequestsTable.userId,
        amount: withdrawalRequestsTable.amount,
        upiId: withdrawalRequestsTable.upiId,
        bankName: withdrawalRequestsTable.bankName,
        accountNumber: withdrawalRequestsTable.accountNumber,
        ifscCode: withdrawalRequestsTable.ifscCode,
        accountName: withdrawalRequestsTable.accountName,
        createdAt: withdrawalRequestsTable.createdAt,
        userFirstName: usersTable.firstName,
        userLastName: usersTable.lastName,
        userEmail: usersTable.email,
        walletBalance: freelanceWalletsTable.balance,
      })
      .from(withdrawalRequestsTable)
      .leftJoin(usersTable, eq(withdrawalRequestsTable.userId, usersTable.id))
      .leftJoin(freelanceWalletsTable, eq(withdrawalRequestsTable.walletId, freelanceWalletsTable.id))
      .where(eq(withdrawalRequestsTable.status, "PENDING"))
      .orderBy(desc(withdrawalRequestsTable.createdAt));

    // Flat platform commission on every withdrawal (default 5%)
    const enriched = rows.map((r) => {
      const { feePct, commission, netAmount } = calcWithdrawFee(Number(r.amount));
      return { ...r, commissionPct: feePct, commission, netAmount };
    });

    res.json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch pending withdrawals" });
  }
});

router.post("/admin/withdrawals/confirm/:id", async (req: Request, res: Response) => {
  const wdId = req.params.id as string;
  try {
    const [wd] = await db
      .select({
        id: withdrawalRequestsTable.id,
        userId: withdrawalRequestsTable.userId,
        amount: withdrawalRequestsTable.amount,
        status: withdrawalRequestsTable.status,
        upiId: withdrawalRequestsTable.upiId,
        bankName: withdrawalRequestsTable.bankName,
        accountNumber: withdrawalRequestsTable.accountNumber,
        ifscCode: withdrawalRequestsTable.ifscCode,
        accountName: withdrawalRequestsTable.accountName,
        createdAt: withdrawalRequestsTable.createdAt,
      })
      .from(withdrawalRequestsTable)
      .where(eq(withdrawalRequestsTable.id, wdId))
      .limit(1);
    if (!wd) { res.status(404).json({ success: false, message: "Withdrawal not found" }); return; }
    if (wd.status !== "PENDING") { res.status(400).json({ success: false, message: "Already processed" }); return; }

    const { feePct: commissionPct, commission, netAmount } = calcWithdrawFee(Number(wd.amount));

    const [adminUser] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, "amuthavananfl@gmail.com"))
      .limit(1);

    if (adminUser) {
      const [adminWallet] = await db
        .select({ id: freelanceWalletsTable.id })
        .from(freelanceWalletsTable)
        .where(eq(freelanceWalletsTable.userId, adminUser.id))
        .limit(1);
      if (!adminWallet) {
        await db.insert(freelanceWalletsTable).values({
          userId: adminUser.id,
          balance: 0,
          totalEarned: 0,
          updatedAt: new Date(),
        });
      }
    }

    await db.transaction(async (tx) => {
      if (commission > 0 && adminUser) {
        await tx.execute(
          sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${commission}, total_earned = COALESCE(total_earned, 0) + ${commission}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${adminUser.id}`
        );

        await tx.insert(transactionsTable).values({
          userId: adminUser.id,
          type: "COMMISSION",
          amount: commission,
          description: `Withdrawal commission (${commissionPct}%) on ₹${wd.amount}`,
          status: "COMPLETED",
        });
      }

      await tx.update(withdrawalRequestsTable)
        .set({ status: "COMPLETED", processedAt: new Date() })
        .where(eq(withdrawalRequestsTable.id, wd.id));
    });

    // Send admin conversation message to user
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Kolkata" });
    const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata", hour12: true });

    const paymentMethod = wd.upiId
      ? `UPI ID: ${wd.upiId}`
      : `Bank: ${wd.bankName || "N/A"} · A/C: ${wd.accountNumber ? "xxxx" + wd.accountNumber.slice(-4) : "N/A"} · IFSC: ${wd.ifscCode || "N/A"} · Name: ${wd.accountName || "N/A"}`;

    const adminMsg = `✅ Your withdrawal of ₹${netAmount} has been processed and sent to your ${paymentMethod}.\n\nAmount: ₹${netAmount}\nDate: ${dateStr}\nTime: ${timeStr}\n\nThank you for using Grit&Gigs!`;

    await _adminSendMessage(adminUser!.id, wd.userId, adminMsg, req, []);

    await db.insert(notificationsTable).values({
      userId: wd.userId,
      type: "WITHDRAWAL_COMPLETED",
      title: "Withdrawal completed",
      message: `Your withdrawal of ₹${netAmount} has been processed and sent.`,
      linkUrl: "/wallet",
    });

    res.json({ success: true, message: `Withdrawal confirmed — ₹${netAmount} sent to user (₹${commission} commission credited to your wallet)` });
  } catch (err) {
    console.error("confirm withdrawal error:", err);
    res.status(500).json({ success: false, message: "Failed to confirm withdrawal" });
  }
});

// ── Admin: withdrawal history (all statuses) ──
router.get("/admin/withdrawals/history", async (_req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        id: withdrawalRequestsTable.id,
        userId: withdrawalRequestsTable.userId,
        amount: withdrawalRequestsTable.amount,
        upiId: withdrawalRequestsTable.upiId,
        bankName: withdrawalRequestsTable.bankName,
        status: withdrawalRequestsTable.status,
        processedAt: withdrawalRequestsTable.processedAt,
        createdAt: withdrawalRequestsTable.createdAt,
        userFirstName: usersTable.firstName,
        userLastName: usersTable.lastName,
        userEmail: usersTable.email,
      })
      .from(withdrawalRequestsTable)
      .leftJoin(usersTable, eq(withdrawalRequestsTable.userId, usersTable.id))
      .orderBy(desc(withdrawalRequestsTable.createdAt))
      .limit(50);
    const data = rows.map((r) => {
      const { feePct, commission, netAmount } = calcWithdrawFee(Number(r.amount));
      return { ...r, commissionPct: feePct, commission, netAmount };
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch withdrawal history" });
  }
});

// ── Admin: all platform orders ──
router.get("/admin/orders", async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  const offset = (page - 1) * limit;
  const statusFilter = req.query.status as string | undefined;
  const validStatuses = ["PENDING", "ACCEPTED", "IN_PROGRESS", "DELIVERED", "REVISION_REQUESTED", "COMPLETED", "CANCELLED", "DISPUTED"];
  const cond = statusFilter && validStatuses.includes(statusFilter) ? eq(ordersTable.status, statusFilter as never) : undefined;
  const [rows, [{ count }]] = await Promise.all([
    db
      .select({
        id: ordersTable.id,
        priceInr: ordersTable.priceInr,
        status: ordersTable.status,
        createdAt: ordersTable.createdAt,
        completedAt: ordersTable.completedAt,
        buyerId: ordersTable.buyerId,
        sellerId: ordersTable.sellerId,
        serviceId: ordersTable.serviceId,
      })
      .from(ordersTable)
      .where(cond)
      .orderBy(desc(ordersTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(ordersTable).where(cond),
  ]);
  const userIds = [...new Set(rows.flatMap((r) => [r.buyerId, r.sellerId]))];
  const serviceIds = [...new Set(rows.map((r) => r.serviceId))];
  const [userRows, serviceRows] = await Promise.all([
    userIds.length
      ? db.select({ id: usersTable.id, name: sql<string>`TRIM(${usersTable.firstName} || ' ' || ${usersTable.lastName})` }).from(usersTable).where(inArray(usersTable.id, userIds))
      : Promise.resolve([]),
    serviceIds.length
      ? db.select({ id: servicesTable.id, title: servicesTable.title }).from(servicesTable).where(inArray(servicesTable.id, serviceIds))
      : Promise.resolve([]),
  ]);
  const nameById: Record<string, string> = {};
  for (const u of userRows) nameById[u.id] = u.name;
  const titleById: Record<string, string> = {};
  for (const s of serviceRows) titleById[s.id] = s.title;
  const data = rows.map((r) => ({
    ...r,
    buyerName: nameById[r.buyerId] || "—",
    sellerName: nameById[r.sellerId] || "—",
    serviceTitle: titleById[r.serviceId] || "—",
  }));
  res.json({ success: true, data, total: Number(count) });
});

// POST /admin/send-email — manually send an email to a user
router.post("/admin/send-email", adminAuth, async (req: Request, res: Response): Promise<void> => {
  const { to, subject, message } = req.body;
  if (!to || !subject || !message) {
    res.status(400).json({ success: false, message: "to, subject, and message are required" });
    return;
  }
  try {
    const result = await sendAdminEmail(to, subject, message, "gritandgigsofficial@gmail.com");
    if (result) {
      res.json({ success: true, message: "Email sent successfully" });
    } else {
      res.status(502).json({ success: false, message: "Failed to send email — check Resend API key" });
    }
  } catch (err) {
    console.error("send email error:", err);
    res.status(500).json({ success: false, message: "Failed to send email" });
  }
});

// ── Referrals (admin review: view / pay / void) ──────────────────────────────
router.get("/admin/referrals", adminAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const rows = await db
      .select()
      .from(referralsTable)
      .orderBy(desc(referralsTable.createdAt));

    const enriched = await Promise.all(
      rows.map(async (r) => {
        const [referrer] = await db
          .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
          .from(usersTable)
          .where(eq(usersTable.id, r.referrerId))
          .limit(1);
        const [referredUser] = await db
          .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
          .from(usersTable)
          .where(eq(usersTable.id, r.referredUserId))
          .limit(1);
        let projectTitle: string | null = null;
        if (r.projectId) {
          const [p] = await db.select({ title: projectsTable.title }).from(projectsTable).where(eq(projectsTable.id, r.projectId)).limit(1);
          projectTitle = p?.title || null;
        }
        return { ...r, referrer: referrer || null, referredUser: referredUser || null, projectTitle };
      })
    );

    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error("admin referrals error:", err);
    res.status(500).json({ success: false, message: "Failed to load referrals" });
  }
});

// POST /admin/referrals/:id/pay — manually credit the reward (PENDING → PAID)
router.post("/admin/referrals/:id/pay", adminAuth, async (req: Request, res: Response): Promise<void> => {
  const [ref] = await db.select().from(referralsTable).where(eq(referralsTable.id, req.params.id as string)).limit(1);
  if (!ref) {
    res.status(404).json({ success: false, message: "Referral not found" });
    return;
  }
  if (ref.status !== "PENDING") {
    res.status(400).json({ success: false, message: "Only pending referrals can be paid" });
    return;
  }
  const amount = Number(ref.rewardAmount) || 500;
  try {
    await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(referralsTable)
        .set({ status: "PAID", updatedAt: new Date() })
        .where(and(eq(referralsTable.id, ref.id), eq(referralsTable.status, "PENDING")))
        .returning();
      if (!claimed) throw new Error("Referral already processed");
      await creditReferrerReward(tx, claimed.referrerId, amount, "Referral reward (approved by admin)");
    });
    await db.insert(notificationsTable).values({
      userId: ref.referrerId,
      type: "REFERRAL_REWARD",
      title: "Referral reward credited! 🎉",
      message: `Your ₹${amount} referral bonus has been approved and credited. Use it on any service or project.`,
      linkUrl: "/dashboard.html?tab=refer",
    });
    res.json({ success: true, message: `Referral paid — ₹${amount} credited to the referrer` });
  } catch (err) {
    console.error("pay referral error:", err);
    res.status(500).json({ success: false, message: "Failed to pay referral" });
  }
});

// POST /admin/referrals/:id/void — reject/reverse a fake referral
router.post("/admin/referrals/:id/void", adminAuth, async (req: Request, res: Response): Promise<void> => {
  const [ref] = await db.select().from(referralsTable).where(eq(referralsTable.id, req.params.id as string)).limit(1);
  if (!ref) {
    res.status(404).json({ success: false, message: "Referral not found" });
    return;
  }
  if (ref.status === "VOIDED") {
    res.status(400).json({ success: false, message: "Referral is already voided" });
    return;
  }
  const amount = Number(ref.rewardAmount) || 500;
  try {
    await db.transaction(async (tx) => {
      if (ref.status === "PAID") {
        await reverseReferrerReward(tx, ref.referrerId, amount, "Referral reward reversed (voided by admin)");
        if (ref.projectId) {
          await tx.update(projectsTable).set({ zeroCommission: false, updatedAt: new Date() }).where(eq(projectsTable.id, ref.projectId));
        }
      }
      await tx
        .update(referralsTable)
        .set({ status: "VOIDED", updatedAt: new Date() })
        .where(eq(referralsTable.id, ref.id));
    });
    res.json({ success: true, message: ref.status === "PAID" ? "Referral voided — reward reversed" : "Referral voided" });
  } catch (err) {
    console.error("void referral error:", err);
    res.status(500).json({ success: false, message: "Failed to void referral" });
  }
});

// ── Full-time Jobs management ───────────────────────────────────────────────
// GET /admin/jobs — list all jobs (active + paused) with application counts.
router.get("/admin/jobs", async (req: Request, res: Response): Promise<void> => {
  const rows = await db
    .select({
      job: jobsTable,
      applicants: sql<number>`(SELECT count(*) FROM ${jobApplicationsTable} WHERE ${jobApplicationsTable.jobId} = ${jobsTable.id})`,
    })
    .from(jobsTable)
    .orderBy(desc(jobsTable.createdAt));

  res.json({
    success: true,
    data: rows.map((r) => ({ ...r.job, applicants: Number(r.applicants) })),
  });
});

// POST /admin/jobs — create a job posting.
router.post("/admin/jobs", async (req: Request, res: Response): Promise<void> => {
  const { title, company, location, type, salaryRange, description, skills, isActive, applicationDeadline, link } = req.body || {};
  if (!title || !company || !description) {
    res.status(400).json({ success: false, message: "Title, company, and description are required" });
    return;
  }
  const adminUser = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);

  const [job] = await db
    .insert(jobsTable)
    .values({
      title,
      company,
      location: location || null,
      type: type || "Full-time",
      salaryRange: salaryRange || null,
      description,
      skills: Array.isArray(skills) ? skills : String(skills || "").split(",").map((s: string) => s.trim()).filter(Boolean),
      link: link || null,
      postedById: adminUser[0]?.id,
      isActive: isActive !== false,
      applicationDeadline: applicationDeadline ? new Date(applicationDeadline) : null,
    })
    .returning();

  res.status(201).json({ success: true, message: "Job posted", data: job });
});

// PUT /admin/jobs/:id — edit a job or toggle active/paused.
router.put("/admin/jobs/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const { title, company, location, type, salaryRange, description, skills, isActive, applicationDeadline, link } = req.body || {};

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, id)).limit(1);
  if (!job) {
    res.status(404).json({ success: false, message: "Job not found" });
    return;
  }

  const [updated] = await db
    .update(jobsTable)
    .set({
      title: title ?? job.title,
      company: company ?? job.company,
      location: location !== undefined ? location : job.location,
      type: type ?? job.type,
      salaryRange: salaryRange !== undefined ? salaryRange : job.salaryRange,
      description: description ?? job.description,
      skills: Array.isArray(skills) ? skills : job.skills,
      link: link !== undefined ? link : job.link,
      isActive: isActive !== undefined ? !!isActive : job.isActive,
      applicationDeadline: applicationDeadline !== undefined ? (applicationDeadline ? new Date(applicationDeadline) : null) : job.applicationDeadline,
      updatedAt: new Date(),
    })
    .where(eq(jobsTable.id, id))
    .returning();

  res.json({ success: true, message: "Job updated", data: updated });
});

// DELETE /admin/jobs/:id — remove a job (its applications cascade).
router.delete("/admin/jobs/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const [job] = await db.select({ id: jobsTable.id }).from(jobsTable).where(eq(jobsTable.id, id)).limit(1);
  if (!job) {
    res.status(404).json({ success: false, message: "Job not found" });
    return;
  }
  await db.delete(jobsTable).where(eq(jobsTable.id, id));
  res.json({ success: true, message: "Job deleted" });
});

// GET /admin/jobs/:id/applications — applicants for a job with their details.
router.get("/admin/jobs/:id/applications", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const rows = await db
    .select({
      application: jobApplicationsTable,
      applicant: {
        id: usersTable.id,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        email: usersTable.email,
        city: usersTable.city,
        profilePhoto: usersTable.profilePhoto,
        tagline: usersTable.tagline,
        kycVerified: usersTable.kycVerified,
      },
    })
    .from(jobApplicationsTable)
    .innerJoin(usersTable, eq(jobApplicationsTable.applicantId, usersTable.id))
    .where(eq(jobApplicationsTable.jobId, id))
    .orderBy(desc(jobApplicationsTable.createdAt));

  res.json({ success: true, data: rows });
});

// PUT /admin/jobs/:id/applications/:applicationId — update application status.
router.put("/admin/jobs/:id/applications/:applicationId", async (req: Request, res: Response): Promise<void> => {
  const applicationId = String(req.params.applicationId);
  const { status } = req.body || {};
  const valid = ["PENDING", "REVIEWED", "ACCEPTED", "REJECTED"];
  if (!valid.includes(status)) {
    res.status(400).json({ success: false, message: "Invalid status" });
    return;
  }
  const [app] = await db.select().from(jobApplicationsTable).where(eq(jobApplicationsTable.id, applicationId)).limit(1);
  if (!app) {
    res.status(404).json({ success: false, message: "Application not found" });
    return;
  }
  const [updated] = await db
    .update(jobApplicationsTable)
    .set({ status })
    .where(eq(jobApplicationsTable.id, applicationId))
    .returning();
  res.json({ success: true, message: "Application updated", data: updated });
});

// ── Grit Circles / Squads management ──────────────────────────────────────
// GET /admin/squads — all squads (active + archived) with leader and counts.
router.get("/admin/squads", async (_req: Request, res: Response): Promise<void> => {
  const rows = await db
    .select({
      squad: squadsTable,
      leader: {
        id: usersTable.id,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        email: usersTable.email,
        profilePhoto: usersTable.profilePhoto,
      },
      memberCount: sql<number>`(SELECT count(*) FROM ${squadMembersTable} WHERE ${squadMembersTable.squadId} = ${squadsTable.id})`,
      serviceCount: sql<number>`(SELECT count(*) FROM ${squadServicesTable} WHERE ${squadServicesTable.squadId} = ${squadsTable.id} AND ${squadServicesTable.status} <> 'DELETED')`,
      activeServiceCount: sql<number>`(SELECT count(*) FROM ${squadServicesTable} WHERE ${squadServicesTable.squadId} = ${squadsTable.id} AND ${squadServicesTable.status} = 'ACTIVE')`,
      inviteCount: sql<number>`(SELECT count(*) FROM ${squadInvitesTable} WHERE ${squadInvitesTable.squadId} = ${squadsTable.id} AND ${squadInvitesTable.status} = 'PENDING')`,
    })
    .from(squadsTable)
    .innerJoin(usersTable, eq(squadsTable.leaderId, usersTable.id))
    .orderBy(desc(squadsTable.createdAt));

  res.json({
    success: true,
    data: rows.map((r) => ({
      ...r.squad,
      memberCount: Number(r.memberCount),
      serviceCount: Number(r.serviceCount),
      activeServiceCount: Number(r.activeServiceCount),
      inviteCount: Number(r.inviteCount),
      leader: r.leader
        ? { id: r.leader.id, firstName: r.leader.firstName, lastName: r.leader.lastName ?? "", email: r.leader.email, profilePhoto: r.leader.profilePhoto ?? null }
        : null,
    })),
  });
});

// GET /admin/squads/:id — full detail: members, invites, services.
router.get("/admin/squads/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const [squad] = await db.select().from(squadsTable).where(eq(squadsTable.id, id)).limit(1);
  if (!squad) {
    res.status(404).json({ success: false, message: "Squad not found" });
    return;
  }
  const [leader] = await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email, profilePhoto: usersTable.profilePhoto, tagline: usersTable.tagline })
    .from(usersTable)
    .where(eq(usersTable.id, squad.leaderId))
    .limit(1);

  const members = await db
    .select({ member: squadMembersTable, user: usersTable })
    .from(squadMembersTable)
    .innerJoin(usersTable, eq(squadMembersTable.userId, usersTable.id))
    .where(eq(squadMembersTable.squadId, id))
    .orderBy(desc(squadMembersTable.role), desc(squadMembersTable.createdAt));

  const invites = await db
    .select({ invite: squadInvitesTable, user: usersTable })
    .from(squadInvitesTable)
    .leftJoin(usersTable, eq(squadInvitesTable.invitedUserId, usersTable.id))
    .where(eq(squadInvitesTable.squadId, id))
    .orderBy(desc(squadInvitesTable.createdAt));

  const services = await db
    .select()
    .from(squadServicesTable)
    .where(eq(squadServicesTable.squadId, id))
    .orderBy(desc(squadServicesTable.createdAt));

  res.json({
    success: true,
    data: {
      ...squad,
      leader: leader ? { id: leader.id, firstName: leader.firstName, lastName: leader.lastName ?? "", email: leader.email, profilePhoto: leader.profilePhoto ?? null, tagline: leader.tagline ?? null } : null,
      members: members.map((m) => ({ role: m.member.role, joinedAt: m.member.createdAt, user: { id: m.user.id, firstName: m.user.firstName, lastName: m.user.lastName ?? "", email: m.user.email, profilePhoto: m.user.profilePhoto ?? null, tagline: m.user.tagline ?? null } })),
      invites: invites.map((r) => ({ id: r.invite.id, invitedEmail: r.invite.invitedEmail, message: r.invite.message ?? null, status: r.invite.status, createdAt: r.invite.createdAt, respondedAt: r.invite.respondedAt, user: r.user ? { id: r.user.id, firstName: r.user.firstName, lastName: r.user.lastName ?? "", email: r.user.email, profilePhoto: r.user.profilePhoto ?? null } : null })),
      services: services.map((s) => ({ id: s.id, title: s.title, description: s.description, category: s.category ?? null, priceInr: s.priceInr, deliveryDays: s.deliveryDays, skills: s.skills ?? [], status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt })),
    },
  });
});

// PUT /admin/squads/:id — restore / archive a squad.
router.put("/admin/squads/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const { isActive } = req.body || {};
  if (typeof isActive !== "boolean") {
    res.status(400).json({ success: false, message: "isActive (boolean) is required" });
    return;
  }
  const [updated] = await db
    .update(squadsTable)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(squadsTable.id, id))
    .returning({ id: squadsTable.id, isActive: squadsTable.isActive });
  if (!updated) {
    res.status(404).json({ success: false, message: "Squad not found" });
    return;
  }
  res.json({ success: true, message: isActive ? "Squad restored" : "Squad archived", data: updated });
});

// DELETE /admin/squads/:id — archive a squad and notify all members.
router.delete("/admin/squads/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const [squad] = await db.select().from(squadsTable).where(eq(squadsTable.id, id)).limit(1);
  if (!squad) {
    res.status(404).json({ success: false, message: "Squad not found" });
    return;
  }
  await db.update(squadsTable).set({ isActive: false, updatedAt: new Date() }).where(eq(squadsTable.id, id));

  const memberIds: string[] = [];
  if (squad.leaderId) memberIds.push(squad.leaderId);
  const members = await db.select({ userId: squadMembersTable.userId }).from(squadMembersTable).where(eq(squadMembersTable.squadId, id));
  members.forEach((m) => memberIds.push(m.userId));

  if (memberIds.length) {
    const notif = { type: "SQUAD_CLOSED", title: `${squad.name} was closed`, message: "The Grit Circle was closed by the team at Grit&Gigs.", linkUrl: "/dashboard#grit-circle" };
    await db
      .insert(notificationsTable)
      .values(memberIds.map((userId) => ({ userId, ...notif })));
    memberIds.forEach((userId) => {
      try {
        req.app?.get("io")?.to(`user:${userId}`).emit("notification:new", notif);
      } catch {}
    });
  }

  res.json({ success: true, message: "Squad archived and members notified" });
});

// DELETE /admin/squads/:id/members/:memberId — remove a member from a squad.
router.delete("/admin/squads/:id/members/:memberId", async (req: Request, res: Response): Promise<void> => {
  const squadId = String(req.params.id);
  const memberId = String(req.params.memberId);

  const [target] = await db
    .select({ member: squadMembersTable, user: usersTable })
    .from(squadMembersTable)
    .innerJoin(usersTable, eq(squadMembersTable.userId, usersTable.id))
    .where(and(eq(squadMembersTable.squadId, squadId), eq(squadMembersTable.userId, memberId)))
    .limit(1);
  if (!target) {
    res.status(404).json({ success: false, message: "Member not found in this squad" });
    return;
  }
  if (target.member.role === "LEADER") {
    res.status(400).json({ success: false, message: "The leader can't be removed — archive the squad instead" });
    return;
  }
  await db.delete(squadMembersTable).where(eq(squadMembersTable.id, target.member.id));

  const notif = { type: "SQUAD_REMOVED", title: "You were removed from a circle", message: "An admin removed you from your Grit Circle.", linkUrl: "/dashboard#grit-circle" };
  await db.insert(notificationsTable).values({ userId: target.user.id, ...notif });
  try {
    req.app?.get("io")?.to(`user:${target.user.id}`).emit("notification:new", notif);
  } catch {}

  res.json({ success: true, message: "Member removed" });
});

// PUT /admin/squads/services/:serviceId — set status ACTIVE / PAUSED / DELETED.
router.put("/admin/squads/services/:serviceId", async (req: Request, res: Response): Promise<void> => {
  const serviceId = String(req.params.serviceId);
  const { status } = req.body || {};
  if (!["ACTIVE", "PAUSED", "DELETED"].includes(status)) {
    res.status(400).json({ success: false, message: "Invalid status" });
    return;
  }
  const [updated] = await db
    .update(squadServicesTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(squadServicesTable.id, serviceId))
    .returning();
  if (!updated) {
    res.status(404).json({ success: false, message: "Service not found" });
    return;
  }
  res.json({ success: true, message: "Service updated", data: updated });
});

interface ActivityItem {
  id: string;
  type: "POST" | "BID" | "BARTER" | "ORDER" | "WALLET" | "BUNDLE";
  title: string;
  meta: string | null;
  status: string;
  amount: number | null;
  at: Date | null;
  actor: { name: string; email: string | null };
  link: string | null;
}

// ── GET /admin/activity — recent platform activity across all surfaces ──
// One merged, newest-first feed. Each source is capped independently so a
// single busy table cannot starve the others. Sources that fail are reported
// in `errors` rather than failing the whole request.
router.get("/admin/activity", async (req: Request, res: Response): Promise<void> => {
  const limitRaw = Number(req.query.limit ?? 20);
  const limit = Math.min(50, Math.max(5, Number.isFinite(limitRaw) ? limitRaw : 20));
  const errors: string[] = [];

  const nameCols = {
    first: usersTable.firstName,
    last: usersTable.lastName,
    email: usersTable.email,
  };
  const who = (row: Record<string, unknown>) => {
    const u = row.user as { firstName?: string; lastName?: string; email?: string } | null;
    const label = u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email || "Unknown" : "Unknown";
    return { name: label, email: u?.email ?? null };
  };

  const sources: { key: string; run: () => Promise<ActivityItem[]> }[] = [
    {
      // New posts of every kind: POST, GIG, BARTER, PROJECT.
      key: "posts",
      run: async () => {
        const rows = await db
          .select({
            id: communityPostsTable.id,
            kind: communityPostsTable.kind,
            content: communityPostsTable.content,
            status: communityPostsTable.status,
            priceInr: communityPostsTable.priceInr,
            createdAt: communityPostsTable.createdAt,
            user: {
              firstName: nameCols.first,
              lastName: nameCols.last,
              email: nameCols.email,
            },
          })
          .from(communityPostsTable)
          .leftJoin(usersTable, eq(communityPostsTable.userId, usersTable.id))
          .orderBy(desc(communityPostsTable.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: r.id,
          type: "POST",
          title: summarize(r.content, r.kind),
          meta: r.kind,
          status: r.status,
          amount: r.priceInr,
          at: r.createdAt,
          actor: who(r as unknown as Record<string, unknown>),
          link: `/explore?q=${encodeURIComponent(r.id)}`,
        }));
      },
    },
    {
      // Bids placed on client projects.
      key: "bids",
      run: async () => {
        const rows = await db
          .select({
            id: projectBidsTable.id,
            amount: projectBidsTable.amount,
            status: projectBidsTable.status,
            deliveryDays: projectBidsTable.deliveryDays,
            createdAt: projectBidsTable.createdAt,
            proposal: projectBidsTable.proposal,
            projectId: projectBidsTable.projectId,
            projectTitle: projectsTable.title,
            projectBudgetMin: projectsTable.budgetMin,
            projectBudgetMax: projectsTable.budgetMax,
            user: {
              firstName: nameCols.first,
              lastName: nameCols.last,
              email: nameCols.email,
            },
          })
          .from(projectBidsTable)
          .leftJoin(usersTable, eq(projectBidsTable.userId, usersTable.id))
          .leftJoin(projectsTable, eq(projectBidsTable.projectId, projectsTable.id))
          .orderBy(desc(projectBidsTable.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: r.id,
          type: "BID",
          title: r.projectTitle ? `Bid on "${summarize(r.projectTitle, "PROJECT")}"` : "Bid placed",
          meta: bidMeta(r.deliveryDays, r.projectBudgetMin, r.projectBudgetMax),
          status: r.status,
          amount: r.amount,
          at: r.createdAt,
          actor: who(r as unknown as Record<string, unknown>),
          link: r.projectId ? `/projects/${r.projectId}` : null,
        }));
      },
    },
    {
      // Barter matches formed between two members.
      key: "barter",
      run: async () => {
        const rows = await db
          .select({
            id: barterMatchesTable.id,
            status: barterMatchesTable.status,
            createdAt: barterMatchesTable.createdAt,
            user1: {
              firstName: usersTable.firstName,
              lastName: usersTable.lastName,
              email: usersTable.email,
            },
          })
          .from(barterMatchesTable)
          .innerJoin(usersTable, eq(barterMatchesTable.user1Id, usersTable.id))
          .orderBy(desc(barterMatchesTable.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: r.id,
          type: "BARTER",
          title: `Barter match formed with ${(r.user1.firstName ?? "") + " " + (r.user1.lastName ?? "")}`.trim(),
          meta: null,
          status: r.status,
          amount: null,
          at: r.createdAt,
          actor: { name: "Platform", email: null },
          link: `/barter?match=${r.id}`,
        }));
      },
    },
    {
      // Community orders — a buyer ordering a GIG or BARTER post.
      key: "orders",
      run: async () => {
        const rows = await db
          .select({
            id: communityOrdersTable.id,
            kind: communityOrdersTable.kind,
            status: communityOrdersTable.status,
            amount: communityOrdersTable.amount,
            createdAt: communityOrdersTable.createdAt,
            seller: {
              firstName: nameCols.first,
              lastName: nameCols.last,
              email: nameCols.email,
            },
          })
          .from(communityOrdersTable)
          .innerJoin(usersTable, eq(communityOrdersTable.sellerId, usersTable.id))
          .orderBy(desc(communityOrdersTable.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: r.id,
          type: "ORDER",
          title: `${r.kind} order placed`,
          meta: null,
          status: r.status,
          amount: r.amount,
          at: r.createdAt,
          actor: who({ user: r.seller }),
          link: `/orders?id=${r.id}`,
        }));
      },
    },
    {
      // Settled wallet credits — real money in.
      key: "wallet",
      run: async () => {
        const rows = await db
          .select({
            id: transactionsTable.id,
            type: transactionsTable.type,
            amount: transactionsTable.amount,
            status: transactionsTable.status,
            description: transactionsTable.description,
            createdAt: transactionsTable.createdAt,
            user: {
              firstName: nameCols.first,
              lastName: nameCols.last,
              email: nameCols.email,
            },
          })
          .from(transactionsTable)
          .leftJoin(usersTable, eq(transactionsTable.userId, usersTable.id))
          .where(
            and(
              eq(transactionsTable.type, "CREDIT_PURCHASE"),
              eq(transactionsTable.status, "COMPLETED"),
            ),
          )
          .orderBy(desc(transactionsTable.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: r.id,
          type: "WALLET",
          title: r.description || "Wallet top-up",
          meta: null,
          status: r.status,
          amount: Math.round(Number(r.amount)),
          at: r.createdAt,
          actor: who(r as unknown as Record<string, unknown>),
          link: `/wallet`,
        }));
      },
    },
    {
      // Paid quota bundles — proposals and gig posts bought via Buy more.
      key: "bundles",
      run: async () => {
        // Purchase events, not current balances: quota bonuses get spent, so
        // reading community_quotas would repeat live rows and miss paid ones.
        const rows = await db
          .select({
            id: transactionsTable.id,
            amount: transactionsTable.amount,
            status: transactionsTable.status,
            description: transactionsTable.description,
            createdAt: transactionsTable.createdAt,
            user: {
              firstName: nameCols.first,
              lastName: nameCols.last,
              email: nameCols.email,
            },
          })
          .from(transactionsTable)
          .innerJoin(usersTable, eq(transactionsTable.userId, usersTable.id))
          .where(eq(transactionsTable.type, "QUOTA_BUNDLE"))
          .orderBy(desc(transactionsTable.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: r.id,
          type: "BUNDLE" as const,
          title: (r.description || "Quota bundle").replace(/^Pending\s+/, ""),
          meta: "Buy more",
          status: r.status,
          amount: Math.round(Number(r.amount)),
          at: r.createdAt,
          actor: who(r as unknown as Record<string, unknown>),
          link: `/admin/users?q=${encodeURIComponent(r.user.email ?? "")}`,
        }));
      },
    },
  ];

  const settled = await Promise.all(
    sources.map(async (s) => {
      try {
        return await s.run();
      } catch (err) {
        errors.push(s.key);
        console.error(`admin activity source "${s.key}" failed:`, err);
        return [] as ActivityItem[];
      }
    }),
  );

  const items = settled.flat().sort((a, b) => {
    const at = a.at ? new Date(a.at).getTime() : 0;
    const bt = b.at ? new Date(b.at).getTime() : 0;
    return bt - at;
  });

  const counts = {
    posts: settled[0].length,
    bids: settled[1].length,
    barter: settled[2].length,
    orders: settled[3].length,
    wallet: settled[4].length,
    bundles: settled[5].length,
  };

  res.json({ success: true, data: { items: items.slice(0, limit * 3), counts, errors } });
});

/** Builds the secondary line on a bid row: delivery time plus project budget. */
function bidMeta(days: number | null, min: number | null, max: number | null): string | null {
  const parts: string[] = [];
  if (days) parts.push(`${days} day${Number(days) === 1 ? "" : "s"} delivery`);
  if (min != null && max != null && max > 0) {
    parts.push(min > 0 ? `budget ₹${min.toLocaleString("en-IN")}–₹${max.toLocaleString("en-IN")}` : `up to ₹${max.toLocaleString("en-IN")}`);
  } else if (max != null && max > 0) {
    parts.push(`budget ₹${max.toLocaleString("en-IN")}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

/** Trims long post/bid copy down to a single-line summary for the feed. */
function summarize(text: string | null | undefined, kind?: string | null): string {
  const raw = (text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return `${kind ?? "Item"} posted`;
  const cap = 90;
  return raw.length > cap ? raw.slice(0, cap - 1).trimEnd() + "…" : raw;
}

// POST /admin/community/grant-quota — manually credit community quota bundles.
router.post("/admin/community/grant-quota", async (req: Request, res: Response): Promise<void> => {
  const { userId, gigPosts = 0, proposals = 0 } = req.body ?? {};
  if (!userId) {
    res.status(400).json({ success: false, message: "userId is required" });
    return;
  }
  await grantQuotaBundle(String(userId), Math.max(0, Number(gigPosts) || 0), Math.max(0, Number(proposals) || 0));
  res.json({ success: true, message: "Quota credited" });
});

export default router;