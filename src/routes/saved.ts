import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, inArray, desc } from "drizzle-orm";
import {
  db,
  savedItemsTable,
  savedSearchesTable,
  barterRequestsTable,
} from "../db";
import { authenticate } from "../middlewares/authenticate";

const router: IRouter = Router();

// GET /saved — list the current user's saved barters (gig/project saves are
// hidden now that those marketplaces are retired)
router.get("/saved", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const items = await db.select().from(savedItemsTable).where(eq(savedItemsTable.userId, userId)).orderBy(desc(savedItemsTable.createdAt));

  const barterIds = items.filter((i) => i.itemType === "BARTER").map((i) => i.itemId);

  const barters = barterIds.length ? await db.select().from(barterRequestsTable).where(inArray(barterRequestsTable.id, barterIds)) : [];

  res.json({ success: true, data: { services: [], projects: [], barters } });
});

// POST /saved — body: { itemType: 'BARTER', itemId }
router.post("/saved", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { itemType, itemId } = req.body;
  if (itemType !== "BARTER" || !itemId) {
    res.status(400).json({ success: false, message: "Only barter listings can be saved" });
    return;
  }
  const [existing] = await db.select().from(savedItemsTable).where(and(eq(savedItemsTable.userId, userId), eq(savedItemsTable.itemType, itemType), eq(savedItemsTable.itemId, itemId))).limit(1);
  if (existing) {
    res.json({ success: true, message: "Already saved", data: { saved: true } });
    return;
  }
  await db.insert(savedItemsTable).values({ userId, itemType, itemId });
  res.status(201).json({ success: true, message: "Saved", data: { saved: true } });
});

// DELETE /saved — body: { itemType, itemId }
router.delete("/saved", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { itemType, itemId } = req.body;
  await db.delete(savedItemsTable).where(and(eq(savedItemsTable.userId, userId), eq(savedItemsTable.itemType, itemType), eq(savedItemsTable.itemId, itemId)));
  res.json({ success: true, message: "Removed", data: { saved: false } });
});

// ── Saved searches / job alerts ─────────────────────────────────────────────
router.get("/saved-searches", authenticate, async (req: Request, res: Response): Promise<void> => {
  const searches = await db.select().from(savedSearchesTable).where(eq(savedSearchesTable.userId, req.user!.id)).orderBy(desc(savedSearchesTable.createdAt));
  res.json({ success: true, data: { searches } });
});

router.post("/saved-searches", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { label, category, q, budgetMin } = req.body;
  if (!label) {
    res.status(400).json({ success: false, message: "A label is required" });
    return;
  }
  const [search] = await db.insert(savedSearchesTable).values({
    userId: req.user!.id,
    label,
    category: category || null,
    q: q || null,
    budgetMin: Number.isFinite(Number(budgetMin)) ? Number(budgetMin) : null,
  }).returning();
  res.status(201).json({ success: true, data: { search } });
});

router.delete("/saved-searches/:id", authenticate, async (req: Request, res: Response): Promise<void> => {
  const searchId = req.params.id as string;
  await db.delete(savedSearchesTable).where(and(eq(savedSearchesTable.id, searchId), eq(savedSearchesTable.userId, req.user!.id)));
  res.json({ success: true, message: "Deleted" });
});

// POST /saved-searches/check — project listings are retired, so there is
// nothing new to match. Kept as a no-op so old dashboard calls stay 200.
router.post("/saved-searches/check", authenticate, async (req: Request, res: Response): Promise<void> => {
  res.json({ success: true, data: { newMatches: 0 } });
});

export default router;
