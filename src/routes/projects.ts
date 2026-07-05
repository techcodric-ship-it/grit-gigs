import { Router, Request, Response } from 'express';
import { db, userSubscriptionsTable } from '../db';
import { projectsTable, projectBidsTable, projectDeliveriesTable } from '../db/schema/projects';
import { notificationsTable, usersTable } from '../db/schema/users';
import { freelanceWalletsTable, transactionsTable } from '../db/schema/wallet';
import { eq, desc, and, not, or, count, sql, inArray } from 'drizzle-orm';
import { reviewsTable } from '../db/schema/orders';
import { clientReviewsTable } from '../db/schema/client-reviews';
import { authenticate, optionalAuth } from '../middlewares/authenticate';
import { getActivePlanForUser, getOrCreateSubscription } from '../lib/subscriptions';
import { attachPlanBadge, attachPlanBadges } from '../lib/planBadge';
import { uploadToSupabase } from '../lib/storage';
import { PROJECT_ROOT } from '../lib/root';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = Router();

const _projUploadDir = path.join(PROJECT_ROOT, 'uploads', 'projects');
fs.mkdirSync(_projUploadDir, { recursive: true });
const _projUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, _projUploadDir),
    filename: (_req, file, cb) => { const ext = path.extname(file.originalname); cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext); },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
});

function toPositiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function attachReviewStats(users: ({ id: string } | undefined | null)[]) {
  const ids = users.filter((u): u is { id: string } => !!u && !!u.id).map(u => u.id);
  if (!ids.length) return;
  const [serviceRows, clientRows] = await Promise.all([
    ids.length ? db.select({ revieweeId: reviewsTable.revieweeId, avg: sql<number>`avg(rating)`, cnt: sql<number>`count(*)` }).from(reviewsTable).where(inArray(reviewsTable.revieweeId, ids)).groupBy(reviewsTable.revieweeId) : Promise.resolve([]),
    ids.length ? db.select({ revieweeId: clientReviewsTable.revieweeId, avg: sql<number>`avg(rating)`, cnt: sql<number>`count(*)` }).from(clientReviewsTable).where(inArray(clientReviewsTable.revieweeId, ids)).groupBy(clientReviewsTable.revieweeId) : Promise.resolve([]),
  ]);
  const allStats: Record<string, { total: number; count: number }> = {};
  for (const r of serviceRows) { if (!allStats[r.revieweeId]) allStats[r.revieweeId] = { total: 0, count: 0 }; allStats[r.revieweeId].total += Number(r.avg) * Number(r.cnt); allStats[r.revieweeId].count += Number(r.cnt); }
  for (const r of clientRows) { if (!allStats[r.revieweeId]) allStats[r.revieweeId] = { total: 0, count: 0 }; allStats[r.revieweeId].total += Number(r.avg) * Number(r.cnt); allStats[r.revieweeId].count += Number(r.cnt); }
  for (const u of users) {
    if (!u) continue;
    if (allStats[u.id]) {
      (u as any).avgRating = allStats[u.id].total / allStats[u.id].count;
      (u as any).reviewCount = allStats[u.id].count;
    } else {
      (u as any).avgRating = 0;
      (u as any).reviewCount = 0;
    }
  }
}

async function getProjectWithBids(projectId: string, currentUserId?: string) {
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId))
    .limit(1);
  if (!project) return null;

  const [owner] = await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified })
    .from(usersTable)
    .where(eq(usersTable.id, project.userId))
    .limit(1);

  const bids = await db
    .select()
    .from(projectBidsTable)
    .where(eq(projectBidsTable.projectId, projectId))
    .orderBy(desc(projectBidsTable.isHighlighted), desc(projectBidsTable.createdAt));

  const bidsWithUsers = await Promise.all(
    bids.map(async (b) => {
      const [u] = await db
        .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified })
        .from(usersTable)
        .where(eq(usersTable.id, b.userId))
        .limit(1);
      return { ...b, user: u };
    })
  );

  const allUsers = [owner, ...bidsWithUsers.map(b => b.user)].filter(Boolean);
  await attachReviewStats(allUsers);
  await attachPlanBadges(allUsers);

  return {
    ...project,
    user: owner,
    bids: bidsWithUsers,
    _userBid: currentUserId ? bidsWithUsers.find(b => b.userId === currentUserId) || null : null,
    _count: { bids: bids.length },
  };
}

// ── GET /projects — browse open projects (paginated, 10 per page) ────────────
router.get('/projects', optionalAuth, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  const { q, page = '1', limit = '10' } = req.query as { q?: string; page?: string; limit?: string };
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  const offset = (safePage - 1) * safeLimit;

  const [totalResult] = await db.select({ value: count() }).from(projectsTable).where(eq(projectsTable.status, 'OPEN'));
  const total = Number(totalResult?.value ?? 0);
  const totalPages = Math.ceil(total / safeLimit);

  const projects = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.status, 'OPEN'))
    .orderBy(desc(projectsTable.createdAt))
    .limit(safeLimit)
    .offset(offset);

  const result = await Promise.all(
    projects.map(async (p) => {
      const [owner] = await db
        .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified })
        .from(usersTable)
        .where(eq(usersTable.id, p.userId))
        .limit(1);

      const bids = await db
        .select({ id: projectBidsTable.id, userId: projectBidsTable.userId, status: projectBidsTable.status })
        .from(projectBidsTable)
        .where(eq(projectBidsTable.projectId, p.id));

      const userBid = userId ? bids.find(b => b.userId === userId) || null : null;

      return { ...p, user: owner, _count: { bids: bids.length }, _userBid: userBid };
    })
  );

  const filtered = q
    ? result.filter(p =>
        p.title.toLowerCase().includes(q.toLowerCase()) ||
        p.description.toLowerCase().includes(q.toLowerCase()) ||
        (p.category?.toLowerCase().includes(q.toLowerCase())) ||
        (p.skills?.toLowerCase().includes(q.toLowerCase()))
      )
    : result;

  // Attach review stats for all owners
  const allOwners = filtered.map(p => p.user).filter(Boolean);
  await attachReviewStats(allOwners);
  await attachPlanBadges(allOwners);

  return res.json({ success: true, data: { projects: filtered, page: safePage, totalPages, total } });
});

// ── GET /projects/mine — my posted projects ───────────────────────────────────
router.get('/projects/mine', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const projects = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.userId, userId))
    .orderBy(desc(projectsTable.createdAt));

  const result = await Promise.all(
    projects.map(async (p) => {
      const bids = await db
        .select()
        .from(projectBidsTable)
        .where(eq(projectBidsTable.projectId, p.id))
        .orderBy(desc(projectBidsTable.createdAt));

      const bidsWithUsers = await Promise.all(
        bids.map(async (b) => {
          const [u] = await db
            .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified })
            .from(usersTable)
            .where(eq(usersTable.id, b.userId))
            .limit(1);
          return { ...b, user: u };
        })
      );

      return { ...p, bids: bidsWithUsers, _count: { bids: bids.length } };
    })
  );

  // Attach review stats for all bidders
  const allBidders: { id: string }[] = [];
  for (const p of result) { for (const b of p.bids || []) { if (b.user) allBidders.push(b.user); } }
  await attachReviewStats(allBidders);
  await attachPlanBadges(allBidders);

  return res.json({ success: true, data: { projects: result } });
});

// ── GET /projects/my-bids — bids I've submitted ───────────────────────────────
router.get('/projects/my-bids', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const bids = await db
    .select()
    .from(projectBidsTable)
    .where(eq(projectBidsTable.userId, userId))
    .orderBy(desc(projectBidsTable.createdAt));

  const result = await Promise.all(
    bids.map(async (b) => {
      const [project] = await db
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.id, b.projectId))
        .limit(1);
      if (!project) return { ...b, project: null };
      const [client] = await db
        .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified })
        .from(usersTable)
        .where(eq(usersTable.id, project.userId))
        .limit(1);
      return { ...b, project: { ...project, user: client } };
    })
  );

  const allClients = result.map(r => r.project?.user).filter(Boolean);
  await attachReviewStats(allClients);
  await attachPlanBadges(allClients);

  return res.json({ success: true, data: { bids: result } });
});

// ── GET /projects/:id — single project with bids ──────────────────────────────
router.get('/projects/:id', optionalAuth, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  const projectId = req.params.id as string as string;
  const project = await getProjectWithBids(projectId, userId);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found' });
  return res.json({ success: true, data: { project } });
});

// ── POST /projects — create a project ────────────────────────────────────────
router.post('/projects', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { title, description, category, skills, budgetMin, budgetMax, deadline, imageUrl } = req.body;
  if (!title || !description || !category) {
    return res.status(400).json({ success: false, message: 'Title, description, and category are required' });
  }

  // Subscription plan: check max active projects
  const plan = await getActivePlanForUser(userId);
  if (plan.maxActiveProjects !== -1) {
    const [{ value: projectCount }] = await db
      .select({ value: sql<number>`count(*)` })
      .from(projectsTable)
      .where(and(eq(projectsTable.userId, userId), eq(projectsTable.status, 'OPEN')));
    if (Number(projectCount) >= plan.maxActiveProjects) {
      return res.status(403).json({
        success: false,
        message: `Your ${plan.name} plan allows max ${plan.maxActiveProjects} active project${plan.maxActiveProjects === 1 ? '' : 's'}. Upgrade your plan to post more.`,
        _planLimitExceeded: true,
      });
    }
  }

  const [project] = await db
    .insert(projectsTable)
    .values({
      userId,
      title: String(title).trim(),
      description: String(description).trim(),
      category,
      skills: skills || null,
      deadline: (() => { const _dl = deadline; if (!_dl || typeof _dl !== 'string' || !_dl.trim() || _dl === 'dd-mm-yyyy' || _dl === 'mm/dd/yyyy') return null; const _d1 = new Date(_dl.trim()); if (!isNaN(_d1.getTime())) return _d1; const _m = _dl.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/); if (_m) { const _d2 = new Date(_m[3]+'-'+_m[2]+'-'+_m[1]); if (!isNaN(_d2.getTime())) return _d2; } return null; })(),
      budgetMin: toPositiveInt(budgetMin),
      budgetMax: toPositiveInt(budgetMax),
      imageUrl: typeof imageUrl === 'string' && imageUrl.trim() ? imageUrl.trim() : null,
    })
    .returning();

  return res.status(201).json({ success: true, data: { project } });
});

// ── POST /projects/:id/bids — submit a bid ───────────────────────────────────
router.post('/projects/:id/bids', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const projectId = req.params.id as string as string;
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId))
    .limit(1);

  if (!project) return res.status(404).json({ success: false, message: 'Project not found' });
  if (project.status !== 'OPEN') return res.status(400).json({ success: false, message: 'Project is no longer accepting bids' });
  if (project.userId === userId) return res.status(400).json({ success: false, message: 'Cannot bid on your own project' });

  // Check if already bid
  const [existing] = await db
    .select()
    .from(projectBidsTable)
    .where(and(eq(projectBidsTable.projectId, project.id), eq(projectBidsTable.userId, userId)))
    .limit(1);

  if (existing) return res.status(400).json({ success: false, message: 'You already submitted a bid on this project' });

  const { amount, proposal, deliveryDays, highlight } = req.body;
  const bidAmount = toPositiveInt(amount);
  const deliveryEstimate = toPositiveInt(deliveryDays);
  if (!bidAmount || !proposal?.trim()) {
    return res.status(400).json({ success: false, message: 'Amount and proposal are required' });
  }

  // Truelancer rule: only ONE highlighted bid per project
  if (highlight) {
    const [existingHighlight] = await db
      .select()
      .from(projectBidsTable)
      .where(and(eq(projectBidsTable.projectId, project.id), eq(projectBidsTable.isHighlighted, true)))
      .limit(1);
    if (existingHighlight) {
      return res.status(400).json({
        success: false,
        message: 'This project already has a highlighted proposal. Only one highlighted proposal is allowed per project.',
      });
    }
  }

  // Highlighted proposal: ₹50 flat fee from wallet for every user
  let isHighlighted = false;
  let _highlightWallet: any = null;
  const HIGHLIGHT_FEE = 50;
  if (highlight) {
    const [wallet] = await db
      .select()
      .from(freelanceWalletsTable)
      .where(eq(freelanceWalletsTable.userId, userId));
    if (!wallet || Number(wallet.balance) < HIGHLIGHT_FEE) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance for highlight (₹${HIGHLIGHT_FEE} required). Add funds to your wallet first.`,
        _highlightFailed: true,
      });
    }
    _highlightWallet = wallet;
    isHighlighted = true;
  }

  // Subscription plan: deduct a proposal credit (skip for Elite / unlimited)
  const sub = await getOrCreateSubscription(userId);
  if (sub.proposalCreditsRemaining !== -1) {
    if (sub.proposalCreditsRemaining <= 0) {
      return res.status(403).json({
        success: false,
        message: 'You\'ve used all your free proposal credits this month. Upgrade your plan for more credits.',
        _creditsExhausted: true,
      });
    }
  }

  const [bid] = await db
    .insert(projectBidsTable)
    .values({
      projectId: project.id,
      userId,
      amount: bidAmount,
      proposal: proposal.trim(),
      deliveryDays: deliveryEstimate,
      isHighlighted,
    })
    .returning();

  // Deduct highlight fee AFTER bid is created
  if (isHighlighted && _highlightWallet) {
    const deductResult = await db.execute(
      sql`UPDATE ${freelanceWalletsTable} SET balance = balance - ${HIGHLIGHT_FEE}, updated_at = NOW() WHERE ${freelanceWalletsTable.id} = ${_highlightWallet.id} AND balance >= ${HIGHLIGHT_FEE}`
    );
    if (deductResult.rowCount === 0) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance for highlight (₹${HIGHLIGHT_FEE} required). Add funds to your wallet first.`,
        _highlightFailed: true,
      });
    }
    await db.insert(transactionsTable).values({
      userId,
      type: 'SERVICE_PAYMENT',
      amount: HIGHLIGHT_FEE,
      description: 'Bid highlight fee',
      status: 'COMPLETED',
    });
  }

  // Deduct proposal credit AFTER bid is created
  if (sub.proposalCreditsRemaining !== -1) {
    await db
      .update(userSubscriptionsTable)
      .set({
        proposalCreditsRemaining: sub.proposalCreditsRemaining - 1,
        updatedAt: new Date(),
      })
      .where(eq(userSubscriptionsTable.id, sub.id));
  }

  await db.insert(notificationsTable).values({
    userId: project.userId,
    type: 'PROJECT_BID_RECEIVED',
    title: 'New project proposal',
    message: `A freelancer submitted a proposal for "${project.title}".`,
    linkUrl: '/dashboard.html#my-projects',
  });

  return res.status(201).json({ success: true, data: { bid } });
});

// ── PUT /projects/bids/:bidId/accept — client accepts a bid ──────────────────
router.put('/projects/bids/:bidId/accept', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const [bid] = await db
    .select()
    .from(projectBidsTable)
    .where(eq(projectBidsTable.id, req.params.bidId as string))
    .limit(1);

  if (!bid) return res.status(404).json({ success: false, message: 'Bid not found' });

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, bid.projectId))
    .limit(1);

  if (!project) return res.status(404).json({ success: false, message: 'Project not found' });
  if (project.userId !== userId) return res.status(403).json({ success: false, message: 'Only the project owner can accept bids' });
  if (project.status !== 'OPEN') return res.status(400).json({ success: false, message: 'Project is not open' });
  if (bid.userId === userId) return res.status(400).json({ success: false, message: 'Cannot accept your own bid' });

  // Accept this bid, reject others, close project — atomically
  await db.transaction(async (tx) => {
    await tx
      .update(projectBidsTable)
      .set({ status: 'ACCEPTED' })
      .where(eq(projectBidsTable.id, bid.id));

    await tx
      .update(projectBidsTable)
      .set({ status: 'REJECTED' })
      .where(and(eq(projectBidsTable.projectId, project.id), not(eq(projectBidsTable.id, bid.id))));

    await tx
      .update(projectsTable)
      .set({ status: 'IN_PROGRESS', acceptedBidId: bid.id })
      .where(eq(projectsTable.id, project.id));
  });

  // Fetch freelancer info for the response
  const [freelancer] = await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified })
    .from(usersTable)
    .where(eq(usersTable.id, bid.userId))
    .limit(1);

  await attachPlanBadge(freelancer);

  await db.insert(notificationsTable).values({
    userId: bid.userId,
    type: 'PROJECT_BID_ACCEPTED',
    title: 'Proposal accepted! 🎉',
    message: `Your proposal for "${project.title}" was accepted. Go to My Projects → My Bids to message the client.`,
    linkUrl: '/dashboard.html#my-projects',
  });

  return res.json({
    success: true,
    message: 'Proposal accepted! The freelancer has been notified.',
    data: {
      bid: { ...bid, status: 'ACCEPTED' },
      project: { ...project, status: 'IN_PROGRESS' },
      freelancer,
    },
  });
});

// ── DELETE /projects/:id — delete/cancel a project ───────────────────────────
router.delete('/projects/:id', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, req.params.id as string), eq(projectsTable.userId, userId)))
    .limit(1);

  if (!project) return res.status(404).json({ success: false, message: 'Project not found' });

  await db
    .update(projectsTable)
    .set({ status: 'CANCELLED' })
    .where(eq(projectsTable.id, req.params.id as string));

  return res.json({ success: true, message: 'Project cancelled' });
});


// ── POST /projects/upload — upload a project cover image ─────────────────────
router.post('/projects/upload', authenticate, _projUpload.single('image'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
  const supabaseUrl = await uploadToSupabase(fs.readFileSync(req.file.path), req.file.originalname, "projects");
  const imageUrl = supabaseUrl || `/uploads/projects/${req.file.filename}`;
  return res.json({ success: true, data: { imageUrl } });
});

// ── PUT /projects/:id — edit a project ────────────────────────────────────────
router.put('/projects/:id', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const [project] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, req.params.id as string), eq(projectsTable.userId, userId))).limit(1);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found' });
  if (project.status !== 'OPEN') return res.status(400).json({ success: false, message: 'Only OPEN projects can be edited' });
  const { title, description, category, skills, budgetMin, budgetMax, deadline } = req.body;
  const [updated] = await db.update(projectsTable).set({
    ...(title ? { title: String(title).trim() } : {}),
    ...(description ? { description: String(description).trim() } : {}),
    ...(category ? { category: String(category) } : {}),
    skills: skills !== undefined ? (skills || null) : project.skills,
    budgetMin: budgetMin !== undefined ? toPositiveInt(budgetMin) : project.budgetMin,
    budgetMax: budgetMax !== undefined ? toPositiveInt(budgetMax) : project.budgetMax,
    deadline: (() => { const _dl = deadline; if (_dl === undefined) return project.deadline; if (!_dl || typeof _dl !== 'string' || !_dl.trim() || _dl === 'dd-mm-yyyy') return null; const _d1 = new Date(_dl.trim()); if (!isNaN(_d1.getTime())) return _d1; const _m = _dl.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/); if (_m) { const _d2 = new Date(_m[3]+'-'+_m[2]+'-'+_m[1]); if (!isNaN(_d2.getTime())) return _d2; } return null; })(),
    updatedAt: new Date(),
  }).where(eq(projectsTable.id, req.params.id as string)).returning();
  return res.json({ success: true, data: { project: updated }, message: 'Project updated' });
});

// ── PUT /projects/bids/:bidId — edit own pending bid ─────────────────────────
router.put('/projects/bids/:bidId', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const [bid] = await db.select().from(projectBidsTable).where(and(eq(projectBidsTable.id, req.params.bidId as string), eq(projectBidsTable.userId, userId))).limit(1);
  if (!bid) return res.status(404).json({ success: false, message: 'Bid not found or not yours' });
  if (bid.status !== 'PENDING') return res.status(400).json({ success: false, message: 'Only PENDING bids can be edited' });
  const { amount, deliveryDays, proposal } = req.body;
  const [updated] = await db.update(projectBidsTable).set({
    ...(amount ? { amount: toPositiveInt(amount) ?? bid.amount } : {}),
    deliveryDays: deliveryDays !== undefined ? (toPositiveInt(deliveryDays) || null) : bid.deliveryDays,
    ...(proposal ? { proposal: String(proposal).trim() } : {}),
    updatedAt: new Date(),
  }).where(eq(projectBidsTable.id, req.params.bidId as string)).returning();
  return res.json({ success: true, data: { bid: updated }, message: 'Proposal updated' });
});

// ── DELETE /projects/bids/:bidId — withdraw own pending bid ──────────────────
router.delete('/projects/bids/:bidId', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const [bid] = await db.select().from(projectBidsTable).where(and(eq(projectBidsTable.id, req.params.bidId as string), eq(projectBidsTable.userId, userId))).limit(1);
  if (!bid) return res.status(404).json({ success: false, message: 'Bid not found or not yours' });
  if (bid.status !== 'PENDING') return res.status(400).json({ success: false, message: 'Only PENDING bids can be withdrawn' });
  await db.delete(projectBidsTable).where(eq(projectBidsTable.id, bid.id));
  return res.json({ success: true, message: 'Proposal withdrawn.' });
});

// ── POST /projects/bids/:bidId/highlight — retroactively highlight a bid ─────
router.post('/projects/bids/:bidId/highlight', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const [bid] = await db
    .select()
    .from(projectBidsTable)
    .where(and(eq(projectBidsTable.id, req.params.bidId as string), eq(projectBidsTable.userId, userId)))
    .limit(1);

  if (!bid) return res.status(404).json({ success: false, message: 'Bid not found or not yours' });
  if (bid.isHighlighted) return res.status(400).json({ success: false, message: 'Bid is already highlighted' });
  if (bid.status !== 'PENDING') return res.status(400).json({ success: false, message: 'Only PENDING bids can be highlighted' });

  // Atomically charge ₹50 + ensure only one highlighted bid per project
  const HIGHLIGHT_FEE = 50;
  const deductResult = await db.execute(
    sql`UPDATE ${freelanceWalletsTable} SET balance = balance - ${HIGHLIGHT_FEE}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${userId} AND balance >= ${HIGHLIGHT_FEE}`
  );
  if (deductResult.rowCount === 0) {
    return res.status(400).json({
      success: false,
      message: `Insufficient balance for highlight (₹${HIGHLIGHT_FEE} required). Add funds to your wallet first.`,
    });
  }
  await db.insert(transactionsTable).values({
    userId,
    type: 'SERVICE_PAYMENT',
    amount: HIGHLIGHT_FEE,
    description: 'Bid highlight fee',
    status: 'COMPLETED',
  });

  const [updated] = await db
    .update(projectBidsTable)
    .set({ isHighlighted: true, updatedAt: new Date() })
    .where(and(eq(projectBidsTable.id, bid.id), eq(projectBidsTable.isHighlighted, false)))
    .returning();

  if (!updated) {
    return res.status(400).json({
      success: false,
      message: 'This project already has a highlighted proposal or this bid is already highlighted.',
    });
  }

  return res.json({ success: true, data: { bid: updated }, message: 'Bid highlighted! It will now appear at the top of the list.' });
});

// -- POST /projects/:id/mark-complete -- freelancer delivers work
router.post('/projects/:id/mark-complete', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, req.params.id as string)).limit(1);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found' });
  if (!['IN_PROGRESS', 'REVISION_REQUESTED'].includes(project.status)) return res.status(400).json({ success: false, message: 'Project is not in progress' });
  const _ab = project.acceptedBidId ? (await db.select().from(projectBidsTable).where(eq(projectBidsTable.id, project.acceptedBidId)).limit(1))[0] : null;
  if (!_ab || _ab.userId !== userId) return res.status(403).json({ success: false, message: 'Only the hired freelancer can mark this project as complete' });

  // Atomically claim the delivery — only the first request succeeds
  const claimResult = await db.execute(
    sql`UPDATE ${projectsTable} SET ${projectsTable.status} = 'DELIVERED', ${projectsTable.updatedAt} = NOW() WHERE ${projectsTable.id} = ${project.id} AND ${projectsTable.status} IN ('IN_PROGRESS', 'REVISION_REQUESTED')`
  );
  if (claimResult.rowCount === 0) {
    return res.status(400).json({ success: false, message: 'Project is not in progress' });
  }

  const { description: deliveryNote, link } = req.body;
  const [lastDelivery] = await db.select().from(projectDeliveriesTable).where(eq(projectDeliveriesTable.projectId, project.id)).orderBy(desc(projectDeliveriesTable.revisionNumber)).limit(1);
  const revisionNumber = lastDelivery ? lastDelivery.revisionNumber + 1 : 0;
  await db.insert(projectDeliveriesTable).values({ projectId: project.id, deliveryNote: deliveryNote || null, link: link || null, revisionNumber });

    await db.insert(notificationsTable).values({
        userId: project.userId,
        type: 'PROJECT_DELIVERED',
        title: 'Work delivered!',
        message: `The freelancer on "${project.title}" has delivered the work. Please review, approve, or request a revision.`,
        linkUrl: '/dashboard.html#my-projects',
      });
      return res.json({ success: true, message: 'Work delivered! Client can now review, approve, or request a revision.' });
});

// -- POST /projects/:id/request-revision -- client requests revision
router.post('/projects/:id/request-revision', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, req.params.id as string)).limit(1);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found' });
  if (project.userId !== userId) return res.status(403).json({ success: false, message: 'Only the client can request a revision' });
  if (project.status !== 'DELIVERED') return res.status(400).json({ success: false, message: 'Project has not been delivered' });
  const { revisionNote } = req.body;
  await db.update(projectsTable).set({ status: 'REVISION_REQUESTED', updatedAt: new Date() }).where(eq(projectsTable.id, project.id));
  const [bidForNotify] = project.acceptedBidId ? await db.select({ userId: projectBidsTable.userId }).from(projectBidsTable).where(eq(projectBidsTable.id, project.acceptedBidId)).limit(1) : [];
  await db.insert(notificationsTable).values({
    userId: bidForNotify?.userId || '',
    type: 'PROJECT_REVISION_REQUESTED',
    title: 'Revision requested',
    message: revisionNote ? `The client requested a revision: ${revisionNote}` : 'The client has requested a revision on the delivered work.',
    linkUrl: '/dashboard.html#my-projects',
  });
  return res.json({ success: true, message: 'Revision requested. Freelancer has been notified.' });
});

// -- POST /projects/:id/release-payment -- client releases payment with commission
router.post('/projects/:id/release-payment', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, req.params.id as string)).limit(1);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found' });
  if (project.userId !== userId) return res.status(403).json({ success: false, message: 'Only the project owner can release payment' });
  if (project.status !== 'DELIVERED') return res.status(400).json({ success: false, message: 'Project has not been delivered. Payment can only be released after delivery.' });
  const _ab = project.acceptedBidId ? (await db.select().from(projectBidsTable).where(eq(projectBidsTable.id, project.acceptedBidId)).limit(1))[0] : null;
  if (!_ab) return res.status(400).json({ success: false, message: 'No accepted bid found' });
  const _pay = _ab.amount;

  // Atomically claim the transition — only the first request succeeds
  const claimResult = await db.execute(
    sql`UPDATE ${projectsTable} SET ${projectsTable.status} = 'COMPLETED', ${projectsTable.updatedAt} = NOW() WHERE ${projectsTable.id} = ${project.id} AND ${projectsTable.status} = 'DELIVERED'`
  );
  if (claimResult.rowCount === 0) {
    return res.status(409).json({ success: false, message: 'Payment already released' });
  }

  // Calculate commission based on freelancer's plan
  const plan = await getActivePlanForUser(_ab.userId);
  const commissionPct = plan.serviceFeePercent;
  const commission = Math.round(_pay * commissionPct / 100);
  const netAmount = _pay - commission;

  // Wallet operations + transaction records in a DB transaction
  try {
    await db.transaction(async (tx) => {
      const deductResult = await tx.execute(
        sql`UPDATE ${freelanceWalletsTable} SET balance = balance - ${_pay}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${project.userId} AND balance >= ${_pay}`
      );
      if (deductResult.rowCount === 0) {
        throw new Error("Insufficient funds");
      }

      const creditResult = await tx.execute(
        sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${netAmount}, total_earned = COALESCE(total_earned, 0) + ${netAmount}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${_ab.userId}`
      );
      if (creditResult.rowCount === 0) {
        await tx.insert(freelanceWalletsTable).values({
          userId: _ab.userId,
          balance: netAmount,
          totalEarned: netAmount,
          updatedAt: new Date(),
        });
      }

      await tx.insert(transactionsTable).values({
        userId: project.userId,
        type: 'SERVICE_PAYMENT',
        amount: _pay,
        description: `Payment for project "${project.title}"`,
        status: 'COMPLETED',
      });

      await tx.insert(transactionsTable).values({
        userId: _ab.userId,
        type: 'SERVICE_EARNING',
        amount: netAmount,
        description: `Payment received for project "${project.title}"`,
        status: 'COMPLETED',
      });
      if (commission > 0) {
        await tx.insert(transactionsTable).values({
          userId: _ab.userId,
          type: 'COMMISSION',
          amount: commission,
          description: `Platform commission (${commissionPct}%) on project "${project.title}"`,
          status: 'COMPLETED',
        });
      }
    });
  } catch (e) {
    await db.execute(sql`UPDATE ${projectsTable} SET ${projectsTable.status} = 'DELIVERED', ${projectsTable.updatedAt} = NOW() WHERE ${projectsTable.id} = ${project.id}`);
    if (e instanceof Error && e.message === "Insufficient funds") {
      return res.status(400).json({ success: false, message: "You don't have enough funds in your wallet. Please add funds and try again." });
    }
    return res.status(500).json({ success: false, message: "Payment processing failed. Please try again." });
  }

  await db.insert(notificationsTable).values({
    userId: project.userId,
    type: 'PAYMENT_SENT',
    title: 'Payment sent',
    message: `₹${_pay} deducted from your wallet for project "${project.title}"`,
    linkUrl: '/dashboard.html#my-projects',
  });
  await db.insert(notificationsTable).values({
    userId: _ab.userId,
    type: 'PROJECT_PAYMENT_RELEASED',
    title: 'Payment received!',
    message: `You received ₹${netAmount} for "${project.title}" (${commissionPct}% commission: ₹${commission}). Thank you!`,
    linkUrl: '/dashboard.html#my-projects',
  });
  return res.json({ success: true, message: `Payment of ₹${_pay} released! Freelancer receives ₹${netAmount} (${commissionPct}% commission: ₹${commission}).` });
});

export default router;
