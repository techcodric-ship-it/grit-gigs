import { Router, Request, Response } from 'express';
import { db, userSubscriptionsTable } from '../db';
import { projectsTable, projectBidsTable, projectDeliveriesTable } from '../db/schema/projects';
import { squadsTable, squadMembersTable } from '../db/schema/squads';
import { conversationsTable, conversationParticipantsTable } from '../db/schema/messages';
import { notificationsTable, usersTable } from '../db/schema/users';
import { freelanceWalletsTable, transactionsTable } from '../db/schema/wallet';
import { eq, desc, and, not, or, count, sql, inArray, isNull } from 'drizzle-orm';
import { reviewsTable } from '../db/schema/orders';
import { clientReviewsTable } from '../db/schema/client-reviews';
import { authenticate, optionalAuth } from '../middlewares/authenticate';
import { getActivePlanForUser, getOrCreateSubscription, getPlan, consumeProjectCreation } from '../lib/subscriptions';
import { attachPlanBadge, attachPlanBadges } from '../lib/planBadge';
import { uploadToSupabase } from '../lib/storage';
import { PROJECT_ROOT } from '../lib/root';
import { notifyAllUsersNewListing, sendNotificationEmail } from '../lib/email';
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

// Tags each item's bidder (item.userId) with their active squad so a client can
// see when a proposal comes from a whole Grit Circle / squad.
async function attachSquadTags(items: { userId?: string | null }[]) {
  const userIds = items.map((i) => i.userId).filter(Boolean) as string[];
  if (!userIds.length) return;
  const rows = await db
    .select({
      userId: squadMembersTable.userId,
      squadId: squadMembersTable.squadId,
      squad: squadsTable,
      memberCount: sql<number>`(SELECT count(*) FROM ${squadMembersTable} WHERE ${squadMembersTable.squadId} = ${squadsTable.id})`,
    })
    .from(squadMembersTable)
    .innerJoin(squadsTable, eq(squadMembersTable.squadId, squadsTable.id))
    .where(and(inArray(squadMembersTable.userId, userIds), eq(squadsTable.isActive, true)));
  const byUser: Record<string, { id: string; name: string; avatar: string | null; leaderId: string; memberCount: number }> = {};
  for (const r of rows) {
    if (!byUser[r.userId]) {
      byUser[r.userId] = {
        id: r.squad.id,
        name: r.squad.name,
        avatar: r.squad.avatar,
        leaderId: r.squad.leaderId,
        memberCount: Number(r.memberCount),
      };
    }
  }
  for (const item of items) {
    if (byUser[item.userId!]) (item as any).squad = byUser[item.userId!];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function attachReviewStats(users: ({ id: string } | undefined | null)[]) {
  const ids = users.filter((u): u is { id: string } => !!u && !!u.id).map(u => u.id);
  if (!ids.length) return;
  const [serviceRows, clientRows] = await Promise.all([
    ids.length ? db.select({ revieweeId: reviewsTable.revieweeId, avg: sql<number>`avg(rating)`, cnt: sql<number>`count(*)` }).from(reviewsTable).where(inArray(reviewsTable.revieweeId, ids)).groupBy(reviewsTable.revieweeId) : Promise.resolve([]),
    ids.length ? db.select({ revieweeId: clientReviewsTable.revieweeId, avg: sql<number>`avg(rating)`, cnt: sql<number>`count(*)` }).from(clientReviewsTable).where(inArray(clientReviewsTable.revieweeId, ids)).groupBy(clientReviewsTable.revieweeId) : Promise.resolve([]),
  ]);
  let projectRows: { rows: any[] } = { rows: [] };
  try {
    if (ids.length) {
      const r = await db.execute(sql`SELECT reviewee_id, AVG(rating)::float AS avg, COUNT(*)::int AS cnt FROM project_reviews WHERE reviewee_id = ANY(${ids}::uuid[]) GROUP BY reviewee_id`);
      projectRows = r as any;
    }
  } catch { /* project_reviews table may not exist on older deployments */ }
  const allStats: Record<string, { total: number; count: number }> = {};
  for (const r of serviceRows) { if (!allStats[r.revieweeId]) allStats[r.revieweeId] = { total: 0, count: 0 }; allStats[r.revieweeId].total += Number(r.avg) * Number(r.cnt); allStats[r.revieweeId].count += Number(r.cnt); }
  for (const r of clientRows) { if (!allStats[r.revieweeId]) allStats[r.revieweeId] = { total: 0, count: 0 }; allStats[r.revieweeId].total += Number(r.avg) * Number(r.cnt); allStats[r.revieweeId].count += Number(r.cnt); }
  for (const r of projectRows.rows || []) { if (!allStats[r.reviewee_id]) allStats[r.reviewee_id] = { total: 0, count: 0 }; allStats[r.reviewee_id].total += Number(r.avg) * Number(r.cnt); allStats[r.reviewee_id].count += Number(r.cnt); }
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
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified, isActive: usersTable.isActive })
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
        .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified, isActive: usersTable.isActive })
        .from(usersTable)
        .where(eq(usersTable.id, b.userId))
        .limit(1);
      return { ...b, user: u };
    })
  );

  const allUsers = [owner, ...bidsWithUsers.map(b => b.user)].filter(Boolean);
  await attachReviewStats(allUsers);
  await attachPlanBadges(allUsers);
  await attachSquadTags(bidsWithUsers);

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

  const [totalResult] = await db
    .select({ value: count() })
    .from(projectsTable)
    .where(and(eq(projectsTable.status, 'OPEN'), isNull(projectsTable.acceptedBidId)));
  const total = Number(totalResult?.value ?? 0);
  const totalPages = Math.ceil(total / safeLimit);

  const projects = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.status, 'OPEN'), isNull(projectsTable.acceptedBidId)))
    .orderBy(desc(projectsTable.createdAt))
    .limit(safeLimit)
    .offset(offset);

  const result = await Promise.all(
    projects.map(async (p) => {
      const [owner] = await db
        .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified, isActive: usersTable.isActive })
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
            .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified, isActive: usersTable.isActive })
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

  // Attach squad tags to bids
  for (const p of result) { await attachSquadTags(p.bids || []); }

  return res.json({ success: true, data: { projects: result } });
});

// ── GET /projects/my-bids — bids I've submitted ───────────────────────────────
router.get('/projects/my-bids', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const bidderIds = [userId];
  const [userSquad] = await db.select({ squadId: squadMembersTable.squadId }).from(squadMembersTable).innerJoin(squadsTable, eq(squadsTable.id, squadMembersTable.squadId)).where(and(eq(squadMembersTable.userId, userId), eq(squadsTable.isActive, true))).limit(1);
  if (userSquad?.squadId) {
    const squadMates = await db.select({ userId: squadMembersTable.userId }).from(squadMembersTable).where(eq(squadMembersTable.squadId, userSquad.squadId));
    for (const m of squadMates) { if (!bidderIds.includes(m.userId)) bidderIds.push(m.userId); }
  }

  const bids = await db
    .select()
    .from(projectBidsTable)
    .where(inArray(projectBidsTable.userId, bidderIds))
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
        .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, reputationScore: usersTable.reputationScore, kycVerified: usersTable.kycVerified, isActive: usersTable.isActive })
        .from(usersTable)
        .where(eq(usersTable.id, project.userId))
        .limit(1);
      return { ...b, project: { ...project, user: client } };
    })
  );

  const allClients = result.map(r => r.project?.user).filter(Boolean);
  await attachReviewStats(allClients);
  await attachPlanBadges(allClients);
  await attachSquadTags(result);

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
  const projectType = (req.body.projectType === 'SQUAD' || req.body.projectType === 'squad') ? 'SQUAD' : 'INDIVIDUAL';

  // Subscription plan: check monthly project creation quota
  const plan = await getActivePlanForUser(userId);
  const projectAllowed = await consumeProjectCreation(userId, plan.maxActiveProjects);
  if (!projectAllowed) {
    return res.status(403).json({
      success: false,
      message: `Your ${plan.name} plan allows ${plan.maxActiveProjects} new project${plan.maxActiveProjects === 1 ? '' : 's'} per month and this month's quota is used up. It resets every 30 days, or upgrade your plan to post more.`,
      _planLimitExceeded: true,
    });
  }

  try {
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
        projectType,
      })
      .returning();

    notifyAllUsersNewListing("project", project.title, req.user!.firstName, "/projects", req.user!.email);
    return res.status(201).json({ success: true, data: { project } });
  } catch (err) {
    // Give the project-creation slot back if the insert failed, so a failed
    // request doesn't waste the user's monthly quota.
    try {
      const sub = await getOrCreateSubscription(userId);
      if (sub.projectsCreatedThisCycle > 0) {
        await db.execute(
          sql`UPDATE ${userSubscriptionsTable} SET projects_created_this_cycle = GREATEST(projects_created_this_cycle - 1, 0), updated_at = NOW() WHERE ${userSubscriptionsTable}.id = ${sub.id}`
        );
      }
    } catch {}
    console.error('Error creating project:', err);
    return res.status(500).json({ success: false, message: 'Failed to create project. Please try again.' });
  }
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

  // Squad projects (projectType === 'SQUAD') may only be bidded on by a member
  // of an active Grit Circle that has at least 4 members.
  if (project.projectType === 'SQUAD') {
    const memberSquads = await db
      .select({
        squadId: squadMembersTable.squadId,
        memberCount: sql<number>`(SELECT count(*) FROM ${squadMembersTable} WHERE ${squadMembersTable.squadId} = ${squadsTable.id})`,
      })
      .from(squadMembersTable)
      .innerJoin(squadsTable, eq(squadsTable.id, squadMembersTable.squadId))
      .where(and(eq(squadMembersTable.userId, userId), eq(squadsTable.isActive, true)));
    const hasTeam = memberSquads.some((s) => Number(s.memberCount) >= 4);
    if (!hasTeam) {
      return res.status(403).json({ success: false, message: 'Squad projects can only be bid on by a Grit Circle with at least 4 members. Grow your circle to unlock squad project bids.' });
    }
  }

  const { amount, proposal, deliveryDays, revisions, highlight } = req.body;
  const bidAmount = toPositiveInt(amount);
  const deliveryEstimate = toPositiveInt(deliveryDays);
  const revisionsIncluded = revisions === undefined || revisions === null ? 2 : Math.max(0, Math.min(10, Math.round(Number(revisions))));
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

  // Subscription plan: deduct a project-bid credit (skip when unlimited)
  const sub = await getOrCreateSubscription(userId);
  if (sub.proposalCreditsRemaining !== -1) {
    if (sub.proposalCreditsRemaining <= 0) {
      return res.status(403).json({
        success: false,
        message: "You've used all your project bids for this week. Upgrade your plan for unlimited bids.",
        _creditsExhausted: true,
      });
    }
  }

  let bid;
  try {
    await db.transaction(async (tx) => {
      [bid] = await tx
        .insert(projectBidsTable)
        .values({
          projectId: project.id,
          userId,
          amount: bidAmount,
          proposal: proposal.trim(),
          deliveryDays: deliveryEstimate,
          revisions: revisionsIncluded,
          isHighlighted,
        })
        .returning();

      if (isHighlighted && _highlightWallet) {
        const deductResult = await tx.execute(
          sql`UPDATE ${freelanceWalletsTable} SET balance = balance - ${HIGHLIGHT_FEE}, updated_at = NOW() WHERE ${freelanceWalletsTable.id} = ${_highlightWallet.id} AND balance >= ${HIGHLIGHT_FEE}`
        );
        if (deductResult.rowCount === 0) {
          throw new Error("INSUFFICIENT_HIGHLIGHT");
        }
        await tx.insert(transactionsTable).values({
          userId,
          type: 'SERVICE_PAYMENT',
          amount: HIGHLIGHT_FEE,
          description: 'Bid highlight fee',
          status: 'COMPLETED',
        });
      }

      if (sub.proposalCreditsRemaining !== -1) {
        await tx
          .update(userSubscriptionsTable)
          .set({
            proposalCreditsRemaining: sub.proposalCreditsRemaining - 1,
            updatedAt: new Date(),
          })
          .where(eq(userSubscriptionsTable.id, sub.id));
      }
    });
  } catch (e) {
    if (e instanceof Error && e.message === "INSUFFICIENT_HIGHLIGHT") {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance for highlight (₹${HIGHLIGHT_FEE} required). Add funds to your wallet first.`,
        _highlightFailed: true,
      });
    }
    throw e;
  }

  await db.insert(notificationsTable).values({
    userId: project.userId,
    type: 'PROJECT_BID_RECEIVED',
    title: 'New project proposal',
    message: `A freelancer submitted a proposal for "${project.title}".`,
    linkUrl: '/dashboard.html#my-projects',
  });

  const [projectOwner] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, project.userId)).limit(1);
  if (projectOwner?.email) {
    sendNotificationEmail(projectOwner.email, 'New project proposal', `A freelancer submitted a proposal for "${project.title}".`, '/dashboard.html#my-projects').catch(() => {});
  }

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

  const [clientWallet] = await db.select({ balance: freelanceWalletsTable.balance }).from(freelanceWalletsTable).where(eq(freelanceWalletsTable.userId, userId)).limit(1);
  const clientBalance = clientWallet?.balance ?? 0;
  if (clientBalance < bid.amount) {
    return res.status(400).json({ success: false, message: `You need ₹${Number(bid.amount).toLocaleString('en-IN')} in your wallet to accept this bid. Please add funds first.` });
  }

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

  // When the accepted proposal comes from a Grit Circle member, create a
  // STANDALONE project team chat (client + the full squad). This must NOT reuse
  // the circle's group chat — it is a separate conversation shown under the
  // Freelance filter, and the client is marked so the squad knows who hired them.
  let teamConversation: { id: string; groupName: string; clientId: string } | null = null;
  const bidderSquad = await db
    .select({ squadId: squadMembersTable.squadId })
    .from(squadMembersTable)
    .innerJoin(squadsTable, eq(squadsTable.id, squadMembersTable.squadId))
    .where(and(eq(squadMembersTable.userId, bid.userId), eq(squadsTable.isActive, true)))
    .limit(1);
  if (bidderSquad?.[0]) {
    const squadId = bidderSquad[0].squadId;

    // All squad members (the freelance team) plus the hiring client.
    const squadMembers = await db
      .select({ userId: squadMembersTable.userId })
      .from(squadMembersTable)
      .where(eq(squadMembersTable.squadId, squadId));
    const memberIds = squadMembers.map(m => m.userId);
    if (!memberIds.includes(project.userId)) memberIds.push(project.userId);

    // The project team chat is unique per accepted bid (its own conversation).
    let [gconv] = await db
      .select()
      .from(conversationsTable)
      .where(and(eq(conversationsTable.projectBidId, bid.id), sql`${conversationsTable.isGroup} = TRUE`))
      .limit(1);
    if (!gconv) {
      const [created] = await db.insert(conversationsTable).values({
        user1Id: project.userId,
        user2Id: bid.userId,
        isGroup: true,
        groupName: `${project.title ?? 'Project'} · Team`,
        groupId: squadId,
        projectBidId: bid.id,
        lastMessageAt: new Date(),
      }).returning();
      gconv = created;
    }

    // Add every team member + client as participants.
    for (const uid of memberIds) {
      const [already] = await db
        .select({ id: conversationParticipantsTable.id })
        .from(conversationParticipantsTable)
        .where(and(eq(conversationParticipantsTable.conversationId, gconv.id), eq(conversationParticipantsTable.userId, uid)))
        .limit(1);
      if (!already) {
        await db.insert(conversationParticipantsTable).values({ conversationId: gconv.id, userId: uid });
      }
    }

    // The client should NOT appear in the circle's group chat — remove them if
    // an earlier version accidentally added the client there.
    const [circleConv] = await db
      .select({ id: conversationsTable.id })
      .from(conversationsTable)
      .where(and(eq(conversationsTable.groupId, squadId), sql`${conversationsTable.isGroup} = TRUE`, isNull(conversationsTable.projectBidId)))
      .limit(1);
    if (circleConv) {
      await db.delete(conversationParticipantsTable)
        .where(and(eq(conversationParticipantsTable.conversationId, circleConv.id), eq(conversationParticipantsTable.userId, project.userId)))
        .catch(() => {});
    }

    try {
      req.app?.get('io')?.to(`conv:${gconv!.id}`).emit('group:updated', { conversationId: gconv!.id });
    } catch {}
    teamConversation = { id: gconv.id, groupName: gconv.groupName ?? `${project.title ?? 'Project'} · Team`, clientId: project.userId };
  }

  // Notify rejected bidders
  const rejectedBids = await db
    .select({ userId: projectBidsTable.userId })
    .from(projectBidsTable)
    .where(and(eq(projectBidsTable.projectId, project.id), eq(projectBidsTable.status, 'REJECTED')));

  for (const rb of rejectedBids) {
    await db.insert(notificationsTable).values({
      userId: rb.userId,
      type: 'PROJECT_BID_REJECTED',
      title: 'Proposal not selected',
      message: `Your proposal for "${project.title}" was not selected this time. Keep applying — the right project is out there!`,
      linkUrl: '/dashboard.html#my-projects',
    });

    const [rejectedUser] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, rb.userId)).limit(1);
    if (rejectedUser?.email) {
      sendNotificationEmail(rejectedUser.email, 'Proposal not selected', `Your proposal for "${project.title}" was not selected this time. Keep applying — the right project is out there!`, '/dashboard.html#my-projects').catch(() => {});
    }
  }

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

  const [acceptedFreelancer] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, bid.userId)).limit(1);
  if (acceptedFreelancer?.email) {
    sendNotificationEmail(acceptedFreelancer.email, 'Proposal accepted! 🎉', `Your proposal for "${project.title}" was accepted. Go to My Projects → My Bids to message the client.`, '/dashboard.html#my-projects').catch(() => {});
  }

  return res.json({
    success: true,
    message: 'Proposal accepted! The freelancer has been notified.',
    data: {
      bid: { ...bid, status: 'ACCEPTED' },
      project: { ...project, status: 'IN_PROGRESS' },
      freelancer,
      teamConversation,
    },
  });
});

// ── PUT /projects/bids/:bidId/reject — decline a single bid ───────────────────
router.put('/projects/bids/:bidId/reject', authenticate, async (req: Request, res: Response) => {
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
  if (project.userId !== userId) return res.status(403).json({ success: false, message: 'Only the project owner can reject bids' });
  if (bid.status !== 'PENDING') return res.status(400).json({ success: false, message: 'Can only reject pending bids' });

  await db.update(projectBidsTable).set({ status: 'REJECTED' }).where(eq(projectBidsTable.id, bid.id));

  await db.insert(notificationsTable).values({
    userId: bid.userId,
    type: 'PROJECT_BID_REJECTED',
    title: 'Proposal declined',
    message: `Your proposal for "${project.title}" was declined by the client.`,
    linkUrl: '/dashboard.html#my-projects',
  });

  const [rejectedUser] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, bid.userId)).limit(1);
  if (rejectedUser?.email) {
    sendNotificationEmail(rejectedUser.email, 'Proposal declined', `Your proposal for "${project.title}" was declined by the client.`, '/dashboard.html#my-projects').catch(() => {});
  }

  return res.json({ success: true, message: 'Proposal declined.' });
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
  const { title, description, category, skills, deadline } = req.body;
  const [updated] = await db.update(projectsTable).set({
    ...(title ? { title: String(title).trim() } : {}),
    ...(description ? { description: String(description).trim() } : {}),
    ...(category ? { category: String(category) } : {}),
    skills: skills !== undefined ? (skills || null) : project.skills,
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
  const { deliveryDays, proposal } = req.body;
  const [updated] = await db.update(projectBidsTable).set({
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
  await db.transaction(async (tx) => {
    await tx.delete(projectBidsTable).where(eq(projectBidsTable.id, bid.id));
    // Restore proposal bid credit if plan tracks credits
    const sub = await getOrCreateSubscription(userId);
    const plan = getPlan(sub.planId);
    if (plan.weeklyBidCredits !== -1 && sub.proposalCreditsRemaining < plan.weeklyBidCredits) {
      await tx.update(userSubscriptionsTable)
        .set({ proposalCreditsRemaining: sub.proposalCreditsRemaining + 1, updatedAt: new Date() })
        .where(eq(userSubscriptionsTable.id, sub.id));
    }
  });
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
  let updated;
  try {
    await db.transaction(async (tx) => {
      const deductResult = await tx.execute(
        sql`UPDATE ${freelanceWalletsTable} SET balance = balance - ${HIGHLIGHT_FEE}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${userId} AND balance >= ${HIGHLIGHT_FEE}`
      );
      if (deductResult.rowCount === 0) {
        throw new Error("INSUFFICIENT_HIGHLIGHT");
      }
      await tx.insert(transactionsTable).values({
        userId,
        type: 'SERVICE_PAYMENT',
        amount: HIGHLIGHT_FEE,
        description: 'Bid highlight fee',
        status: 'COMPLETED',
      });
      [updated] = await tx
        .update(projectBidsTable)
        .set({ isHighlighted: true, updatedAt: new Date() })
        .where(and(eq(projectBidsTable.id, bid.id), eq(projectBidsTable.isHighlighted, false)))
        .returning();
      if (!updated) {
        throw new Error("HIGHLIGHT_CONFLICT");
      }
    });
  } catch (e) {
    if (e instanceof Error && e.message === "INSUFFICIENT_HIGHLIGHT") {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance for highlight (₹${HIGHLIGHT_FEE} required). Add funds to your wallet first.`,
      });
    }
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
  if (!_ab) return res.status(403).json({ success: false, message: 'No accepted bid found' });
  let canDeliver = _ab.userId === userId;
  if (!canDeliver) {
    const bidderSquad = await db.select({ squadId: squadMembersTable.squadId }).from(squadMembersTable).innerJoin(squadsTable, eq(squadsTable.id, squadMembersTable.squadId)).where(and(eq(squadMembersTable.userId, _ab.userId), eq(squadsTable.isActive, true))).limit(1);
    if (bidderSquad?.[0]) {
      const isMember = await db.select({ id: squadMembersTable.id }).from(squadMembersTable).where(and(eq(squadMembersTable.squadId, bidderSquad[0].squadId), eq(squadMembersTable.userId, userId))).limit(1);
      if (isMember?.[0]) canDeliver = true;
    }
  }
  if (!canDeliver) return res.status(403).json({ success: false, message: 'Only the hired freelancer or their circle members can mark this project as complete' });

  // Atomically claim the delivery — only the first request succeeds
  const claimResult = await db.execute(
    sql`UPDATE ${sql.identifier("projects")} SET status = 'DELIVERED', updated_at = NOW() WHERE id = ${project.id} AND status IN ('IN_PROGRESS', 'REVISION_REQUESTED')`
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

  // Enforce the revision cap set on the accepted bid.
  const acceptedBid = project.acceptedBidId
    ? await db.select().from(projectBidsTable).where(eq(projectBidsTable.id, project.acceptedBidId)).limit(1)
    : [];
  const revisionsIncluded = Number(acceptedBid[0]?.revisions ?? 0);
  const [projectDeliveryCount] = await db
    .select({ value: count() })
    .from(projectDeliveriesTable)
    .where(eq(projectDeliveriesTable.projectId, project.id));
  if (Number(projectDeliveryCount.value) > revisionsIncluded) {
    return res.status(400).json({ success: false, message: `Maximum revisions (${revisionsIncluded}) reached` });
  }

  await db.update(projectsTable).set({ status: 'REVISION_REQUESTED', updatedAt: new Date() }).where(eq(projectsTable.id, project.id));
  const notifyIds: string[] = [];
  if (project.acceptedBidId) {
    const [bidOwner] = await db.select({ userId: projectBidsTable.userId }).from(projectBidsTable).where(eq(projectBidsTable.id, project.acceptedBidId)).limit(1);
    if (bidOwner?.userId) {
      const bidderSquad = await db.select({ squadId: squadMembersTable.squadId }).from(squadMembersTable).innerJoin(squadsTable, eq(squadsTable.id, squadMembersTable.squadId)).where(and(eq(squadMembersTable.userId, bidOwner.userId), eq(squadsTable.isActive, true))).limit(1);
      if (bidderSquad?.[0]) {
        const members = await db.select({ userId: squadMembersTable.userId }).from(squadMembersTable).where(eq(squadMembersTable.squadId, bidderSquad[0].squadId));
        notifyIds.push(...members.map(m => m.userId));
      } else {
        notifyIds.push(bidOwner.userId);
      }
    }
  }
  for (const nid of notifyIds) {
    await db.insert(notificationsTable).values({ userId: nid, type: 'PROJECT_REVISION_REQUESTED', title: 'Revision requested', message: revisionNote ? `The client requested a revision: ${revisionNote}` : 'The client has requested a revision on the delivered work.', linkUrl: '/dashboard.html#my-projects' });
    try { req.app?.get("io")?.to(`user:${nid}`).emit("notification:new", { type: 'PROJECT_REVISION_REQUESTED', title: 'Revision requested', message: revisionNote || 'Revision requested', linkUrl: '/dashboard.html#my-projects' }); } catch {}
  }
  if (notifyIds.length) {
    const [freelancer] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, notifyIds[0])).limit(1);
    if (freelancer?.email) {
      sendNotificationEmail(freelancer.email, 'Revision requested', revisionNote ? `The client requested a revision: ${revisionNote}` : 'The client has requested a revision on the delivered work.', '/dashboard.html#my-projects').catch(() => {});
    }
  }
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
    sql`UPDATE ${sql.identifier("projects")} SET status = 'COMPLETED', updated_at = NOW() WHERE id = ${project.id} AND status = 'DELIVERED'`
  );
  if (claimResult.rowCount === 0) {
    return res.status(409).json({ success: false, message: 'Payment already released' });
  }

  // If the accepted bidder belongs to a Grit Circle, split the payout equally
  // among all active squad members on release, then apply each member's own
  // plan commission to their share.
  const splitMemberIds = [_ab.userId];
  const bidderSquad = await db
    .select({ squadId: squadMembersTable.squadId })
    .from(squadMembersTable)
    .innerJoin(squadsTable, eq(squadsTable.id, squadMembersTable.squadId))
    .where(and(eq(squadMembersTable.userId, _ab.userId), eq(squadsTable.isActive, true)))
    .limit(1);
  if (bidderSquad?.[0]) {
    const members = await db
      .select({ userId: squadMembersTable.userId })
      .from(squadMembersTable)
      .where(eq(squadMembersTable.squadId, bidderSquad[0].squadId));
    if (members.length > 1) splitMemberIds.splice(0, splitMemberIds.length, ...members.map(m => m.userId));
  }

  const perShare = Math.floor(_pay / splitMemberIds.length);
  let remainder = _pay - perShare * splitMemberIds.length;
  const grossShares = splitMemberIds.map((userId) => {
    const amount = perShare + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    return { userId, amount };
  });
  const creditRecipients: { userId: string; grossAmount: number; commission: number; commissionPct: number; netAmount: number }[] = [];
  for (const gs of grossShares) {
    const mPlan = await getActivePlanForUser(gs.userId);
    const mPct = project.zeroCommission ? 0 : mPlan.serviceFeePercent;
    const mCommission = Math.round(gs.amount * mPct / 100);
    creditRecipients.push({
      userId: gs.userId,
      grossAmount: gs.amount,
      commission: mCommission,
      commissionPct: mPct,
      netAmount: gs.amount - mCommission,
    });
  }
  const totalCommission = creditRecipients.reduce((s, m) => s + m.commission, 0);

  // Wallet operations + transaction records in a DB transaction
  try {
    await db.transaction(async (tx) => {
      const deductResult = await tx.execute(
        sql`UPDATE ${freelanceWalletsTable} SET balance = balance - ${_pay}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${project.userId} AND balance >= ${_pay}`
      );
      if (deductResult.rowCount === 0) {
        throw new Error("Insufficient funds");
      }

      for (const rc of creditRecipients) {
        if (rc.netAmount <= 0) continue;
        const creditResult = await tx.execute(
          sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${rc.netAmount}, total_earned = COALESCE(total_earned, 0) + ${rc.netAmount}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${rc.userId}`
        );
        if (creditResult.rowCount === 0) {
          await tx.insert(freelanceWalletsTable).values({
            userId: rc.userId,
            balance: rc.netAmount,
            totalEarned: rc.netAmount,
            updatedAt: new Date(),
          });
        }
        await tx.insert(transactionsTable).values({
          userId: rc.userId,
          type: 'SERVICE_EARNING',
          amount: rc.netAmount,
          description: creditRecipients.length > 1
            ? `Your share of project payout for "${project.title}" after ${rc.commissionPct}% commission (split across ${creditRecipients.length} circle members)`
            : `Payment received for project "${project.title}"`,
          status: 'COMPLETED',
        });
        if (rc.commission > 0) {
          await tx.insert(transactionsTable).values({
            userId: rc.userId,
            type: 'COMMISSION',
            amount: rc.commission,
            description: `Platform commission (${rc.commissionPct}%) on your share of project "${project.title}"`,
            status: 'COMPLETED',
          });
        }
      }

      await tx.insert(transactionsTable).values({
        userId: project.userId,
        type: 'SERVICE_PAYMENT',
        amount: _pay,
        description: `Payment for project "${project.title}"`,
        status: 'COMPLETED',
      });
    });
  } catch (e) {
    await db.execute(sql`UPDATE ${sql.identifier("projects")} SET status = 'DELIVERED', updated_at = NOW() WHERE id = ${project.id}`);
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

  for (const rc of creditRecipients) {
    await db.insert(notificationsTable).values({
      userId: rc.userId,
      type: 'PROJECT_PAYMENT_RELEASED',
      title: 'Payment received!',
      message: creditRecipients.length > 1
        ? `You received ₹${rc.netAmount} for "${project.title}" (₹${rc.grossAmount} share, ${rc.commissionPct}% commission: ₹${rc.commission}).`
        : `You received ₹${rc.netAmount} for "${project.title}" (${rc.commissionPct}% commission: ₹${rc.commission}). Thank you!`,
      linkUrl: '/dashboard.html#my-projects',
    });
  }

  const breakdown = creditRecipients.length > 1
    ? ` split equally across ${creditRecipients.length} circle members (each ₹${creditRecipients[0].grossAmount} before commission)`
    : '';
  return res.json({ success: true, message: `Payment of ₹${_pay} released! ₹${_pay} split equally across ${creditRecipients.length} circle member${creditRecipients.length === 1 ? '' : 's'}${breakdown} (₹${totalCommission} total commission).` });
});

export default router;
