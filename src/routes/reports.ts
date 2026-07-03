import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, reportsTable, servicesTable, barterRequestsTable, projectsTable, usersTable } from "../db";
import { authenticate } from "../middlewares/authenticate";

const router: IRouter = Router();

// POST /reports — submit a report (targetType: USER|SERVICE|BARTER|PROJECT, targetId, reason)
router.post("/reports", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { targetType, targetId, reason } = req.body;
  if (!["USER", "SERVICE", "BARTER", "PROJECT"].includes(targetType) || !targetId || !reason?.trim()) {
    res.status(400).json({ success: false, message: "targetType, targetId, and reason are required" }); return;
  }
  if (targetType === "USER" && targetId === userId) {
    res.status(400).json({ success: false, message: "You cannot report yourself" }); return;
  }
  const [existing] = await db.select().from(reportsTable).where(
    and(eq(reportsTable.targetType, targetType), eq(reportsTable.targetId, targetId), eq(reportsTable.reportedById, userId), eq(reportsTable.status, "OPEN"))
  ).limit(1);
  if (existing) { res.status(400).json({ success: false, message: "You already reported this item" }); return; }

  const [report] = await db.insert(reportsTable).values({ targetType, targetId, reportedById: userId, reason: reason.trim() }).returning();
  res.status(201).json({ success: true, message: "Report submitted. Our team will review it.", data: { report } });
});

// GET /reports/mine — reports the user submitted + reports against their content
router.get("/reports/mine", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;

  // ── Reports submitted BY this user ──
  const submitted = await db
    .select()
    .from(reportsTable)
    .where(eq(reportsTable.reportedById, userId))
    .orderBy(desc(reportsTable.createdAt));

  // ── Reports where this user's content was TARGETED ──
  const againstUser = await db
    .select()
    .from(reportsTable)
    .where(and(eq(reportsTable.targetType, "USER"), eq(reportsTable.targetId, userId)))
    .orderBy(desc(reportsTable.createdAt));

  const serviceRows = await db
    .select({ report: reportsTable, targetTitle: servicesTable.title })
    .from(reportsTable)
    .innerJoin(servicesTable, eq(reportsTable.targetId, servicesTable.id))
    .where(and(eq(reportsTable.targetType, "SERVICE"), eq(servicesTable.sellerId, userId)))
    .orderBy(desc(reportsTable.createdAt));

  const barterRows = await db
    .select({ report: reportsTable, targetTitle: barterRequestsTable.skillOffered, targetSub: barterRequestsTable.skillNeeded })
    .from(reportsTable)
    .innerJoin(barterRequestsTable, eq(reportsTable.targetId, barterRequestsTable.id))
    .where(and(eq(reportsTable.targetType, "BARTER"), eq(barterRequestsTable.userId, userId)))
    .orderBy(desc(reportsTable.createdAt));

  const projectRows = await db
    .select({ report: reportsTable, targetTitle: projectsTable.title })
    .from(reportsTable)
    .innerJoin(projectsTable, eq(reportsTable.targetId, projectsTable.id))
    .where(and(eq(reportsTable.targetType, "PROJECT"), eq(projectsTable.userId, userId)))
    .orderBy(desc(reportsTable.createdAt));

  // Build "received" array with target details
  const received = [
    ...againstUser.map(r => ({ ...r, direction: "received", targetDetails: { type: "USER", title: "Your Profile", id: userId } })),
    ...serviceRows.map(r => ({ ...r.report, direction: "received", targetDetails: { type: "SERVICE", title: r.targetTitle, id: r.report.targetId } })),
    ...barterRows.map(r => ({ ...r.report, direction: "received", targetDetails: { type: "BARTER", title: r.targetTitle + " ↔ " + r.targetSub, id: r.report.targetId } })),
    ...projectRows.map(r => ({ ...r.report, direction: "received", targetDetails: { type: "PROJECT", title: r.targetTitle, id: r.report.targetId } })),
  ];

  // Enrich submitted reports with target details
  const submittedWithTargets = await Promise.all(submitted.map(async (r) => {
    let targetDetails: Record<string, any> | null = null;
    if (r.targetType === "USER") {
      const [u] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto }).from(usersTable).where(eq(usersTable.id, r.targetId)).limit(1);
      targetDetails = u ? { type: "USER", title: u.firstName + " " + u.lastName, id: u.id, profilePhoto: u.profilePhoto } : null;
    } else if (r.targetType === "SERVICE") {
      const [s] = await db.select({ id: servicesTable.id, title: servicesTable.title, sellerId: servicesTable.sellerId }).from(servicesTable).where(eq(servicesTable.id, r.targetId)).limit(1);
      let owner: Record<string, any> | null = null;
      if (s) {
        const [o] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto }).from(usersTable).where(eq(usersTable.id, s.sellerId)).limit(1);
        owner = o;
      }
      targetDetails = s ? { type: "SERVICE", title: s.title, id: s.id, owner } : null;
    } else if (r.targetType === "BARTER") {
      const [b] = await db.select({ id: barterRequestsTable.id, skillOffered: barterRequestsTable.skillOffered, skillNeeded: barterRequestsTable.skillNeeded, userId: barterRequestsTable.userId }).from(barterRequestsTable).where(eq(barterRequestsTable.id, r.targetId)).limit(1);
      let owner: Record<string, any> | null = null;
      if (b) {
        const [o] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto }).from(usersTable).where(eq(usersTable.id, b.userId)).limit(1);
        owner = o;
      }
      targetDetails = b ? { type: "BARTER", title: b.skillOffered + " ↔ " + b.skillNeeded, id: b.id, owner } : null;
    } else if (r.targetType === "PROJECT") {
      const [p] = await db.select({ id: projectsTable.id, title: projectsTable.title, userId: projectsTable.userId }).from(projectsTable).where(eq(projectsTable.id, r.targetId)).limit(1);
      let owner: Record<string, any> | null = null;
      if (p) {
        const [o] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto }).from(usersTable).where(eq(usersTable.id, p.userId)).limit(1);
        owner = o;
      }
      targetDetails = p ? { type: "PROJECT", title: p.title, id: p.id, owner } : null;
    }
    return { ...r, direction: "submitted", targetDetails };
  }));

  // Enrich received reports with reporter info
  const receivedWithReporters = await Promise.all(received.map(async (r) => {
    const [reporter] = await db
      .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto })
      .from(usersTable)
      .where(eq(usersTable.id, r.reportedById))
      .limit(1);
    return { ...r, reporter };
  }));

  const all = [...submittedWithTargets, ...receivedWithReporters];
  all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  res.json({ success: true, data: { reports: all } });
});

export default router;