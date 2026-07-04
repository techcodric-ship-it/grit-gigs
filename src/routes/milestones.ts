import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, sum, sql } from "drizzle-orm";
import {
  db, projectMilestonesTable, projectsTable, projectBidsTable,
  notificationsTable, usersTable, transactionsTable,
  freelanceWalletsTable,
} from "../db";
import { authenticate } from "../middlewares/authenticate";
import { getActivePlanForUser } from "../lib/subscriptions";

const router: IRouter = Router();

// POST /projects/:id/milestones — client sets up milestones against an accepted bid.
// body: { bidId, milestones: [{ title, amount }] }  amounts must sum <= bid.amount
router.post("/projects/:id/milestones", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { bidId, milestones } = req.body;
  if (!bidId || !Array.isArray(milestones) || milestones.length === 0) {
    res.status(400).json({ success: false, message: "bidId and milestones array are required" }); return;
  }

  const projectId = req.params.id as string;
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
  if (!project) { res.status(404).json({ success: false, message: "Project not found" }); return; }
  if (project.userId !== userId) { res.status(403).json({ success: false, message: "Only the project owner can set milestones" }); return; }

  const [bid] = await db.select().from(projectBidsTable).where(and(eq(projectBidsTable.id, bidId), eq(projectBidsTable.projectId, project.id))).limit(1);
  if (!bid) { res.status(404).json({ success: false, message: "Bid not found on this project" }); return; }
  if (bid.status !== "ACCEPTED") { res.status(400).json({ success: false, message: "Milestones can only be added to an accepted bid" }); return; }

  const total = milestones.reduce((s: number, m: { amount: number }) => s + Number(m.amount), 0);
  if (total > bid.amount * 1.01) {
    res.status(400).json({ success: false, message: `Milestone total (${total}) exceeds the accepted bid amount (${bid.amount})` }); return;
  }

  // Clear any previously set milestones for this bid before re-creating
  await db.delete(projectMilestonesTable).where(and(eq(projectMilestonesTable.bidId, bidId), eq(projectMilestonesTable.projectId, project.id)));

  const rows = await db.insert(projectMilestonesTable).values(
    milestones.map((m: { title: string; amount: number }, i: number) => ({
      projectId: project.id, bidId, title: m.title, amount: Number(m.amount), sortOrder: i,
    }))
  ).returning();

  await db.insert(notificationsTable).values({
    userId: bid.userId, type: "MILESTONE",
    title: "Milestones set for your project",
    message: `${milestones.length} milestone${milestones.length > 1 ? "s" : ""} have been set for "${project.title}". Complete each one to receive staged payments.`,
    linkUrl: `/dashboard.html?tab=orders`,
  });

  res.status(201).json({ success: true, data: { milestones: rows } });
});

// GET /projects/:id/milestones — anyone involved can view
router.get("/projects/:id/milestones", authenticate, async (req: Request, res: Response): Promise<void> => {
  const projectId = req.params.id as string;
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
  if (!project) { res.status(404).json({ success: false, message: "Project not found" }); return; }

  const milestones = await db.select().from(projectMilestonesTable)
    .where(eq(projectMilestonesTable.projectId, project.id))
    .orderBy(projectMilestonesTable.sortOrder);

  res.json({ success: true, data: { milestones } });
});

// POST /milestones/:id/deliver — freelancer marks a milestone as delivered
router.post("/milestones/:id/deliver", authenticate, async (req: Request, res: Response): Promise<void> => {
  const msId = req.params.id as string;
  const [ms] = await db.select().from(projectMilestonesTable).where(eq(projectMilestonesTable.id, msId)).limit(1);
  if (!ms) { res.status(404).json({ success: false, message: "Milestone not found" }); return; }

  const [bid] = await db.select().from(projectBidsTable).where(eq(projectBidsTable.id, ms.bidId)).limit(1);
  if (!bid || bid.userId !== req.user!.id) { res.status(403).json({ success: false, message: "Only the assigned freelancer can deliver a milestone" }); return; }
  if (ms.status !== "IN_PROGRESS" && ms.status !== "PENDING") { res.status(400).json({ success: false, message: "Milestone is not in a deliverable state" }); return; }

  const { deliveryNote } = req.body;
  await db.update(projectMilestonesTable).set({ status: "DELIVERED", deliveryNote: deliveryNote || null, deliveredAt: new Date() }).where(eq(projectMilestonesTable.id, ms.id));

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, ms.projectId)).limit(1);
  await db.insert(notificationsTable).values({
    userId: project.userId, type: "MILESTONE",
    title: `Milestone delivered: "${ms.title}"`,
    message: `Your freelancer has submitted "${ms.title}" for review. Approve it to release the ₹${ms.amount} payment.`,
    linkUrl: `/dashboard.html?tab=my-projects&project=${ms.projectId}`,
  });

  res.json({ success: true, message: "Milestone marked as delivered" });
});

// POST /milestones/:id/approve — client approves delivery with commission
router.post("/milestones/:id/approve", authenticate, async (req: Request, res: Response): Promise<void> => {
  const msId = req.params.id as string;
  const [ms] = await db.select().from(projectMilestonesTable).where(eq(projectMilestonesTable.id, msId)).limit(1);
  if (!ms) { res.status(404).json({ success: false, message: "Milestone not found" }); return; }
  if (ms.status !== "DELIVERED") { res.status(400).json({ success: false, message: "Milestone has not been delivered yet" }); return; }

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, ms.projectId)).limit(1);
  if (!project || project.userId !== req.user!.id) { res.status(403).json({ success: false, message: "Only the project owner can approve milestones" }); return; }

  const [bid] = await db.select().from(projectBidsTable).where(eq(projectBidsTable.id, ms.bidId)).limit(1);
  if (!bid) { res.status(500).json({ success: false, message: "Could not find associated bid" }); return; }

  // Atomically claim the transition — only the first request succeeds
  const claimResult = await db.execute(
    sql`UPDATE ${projectMilestonesTable} SET ${projectMilestonesTable.status} = 'APPROVED', ${projectMilestonesTable.approvedAt} = NOW() WHERE ${projectMilestonesTable.id} = ${ms.id} AND ${projectMilestonesTable.status} = 'DELIVERED'`
  );
  if (claimResult.rowCount === 0) {
    res.status(409).json({ success: false, message: "Milestone already approved" });
    return;
  }

  // Calculate commission based on freelancer's plan
  const plan = await getActivePlanForUser(bid.userId);
  const commissionPct = plan.serviceFeePercent;
  const milestoneAmount = Number(ms.amount) || 0;
  const commission = Math.round(milestoneAmount * commissionPct / 100);
  const netAmount = milestoneAmount - commission;

  // Wallet operations + transaction records in a DB transaction
  try {
    await db.transaction(async (tx) => {
      const deductResult = await tx.execute(
        sql`UPDATE ${freelanceWalletsTable} SET balance = balance - ${milestoneAmount}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${project.userId} AND balance >= ${milestoneAmount}`
      );
      if (deductResult.rowCount === 0) {
        throw new Error("Insufficient funds");
      }

      const creditResult = await tx.execute(
        sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${netAmount}, total_earned = COALESCE(total_earned, 0) + ${netAmount}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${bid.userId}`
      );
      if (creditResult.rowCount === 0) {
        await tx.insert(freelanceWalletsTable).values({
          userId: bid.userId,
          balance: netAmount,
          totalEarned: netAmount,
          updatedAt: new Date(),
        });
      }

      await tx.insert(transactionsTable).values({
        userId: project.userId,
        type: 'SERVICE_PAYMENT',
        amount: milestoneAmount,
        description: `Payment for milestone "${ms.title}"`,
        status: 'COMPLETED',
      });

      await tx.insert(transactionsTable).values({
        userId: bid.userId,
        type: 'SERVICE_EARNING',
        amount: netAmount,
        description: `Payment received for milestone "${ms.title}"`,
        status: 'COMPLETED',
      });
      if (commission > 0) {
        await tx.insert(transactionsTable).values({
          userId: bid.userId,
          type: 'COMMISSION',
          amount: commission,
          description: `Platform commission (${commissionPct}%) on milestone "${ms.title}"`,
          status: 'COMPLETED',
        });
      }
    });
  } catch (e) {
    await db.execute(sql`UPDATE ${projectMilestonesTable} SET ${projectMilestonesTable.status} = 'DELIVERED' WHERE ${projectMilestonesTable.id} = ${ms.id}`);
    if (e instanceof Error && e.message === "Insufficient funds") {
      res.status(400).json({ success: false, message: 'You don\'t have enough funds in your wallet. Please add funds and try again.' });
    } else {
      res.status(500).json({ success: false, message: "Payment processing failed. Please try again." });
    }
    return;
  }

  await db.insert(notificationsTable).values({
    userId: project.userId, type: "MILESTONE",
    title: `Milestone approved and paid`,
    message: `₹${milestoneAmount} deducted from your wallet for "${ms.title}".`,
    linkUrl: `/dashboard.html?tab=my-projects&project=${ms.projectId}`,
  });
  await db.insert(notificationsTable).values({
    userId: bid.userId, type: "MILESTONE",
    title: `Milestone approved!`,
    message: `"${ms.title}" approved — you received ₹${netAmount} (${commissionPct}% commission: ₹${commission}).`,
    linkUrl: `/dashboard.html?tab=orders`,
  });

  res.json({ success: true, message: `Milestone approved. Freelancer receives ₹${netAmount} (${commissionPct}% commission: ₹${commission}).` });
});

export default router;
