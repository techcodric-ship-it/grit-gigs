import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, or } from "drizzle-orm";
import { db, disputesTable, ordersTable, projectsTable, barterRequestsTable, servicesTable, usersTable, notificationsTable } from "../db";
import { authenticate } from "../middlewares/authenticate";

const router: IRouter = Router();

// POST /disputes — raise a dispute on an order or project
// body: { targetType: 'ORDER'|'PROJECT', targetId, reason }
router.post("/disputes", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { targetType, targetId, reason } = req.body;
  if (!["ORDER", "PROJECT", "BARTER"].includes(targetType) || !targetId || !reason?.trim()) {
    res.status(400).json({ success: false, message: "targetType, targetId and reason are required" }); return;
  }

  // Verify the caller is a party to this order/project
  let otherPartyId: string | null = null;
  if (targetType === "ORDER") {
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, targetId)).limit(1);
    if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
    if (order.buyerId !== userId && order.sellerId !== userId) { res.status(403).json({ success: false, message: "You are not party to this order" }); return; }
    otherPartyId = order.buyerId === userId ? order.sellerId : order.buyerId;
  } else if (targetType === "PROJECT") {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, targetId)).limit(1);
    if (!project) { res.status(404).json({ success: false, message: "Project not found" }); return; }
    if (project.userId !== userId) { res.status(403).json({ success: false, message: "Only the project owner can raise a project dispute" }); return; }
  } else if (targetType === "BARTER") {
    const [barter] = await db.select().from(barterRequestsTable).where(eq(barterRequestsTable.id, targetId)).limit(1);
    if (!barter) { res.status(404).json({ success: false, message: "Barter request not found" }); return; }
    if (barter.userId !== userId) { res.status(403).json({ success: false, message: "You are not the owner of this barter request" }); return; }
  }

  const [existing] = await db.select().from(disputesTable).where(and(eq(disputesTable.targetId, targetId), eq(disputesTable.raisedById, userId), eq(disputesTable.status, "OPEN"))).limit(1);
  if (existing) { res.status(400).json({ success: false, message: "You already have an open dispute for this item" }); return; }

  const [dispute] = await db.insert(disputesTable).values({ targetType, targetId, raisedById: userId, reason: reason.trim() }).returning();

  if (otherPartyId) {
    const [n] = await db.insert(notificationsTable).values({
      userId: otherPartyId, type: "DISPUTE",
      title: "A dispute has been raised",
      message: `A dispute was filed on a ${targetType.toLowerCase()} you're involved in. Our team will review it shortly.`,
      linkUrl: `/dashboard.html?tab=orders`,
    }).returning();
    try { req.app.get("io").to(`user:${otherPartyId}`).emit("notification:new", n); } catch {}
  }

  res.status(201).json({ success: true, message: "Dispute raised. Our team will review within 24–48 hours.", data: { dispute } });
});

// GET /disputes/my-items — user's items that can be disputed (type: ORDER|PROJECT|BARTER)
router.get("/disputes/my-items", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const type = (req.query.type as string || "").toUpperCase();
  let items: { id: string; title: string }[] = [];
  if (type === "ORDER") {
    const orders = await db
      .select({ id: ordersTable.id, title: servicesTable.title })
      .from(ordersTable)
      .innerJoin(servicesTable, eq(ordersTable.serviceId, servicesTable.id))
      .where(or(eq(ordersTable.buyerId, userId), eq(ordersTable.sellerId, userId)))
      .orderBy(desc(ordersTable.createdAt));
    items = orders.map(o => ({ id: o.id, title: o.title }));
  } else if (type === "PROJECT") {
    const projects = await db
      .select({ id: projectsTable.id, title: projectsTable.title })
      .from(projectsTable)
      .where(eq(projectsTable.userId, userId))
      .orderBy(desc(projectsTable.createdAt));
    items = projects.map(p => ({ id: p.id, title: p.title }));
  } else if (type === "BARTER") {
    const barters = await db
      .select({ id: barterRequestsTable.id, skillOffered: barterRequestsTable.skillOffered, skillNeeded: barterRequestsTable.skillNeeded })
      .from(barterRequestsTable)
      .where(eq(barterRequestsTable.userId, userId))
      .orderBy(desc(barterRequestsTable.createdAt));
    items = barters.map(b => ({ id: b.id, title: b.skillOffered + " ↔ " + b.skillNeeded }));
  }
  res.json({ success: true, data: { items } });
});

// GET /disputes/mine — disputes the user raised or is involved in
router.get("/disputes/mine", authenticate, async (req: Request, res: Response): Promise<void> => {
  const disputes = await db.select().from(disputesTable).where(eq(disputesTable.raisedById, req.user!.id)).orderBy(desc(disputesTable.createdAt));
  res.json({ success: true, data: { disputes } });
});

// GET /disputes/:id — detail view
router.get("/disputes/:id", authenticate, async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const [dispute] = await db.select().from(disputesTable).where(eq(disputesTable.id, id)).limit(1);
  if (!dispute) { res.status(404).json({ success: false, message: "Dispute not found" }); return; }
  if (dispute.raisedById !== req.user!.id && req.user!.role !== "ADMIN" && req.user!.role !== "MODERATOR") {
    res.status(403).json({ success: false, message: "Forbidden" }); return;
  }
  res.json({ success: true, data: { dispute } });
});

// PUT /disputes/:id/resolve — admin only: resolve in favour of buyer or seller
// body: { resolution: 'RESOLVED_BUYER'|'RESOLVED_SELLER', adminNotes, refundAmount? }
router.put("/disputes/:id/resolve", authenticate, async (req: Request, res: Response): Promise<void> => {
  if (req.user!.role !== "ADMIN" && req.user!.role !== "MODERATOR") { res.status(403).json({ success: false, message: "Admin only" }); return; }
  const { resolution, adminNotes, refundAmount } = req.body;
  if (!["RESOLVED_BUYER", "RESOLVED_SELLER", "CLOSED"].includes(resolution)) {
    res.status(400).json({ success: false, message: "Invalid resolution value" }); return;
  }
  const id = req.params.id as string;
  const [dispute] = await db.select().from(disputesTable).where(eq(disputesTable.id, id)).limit(1);
  if (!dispute) { res.status(404).json({ success: false, message: "Dispute not found" }); return; }
  if (dispute.status !== "OPEN" && dispute.status !== "UNDER_REVIEW") {
    res.status(400).json({ success: false, message: "Dispute is already resolved" }); return;
  }

  await db.update(disputesTable).set({ status: resolution, adminNotes: adminNotes || null, resolvedAt: new Date() }).where(eq(disputesTable.id, dispute.id));

  const [n] = await db.insert(notificationsTable).values({
    userId: dispute.raisedById, type: "DISPUTE",
    title: "Your dispute has been resolved",
    message: resolution === "RESOLVED_BUYER"
      ? `Dispute resolved in your favour.`
      : resolution === "RESOLVED_SELLER"
      ? "Dispute was reviewed and resolved in the other party's favour."
      : "Your dispute has been closed.",
    linkUrl: `/dashboard.html?tab=orders`,
  }).returning();
  try { req.app.get("io").to(`user:${dispute.raisedById}`).emit("notification:new", n); } catch {}

  res.json({ success: true, message: "Dispute resolved" });
});

// PUT /disputes/:id/mark-reviewing — admin marks under review
router.put("/disputes/:id/mark-reviewing", authenticate, async (req: Request, res: Response): Promise<void> => {
  if (req.user!.role !== "ADMIN" && req.user!.role !== "MODERATOR") { res.status(403).json({ success: false, message: "Admin only" }); return; }
  const id = req.params.id as string;
  const [dispute] = await db.select().from(disputesTable).where(eq(disputesTable.id, id)).limit(1);
  if (!dispute) { res.status(404).json({ success: false, message: "Not found" }); return; }
  await db.update(disputesTable).set({ status: "UNDER_REVIEW" }).where(eq(disputesTable.id, dispute.id));
  const [n] = await db.insert(notificationsTable).values({
    userId: dispute.raisedById, type: "DISPUTE",
    title: "Your dispute is under review",
    message: "Our team has started reviewing your dispute. We'll notify you when it's resolved.",
    linkUrl: `/dashboard.html?tab=orders`,
  }).returning();
  try { req.app.get("io").to(`user:${dispute.raisedById}`).emit("notification:new", n); } catch {}
  res.json({ success: true, message: "Marked as under review" });
});

export default router;
