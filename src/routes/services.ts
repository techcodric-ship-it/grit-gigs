import { Router, type IRouter } from "express";
import {
  db,
  servicesTable,
  servicePackagesTable,
  ordersTable,
  usersTable,
  reviewsTable,
  notificationsTable,
} from "../db";
import { eq, ilike, or, and, desc, ne, sql, asc, count, inArray } from "drizzle-orm";
import { authenticate, optionalAuth } from "../middlewares/authenticate";
import { getActivePlanForUser } from "../lib/subscriptions";
import { attachPlanBadge, attachPlanBadges } from "../lib/planBadge";
import { uploadToSupabase, isSupabaseConfigured } from "../lib/storage";
import { PROJECT_ROOT } from "../lib/root";
import multer from "multer";
import path from "path";
import fs from "fs";

const router: IRouter = Router();

const uploadDir = path.join(PROJECT_ROOT, "uploads", "services");
fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

router.get("/services", optionalAuth, async (req, res): Promise<void> => {
  const { page = "1", limit = "15", category, q, sort = "newest", minPrice, maxPrice, maxDelivery, minRating } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const conditions: ReturnType<typeof eq>[] = [eq(servicesTable.status, "ACTIVE")];
  if (category) conditions.push(ilike(servicesTable.category, `%${category}%`) as ReturnType<typeof eq>);
  if (q) {
    conditions.push(
      or(
        ilike(servicesTable.title, `%${q}%`),
        ilike(servicesTable.description, `%${q}%`),
        ilike(servicesTable.category, `%${q}%`),
      )! as ReturnType<typeof eq>,
    );
  }
  if (minRating && parseFloat(minRating) > 0) {
    conditions.push(sql`${servicesTable.ratingAvg} >= ${parseFloat(minRating)}` as unknown as ReturnType<typeof eq>);
  }
  if (minPrice || maxPrice) {
    const minP = minPrice ? parseInt(minPrice) : 0;
    const maxP = maxPrice ? parseInt(maxPrice) : 9999999;
    conditions.push(
      sql`${servicesTable.id} IN (SELECT service_id FROM service_packages WHERE price_inr >= ${minP} AND price_inr <= ${maxP})` as unknown as ReturnType<typeof eq>,
    );
  }
  if (maxDelivery && parseInt(maxDelivery) > 0) {
    const days = parseInt(maxDelivery);
    conditions.push(
      sql`${servicesTable.id} IN (SELECT service_id FROM service_packages WHERE delivery_days <= ${days})` as unknown as ReturnType<typeof eq>,
    );
  }

  const where = conditions.length > 1 ? and(...conditions) : conditions[0];

  const orderBy =
    sort === "rating"
      ? desc(servicesTable.ratingAvg)
      : sort === "newest"
        ? desc(servicesTable.createdAt)
        : sort === "price_asc"
          ? sql`(SELECT MIN(price_inr) FROM service_packages WHERE service_id = ${servicesTable.id}) ASC`
          : sort === "price_desc"
            ? sql`(SELECT MAX(price_inr) FROM service_packages WHERE service_id = ${servicesTable.id}) DESC`
            : desc(servicesTable.orderCount);

  const [countResult, services] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(servicesTable).where(where),
    db
      .select({
        id: servicesTable.id,
        title: servicesTable.title,
        category: servicesTable.category,
        subcategory: servicesTable.subcategory,
        images: servicesTable.images,
        tags: servicesTable.tags,
        ratingAvg: servicesTable.ratingAvg,
        reviewCount: servicesTable.reviewCount,
        orderCount: servicesTable.orderCount,
        createdAt: servicesTable.createdAt,
        sellerId: servicesTable.sellerId,
      })
      .from(servicesTable)
      .where(where)
      .orderBy(orderBy)
      .limit(parseInt(limit))
      .offset(skip),
  ]);

  const total = countResult[0]?.count ?? 0;

  const sellersMap: Record<string, { id: string; firstName: string; lastName: string; profilePhoto: string | null; city: string | null; reputationScore: number }> = {};
  const packagesMap: Record<string, typeof servicePackagesTable.$inferSelect[]> = {};

  for (const svc of services) {
    const [seller] = await db
      .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, city: usersTable.city, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified })
      .from(usersTable)
      .where(eq(usersTable.id, svc.sellerId));
    if (seller) sellersMap[svc.sellerId] = seller;

    const pkgs = await db
      .select()
      .from(servicePackagesTable)
      .where(eq(servicePackagesTable.serviceId, svc.id));
    packagesMap[svc.id] = pkgs;
  }

  const result = services.map((s) => ({
    ...s,
    seller: sellersMap[s.sellerId],
    packages: packagesMap[s.id] ?? [],
  }));

  await attachPlanBadges(Object.values(sellersMap));
  res.json({ success: true, data: { services: result, total, page: parseInt(page) } });
});

router.get("/services/mine", authenticate, async (req, res): Promise<void> => {
  const services = await db
    .select()
    .from(servicesTable)
    .where(and(eq(servicesTable.sellerId, req.user!.id), ne(servicesTable.status, "DELETED")))
    .orderBy(desc(servicesTable.createdAt));

  const [seller] = await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, city: usersTable.city, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified })
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.id));
  const result = await Promise.all(
    services.map(async (svc) => {
      const pkgs = await db.select().from(servicePackagesTable).where(eq(servicePackagesTable.serviceId, svc.id));
      return { ...svc, seller, packages: pkgs };
    }),
  );

  if (seller) await attachPlanBadge(seller);
  res.json({ success: true, data: { services: result } });
});

router.get("/services/:id", optionalAuth, async (req, res): Promise<void> => {
  const [service] = await db.select().from(servicesTable).where(eq(servicesTable.id, String(req.params.id)));
  if (!service || service.status === "DELETED") {
    res.status(404).json({ success: false, message: "Service not found" });
    return;
  }

  const [seller] = await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, bio: usersTable.bio, city: usersTable.city, reputationScore: usersTable.reputationScore, createdAt: usersTable.createdAt, kycVerified: usersTable.kycVerified })
    .from(usersTable)
    .where(eq(usersTable.id, service.sellerId));

  const packages = await db.select().from(servicePackagesTable).where(eq(servicePackagesTable.serviceId, service.id));
  const reviews = await db
    .select({ id: reviewsTable.id, rating: reviewsTable.rating, reviewText: reviewsTable.reviewText, createdAt: reviewsTable.createdAt, reviewerId: reviewsTable.reviewerId })
    .from(reviewsTable)
    .where(and(eq(reviewsTable.serviceId, service.id), eq(reviewsTable.type, "service")))
    .orderBy(desc(reviewsTable.createdAt))
    .limit(10);

  const reviewerIds = [...new Set(reviews.map(r => r.reviewerId))];
  const reviewers = reviewerIds.length ? await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto })
    .from(usersTable)
    .where(inArray(usersTable.id, reviewerIds)) : [];
  const reviewerMap = Object.fromEntries(reviewers.map(r => [r.id, { firstName: r.firstName, lastName: r.lastName, profilePhoto: r.profilePhoto }]));
  const reviewsWithUsers = reviews.map(r => ({ ...r, reviewer: reviewerMap[r.reviewerId] || null }));

  db.execute(sql`UPDATE ${servicesTable} SET view_count = view_count + 1 WHERE ${servicesTable.id} = ${service.id}`).catch(() => {});

  if (seller) await attachPlanBadge(seller);
  const reviewersList = Object.values(reviewerMap);
  if (reviewersList.length) await attachPlanBadges(reviewersList);
  res.json({ success: true, data: { service: { ...service, seller, packages, reviews: reviewsWithUsers } } });
});

router.post("/services", authenticate, upload.array("images", 5), async (req, res): Promise<void> => {
  const { title, category, subcategory, description, tags, packages } = req.body;

  if (!title || !category || !description) {
    res.status(400).json({ success: false, message: "Title, category, and description are required" });
    return;
  }
  if (!packages) {
    res.status(400).json({ success: false, message: "At least one package is required" });
    return;
  }

  let parsedPackages: Array<{ packageType: string; priceInr: number; description: string; deliveryDays: number; revisions?: number; features?: string[] }>;
  try {
    parsedPackages = typeof packages === "string" ? JSON.parse(packages) : packages;
  } catch {
    res.status(400).json({ success: false, message: "Invalid packages format" });
    return;
  }

  if (!Array.isArray(parsedPackages) || parsedPackages.length === 0) {
    res.status(400).json({ success: false, message: "At least one package required" });
    return;
  }

  let parsedTags: string[] = [];
  try {
    parsedTags = tags ? (typeof tags === "string" ? JSON.parse(tags) : tags) : [];
  } catch {
    parsedTags = tags ? [tags] : [];
  }

  // ── Plan-based active gig listing cap ────────────────────────────────────
  const plan = await getActivePlanForUser(req.user!.id);
  if (plan.maxActiveGigs !== -1) {
    const [{ value: activeCount }] = await db
      .select({ value: count() })
      .from(servicesTable)
      .where(and(eq(servicesTable.sellerId, req.user!.id), eq(servicesTable.status, "ACTIVE")));
    if (activeCount >= plan.maxActiveGigs) {
      res.status(403).json({
        success: false,
        message: `Your ${plan.name} plan allows up to ${plan.maxActiveGigs} active gig listings. Pause an existing gig or upgrade your plan to list more.`,
        _planLimitExceeded: true,
      });
      return;
    }
  }

  const files = (req.files as Express.Multer.File[]) ?? [];
  const imageUrls: string[] = [];
  for (const f of files) {
    const url = await uploadToSupabase(fs.readFileSync(f.path), f.originalname, "services");
    if (!url) {
      if (isSupabaseConfigured()) {
        res.status(500).json({ success: false, message: "Image upload failed" });
        return;
      }
      imageUrls.push(`/uploads/services/${f.filename}`);
    } else {
      imageUrls.push(url);
    }
  }

  const [service] = await db
    .insert(servicesTable)
    .values({ sellerId: req.user!.id, title: String(title).trim(), category, subcategory: subcategory ?? null, description: String(description).trim(), images: imageUrls, tags: parsedTags })
    .returning();

  await db.insert(servicePackagesTable).values(
    parsedPackages.map((p) => ({
      serviceId: service.id,
      packageType: p.packageType ?? "basic",
      priceInr: Number(p.priceInr),
      description: p.description,
      deliveryDays: Number(p.deliveryDays),
      revisions: Number(p.revisions ?? 2),
      features: Array.isArray(p.features) ? p.features : [],
    })),
  );

  const pkgs = await db.select().from(servicePackagesTable).where(eq(servicePackagesTable.serviceId, service.id));
  res.status(201).json({ success: true, message: "Service created!", data: { service: { ...service, packages: pkgs } } });
});

router.post("/services/:id/images", authenticate, upload.array("images", 5), async (req, res): Promise<void> => {
  const [service] = await db.select().from(servicesTable).where(eq(servicesTable.id, String(req.params.id)));
  if (!service) { res.status(404).json({ success: false, message: "Service not found" }); return; }
  if (service.sellerId !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }

  const files = (req.files as Express.Multer.File[]) ?? [];
  const newImages: string[] = [];
  for (const f of files) {
    const url = await uploadToSupabase(fs.readFileSync(f.path), f.originalname, "services");
    if (!url) {
      if (isSupabaseConfigured()) {
        res.status(500).json({ success: false, message: "Image upload failed" });
        return;
      }
      newImages.push(`/uploads/services/${f.filename}`);
    } else {
      newImages.push(url);
    }
  }
  const allImages = [...service.images, ...newImages].slice(0, 5);

  const [updated] = await db.update(servicesTable).set({ images: allImages }).where(eq(servicesTable.id, service.id)).returning({ id: servicesTable.id, images: servicesTable.images });
  res.json({ success: true, data: { service: updated } });
});

router.put("/services/:id", authenticate, async (req, res): Promise<void> => {
  const [service] = await db.select().from(servicesTable).where(eq(servicesTable.id, String(req.params.id)));
  if (!service) { res.status(404).json({ success: false, message: "Service not found" }); return; }
  if (service.sellerId !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }

  // Block editing if gig has active orders (non-cancelled)
  const [{ value: activeOrders }] = await db
    .select({ value: count() })
    .from(ordersTable)
    .where(and(eq(ordersTable.serviceId, service.id), ne(ordersTable.status, "CANCELLED")));
  if (activeOrders > 0) {
    res.status(400).json({ success: false, message: "Cannot edit a gig while it has active or completed orders." });
    return;
  }

  const { title, category, subcategory, description, tags, status } = req.body;
  const updates: Partial<typeof servicesTable.$inferInsert> = { updatedAt: new Date() };
  if (title) updates.title = title;
  if (category) updates.category = category;
  if (subcategory !== undefined) updates.subcategory = subcategory;
  if (description) updates.description = description;
  if (tags) updates.tags = Array.isArray(tags) ? tags : [tags];
  if (status && service.status !== status) {
    if (status === "ACTIVE") {
      const plan = await getActivePlanForUser(req.user!.id);
      if (plan.maxActiveGigs !== -1) {
        const [{ value: activeCount }] = await db
          .select({ value: count() })
          .from(servicesTable)
          .where(and(eq(servicesTable.sellerId, req.user!.id), eq(servicesTable.status, "ACTIVE")));
        if (activeCount >= plan.maxActiveGigs) {
          res.status(403).json({ success: false, message: `Your ${plan.name} plan allows up to ${plan.maxActiveGigs} active gig listings. Pause another gig first or upgrade your plan.`, _planLimitExceeded: true });
          return;
        }
      }
    }
    updates.status = status;
  }

  const [updated] = await db.update(servicesTable).set(updates).where(eq(servicesTable.id, service.id)).returning();
  const pkgs = await db.select().from(servicePackagesTable).where(eq(servicePackagesTable.serviceId, service.id));
  res.json({ success: true, data: { service: { ...updated, packages: pkgs } } });
});

router.delete("/services/:id", authenticate, async (req, res): Promise<void> => {
  const [service] = await db.select().from(servicesTable).where(eq(servicesTable.id, String(req.params.id)));
  if (!service) { res.status(404).json({ success: false, message: "Service not found" }); return; }
  if (service.sellerId !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
  // Block deleting if gig has orders
  const [{ value: orderCount }] = await db
    .select({ value: count() })
    .from(ordersTable)
    .where(eq(ordersTable.serviceId, service.id));
  if (orderCount > 0) {
    res.status(400).json({ success: false, message: "Cannot delete a gig that has orders. You can pause it instead." });
    return;
  }
  await db.update(servicesTable).set({ status: "DELETED" }).where(eq(servicesTable.id, service.id));
  res.json({ success: true, message: "Service deleted" });
});

router.put("/services/:id/toggle", authenticate, async (req, res): Promise<void> => {
  const [service] = await db.select().from(servicesTable).where(eq(servicesTable.id, String(req.params.id)));
  if (!service) { res.status(404).json({ success: false, message: "Service not found" }); return; }
  if (service.sellerId !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
  const newStatus = service.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
  // Check maxActiveGigs when reactivating
  if (newStatus === "ACTIVE") {
    const plan = await getActivePlanForUser(req.user!.id);
    if (plan.maxActiveGigs !== -1) {
      const [{ value: activeCount }] = await db
        .select({ value: count() })
        .from(servicesTable)
        .where(and(eq(servicesTable.sellerId, req.user!.id), eq(servicesTable.status, "ACTIVE")));
      if (activeCount >= plan.maxActiveGigs) {
        res.status(403).json({ success: false, message: `Your ${plan.name} plan allows up to ${plan.maxActiveGigs} active gig listings. Pause another gig first or upgrade your plan.`, _planLimitExceeded: true });
        return;
      }
    }
  }
  await db.update(servicesTable).set({ status: newStatus }).where(eq(servicesTable.id, service.id));
  res.json({ success: true, data: { status: newStatus }, message: `Service ${newStatus === "ACTIVE" ? "activated" : "paused"}` });
});

export default router;
