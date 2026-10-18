import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, inArray, desc } from "drizzle-orm";
import {
  db,
  savedItemsTable,
  savedSearchesTable,
  servicesTable,
  projectsTable,
  barterRequestsTable,
  notificationsTable,
} from "../db";
import { authenticate } from "../middlewares/authenticate";

const router: IRouter = Router();

// GET /saved — list the current user's saved gigs, projects & barters
router.get("/saved", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const items = await db.select().from(savedItemsTable).where(eq(savedItemsTable.userId, userId)).orderBy(desc(savedItemsTable.createdAt));

  const serviceIds = items.filter((i) => i.itemType === "SERVICE").map((i) => i.itemId);
  const projectIds = items.filter((i) => i.itemType === "PROJECT").map((i) => i.itemId);
  const barterIds = items.filter((i) => i.itemType === "BARTER").map((i) => i.itemId);

  const services = serviceIds.length ? await db.select().from(servicesTable).where(inArray(servicesTable.id, serviceIds)) : [];
  const projects = projectIds.length ? await db.select().from(projectsTable).where(inArray(projectsTable.id, projectIds)) : [];
  const barters = barterIds.length ? await db.select().from(barterRequestsTable).where(inArray(barterRequestsTable.id, barterIds)) : [];

  res.json({ success: true, data: { services, projects, barters } });
});

// POST /saved — body: { itemType: 'SERVICE'|'PROJECT'|'BARTER', itemId }
router.post("/saved", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { itemType, itemId } = req.body;
  if (!["SERVICE", "PROJECT", "BARTER"].includes(itemType) || !itemId) {
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

// POST /saved-searches/check — runs every saved search against current OPEN
// projects, notifies the user of new matches since they last checked, and
// updates lastSeenCount. Cheap, no cron needed — call this from the
// dashboard on load (this app has no email service, so "alerts" are in-app).
router.post("/saved-searches/check", authenticate, async (req: Request, res: Response): Promise<void> => {
  const searches = await db.select().from(savedSearchesTable).where(eq(savedSearchesTable.userId, req.user!.id));
  let newMatchesTotal = 0;
  for (const s of searches) {
    const all = await db.select().from(projectsTable).where(eq(projectsTable.status, "OPEN"));
    const matched = all.filter((p) => {
      if (s.category && p.category !== s.category) return false;
      if (s.q && !p.title.toLowerCase().includes(s.q.toLowerCase()) && !p.description.toLowerCase().includes(s.q.toLowerCase())) return false;
      if (s.budgetMin && (p.budgetMax ?? 0) < s.budgetMin) return false;
      return true;
    });
    const newCount = matched.length - s.lastSeenCount;
    if (newCount > 0) {
      newMatchesTotal += newCount;
      await db.insert(notificationsTable).values({
        userId: req.user!.id,
        type: "SAVED_SEARCH_MATCH",
        title: `${newCount} new project${newCount > 1 ? "s" : ""} for "${s.label}"`,
        message: `New projects matching your saved search are ready to view.`,
        linkUrl: "/dashboard.html?tab=browse-projects",
      });
      await db.update(savedSearchesTable).set({ lastSeenCount: matched.length }).where(eq(savedSearchesTable.id, s.id));
    }
  }
  res.json({ success: true, data: { newMatches: newMatchesTotal } });
});

export default router;
