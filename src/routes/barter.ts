import { Router, type IRouter } from "express";
import {
  db,
  pool,
  barterRequestsTable,
  barterMatchesTable,
  barterDeliveriesTable,
  usersTable,
  notificationsTable,
  conversationsTable,
} from "../db";
import { eq, ilike, or, and, desc, ne, inArray, sql } from "drizzle-orm";
import { authenticate, optionalAuth } from "../middlewares/authenticate";
import { getActivePlanForUser, getOrCreateSubscription } from "../lib/subscriptions";
import { attachPlanBadge, attachPlanBadges } from "../lib/planBadge";
import { uploadToSupabase } from "../lib/storage";
import { PROJECT_ROOT } from "../lib/root";
import multer from "multer";
import path from "path";
import fs from "fs";

const uploadDir = path.join(PROJECT_ROOT, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const barterUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, Date.now() + "-" + Math.random().toString(36).slice(2) + ext);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const router: IRouter = Router();

router.get("/barter/requests", optionalAuth, async (req, res): Promise<void> => {
  const { page = "1", limit = "12", category, city, q, sort = "newest" } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const conditions: unknown[] = [and(eq(barterRequestsTable.status, "ACTIVE"), eq(barterRequestsTable.isPaused, false))];
  if (category && category !== "All categories") {
    conditions.push(
      or(
        ilike(barterRequestsTable.offerCategory, `%${category}%`),
        ilike(barterRequestsTable.needCategory, `%${category}%`),
        ilike(barterRequestsTable.skillOffered, `%${category}%`),
        ilike(barterRequestsTable.skillNeeded, `%${category}%`),
      ),
    );
  }
  if (city && city !== "All locations") conditions.push(ilike(barterRequestsTable.city, `%${city}%`));
  if (q) {
    conditions.push(
      or(
        ilike(barterRequestsTable.skillOffered, `%${q}%`),
        ilike(barterRequestsTable.skillNeeded, `%${q}%`),
        ilike(barterRequestsTable.description, `%${q}%`),
      ),
    );
  }

  const where = conditions.length > 1 ? and(...(conditions as Parameters<typeof and>)) : conditions[0] as ReturnType<typeof eq>;

  const orderBy = sort === "popular" ? desc(barterRequestsTable.viewCount) : desc(barterRequestsTable.createdAt);

  const [countResult, requests, remoteCountResult, activeUsersResult] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(barterRequestsTable).where(where),
    db
      .select()
      .from(barterRequestsTable)
      .where(where)
      .orderBy(orderBy)
      .limit(parseInt(limit))
      .offset(skip),
    db.select({ count: sql<number>`count(*)::int` }).from(barterRequestsTable).where(and(eq(barterRequestsTable.status, "ACTIVE"), eq(barterRequestsTable.isRemote, true))),
    db.select({ count: sql<number>`count(DISTINCT user_id)::int` }).from(barterRequestsTable).where(eq(barterRequestsTable.status, "ACTIVE")),
  ]);

  const userIds = [...new Set(requests.map(r => r.userId))];
  const users = userIds.length ? await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, city: usersTable.city, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified })
    .from(usersTable)
    .where(inArray(usersTable.id, userIds)) : [];
  const userMap = new Map(users.map(u => [u.id, u]));
  const result = requests.map(r => ({ ...r, user: userMap.get(r.userId) ?? null }));

  const total = countResult[0]?.count ?? 0;
  const remoteCount = remoteCountResult[0]?.count ?? 0;
  const activeUsers = activeUsersResult[0]?.count ?? 0;
  const limitNum = parseInt(limit);
  const totalPages = Math.ceil(total / limitNum) || 1;
  if (users.length) await attachPlanBadges(users);
  res.json({ success: true, data: { requests: result, page: parseInt(page), total, totalPages, remoteCount, activeUsers } });
});

router.get("/barter/requests/mine", authenticate, async (req, res): Promise<void> => {
  const requests = await db
    .select()
    .from(barterRequestsTable)
    .where(eq(barterRequestsTable.userId, req.user!.id))
    .orderBy(desc(barterRequestsTable.createdAt));
  const userIds = [...new Set(requests.map(r => r.userId))];
  const users = userIds.length ? await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, city: usersTable.city, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified })
    .from(usersTable)
    .where(inArray(usersTable.id, userIds)) : [];
  const userMap = new Map(users.map(u => [u.id, u]));
  const result = requests.map(r => ({ ...r, user: userMap.get(r.userId) ?? null }));
  if (users.length) await attachPlanBadges(users);
  res.json({ success: true, data: { requests: result } });
});

router.get("/barter/requests/:id", optionalAuth, async (req, res): Promise<void> => {
  const [request] = await db.select().from(barterRequestsTable).where(eq(barterRequestsTable.id, String(req.params.id)));
  if (!request) { res.status(404).json({ success: false, message: "Request not found" }); return; }

  const [user] = await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, city: usersTable.city, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified })
    .from(usersTable)
    .where(eq(usersTable.id, request.userId));

  db.execute(sql`UPDATE ${barterRequestsTable} SET view_count = view_count + 1 WHERE ${barterRequestsTable.id} = ${request.id}`).catch(() => {});
  if (user) await attachPlanBadge(user);
  res.json({ success: true, data: { request: { ...request, user } } });
});

router.post("/barter/requests", authenticate, barterUpload.single("image"), async (req, res): Promise<void> => {
  const { skillOffered, skillNeeded, offerCategory, needCategory, description, timeline, city, isRemote } = req.body;

  if (!skillOffered || !skillNeeded) {
    res.status(400).json({ success: false, message: "Skill offered and skill needed are required" });
    return;
  }

  let imageUrl: string | null = null;
  if (req.file) {
    const supabaseUrl = await uploadToSupabase(fs.readFileSync(req.file.path), req.file.originalname, "barter");
    imageUrl = supabaseUrl || `/uploads/${req.file.filename}`;
  }

  const [request] = await db
    .insert(barterRequestsTable)
    .values({
      userId: req.user!.id,
      skillOffered: skillOffered.trim(),
      skillNeeded: skillNeeded.trim(),
      offerCategory: offerCategory ?? null,
      needCategory: needCategory ?? null,
      description: description ?? null,
      timeline: timeline ?? "Flexible",
      city: city ?? req.user!.city ?? null,
      isRemote: isRemote !== false && isRemote !== "false",
      imageUrl,
    })
    .returning();

  const [user] = await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, city: usersTable.city, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified })
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.id));

  if (user) await attachPlanBadge(user);
  res.status(201).json({ success: true, message: "Exchange request posted!", data: { request: { ...request, user } } });
});

router.put("/barter/requests/:id", authenticate, async (req, res): Promise<void> => {
  const [request] = await db.select().from(barterRequestsTable).where(eq(barterRequestsTable.id, String(req.params.id)));
  if (!request) { res.status(404).json({ success: false, message: "Request not found" }); return; }
  if (request.userId !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }

  const allowed = ["skillOffered", "skillNeeded", "description", "timeline", "city", "isRemote", "offerCategory", "needCategory"] as const;
  const updates: Partial<typeof barterRequestsTable.$inferInsert> = { updatedAt: new Date() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) (updates as Record<string, unknown>)[key] = req.body[key];
  }

  // Block edit if already in an accepted match
  const [_putAcc] = await db.select().from(barterMatchesTable).where(and(or(eq(barterMatchesTable.request1Id, request.id), eq(barterMatchesTable.request2Id, request.id)), eq(barterMatchesTable.status, "ACCEPTED"))).limit(1);
  if (_putAcc) { res.status(403).json({ success: false, message: "Cannot edit — this exchange has an accepted match" }); return; }

  const [updated] = await db.update(barterRequestsTable).set(updates).where(eq(barterRequestsTable.id, request.id)).returning();
  res.json({ success: true, data: { request: updated } });
});

router.delete("/barter/requests/:id", authenticate, async (req, res): Promise<void> => {
  const [request] = await db.select().from(barterRequestsTable).where(eq(barterRequestsTable.id, String(req.params.id)));
  if (!request) { res.status(404).json({ success: false, message: "Request not found" }); return; }
  if (request.userId !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
  // Block delete if already in an accepted match
  const [_delAcc] = await db.select().from(barterMatchesTable).where(and(or(eq(barterMatchesTable.request1Id, request.id), eq(barterMatchesTable.request2Id, request.id)), eq(barterMatchesTable.status, "ACCEPTED"))).limit(1);
  if (_delAcc) { res.status(403).json({ success: false, message: "Cannot delete — this exchange has an accepted match" }); return; }
  await db.update(barterRequestsTable).set({ status: "CANCELLED" }).where(eq(barterRequestsTable.id, request.id));
  res.json({ success: true, message: "Request cancelled" });
});

// ── PATCH /barter/requests/:id/toggle-pause — pause or unpause own post ───
router.patch("/barter/requests/:id/toggle-pause", authenticate, async (req, res): Promise<void> => {
  const [request] = await db.select().from(barterRequestsTable).where(eq(barterRequestsTable.id, String(req.params.id)));
  if (!request) { res.status(404).json({ success: false, message: "Request not found" }); return; }
  if (request.userId !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }

  const newPaused = !request.isPaused;
  const [updated] = await db
    .update(barterRequestsTable)
    .set({ isPaused: newPaused, updatedAt: new Date() })
    .where(eq(barterRequestsTable.id, request.id))
    .returning();

  res.json({
    success: true,
    message: newPaused ? "Post paused. Others can't send match requests." : "Post activated. Visible to others again.",
    data: { request: updated },
  });
});

router.get("/barter/trending", async (_req, res): Promise<void> => {
  try {
    const result = await pool.query(`
      SELECT skill, COUNT(*)::int AS count FROM (
        SELECT LOWER(TRIM(skill_offered)) AS skill FROM barter_requests WHERE status = 'ACTIVE' AND is_paused = false
        UNION ALL
        SELECT LOWER(TRIM(skill_needed)) AS skill FROM barter_requests WHERE status = 'ACTIVE' AND is_paused = false
      ) t WHERE skill != ''
      GROUP BY skill ORDER BY count DESC LIMIT 10
    `);
    res.json({ success: true, data: result.rows });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch trending skills" });
  }
});

router.get("/barter/matches", authenticate, async (req, res): Promise<void> => {
  const matches = await db
    .select()
    .from(barterMatchesTable)
    .where(
      or(
        eq(barterMatchesTable.user1Id, req.user!.id),
        eq(barterMatchesTable.user2Id, req.user!.id),
      ),
    )
    .orderBy(desc(barterMatchesTable.updatedAt));

  if (!matches.length) { res.json({ success: true, data: { matches: [] } }); return; }

  const userIds = new Set<string>();
  const reqIds = new Set<string>();
  const matchIds = matches.map(m => m.id);
  for (const m of matches) {
    userIds.add(m.user1Id);
    userIds.add(m.user2Id);
    reqIds.add(m.request1Id);
    reqIds.add(m.request2Id);
  }

  let reviewedMatchIds = new Set<string>();
  try {
    const revRes = await pool.query(
      `SELECT id, match_id FROM barter_reviews WHERE match_id = ANY($1::uuid[]) AND reviewer_id = $2`,
      [matchIds, req.user!.id]
    );
    reviewedMatchIds = new Set(revRes.rows.map((r: { match_id: string }) => r.match_id));
  } catch {
    // barter_reviews table may not exist on older deployments — treat as no reviews
  }

  const [users, reqs, convs, deliveries] = await Promise.all([
    db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, city: usersTable.city, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified }).from(usersTable).where(inArray(usersTable.id, [...userIds])),
    db.select({ id: barterRequestsTable.id, skillOffered: barterRequestsTable.skillOffered, skillNeeded: barterRequestsTable.skillNeeded }).from(barterRequestsTable).where(inArray(barterRequestsTable.id, [...reqIds])),
    db.select({ id: conversationsTable.id, matchId: conversationsTable.matchId }).from(conversationsTable).where(inArray(conversationsTable.matchId, matchIds)),
    db.select().from(barterDeliveriesTable).where(inArray(barterDeliveriesTable.matchId, matchIds)).orderBy(desc(barterDeliveriesTable.createdAt)),
  ]);

  // Fetch barter review stats per user for display stars
  const userRatingMap = new Map<string, { avgRating: number; reviewCount: number }>();
  try {
    const userIdArr = [...userIds];
    if (userIdArr.length) {
      const stats = await pool.query(
        `SELECT reviewee_id, AVG(rating)::float AS avg_rating, COUNT(*)::int AS review_count FROM barter_reviews WHERE reviewee_id = ANY($1::uuid[]) GROUP BY reviewee_id`,
        [userIdArr]
      );
      for (const row of stats.rows) {
        userRatingMap.set(row.reviewee_id, { avgRating: parseFloat(row.avg_rating) || 0, reviewCount: row.review_count || 0 });
      }
    }
  } catch { /* barter_reviews table may not exist */ }

  const userMap = new Map(users.map(u => [u.id, { ...u, ...(userRatingMap.get(u.id) || { avgRating: null, reviewCount: 0 }) }]));
  const reqMap = new Map(reqs.map(r => [r.id, r]));
  const convMap = new Map(convs.map(c => [c.matchId, c]));
  const deliveriesByMatch = new Map<string, typeof barterDeliveriesTable.$inferSelect[]>();
  for (const d of deliveries) {
    const arr = deliveriesByMatch.get(d.matchId) || [];
    arr.push(d);
    deliveriesByMatch.set(d.matchId, arr);
  }
  const result = matches.map(m => ({
    ...m,
    user1: userMap.get(m.user1Id) ?? null,
    user2: userMap.get(m.user2Id) ?? null,
    request1: reqMap.get(m.request1Id) ?? null,
    request2: reqMap.get(m.request2Id) ?? null,
    conversation: convMap.get(m.id) ?? null,
    deliveries: deliveriesByMatch.get(m.id) ?? [],
    hasReviewed: reviewedMatchIds.has(m.id),
  }));

  if (users.length) await attachPlanBadges(users);
  res.json({ success: true, data: { matches: result } });
});

router.post("/barter/matches", authenticate, async (req, res): Promise<void> => {
  const { targetRequestId } = req.body;
  if (!targetRequestId) {
    res.status(400).json({ success: false, message: "targetRequestId required" });
    return;
  }

  const [targetRequest] = await db.select().from(barterRequestsTable).where(eq(barterRequestsTable.id, targetRequestId));
  if (!targetRequest || targetRequest.status !== "ACTIVE" || targetRequest.isPaused) {
    res.status(404).json({ success: false, message: "Request not found or not active" });
    return;
  }
  if (targetRequest.userId === req.user!.id) {
    res.status(400).json({ success: false, message: "Cannot match with your own request" });
    return;
  }

  const [myRequest] = await db
    .select()
    .from(barterRequestsTable)
    .where(and(eq(barterRequestsTable.userId, req.user!.id), eq(barterRequestsTable.status, "ACTIVE")))
    .orderBy(desc(barterRequestsTable.createdAt));

  if (!myRequest) {
    res.status(400).json({ success: false, message: "You need an active barter request to send a match" });
    return;
  }

  const [existing] = await db
    .select()
    .from(barterMatchesTable)
    .where(
      or(
        and(eq(barterMatchesTable.request1Id, myRequest.id), eq(barterMatchesTable.request2Id, targetRequestId)),
        and(eq(barterMatchesTable.request1Id, targetRequestId), eq(barterMatchesTable.request2Id, myRequest.id)),
      ),
    );

  // Block if target exchange already accepted elsewhere
  const [_tgtAcc] = await db.select().from(barterMatchesTable).where(and(or(eq(barterMatchesTable.request1Id, targetRequestId), eq(barterMatchesTable.request2Id, targetRequestId)), eq(barterMatchesTable.status, "ACCEPTED"))).limit(1);
  if (_tgtAcc) { res.status(400).json({ success: false, message: "This exchange has already been matched and accepted" }); return; }

  if (existing) {
    res.status(400).json({ success: false, message: "Match request already exists" });
    return;
  }

  const [match] = await db
    .insert(barterMatchesTable)
    .values({
      request1Id: myRequest.id,
      request2Id: targetRequestId,
      user1Id: req.user!.id,
      user2Id: targetRequest.userId,
    })
    .returning();

  await db.insert(notificationsTable).values({
    userId: targetRequest.userId,
    type: "NEW_MATCH",
    title: "New exchange match request!",
    message: `${req.user!.firstName} wants to exchange "${myRequest.skillOffered}" for "${myRequest.skillNeeded}"`,
    linkUrl: "/dashboard#my-exchanges",
  });

  res.status(201).json({ success: true, message: "Match request sent!", data: { match } });
});

router.put("/barter/matches/:id/respond", authenticate, async (req, res): Promise<void> => {
  const { action } = req.body;
  if (!["accept", "reject"].includes(action)) {
    res.status(400).json({ success: false, message: "Action must be accept or reject" });
    return;
  }

  const [match] = await db.select().from(barterMatchesTable).where(eq(barterMatchesTable.id, String(req.params.id)));
  if (!match) { res.status(404).json({ success: false, message: "Match not found" }); return; }
  if (match.user2Id !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
  if (match.status !== "PENDING") { res.status(400).json({ success: false, message: "Match already responded to" }); return; }

  const newStatus = action === "accept" ? "ACCEPTED" : "REJECTED";
  const [updated] = await db
    .update(barterMatchesTable)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(barterMatchesTable.id, match.id))
    .returning();

  let conversationId: string | null = null;

  if (action === "accept") {
    const [conv] = await db
      .insert(conversationsTable)
      .values({
        user1Id: match.user1Id,
        user2Id: match.user2Id,
        matchId: match.id,
        lastMessageAt: new Date(),
      })
      .returning();

    conversationId = conv.id;

    const io = req.app?.get("io");
    if (io) {
      io.to(`user:${match.user1Id}`).emit("match:accepted", {
        conversationId: conv.id,
        matchId: match.id,
        acceptedBy: req.user!.firstName,
      });
      io.to(`user:${match.user2Id}`).emit("match:accepted", {
        conversationId: conv.id,
        matchId: match.id,
        acceptedBy: req.user!.firstName,
      });
    }

    await db.insert(notificationsTable).values({
      userId: match.user1Id,
      type: "MATCH_ACCEPTED",
      title: "Match accepted!",
      message: `${req.user!.firstName} accepted your exchange request. Start chatting!`,
      linkUrl: "/dashboard#my-exchanges",
    });
  }

  res.json({ success: true, message: action === "accept" ? "Match accepted!" : "Match rejected", data: { match: updated, conversationId } });
});

router.get("/barter/ai-suggestions", authenticate, async (req, res): Promise<void> => {
  try {
    const myReqs = await db
      .select()
      .from(barterRequestsTable)
      .where(and(eq(barterRequestsTable.userId, req.user!.id), eq(barterRequestsTable.status, "ACTIVE"), eq(barterRequestsTable.isPaused, false)))
      .orderBy(desc(barterRequestsTable.createdAt));

    if (!myReqs.length) {
      res.json({ success: true, data: { suggestions: [] } });
      return;
    }

    const myReq = myReqs[0];
    const myOffer = myReq.skillOffered.trim().toLowerCase();
    const myNeed = myReq.skillNeeded.trim().toLowerCase();

    const allActive = await db
      .select()
      .from(barterRequestsTable)
      .where(and(ne(barterRequestsTable.userId, req.user!.id), eq(barterRequestsTable.status, "ACTIVE"), eq(barterRequestsTable.isPaused, false)))
      .orderBy(desc(barterRequestsTable.createdAt))
      .limit(50);

    const alreadyMatched = await db
      .select({ request2Id: barterMatchesTable.request2Id })
      .from(barterMatchesTable)
      .where(and(eq(barterMatchesTable.user1Id, req.user!.id), ne(barterMatchesTable.status, "REJECTED"), ne(barterMatchesTable.status, "CANCELLED")));

    const matchedIds = new Set(alreadyMatched.map(m => m.request2Id));

    function words(s: string): string[] {
      return s.split(/[\s,\/&+]+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(w => w.length > 1);
    }
    const myOfferWords = words(myOffer);
    const myNeedWords = words(myNeed);

    const scored = allActive
      .filter(r => !matchedIds.has(r.id))
      .map(r => {
        const theirOffer = r.skillOffered.trim().toLowerCase();
        const theirNeed = r.skillNeeded.trim().toLowerCase();
        const theirOfferWords = words(theirOffer);
        const theirNeedWords = words(theirNeed);
        let score = 0;
        if (theirOffer === myNeed && theirNeed === myOffer) score = 3;
        else if (theirOffer === myNeed || theirNeed === myOffer) score = 2.5;
        const offerMatch = theirOfferWords.some(w => myNeedWords.includes(w));
        const needMatch = theirNeedWords.some(w => myOfferWords.includes(w));
        if (offerMatch && needMatch) score = Math.max(score, 2);
        else if (offerMatch || needMatch) score = Math.max(score, 1);
        return { ...r, score };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    const userIds = [...new Set(scored.map(r => r.userId))];
    const users = userIds.length ? await db
      .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, city: usersTable.city, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified })
      .from(usersTable)
      .where(inArray(usersTable.id, userIds)) : [];
    const userMap = new Map(users.map(u => [u.id, u]));
    const suggestions = scored.map(r => ({ ...r, user: userMap.get(r.userId) ?? null }));

    if (users.length) await attachPlanBadges(users);
    res.json({ success: true, data: { suggestions, myRequest: myReq } });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to generate AI suggestions" });
  }
});

export default router;
