import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db, waitlistLeadsTable } from "../db";
import { sendWaitlistConfirmationEmail } from "../lib/email";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// POST /waitlist — public: someone joins the launch waitlist
router.post("/waitlist", async (req: Request, res: Response): Promise<void> => {
  const { email, firstName } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ success: false, message: "A valid email is required" });
    return;
  }

  try {
    const clean = email.trim().toLowerCase();
    const [existing] = await db
      .select()
      .from(waitlistLeadsTable)
      .where(eq(waitlistLeadsTable.email, clean))
      .limit(1);

    if (existing) {
      logger.info({ email: clean }, "Waitlist lead already registered");
      res.status(200).json({ success: true, message: "You're already on the list. We'll be in touch!", data: { position: existing.position } });
      return;
    }

    const position = ((await db.select({ c: sql<number>`count(*)` }).from(waitlistLeadsTable))[0]?.c ?? 0) + 1;

    const [lead] = await db
      .insert(waitlistLeadsTable)
      .values({ email: clean, firstName: firstName?.trim() || null, position })
      .returning();

    const sent = await sendWaitlistConfirmationEmail(clean, firstName?.trim(), position);
    logger.info({ leadId: lead.id, position, sent }, "Waitlist lead captured");

    res.status(201).json({ success: true, message: "You're on the list!", data: { position } });
  } catch (err) {
    logger.error({ err }, "Failed to capture waitlist lead");
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
});

// GET /waitlist/position?email=... — public: check signup position
router.get("/waitlist/position", async (req: Request, res: Response): Promise<void> => {
  const email = String(req.query.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ success: false, message: "A valid email is required" });
    return;
  }
  try {
    const [lead] = await db
      .select({ position: waitlistLeadsTable.position })
      .from(waitlistLeadsTable)
      .where(eq(waitlistLeadsTable.email, email))
      .limit(1);
    if (!lead) {
      res.status(404).json({ success: false, message: "Email not found on the list" });
      return;
    }
    res.status(200).json({ success: true, data: { position: lead.position } });
  } catch (err) {
    logger.error({ err }, "Failed to fetch waitlist position");
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
});

export default router;