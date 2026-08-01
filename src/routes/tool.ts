import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, toolLeadsTable } from "../db";
import { authenticate, requireAdmin } from "../middlewares/authenticate";
import { TOOL_SKILLS, calcFreelancer, calcClient, formatINR, type ToolResult } from "../lib/tool-pricing";
import { sendToolReportEmail } from "../lib/email";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// POST /tool/lead — public: someone used the free calculator, capture + email report
router.post("/tool/lead", async (req: Request, res: Response): Promise<void> => {
  const { firstName, email, role, service, experience, hours } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ success: false, message: "A valid email is required" });
    return;
  }
  if (role !== "freelancer" && role !== "client") {
    res.status(400).json({ success: false, message: "role must be 'freelancer' or 'client'" });
    return;
  }
  if (!TOOL_SKILLS[service]) {
    res.status(400).json({ success: false, message: "Please pick a valid service" });
    return;
  }
  const h = Math.min(500, Math.max(1, Number(hours) || 8));

  let result: ToolResult;
  let lines: string[];
  let ctaText: string;
  let ctaUrl: string;
  if (role === "freelancer") {
    const exp = experience ?? "3-5 years";
    result = calcFreelancer(service, exp, h);
    lines = [
      `💰 Hourly rate: <strong>${formatINR(result.hourlyLow)} – ${formatINR(result.hourlyHigh)}</strong>`,
      `📦 Fixed project (${h}h): <strong>${formatINR(result.projectLow)} – ${formatINR(result.projectHigh)}</strong>`,
      `🗓️ Monthly (full-time equivalent): <strong>${formatINR(result.monthlyLow)} – ${formatINR(result.monthlyHigh)}</strong>`,
    ];
    ctaText = "Post your service for free →";
    ctaUrl = `${process.env.APP_URL || "https://www.gritandgigs.in"}/signup`;
  } else {
    result = calcClient(service, h);
    lines = [
      `📊 Expected budget: <strong>${formatINR(result.budgetLow)} – ${formatINR(result.budgetHigh)}</strong>`,
      `⏱️ Typical hourly range: <strong>${formatINR(result.hourlyLow)} – ${formatINR(result.hourlyHigh)}</strong>`,
      `💡 ${result.tip}`,
    ];
    ctaText = "Post your project for free →";
    ctaUrl = `${process.env.APP_URL || "https://www.gritandgigs.in"}/projects`;
  }

  try {
    const [lead] = await db
      .insert(toolLeadsTable)
      .values({
        email: email.toLowerCase(),
        firstName: firstName?.trim() || null,
        role,
        service,
        experience: role === "freelancer" ? (experience ?? null) : null,
        hours: h,
        result: result as unknown as Record<string, unknown>,
        nextFollowupAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      })
      .returning();

    const sent = await sendToolReportEmail(email, firstName?.trim(), role, lines, ctaText, ctaUrl);
    logger.info({ leadId: lead.id, role, service, sent }, "Tool lead captured");

    res.status(201).json({ success: true, data: { result, sent } });
  } catch (err) {
    logger.error({ err }, "Failed to capture tool lead");
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
});

// POST /tool/unsubscribe — public: stop all follow-up emails
router.post("/tool/unsubscribe", async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ success: false, message: "A valid email is required" });
    return;
  }
  await db.update(toolLeadsTable).set({ unsubscribed: true, nextFollowupAt: null }).where(eq(toolLeadsTable.email, email.toLowerCase()));
  res.json({ success: true, message: "You've been unsubscribed." });
});

// GET /tool/leads — admin: view all captured leads
router.get("/tool/leads", authenticate, requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const leads = await db.select().from(toolLeadsTable).orderBy(desc(toolLeadsTable.createdAt)).limit(200);
  res.json({ success: true, data: leads });
});

export default router;
