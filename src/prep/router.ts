// /api/prep router. Mounted from src/app.ts (src/routes/index.ts is off-limits
// while the Focus Rooms work is in progress). FEATURE_PREP gates everything
// except GET /flag, which the nav uses to decide whether to inject the icon.

import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db } from "../db";
import { authenticate } from "../middlewares/authenticate";
import { isPrepEnabled } from "./feature";
import { ensurePrepDb } from "./db";
import { resolveCompany, createPendingCompany } from "./companies";

export const prepRouter = Router();

// Cheap public probe for the nav; must answer even while Prep is disabled.
prepRouter.get("/flag", (_req: Request, res: Response): void => {
  res.json({ success: true, data: { enabled: isPrepEnabled() } });
});

// Everything below is invisible while the flag is off: 404, not 403, so the
// feature is not advertised to users or crawlers.
prepRouter.use((_req: Request, res: Response, next: NextFunction): void => {
  if (!isPrepEnabled()) {
    res.status(404).json({ success: false, message: "Not found" });
    return;
  }
  next();
});

const prepDbGate = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await ensurePrepDb();
    next();
  } catch (err) {
    console.error("[prep] database not ready:", err);
    res.status(503).json({ success: false, message: "Prep is temporarily unavailable" });
  }
};

const companiesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, try again shortly." },
});

const searchQuery = z.object({ q: z.string().min(1).max(200) });

prepRouter.get("/companies", companiesLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  const parsed = searchQuery.safeParse({ q: String(req.query.q ?? "") });
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Query q (1-200 chars) is required" });
    return;
  }
  try {
    const matches = await resolveCompany(db, parsed.data.q);
    res.json({ success: true, data: { matches, needsCreation: matches.length === 0 } });
  } catch (err) {
    console.error("[prep] company search failed:", err);
    res.status(500).json({ success: false, message: "Company search failed" });
  }
});

const createCompanyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, try again shortly." },
});

const createBody = z.object({
  name: z.string().min(2).max(200),
  website: z.string().max(500).optional(),
  domain: z.string().max(200).optional(),
});

prepRouter.post("/companies", authenticate, createCompanyLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  const parsed = createBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "name (2-200 chars) is required" });
    return;
  }
  try {
    const company = await createPendingCompany(db, {
      name: parsed.data.name,
      website: parsed.data.website ?? null,
      domain: parsed.data.domain ?? null,
      createdBy: req.user!.id,
    });
    res.status(201).json({
      success: true,
      data: { company: { id: company.id, slug: company.slug, name: company.name, status: company.status } },
    });
  } catch (err) {
    console.error("[prep] company create failed:", err);
    res.status(500).json({ success: false, message: "Could not save the company" });
  }
});
