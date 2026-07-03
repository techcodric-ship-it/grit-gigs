import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, invitesTable, projectsTable, servicesTable, barterRequestsTable, usersTable, notificationsTable } from "../db";
import { authenticate } from "../middlewares/authenticate";

const router: IRouter = Router();

// POST /invites — send invite (targetType: PROJECT|SERVICE|BARTER, targetId, toUserId, message?)
router.post("/invites", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { targetType, targetId, toUserId, message } = req.body;
  if (!["PROJECT", "SERVICE", "BARTER"].includes(targetType) || !targetId || !toUserId) {
    res.status(400).json({ success: false, message: "targetType, targetId, and toUserId are required" }); return;
  }
  if (toUserId === userId) { res.status(400).json({ success: false, message: "You cannot invite yourself" }); return; }

  const [targetUser] = await db.select().from(usersTable).where(eq(usersTable.id, toUserId)).limit(1);
  if (!targetUser) { res.status(404).json({ success: false, message: "User not found" }); return; }

  const [existing] = await db.select().from(invitesTable).where(
    and(eq(invitesTable.targetType, targetType), eq(invitesTable.targetId, targetId), eq(invitesTable.toUserId, toUserId), eq(invitesTable.fromUserId, userId), eq(invitesTable.status, "PENDING"))
  ).limit(1);
  if (existing) { res.status(400).json({ success: false, message: "Already invited this user" }); return; }

  let title = "You've been invited!";
  if (targetType === "PROJECT") {
    const [proj] = await db.select().from(projectsTable).where(eq(projectsTable.id, targetId)).limit(1);
    if (!proj) { res.status(404).json({ success: false, message: "Project not found" }); return; }
    if (proj.userId !== userId) { res.status(403).json({ success: false, message: "You can only invite users to your own projects" }); return; }
    title = `Invited to bid on "${proj.title}"`;
  } else if (targetType === "SERVICE") {
    const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, targetId)).limit(1);
    if (!svc) { res.status(404).json({ success: false, message: "Service not found" }); return; }
    if (svc.sellerId !== userId) { res.status(403).json({ success: false, message: "You can only invite users to your own services" }); return; }
    title = `Invited to discuss "${svc.title}"`;
  } else if (targetType === "BARTER") {
    const [br] = await db.select().from(barterRequestsTable).where(eq(barterRequestsTable.id, targetId)).limit(1);
    if (!br) { res.status(404).json({ success: false, message: "Barter request not found" }); return; }
    if (br.userId !== userId) { res.status(403).json({ success: false, message: "You can only invite users to your own barter exchanges" }); return; }
    title = `Invited to exchange skills`;
  }

  const [invite] = await db.insert(invitesTable).values({
    targetType, targetId, fromUserId: userId, toUserId, message: message?.trim() || null,
  }).returning();

  const [notif] = await db.insert(notificationsTable).values({
    userId: toUserId, type: "INVITE",
    title,
    message: message ? `${req.user!.firstName || "A user"} sent you an invite: ${message}` : `${req.user!.firstName || "A user"} invited you.`,
    linkUrl: `/dashboard.html?tab=invites`,
  }).returning();

  try { req.app.get("io").to(`user:${toUserId}`).emit("notification:new", notif); } catch {}

  res.status(201).json({ success: true, data: { invite } });
});

// GET /invites/mine — user sees invites they received
router.get("/invites/mine", authenticate, async (req: Request, res: Response): Promise<void> => {
  const invites = await db.select().from(invitesTable).where(eq(invitesTable.toUserId, req.user!.id)).orderBy(desc(invitesTable.createdAt));
  const enriched = await Promise.all(invites.map(async (inv) => {
    let target: any = null;
    if (inv.targetType === "PROJECT") {
      const [p] = await db.select().from(projectsTable).where(eq(projectsTable.id, inv.targetId)).limit(1);
      target = p;
    } else if (inv.targetType === "SERVICE") {
      const [s] = await db.select().from(servicesTable).where(eq(servicesTable.id, inv.targetId)).limit(1);
      target = s;
    } else if (inv.targetType === "BARTER") {
      const [b] = await db.select().from(barterRequestsTable).where(eq(barterRequestsTable.id, inv.targetId)).limit(1);
      target = b;
    }
    let fromUser: any = null;
    if (inv.fromUserId) {
      const [u] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto }).from(usersTable).where(eq(usersTable.id, inv.fromUserId)).limit(1);
      fromUser = u;
    }
    return { ...inv, target, fromUser };
  }));
  res.json({ success: true, data: { invites: enriched } });
});

// PUT /invites/:id — user accepts or declines
router.put("/invites/:id", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { status } = req.body;
  if (!["ACCEPTED", "DECLINED"].includes(status)) { res.status(400).json({ success: false, message: "status must be ACCEPTED or DECLINED" }); return; }
  const inviteId = req.params.id as string;
  const [invite] = await db.select().from(invitesTable).where(eq(invitesTable.id, inviteId)).limit(1);
  if (!invite) { res.status(404).json({ success: false, message: "Invite not found" }); return; }
  if (invite.toUserId !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
  await db.update(invitesTable).set({ status }).where(eq(invitesTable.id, invite.id));
  if (status === "ACCEPTED") {
    const [notif] = await db.insert(notificationsTable).values({
      userId: invite.fromUserId, type: "INVITE", title: "Invite accepted",
      message: "A user accepted your invitation.",
      linkUrl: `/dashboard.html?tab=inbox`,
    }).returning();
    try { req.app.get("io").to(`user:${invite.fromUserId}`).emit("notification:new", notif); } catch {}
  }
  res.json({ success: true, message: `Invite ${status.toLowerCase()}` });
});

export default router;