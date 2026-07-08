import { Router, type IRouter, type Request, type Response } from "express";
import { eq, like, desc, or, and, sql, isNull, inArray } from "drizzle-orm";
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
} from "../db";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import multer from "multer";
import path from "path";
import fs from "fs";
import { uploadToSupabase, isSupabaseConfigured } from "../lib/storage";
import { PROJECT_ROOT } from "../lib/root";
import { getActivePlanForUser } from "../lib/subscriptions";
import { adminAuth } from "../middlewares/adminAuth";
import { waitlistTable } from "./equity";

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

// All subsequent routes require the admin API key
router.use(adminAuth);

// ── Get admin's own user info ──
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

// ── Search users by GG ID, name, email ──
router.get("/admin/users/search", async (req: Request, res: Response) => {
  const q = (req.query.q as string || '').trim().toLowerCase();
  if (!q) {
    return res.json({ success: true, data: [] });
  }
  const cleanId = q.replace(/^g&g-/i, '').toLowerCase();
  const users = await db.select().from(usersTable).where(
    or(
      like(sql`LOWER(${usersTable.firstName})`, `%${q}%`),
      like(sql`LOWER(${usersTable.lastName})`, `%${q}%`),
      like(sql`LOWER(${usersTable.email})`, `%${q}%`),
      like(sql`LOWER(CAST(${usersTable.id} AS TEXT))`, `%${cleanId}%`),
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
  }
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
  const [[{ users }], [{ services }], [{ projects }], [{ barters }], [{ orders }], [{ disputes }], [{ kycPending }]] = await Promise.all([
    db.select({ users: sql<number>`count(*)` }).from(usersTable),
    db.select({ services: sql<number>`count(*)` }).from(servicesTable),
    db.select({ projects: sql<number>`count(*)` }).from(projectsTable),
    db.select({ barters: sql<number>`count(*)` }).from(barterRequestsTable),
    db.select({ orders: sql<number>`count(*)` }).from(ordersTable),
    db.select({ disputes: sql<number>`count(*)` }).from(disputesTable),
    db.select({ kycPending: sql<number>`count(*)` }).from(kycDocumentsTable).where(eq(kycDocumentsTable.status, "PENDING")),
  ]);
  res.json({ success: true, data: { users, services, projects, barters, orders, disputes, kycPending } });
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
      if (isSupabaseConfigured()) {
        return res.status(500).json({ success: false, message: "File upload failed" });
      }
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
    const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, req.params.id)).limit(1);
    if (!conv) return res.status(404).json({ success: false, message: "Conversation not found" });
    const otherUserId = conv.user1Id === admin.id ? conv.user2Id : conv.user1Id;
    const msg = await _adminSendMessage(admin.id, otherUserId, messageText.trim(), req, attachments || []);
    res.json({ success: true, data: msg });
  } catch (err) { console.error("admin reply error:", err); res.status(500).json({ success: false, message: "Failed to send reply" }); }
});

// ── Send announcement to all users ──
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

    // Enrich each row with commission info based on user's plan
    const enriched = await Promise.all(rows.map(async (r) => {
      let commissionPct = 10;
      try {
        const plan = await getActivePlanForUser(r.userId);
        commissionPct = plan.serviceFeePercent;
      } catch {}
      const commission = Math.round(r.amount * commissionPct / 100);
      return { ...r, commissionPct, commission, netAmount: r.amount - commission };
    }));

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
      })
      .from(withdrawalRequestsTable)
      .where(eq(withdrawalRequestsTable.id, wdId))
      .limit(1);
    if (!wd) { res.status(404).json({ success: false, message: "Withdrawal not found" }); return; }
    if (wd.status !== "PENDING") { res.status(400).json({ success: false, message: "Already processed" }); return; }

    const plan = await getActivePlanForUser(wd.userId);
    const commissionPct = plan.serviceFeePercent;
    const commission = Math.round(wd.amount * commissionPct / 100);
    const netAmount = wd.amount - commission;

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
          userId: wd.userId,
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

    await db.insert(notificationsTable).values({
      userId: wd.userId,
      type: "WITHDRAWAL_COMPLETED",
      title: "Withdrawal completed",
      message: `Your withdrawal of ₹${netAmount} has been processed and sent.`,
      linkUrl: "/dashboard.html",
    });

    res.json({ success: true, message: `Withdrawal confirmed — ₹${netAmount} sent to user (₹${commission} commission credited to your wallet)` });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to confirm withdrawal" });
  }
});

export default router;