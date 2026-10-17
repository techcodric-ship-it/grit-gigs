import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, inArray, desc } from "drizzle-orm";
import {
  db,
  savedItemsTable,
  savedSearchesTable,
  servicesTable,
  barterRequestsTable,
  notificationsTable,
} from "../db";
import { authenticate } from "../middlewares/authenticate";

const router: IRouter = Router();

// GET /saved — list the current user's saved gigs and barters.
// Project saves are gone with the Jobs pivot: legacy PROJECT rows are archived
// and never returned.
router.get("/saved", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const items = await db.select().from(savedItemsTable).where(eq(savedItemsTable.userId, userId)).orderBy(desc(savedItemsTable.createdAt));

  const serviceIds = items.filter((i) => i.itemType === "SERVICE").map((i) => i.itemId);
  const barterIds = items.filter((i) => i.itemType === "BARTER").map((i) => i.itemId);

  const services = serviceIds.length ? await db.select().from(servicesTable).where(inArray(servicesTable.id, serviceIds)) : [];
  const barters = barterIds.length ? await db.select().from(barterRequestsTable).where(inArray(barterRequestsTable.id, barterIds)) : [];

  res.json({ success: true, data: { services, barters } });
});

// POST /saved — body: { itemType: 'SERVICE'|'BARTER', itemId }
router.post("/saved", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { itemType, itemId } = req.body;
  if (!["SERVICE", "BARTER"].includes(itemType) || !itemId) {
    res.status(400).json({ success: false, message: "itemType and itemId are required" });
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

// POST /saved-searches/check — used to run every saved search against OPEN
// projects. Projects were archived in the Jobs pivot, so there is nothing to
// match yet: the endpoint reports a real zero until job matching lands with
// the Jobs index, and never invents a count.
router.post("/saved-searches/check", authenticate, async (req: Request, res: Response): Promise<void> => {
  res.json({ success: true, data: { newMatches: 0 } });
});

export default router;
