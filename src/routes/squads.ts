import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, ne, sql, count, or } from "drizzle-orm";
import {
  db,
  usersTable,
  notificationsTable,
  squadsTable,
  squadMembersTable,
  squadInvitesTable,
  squadServicesTable,
  squadOrdersTable,
  squadOrderDeliveriesTable,
  squadJoinRequestsTable,
  squadReviewsTable,
  conversationsTable,
  conversationParticipantsTable,
  messagesTable,
  userSubscriptionsTable,
  freelanceWalletsTable,
  transactionsTable,
} from "../db";
import { authenticate, optionalAuth } from "../middlewares/authenticate";
import { sendNotificationEmail } from "../lib/email";
import { getActivePlanForUser, getOrCreateSubscription, consumeGigCreation } from "../lib/subscriptions";
import { uploadToSupabase } from "../lib/storage";
import { PROJECT_ROOT } from "../lib/root";
import multer from "multer";
import fs from "fs";
import path from "path";

const router: IRouter = Router();

/** Max members a squad can hold (matches the Squad plan's 6-member allowance). */
const MAX_SQUAD_MEMBERS = 6;

function normalizeSkills(input: unknown): string[] {
  if (typeof input === "string") {
    return String(input)
      .split(/[,，、\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  if (Array.isArray(input)) {
    return (input as unknown[])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  return [];
}

function squadLite(squad: typeof squadsTable.$inferSelect, extras: Record<string, unknown> = {}) {
  return {
    id: squad.id,
    name: squad.name,
    tagline: squad.tagline ?? null,
    category: squad.category ?? null,
    description: squad.description ?? null,
    avatar: squad.avatar ?? null,
    skills: squad.skills ?? [],
    leaderId: squad.leaderId,
    isActive: squad.isActive,
    ratingAvg: squad.ratingAvg ?? 0,
    reviewCount: squad.reviewCount ?? 0,
    createdAt: squad.createdAt,
    ...extras,
  };
}

function memberJson(user: { id: string; firstName: string; lastName?: string | null; profilePhoto?: string | null; tagline?: string | null; skillsOffered?: string[] | null }, role: string, createdAt: Date) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName ?? "",
    profilePhoto: user.profilePhoto ?? null,
    tagline: user.tagline ?? null,
    skills: user.skillsOffered ?? [],
    role,
    joinedAt: createdAt,
  };
}

// Ensure a member is part of the circle's group chat so messages land in the
// same conversation as the rest of the team. Creates the group chat on demand.
async function ensureSquadGroupParticipant(squadId: string, userId: string, app?: unknown) {
  let [gconv] = await db
    .select()
    .from(conversationsTable)
    .where(and(eq(conversationsTable.groupId, squadId), sql`${conversationsTable.isGroup} = TRUE`))
    .limit(1);
  if (!gconv) {
    const [squadRow] = await db.select().from(squadsTable).where(eq(squadsTable.id, squadId)).limit(1);
    const [created] = await db
      .insert(conversationsTable)
      .values({
        user1Id: userId,
        user2Id: userId,
        isGroup: true,
        groupName: squadRow?.name ?? "Circle Chat",
        groupId: squadId,
        lastMessageAt: new Date(),
      })
      .returning();
    gconv = created;
  }
  const [already] = await db
    .select({ id: conversationParticipantsTable.id })
    .from(conversationParticipantsTable)
    .where(and(eq(conversationParticipantsTable.conversationId, gconv.id), eq(conversationParticipantsTable.userId, userId)))
    .limit(1);
  if (!already) {
    await db.insert(conversationParticipantsTable).values({ conversationId: gconv.id, userId });
  }
  try {
    (app as any)?.get?.("io")?.to(`conv:${gconv!.id}`).emit("group:updated", { conversationId: gconv!.id });
  } catch {}
}

// ── Create a Grit Circle ───────────────────────────────────────────────
router.post("/squads", authenticate, async (req: Request, res: Response): Promise<void> => {
  const leaderId = req.user!.id;
  const { name, tagline, category, description, skills, avatar } = req.body || {};

  if (!name || !String(name).trim()) {
    res.status(400).json({ success: false, message: "Give your circle a name" });
    return;
  }

  const [existing] = await db
    .select({ id: squadsTable.id })
    .from(squadMembersTable)
    .innerJoin(squadsTable, eq(squadMembersTable.squadId, squadsTable.id))
    .where(and(eq(squadMembersTable.userId, leaderId), eq(squadsTable.isActive, true)))
    .limit(1);
  if (existing) {
    res.status(400).json({ success: false, message: "You're already in a circle. Leave it first to start a new one." });
    return;
  }

  const leaderPlan = await getActivePlanForUser(leaderId);
  if (leaderPlan.squadMembers < 2) {
    res.status(403).json({ success: false, message: `Grit Circles are a Squad plan feature (₹1,499/month). Upgrade to your Squad plan to start a circle.`, _planRequired: "squad" });
    return;
  }

  const [squad] = await db
    .insert(squadsTable)
    .values({
      name: String(name).trim().slice(0, 80),
      tagline: tagline ? String(tagline).trim().slice(0, 140) : null,
      category: category ? String(category).trim().slice(0, 60) : null,
      description: description ? String(description).trim().slice(0, 1000) : null,
      avatar: avatar ? String(avatar).slice(0, 500) : null,
      skills: normalizeSkills(skills),
      leaderId,
    })
    .returning();
  await db.insert(squadMembersTable).values({ squadId: squad.id, userId: leaderId, role: "LEADER" });
  await ensureSquadGroupParticipant(squad.id, leaderId, req.app);

  res.status(201).json({ success: true, message: "Your Grit Circle is live", data: { squad: squadLite(squad) } });
});

// ── Public squad directory ─────────────────────────────────────────────
router.get("/squads", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const squadRows = await db
    .select({
      squad: squadsTable,
      leader: { id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, tagline: usersTable.tagline },
      memberCount: sql<number>`(SELECT count(*) FROM ${squadMembersTable} WHERE ${squadMembersTable.squadId} = ${squadsTable.id})`,
      serviceCount: sql<number>`(SELECT count(*) FROM ${squadServicesTable} WHERE ${squadServicesTable.squadId} = ${squadsTable.id} AND ${squadServicesTable.status} = 'ACTIVE')`,
    })
    .from(squadsTable)
    .leftJoin(usersTable, eq(squadsTable.leaderId, usersTable.id))
    .where(eq(squadsTable.isActive, true))
    .orderBy(desc(squadsTable.createdAt))
    .limit(60);

  const viewerId = req.user?.id ?? null;
  const viewerSquadIds = viewerId
    ? (
        await db
          .select({ squadId: squadMembersTable.squadId })
          .from(squadMembersTable)
          .where(eq(squadMembersTable.userId, viewerId))
      ).map((r) => r.squadId)
    : [];
  const viewerPendingIds = viewerId
    ? (
        await db
          .select({ squadId: squadJoinRequestsTable.squadId })
          .from(squadJoinRequestsTable)
          .where(and(eq(squadJoinRequestsTable.userId, viewerId), eq(squadJoinRequestsTable.status, "PENDING")))
      ).map((r) => r.squadId)
    : [];

  res.json({
    success: true,
    data: squadRows.map((r) => {
      const squadId = r.squad.id;
      return {
        ...squadLite(r.squad, { memberCount: Number(r.memberCount), serviceCount: Number(r.serviceCount) }),
        leader: r.leader ? { id: r.leader.id, firstName: r.leader.firstName, lastName: r.leader.lastName ?? "", profilePhoto: r.leader.profilePhoto ?? null, tagline: r.leader.tagline ?? null } : null,
        joined: viewerId ? viewerSquadIds.includes(squadId) : false,
        requestStatus: viewerId ? (viewerPendingIds.includes(squadId) ? "PENDING" : null) : null,
      };
    }),
  });
});

// ── My circle (leader + members view) ───────────────────────────────────
router.get("/squads/mine", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const [membership] = await db
    .select({ member: squadMembersTable, squad: squadsTable })
    .from(squadMembersTable)
    .innerJoin(squadsTable, eq(squadMembersTable.squadId, squadsTable.id))
    .where(and(eq(squadMembersTable.userId, userId), eq(squadsTable.isActive, true)))
    .limit(1);

  const myInvite = !membership
    ? await db
        .select()
        .from(squadInvitesTable)
        .innerJoin(squadsTable, eq(squadInvitesTable.squadId, squadsTable.id))
        .where(and(eq(squadInvitesTable.invitedUserId, userId), eq(squadInvitesTable.status, "PENDING")))
        .limit(1)
    : [];

  const data: Record<string, unknown> = {
    squad: null,
    role: null,
    members: [],
    openInvites: [],
    services: [],
    invite: null,
  };

  if (membership) {
    const squad = membership.squad;
    const memberRows = await db
      .select({ member: squadMembersTable, user: usersTable })
      .from(squadMembersTable)
      .innerJoin(usersTable, eq(squadMembersTable.userId, usersTable.id))
      .where(eq(squadMembersTable.squadId, squad.id))
      .orderBy(desc(squadMembersTable.role), desc(squadMembersTable.createdAt));

    const openInvites = membership.member.role === "LEADER"
      ? await db
          .select({ invite: squadInvitesTable, user: usersTable })
          .from(squadInvitesTable)
          .leftJoin(usersTable, eq(squadInvitesTable.invitedUserId, usersTable.id))
          .where(and(eq(squadInvitesTable.squadId, squad.id), eq(squadInvitesTable.status, "PENDING")))
          .orderBy(desc(squadInvitesTable.createdAt))
      : [];

    const services = await db
      .select()
      .from(squadServicesTable)
      .where(and(eq(squadServicesTable.squadId, squad.id), ne(squadServicesTable.status, "DELETED")))
      .orderBy(desc(squadServicesTable.createdAt));

    data.squad = squadLite(squad, { memberCount: memberRows.length, maxMembers: MAX_SQUAD_MEMBERS });
    data.role = membership.member.role;
    data.members = memberRows.map((m) => memberJson(m.user, m.member.role, m.member.createdAt));
    data.openInvites = openInvites.map((r) => ({
      id: r.invite.id,
      invitedEmail: r.invite.invitedEmail,
      message: r.invite.message ?? null,
      status: r.invite.status,
      createdAt: r.invite.createdAt,
      user: r.user ? { id: r.user.id, firstName: r.user.firstName, lastName: r.user.lastName ?? "", profilePhoto: r.user.profilePhoto ?? null } : null,
    }));
    data.services = services.map((s) => ({
      id: s.id,
      squadId: s.squadId,
      title: s.title,
      description: s.description,
      category: s.category ?? null,
      priceInr: s.priceInr,
      deliveryDays: s.deliveryDays,
      skills: s.skills ?? [],
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  } else if (myInvite.length) {
    const row = myInvite[0];
    data.invite = {
      id: row.squad_invites.id,
      invitedEmail: row.squad_invites.invitedEmail,
      message: row.squad_invites.message ?? null,
      createdAt: row.squad_invites.createdAt,
      squad: squadLite(row.squads, { memberCount: 0, leaderName: "" }),
    };
    const leader = await db
      .select({ firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto })
      .from(usersTable)
      .where(eq(usersTable.id, row.squads.leaderId))
      .limit(1);
    if (leader.length) {
      const invData = data.invite as { squad: Record<string, unknown> };
      invData.squad = {
        ...invData.squad,
        leader: { firstName: leader[0].firstName, lastName: leader[0].lastName ?? "", profilePhoto: leader[0].profilePhoto ?? null },
      };
    }
  }

  res.json({ success: true, data });
});

// ── Squad settings ─────────────────────────────────────────────────────
router.put("/squads/:id", authenticate, async (req: Request, res: Response): Promise<void> => {
  const squadId = String(req.params.id);
  const [membership] = await db
    .select({ member: squadMembersTable, squad: squadsTable })
    .from(squadMembersTable)
    .innerJoin(squadsTable, eq(squadMembersTable.squadId, squadsTable.id))
    .where(and(eq(squadMembersTable.squadId, squadId), eq(squadMembersTable.userId, req.user!.id)))
    .limit(1);
  if (!membership) {
    res.status(403).json({ success: false, message: "You're not in this circle" });
    return;
  }
  if (membership.member.role !== "LEADER") {
    res.status(403).json({ success: false, message: "Only the circle leader can edit settings" });
    return;
  }
  const { name, tagline, category, description, avatar, skills } = req.body || {};
  const [squad] = await db
    .update(squadsTable)
    .set({
      ...(name !== undefined ? { name: String(name).trim().slice(0, 80) } : {}),
      ...(tagline !== undefined ? { tagline: String(tagline).trim().slice(0, 140) || null } : {}),
      ...(category !== undefined ? { category: String(category).trim().slice(0, 60) || null } : {}),
      ...(description !== undefined ? { description: String(description).trim().slice(0, 1000) || null } : {}),
      ...(avatar !== undefined ? { avatar: String(avatar).slice(0, 500) || null } : {}),
      ...(skills !== undefined ? { skills: normalizeSkills(skills) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(squadsTable.id, squadId))
    .returning();
  res.json({ success: true, message: "Circle updated", data: { squad: squadLite(squad) } });
});

// ── Delete squad ───────────────────────────────────────────────────────
router.delete("/squads/:id", authenticate, async (req: Request, res: Response): Promise<void> => {
  const squadId = String(req.params.id);
  const [membership] = await db
    .select({ member: squadMembersTable })
    .from(squadMembersTable)
    .where(and(eq(squadMembersTable.squadId, squadId), eq(squadMembersTable.userId, req.user!.id)))
    .limit(1);
  if (!membership) {
    res.status(403).json({ success: false, message: "You're not in this circle" });
    return;
  }
  if (membership.member.role !== "LEADER") {
    res.status(403).json({ success: false, message: "Only the circle leader can delete it" });
    return;
  }
  await db.update(squadsTable).set({ isActive: false, updatedAt: new Date() }).where(eq(squadsTable.id, squadId));
  res.json({ success: true, message: "Circle deleted" });
});

// ── Invite by email ────────────────────────────────────────────────────
router.post("/squads/:id/invites", authenticate, async (req: Request, res: Response): Promise<void> => {
  const squadId = String(req.params.id);
  const { email, ggId, message } = req.body || {};
  const inviteEmailBase = String(email || "").trim().toLowerCase();
  const rawGgId = String(ggId || "").trim();
  let inviteEmail = inviteEmailBase;
  let inviteUserId: string | null = null;

  if (!inviteEmail && !rawGgId) {
    res.status(400).json({ success: false, message: "Enter an email address or a GG ID" });
    return;
  }

  if (inviteEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail)) {
    res.status(400).json({ success: false, message: "Enter a valid email address" });
    return;
  }

  // If provided, resolve the GG ID (G&G-XXXXXXXX or XXXXXXXX) to a user.
  if (rawGgId) {
    const ggPrefix = rawGgId.toUpperCase().startsWith("G&G-") ? rawGgId.slice(4) : rawGgId;
    if (!/^[0-9A-Fa-f]{8}$/.test(ggPrefix)) {
      res.status(400).json({ success: false, message: "Invalid GG ID format. Use G&G-XXXXXXXX or just XXXXXXXX" });
      return;
    }
    const hexLower = ggPrefix.toLowerCase();
    const matches = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(sql`LOWER(REPLACE(id::text, '-', '')) LIKE ${hexLower + '%'}`)
      .limit(1);
    if (!matches.length) {
      res.status(400).json({ success: false, message: "No member found with that GG ID" });
      return;
    }
    inviteUserId = matches[0].id;
    if (!inviteEmail) inviteEmail = matches[0].email.trim().toLowerCase();
  }

  if (inviteUserId && inviteUserId === req.user!.id) {
    res.status(400).json({ success: false, message: "You can't invite yourself" });
    return;
  }
  if (!inviteUserId && inviteEmail === req.user!.email.trim().toLowerCase()) {
    res.status(400).json({ success: false, message: "You can't invite yourself" });
    return;
  }

  const [membership] = await db
    .select({ member: squadMembersTable, squad: squadsTable })
    .from(squadMembersTable)
    .innerJoin(squadsTable, eq(squadMembersTable.squadId, squadsTable.id))
    .where(and(eq(squadMembersTable.squadId, squadId), eq(squadMembersTable.userId, req.user!.id)))
    .limit(1);
  if (!membership) {
    res.status(403).json({ success: false, message: "You're not in this circle" });
    return;
  }
  if (membership.member.role !== "LEADER") {
    res.status(403).json({ success: false, message: "Only the leader can invite members" });
    return;
  }

  const inviterPlan = await getActivePlanForUser(req.user!.id);
  if (inviterPlan.squadMembers < 2) {
    res.status(403).json({ success: false, message: "Grit Circles are a Squad plan feature. Upgrade to your Squad plan to invite members." });
    return;
  }

  const squad = membership.squad;
  const memberCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(squadMembersTable)
    .where(eq(squadMembersTable.squadId, squadId));
  if (Number(memberCount[0]?.count ?? 0) >= MAX_SQUAD_MEMBERS) {
    res.status(400).json({ success: false, message: `This circle is full (${MAX_SQUAD_MEMBERS} members max)` });
    return;
  }

  const [targetUser] = inviteUserId
    ? await db.select().from(usersTable).where(eq(usersTable.id, inviteUserId)).limit(1)
    : await db.select().from(usersTable).where(eq(usersTable.email, inviteEmail)).limit(1);
  if (!targetUser && inviteUserId) {
    res.status(400).json({ success: false, message: "No member found with that GG ID" });
    return;
  }

  const [dupe] = await db
    .select({ id: squadInvitesTable.id })
    .from(squadInvitesTable)
    .where(and(eq(squadInvitesTable.squadId, squadId), eq(squadInvitesTable.invitedEmail, inviteEmail), eq(squadInvitesTable.status, "PENDING")))
    .limit(1);
  if (dupe) {
    res.status(400).json({ success: false, message: "That email already has a pending invite" });
    return;
  }
  if (targetUser) {
    const [already] = await db
      .select({ id: squadMembersTable.id })
      .from(squadMembersTable)
      .innerJoin(squadsTable, eq(squadMembersTable.squadId, squadsTable.id))
      .where(and(eq(squadMembersTable.userId, targetUser.id), eq(squadsTable.isActive, true)))
      .limit(1);
    if (already) {
      res.status(400).json({ success: false, message: "That person is already in a circle" });
      return;
    }
  }

  const [invite] = await db
    .insert(squadInvitesTable)
    .values({ squadId, invitedEmail: inviteEmail, invitedUserId: targetUser?.id ?? null, message: message ? String(message).trim().slice(0, 500) : null })
    .returning();

  if (targetUser) {
    const title = `${req.user!.firstName} invited you to join "${squad.name}"`;
    const body = `${req.user!.firstName} ${req.user!.lastName} invited you to join "${squad.name}" on Grit&Gigs. Accept the invite to bid on projects as a team.`;
    await db.insert(notificationsTable).values({
      userId: targetUser.id,
      type: "SQUAD_INVITE",
      title,
      message: message ? String(message).trim().slice(0, 160) : `Join "${squad.name}" and start bidding as a team.`,
      linkUrl: "/dashboard#grit-circle",
    });
    try {
      req.app?.get("io")?.to(`user:${targetUser.id}`).emit("notification:new", {
        type: "SQUAD_INVITE",
        title,
        message,
        linkUrl: "/dashboard#grit-circle",
      });
    } catch {}
    sendNotificationEmail(targetUser.email, `${req.user!.firstName} invited you to join "${squad.name}"`, body, "/dashboard#grit-circle").catch(() => {});
  }

  res.status(201).json({
    success: true,
    message: targetUser
      ? `Invite sent to ${inviteEmail}`
      : `Invite sent to ${inviteEmail} — they'll get a link the next time they sign in or register.`,
    data: { invite: { id: invite.id, invitedEmail: invite.invitedEmail, status: invite.status, createdAt: invite.createdAt } },
  });
});

// ── My pending invites (all invites sent to me) ───────────────────────
router.get("/squads/invites/mine", authenticate, async (req: Request, res: Response): Promise<void> => {
  const rows = await db
    .select({ invite: squadInvitesTable, squad: squadsTable, leader: { id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto } })
    .from(squadInvitesTable)
    .innerJoin(squadsTable, eq(squadInvitesTable.squadId, squadsTable.id))
    .leftJoin(usersTable, eq(squadsTable.leaderId, usersTable.id))
    .where(and(eq(squadInvitesTable.invitedUserId, req.user!.id), eq(squadInvitesTable.status, "PENDING"), eq(squadsTable.isActive, true)))
    .orderBy(desc(squadInvitesTable.createdAt));
  res.json({
    success: true,
    data: rows.map((r) => ({
      id: r.invite.id,
      message: r.invite.message ?? null,
      createdAt: r.invite.createdAt,
      squad: squadLite(r.squad, {
        leader: r.leader ? { id: r.leader.id, firstName: r.leader.firstName, lastName: r.leader.lastName ?? "", profilePhoto: r.leader.profilePhoto ?? null } : null,
      }),
    })),
  });
});

// ── Accept / decline an invite ─────────────────────────────────────────
router.put("/squads/invites/:inviteId", authenticate, async (req: Request, res: Response): Promise<void> => {
  const inviteId = String(req.params.inviteId);
  const { status } = req.body || {};
  if (!["ACCEPTED", "DECLINED"].includes(status)) {
    res.status(400).json({ success: false, message: "Invalid response" });
    return;
  }

  const [invite] = await db
    .select({ invite: squadInvitesTable, squad: squadsTable, leaderUser: usersTable })
    .from(squadInvitesTable)
    .innerJoin(squadsTable, eq(squadInvitesTable.squadId, squadsTable.id))
    .leftJoin(usersTable, eq(squadsTable.leaderId, usersTable.id))
    .where(and(eq(squadInvitesTable.id, inviteId), eq(squadInvitesTable.status, "PENDING")))
    .limit(1);
  if (!invite) {
    res.status(404).json({ success: false, message: "Invite not found or already responded" });
    return;
  }
  if (invite.invite.invitedUserId !== req.user!.id && invite.invite.invitedEmail.toLowerCase() !== req.user!.email.toLowerCase()) {
    res.status(403).json({ success: false, message: "This invite wasn't meant for you" });
    return;
  }

  if (status === "ACCEPTED") {
    const accepterPlan = await getActivePlanForUser(req.user!.id);
    if (accepterPlan.squadMembers < 2) {
      res.status(403).json({ success: false, message: "Grit Circles are a Squad plan feature. Upgrade to your Squad plan to join this circle." });
      return;
    }
    const memberCount = await db.select({ count: sql<number>`count(*)` }).from(squadMembersTable).where(eq(squadMembersTable.squadId, invite.squad.id));
    if (Number(memberCount[0]?.count ?? 0) >= MAX_SQUAD_MEMBERS) {
      res.status(400).json({ success: false, message: `Sorry, that circle is full (${MAX_SQUAD_MEMBERS} members max)` });
      return;
    }
    const [existing] = await db
      .select({ id: squadMembersTable.id })
      .from(squadMembersTable)
      .innerJoin(squadsTable, eq(squadMembersTable.squadId, squadsTable.id))
      .where(and(eq(squadMembersTable.userId, req.user!.id), eq(squadsTable.isActive, true)))
      .limit(1);
    if (existing) {
      res.status(400).json({ success: false, message: "You're already in a circle" });
      return;
    }
    await db.insert(squadMembersTable).values({ squadId: invite.squad.id, userId: req.user!.id, role: "MEMBER" });
    await ensureSquadGroupParticipant(invite.squad.id, req.user!.id, req.app);
  }

  await db
    .update(squadInvitesTable)
    .set({ status, respondedAt: new Date() })
    .where(eq(squadInvitesTable.id, inviteId));

  const leaderNotif = {
    type: "SQUAD_" + status,
    title: status === "ACCEPTED" ? `${req.user!.firstName} joined your circle` : `${req.user!.firstName} declined your invite`,
    message: status === "ACCEPTED" ? `${req.user!.firstName} accepted your invite to "${invite.squad.name}".` : `${req.user!.firstName} declined your invite to "${invite.squad.name}".`,
    linkUrl: "/dashboard#grit-circle",
  };
  await db.insert(notificationsTable).values({ userId: invite.squad.leaderId, ...leaderNotif });
  try {
    req.app?.get("io")?.to(`user:${invite.squad.leaderId}`).emit("notification:new", leaderNotif);
  } catch {}
  if (invite.leaderUser) {
    sendNotificationEmail(invite.leaderUser.email, leaderNotif.title, leaderNotif.message, leaderNotif.linkUrl).catch(() => {});
  }

  res.json({ success: true, message: status === "ACCEPTED" ? "You're now part of the circle" : "Invite declined" });
});

// ── Leader cancels a pending invite ────────────────────────────────────
router.delete("/squads/invites/:inviteId", authenticate, async (req: Request, res: Response): Promise<void> => {
  const inviteId = String(req.params.inviteId);
  const [invite] = await db.select().from(squadInvitesTable).where(eq(squadInvitesTable.id, inviteId)).limit(1);
  if (!invite) {
    res.status(404).json({ success: false, message: "Invite not found" });
    return;
  }
  const [membership] = await db
    .select({ member: squadMembersTable })
    .from(squadMembersTable)
    .where(and(eq(squadMembersTable.squadId, invite.squadId), eq(squadMembersTable.userId, req.user!.id)))
    .limit(1);
  if (!membership || membership.member.role !== "LEADER") {
    res.status(403).json({ success: false, message: "Only the leader can cancel invites" });
    return;
  }
  await db.update(squadInvitesTable).set({ status: "DECLINED", respondedAt: new Date() }).where(eq(squadInvitesTable.id, inviteId));
  res.json({ success: true, message: "Invite cancelled" });
});

// ── Leader removes a member ────────────────────────────────────────────
router.delete("/squads/:id/members/:memberId", authenticate, async (req: Request, res: Response): Promise<void> => {
  const squadId = String(req.params.id);
  const memberId = String(req.params.memberId);

  const [membership] = await db
    .select({ member: squadMembersTable })
    .from(squadMembersTable)
    .where(and(eq(squadMembersTable.squadId, squadId), eq(squadMembersTable.userId, req.user!.id)))
    .limit(1);
  if (!membership || membership.member.role !== "LEADER") {
    res.status(403).json({ success: false, message: "Only the leader can remove members" });
    return;
  }
  const [target] = await db
    .select({ member: squadMembersTable, user: usersTable })
    .from(squadMembersTable)
    .innerJoin(usersTable, eq(squadMembersTable.userId, usersTable.id))
    .where(and(eq(squadMembersTable.squadId, squadId), eq(squadMembersTable.userId, memberId)))
    .limit(1);
  if (!target) {
    res.status(404).json({ success: false, message: "Member not found" });
    return;
  }
  if (target.member.role === "LEADER") {
    res.status(400).json({ success: false, message: "The leader can't be removed" });
    return;
  }
  await db.delete(squadMembersTable).where(eq(squadMembersTable.id, target.member.id));

  const notif = { type: "SQUAD_REMOVED", title: "You were removed from a circle", message: `You were removed from "${membership.member.role === "LEADER" ? "the circle" : "a circle"}".`, linkUrl: "/dashboard#grit-circle" };
  await db.insert(notificationsTable).values({ userId: target.user.id, ...notif });
  try {
    req.app?.get("io")?.to(`user:${target.user.id}`).emit("notification:new", notif);
  } catch {}

  res.json({ success: true, message: "Member removed" });
});

// ── Member leaves ──────────────────────────────────────────────────────
router.delete("/squads/:id/leave", authenticate, async (req: Request, res: Response): Promise<void> => {
  const squadId = String(req.params.id);
  const [membership] = await db
    .select()
    .from(squadMembersTable)
    .where(and(eq(squadMembersTable.squadId, squadId), eq(squadMembersTable.userId, req.user!.id)))
    .limit(1);
  if (!membership) {
    res.status(404).json({ success: false, message: "You're not in this circle" });
    return;
  }
  if (membership.role === "LEADER") {
    res.status(400).json({ success: false, message: "Leaders can't leave — delete the circle instead" });
    return;
  }
  await db.delete(squadMembersTable).where(eq(squadMembersTable.id, membership.id));

  const [squad] = await db.select({ name: squadsTable.name, leaderId: squadsTable.leaderId }).from(squadsTable).where(eq(squadsTable.id, squadId)).limit(1);
  if (squad) {
    const notif = { type: "SQUAD_REMOVED", title: `${req.user!.firstName} left your circle`, message: `They left "${squad.name}".`, linkUrl: "/dashboard#grit-circle" };
    await db.insert(notificationsTable).values({ userId: squad.leaderId, ...notif });
    try {
      req.app?.get("io")?.to(`user:${squad.leaderId}`).emit("notification:new", notif);
    } catch {}
  }

  res.json({ success: true, message: "You left the circle" });
});

// ── Squad services ─────────────────────────────────────────────────────
function serviceJson(s: typeof squadServicesTable.$inferSelect) {
  return {
    id: s.id,
    squadId: s.squadId,
    title: s.title,
    description: s.description,
    category: s.category ?? null,
    coverImage: s.coverImage ?? null,
    priceInr: s.priceInr,
    deliveryDays: s.deliveryDays,
    revisions: s.revisions,
    orderCount: s.orderCount,
    skills: s.skills ?? [],
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// Public feed of ACTIVE squad services
router.get("/squads/services", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const rows = await db
    .select({
      service: squadServicesTable,
      squad: squadsTable,
      leader: { id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto },
      memberCount: sql<number>`(SELECT count(*) FROM ${squadMembersTable} WHERE ${squadMembersTable.squadId} = ${squadsTable.id})`,
    })
    .from(squadServicesTable)
    .innerJoin(squadsTable, eq(squadServicesTable.squadId, squadsTable.id))
    .leftJoin(usersTable, eq(squadsTable.leaderId, usersTable.id))
    .where(and(eq(squadServicesTable.status, "ACTIVE"), eq(squadsTable.isActive, true)))
    .orderBy(desc(squadServicesTable.createdAt))
    .limit(80);
  const mySquadIds = new Set<string>();
  if (req.user?.id) {
    const my = await db
      .select({ squadId: squadMembersTable.squadId })
      .from(squadMembersTable)
      .where(eq(squadMembersTable.userId, req.user.id));
    for (const m of my) mySquadIds.add(m.squadId);
  }
  res.json({
    success: true,
    data: rows.map((r) => ({
      ...serviceJson(r.service),
      squadName: r.squad.name,
      squadAvatar: r.squad.avatar ?? null,
      squadMemberCount: Number(r.memberCount),
      squadRatingAvg: r.squad.ratingAvg ?? 0,
      squadReviewCount: r.squad.reviewCount ?? 0,
      isOwnSquad: mySquadIds.has(r.squad.id),
      leader: r.leader ? { id: r.leader.id, firstName: r.leader.firstName, lastName: r.leader.lastName ?? "", profilePhoto: r.leader.profilePhoto ?? null } : null,
    })),
  });
});

// Create a squad service
router.post("/squads/:id/services", authenticate, async (req: Request, res: Response): Promise<void> => {
  const squadId = String(req.params.id);
  const { title, description, category, priceInr, deliveryDays, revisions, skills, coverImage } = req.body || {};

  if (!title || !String(title).trim()) {
    res.status(400).json({ success: false, message: "Service title is required" });
    return;
  }
  if (!description || !String(description).trim()) {
    res.status(400).json({ success: false, message: "Describe what the team delivers" });
    return;
  }
  const price = Number(priceInr);
  if (!Number.isFinite(price) || price <= 0) {
    res.status(400).json({ success: false, message: "Enter a valid price in ₹" });
    return;
  }

  const [membership] = await db
    .select({ member: squadMembersTable, squad: squadsTable })
    .from(squadMembersTable)
    .innerJoin(squadsTable, eq(squadMembersTable.squadId, squadsTable.id))
    .where(and(eq(squadMembersTable.squadId, squadId), eq(squadMembersTable.userId, req.user!.id), eq(squadsTable.isActive, true)))
    .limit(1);
  if (!membership) {
    res.status(403).json({ success: false, message: "You must be in this circle to publish services" });
    return;
  }

  // Squad service publishing consumes the same monthly gig allowance as
  // posting an individual service.
  const plan = await getActivePlanForUser(req.user!.id);
  const gigAllowed = await consumeGigCreation(req.user!.id, plan.maxActiveGigs);
  if (!gigAllowed) {
    res.status(403).json({
      success: false,
      message: `Your ${plan.name} plan allows ${plan.maxActiveGigs} gig${plan.maxActiveGigs === 1 ? '' : 's'} per month and this month's quota is used up. It resets every 30 days, or upgrade your plan to get more.`,
      _planLimitExceeded: true,
    });
    return;
  }

  let service: typeof squadServicesTable.$inferSelect;
  try {
    const [created] = await db
      .insert(squadServicesTable)
      .values({
        squadId,
        title: String(title).trim().slice(0, 120),
        description: String(description).trim().slice(0, 2000),
        category: category ? String(category).trim().slice(0, 60) : null,
        coverImage: coverImage ? String(coverImage).trim().slice(0, 500) : null,
        priceInr: Math.max(1, Math.round(price)),
        deliveryDays: Math.max(1, Math.min(90, Number(deliveryDays) || 7)),
        revisions: revisions === undefined || revisions === null ? 2 : Math.max(0, Math.min(10, Math.round(Number(revisions)))),
        skills: normalizeSkills(skills),
      })
      .returning();
    service = created;
  } catch (err) {
    // Give the gig-creation slot back if the insert failed, so a failed
    // request doesn't waste the user's monthly quota.
    try {
      const sub = await getOrCreateSubscription(req.user!.id);
      if (sub.gigsCreatedThisCycle > 0) {
        await db.execute(
          sql`UPDATE ${userSubscriptionsTable} SET gigs_created_this_cycle = GREATEST(gigs_created_this_cycle - 1, 0), updated_at = NOW() WHERE ${userSubscriptionsTable}.id = ${sub.id}`
        );
      }
    } catch {}
    console.error("Error creating squad service:", err);
    res.status(500).json({ success: false, message: "Failed to create squad service. Please try again." });
    return;
  }

  res.status(201).json({ success: true, message: "Squad service published", data: { service: serviceJson(service) } });
});

// Update a squad service
router.put("/squads/services/:serviceId", authenticate, async (req: Request, res: Response): Promise<void> => {
  const serviceId = String(req.params.serviceId);
  const [membership] = await db
    .select({ member: squadMembersTable })
    .from(squadServicesTable)
    .innerJoin(squadMembersTable, eq(squadServicesTable.squadId, squadMembersTable.squadId))
    .where(and(eq(squadServicesTable.id, serviceId), eq(squadMembersTable.userId, req.user!.id)))
    .limit(1);
  if (!membership) {
    res.status(403).json({ success: false, message: "You're not in the squad that owns this service" });
    return;
  }
  const { title, description, category, priceInr, deliveryDays, revisions, skills, status, coverImage } = req.body || {};
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (title !== undefined) patch.title = String(title).trim().slice(0, 120);
  if (description !== undefined) patch.description = String(description).trim().slice(0, 2000);
  if (category !== undefined) patch.category = String(category).trim().slice(0, 60) || null;
  if (coverImage !== undefined) patch.coverImage = String(coverImage).trim().slice(0, 500) || null;
  if (priceInr !== undefined) patch.priceInr = Math.max(1, Math.round(Number(priceInr) || 1));
  if (deliveryDays !== undefined) patch.deliveryDays = Math.max(1, Math.min(90, Number(deliveryDays) || 7));
  if (revisions !== undefined) patch.revisions = Math.max(0, Math.min(10, Math.round(Number(revisions))));
  if (skills !== undefined) patch.skills = normalizeSkills(skills);
  if (status !== undefined && ["ACTIVE", "PAUSED", "DELETED"].includes(status)) patch.status = status;

  const [service] = await db.update(squadServicesTable).set(patch).where(eq(squadServicesTable.id, serviceId)).returning();
  res.json({ success: true, message: "Service updated", data: { service: serviceJson(service) } });
});

// Pause / delete a squad service
router.delete("/squads/services/:serviceId", authenticate, async (req: Request, res: Response): Promise<void> => {
  const serviceId = String(req.params.serviceId);
  const [membership] = await db
    .select({ member: squadMembersTable })
    .from(squadServicesTable)
    .innerJoin(squadMembersTable, eq(squadServicesTable.squadId, squadMembersTable.squadId))
    .where(and(eq(squadServicesTable.id, serviceId), eq(squadMembersTable.userId, req.user!.id)))
    .limit(1);
  if (!membership) {
    res.status(403).json({ success: false, message: "You're not in the squad that owns this service" });
    return;
  }
  await db.update(squadServicesTable).set({ status: "DELETED", updatedAt: new Date() }).where(eq(squadServicesTable.id, serviceId));
  res.json({ success: true, message: "Service removed" });
});

// ── Squad avatar / cover image upload ──────────────────────────────────────
const _squadUploadDir = path.join(PROJECT_ROOT, "uploads", "squads");
fs.mkdirSync(_squadUploadDir, { recursive: true });
const _squadUpload = multer({
  storage: multer.diskStorage({
    destination: (_req: Request, _file: unknown, cb) => cb(null, _squadUploadDir),
    filename: (_req: Request, file: { originalname: string }, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.post("/squads/upload", authenticate, _squadUpload.single("image"), async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ success: false, message: "No file uploaded" });
    return;
  }
  const supabaseUrl = await uploadToSupabase(fs.readFileSync(req.file.path), req.file.originalname, "squads");
  const imageUrl = supabaseUrl || `/uploads/squads/${req.file.filename}`;
  res.json({ success: true, data: { imageUrl } });
});

// ── Join requests (members ask to join a circle) ───────────────────────────
router.get("/squads/:id/join-requests", authenticate, async (req: Request, res: Response): Promise<void> => {
  const squadId = String(req.params.id);
  const [leadership] = await db
    .select({ role: squadMembersTable.role })
    .from(squadMembersTable)
    .where(and(eq(squadMembersTable.squadId, squadId), eq(squadMembersTable.userId, req.user!.id)))
    .limit(1);
  if (!leadership || leadership.role !== "LEADER") {
    res.status(403).json({ success: false, message: "Only the leader can review join requests" });
    return;
  }
  const rows = await db
    .select({
      request: squadJoinRequestsTable,
      user: {
        id: usersTable.id,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        profilePhoto: usersTable.profilePhoto,
        tagline: usersTable.tagline,
        skillsOffered: usersTable.skillsOffered,
      },
    })
    .from(squadJoinRequestsTable)
    .innerJoin(usersTable, eq(squadJoinRequestsTable.userId, usersTable.id))
    .where(and(eq(squadJoinRequestsTable.squadId, squadId), eq(squadJoinRequestsTable.status, "PENDING")))
    .orderBy(desc(squadJoinRequestsTable.createdAt));
  res.json({
    success: true,
    data: {
      requests: rows.map((r) => ({
        id: r.request.id,
        message: r.request.message,
        createdAt: r.request.createdAt,
        user: memberJson(r.user, "PENDING", r.request.createdAt),
      })),
    },
  });
});

router.post("/squads/join-requests", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { squadId, message } = req.body || {};
  if (!squadId) {
    res.status(400).json({ success: false, message: "squadId is required" });
    return;
  }
  const [squad] = await db.select().from(squadsTable).where(and(eq(squadsTable.id, String(squadId)), eq(squadsTable.isActive, true))).limit(1);
  if (!squad) {
    res.status(404).json({ success: false, message: "Circle not found" });
    return;
  }
  const [existingMember] = await db
    .select({ id: squadMembersTable.id })
    .from(squadMembersTable)
    .innerJoin(squadsTable, eq(squadsTable.id, squadMembersTable.squadId))
    .where(and(eq(squadMembersTable.userId, req.user!.id), eq(squadsTable.isActive, true)))
    .limit(1);
  if (existingMember) {
    res.status(400).json({ success: false, message: "You're already in a circle. Leave it first to join another." });
    return;
  }
  const joinPlan = await getActivePlanForUser(req.user!.id);
  if (joinPlan.squadMembers < 2) {
    res.status(403).json({ success: false, message: "Grit Circles are a Squad plan feature. Upgrade to your Squad plan to join a circle." });
    return;
  }
  const [existingRequest] = await db
    .select({ id: squadJoinRequestsTable.id })
    .from(squadJoinRequestsTable)
    .where(and(eq(squadJoinRequestsTable.squadId, squad.id), eq(squadJoinRequestsTable.userId, req.user!.id), eq(squadJoinRequestsTable.status, "PENDING")))
    .limit(1);
  if (existingRequest) {
    res.status(400).json({ success: false, message: "You already have a pending join request for this circle" });
    return;
  }
  const [request] = await db
    .insert(squadJoinRequestsTable)
    .values({ squadId: squad.id, userId: req.user!.id, message: message ? String(message).trim().slice(0, 500) : null })
    .returning();
  const [leader] = await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
    .from(usersTable)
    .innerJoin(squadMembersTable, eq(squadMembersTable.userId, usersTable.id))
    .where(and(eq(squadMembersTable.squadId, squad.id), eq(squadMembersTable.role, "LEADER")))
    .limit(1);
  if (leader) {
    const title = `${req.user!.firstName} ${req.user!.lastName} wants to join "${squad.name}"`;
    await db.insert(notificationsTable).values({
      userId: leader.id,
      type: "SQUAD_JOIN_REQUEST",
      title,
      message: message ? String(message).trim().slice(0, 160) : `They'd like to join your circle "${squad.name}". Approve or decline in Pending invites.`,
      linkUrl: "/dashboard#grit-circle",
    });
    try {
      req.app?.get("io")?.to(`user:${leader.id}`).emit("notification:new", {
        type: "SQUAD_JOIN_REQUEST",
        title,
        message: message ? String(message).trim().slice(0, 160) : "Join request",
        linkUrl: "/dashboard#grit-circle",
      });
    } catch {}
  }
  res.status(201).json({ success: true, message: "Join request sent — the leader will review it in Pending invites.", data: { requestId: request.id } });
});

router.put("/squads/:id/join-requests/:requestId", authenticate, async (req: Request, res: Response): Promise<void> => {
  const squadId = String(req.params.id);
  const requestId = String(req.params.requestId);
  const { action } = req.body || {};
  if (!["ACCEPT", "DECLINE"].includes(String(action || "").toUpperCase())) {
    res.status(400).json({ success: false, message: "action must be ACCEPT or DECLINE" });
    return;
  }
  const [leadership] = await db
    .select({ role: squadMembersTable.role })
    .from(squadMembersTable)
    .where(and(eq(squadMembersTable.squadId, squadId), eq(squadMembersTable.userId, req.user!.id)))
    .limit(1);
  if (!leadership || leadership.role !== "LEADER") {
    res.status(403).json({ success: false, message: "Only the leader can review join requests" });
    return;
  }
  const [request] = await db
    .select()
    .from(squadJoinRequestsTable)
    .where(and(eq(squadJoinRequestsTable.id, requestId), eq(squadJoinRequestsTable.squadId, squadId)))
    .limit(1);
  if (!request) {
    res.status(404).json({ success: false, message: "Join request not found" });
    return;
  }
  if (request.status !== "PENDING") {
    res.status(400).json({ success: false, message: "This request was already reviewed" });
    return;
  }
  if (String(action).toUpperCase() === "DECLINE") {
    await db.update(squadJoinRequestsTable).set({ status: "DECLINED", respondedAt: new Date() }).where(eq(squadJoinRequestsTable.id, requestId));
    res.json({ success: true, message: "Request declined" });
    return;
  }
  const requesterPlan = await getActivePlanForUser(request.userId);
  if (requesterPlan.squadMembers < 2) {
    await db.update(squadJoinRequestsTable).set({ status: "DECLINED", respondedAt: new Date() }).where(eq(squadJoinRequestsTable.id, requestId));
    res.status(403).json({ success: false, message: "This member needs the Squad plan to join a circle. Request declined." });
    return;
  }
  const [memberCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(squadMembersTable)
    .where(eq(squadMembersTable.squadId, squadId));
  if (Number(memberCount?.count ?? 0) >= MAX_SQUAD_MEMBERS) {
    res.status(400).json({ success: false, message: `This circle is full (${MAX_SQUAD_MEMBERS} members max)` });
    return;
  }
  const [alreadyInSquad] = await db
    .select({ id: squadMembersTable.id })
    .from(squadMembersTable)
    .innerJoin(squadsTable, eq(squadsTable.id, squadMembersTable.squadId))
    .where(and(eq(squadMembersTable.userId, request.userId), eq(squadsTable.isActive, true)))
    .limit(1);
  if (alreadyInSquad) {
    res.status(400).json({ success: false, message: "This person is already in a circle" });
    return;
  }
  await db
    .insert(squadMembersTable)
    .values({ squadId, userId: request.userId, role: "MEMBER" })
    .onConflictDoNothing({ target: [squadMembersTable.squadId, squadMembersTable.userId] });
  await ensureSquadGroupParticipant(squadId, request.userId, req.app);
  await db.update(squadJoinRequestsTable).set({ status: "ACCEPTED", respondedAt: new Date() }).where(eq(squadJoinRequestsTable.id, requestId));
  const [userRow] = await db.select().from(usersTable).where(eq(usersTable.id, request.userId)).limit(1);
  if (!userRow) {
    res.json({ success: true, message: "Request approved" });
    return;
  }
  const [squadRow] = await db.select().from(squadsTable).where(eq(squadsTable.id, squadId)).limit(1);
  const title = `${req.user!.firstName} approved your request to join "${squadRow?.name ?? "the circle"}"`;
  await db.insert(notificationsTable).values({
    userId: request.userId,
    type: "SQUAD_JOIN_REQUEST",
    title,
    message: `You're now a member of "${squadRow?.name ?? "the circle"}". Start collaborating on projects.`,
    linkUrl: "/dashboard#grit-circle",
  });
  try {
    req.app?.get("io")?.to(`user:${request.userId}`).emit("notification:new", { type: "SQUAD_JOIN_REQUEST", title, message: "Join request approved", linkUrl: "/dashboard#grit-circle" });
  } catch {}
  sendNotificationEmail(userRow.email, title, `You're now a member of "${squadRow?.name ?? "the circle"}". Start collaborating on projects.`, "/dashboard#grit-circle").catch(() => {});
  res.json({ success: true, message: "Request approved — member added" });
});

// ── Squad service orders ─────────────────────────────────────────────
async function isSquadMemberOfService(serviceId: string, userId: string): Promise<boolean> {
  const [membership] = await db
    .select({ squadId: squadMembersTable.squadId })
    .from(squadServicesTable)
    .innerJoin(squadMembersTable, eq(squadServicesTable.squadId, squadMembersTable.squadId))
    .where(and(eq(squadServicesTable.id, serviceId), eq(squadMembersTable.userId, userId)))
    .limit(1);
  return !!membership;
}

// Find or create a group conversation for a squad order (buyer + full squad),
// modeled on the project team chat so delivery/revision updates land in chat.
async function squadOrderConversationId(order: typeof squadOrdersTable.$inferSelect, app?: unknown): Promise<string | null> {
  let [gconv] = await db
    .select()
    .from(conversationsTable)
    .where(and(eq(conversationsTable.squadOrderId, order.id), sql`${conversationsTable.isGroup} = TRUE`))
    .limit(1);
  if (gconv) return gconv.id;

  const [service] = await db.select().from(squadServicesTable).where(eq(squadServicesTable.id, order.serviceId)).limit(1);
  const members = await db
    .select({ userId: squadMembersTable.userId })
    .from(squadMembersTable)
    .where(eq(squadMembersTable.squadId, order.squadId));
  const memberIds = members.map((m) => m.userId);
  if (!memberIds.includes(order.buyerId)) memberIds.push(order.buyerId);

  const [created] = await db
    .insert(conversationsTable)
    .values({
      user1Id: order.buyerId,
      user2Id: order.buyerId,
      isGroup: true,
      groupName: `${service?.title ?? "Squad Order"} · Order`,
      groupId: order.squadId,
      squadOrderId: order.id,
      lastMessageAt: new Date(),
    })
    .returning();
  gconv = created;
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
  try {
    (app as any)?.get?.("io")?.to(`conv:${gconv!.id}`).emit("group:updated", { conversationId: gconv!.id });
  } catch {}
  return gconv.id;
}

async function refreshSquadRating(squadId: string) {
  const [agg] = await db
    .select({ avg: sql<number>`COALESCE(AVG(rating), 0)::float`, cnt: sql<number>`COUNT(*)::int` })
    .from(squadReviewsTable)
    .where(eq(squadReviewsTable.squadId, squadId));
  await db
    .update(squadsTable)
    .set({ ratingAvg: Number(agg?.avg || 0), reviewCount: Number(agg?.cnt || 0), updatedAt: new Date() })
    .where(eq(squadsTable.id, squadId));
}

async function squadOrderJson(order: typeof squadOrdersTable.$inferSelect, viewerId: string) {
  const [service] = await db.select().from(squadServicesTable).where(eq(squadServicesTable.id, order.serviceId)).limit(1);
  const [squad] = await db.select().from(squadsTable).where(eq(squadsTable.id, order.squadId)).limit(1);
  const [buyer] = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      profilePhoto: usersTable.profilePhoto,
    })
    .from(usersTable)
    .where(eq(usersTable.id, order.buyerId))
    .limit(1);
  const deliveries = await db
    .select()
    .from(squadOrderDeliveriesTable)
    .where(eq(squadOrderDeliveriesTable.orderId, order.id))
    .orderBy(desc(squadOrderDeliveriesTable.createdAt));
  const [review] = await db.select().from(squadReviewsTable).where(eq(squadReviewsTable.squadOrderId, order.id)).limit(1);
  const isViewerMember = await isSquadMemberOfService(order.serviceId, viewerId);
  return {
    id: order.id,
    squadId: order.squadId,
    serviceId: order.serviceId,
    buyerId: order.buyerId,
    priceInr: order.priceInr,
    revisions: order.revisions,
    requirements: order.requirements ?? null,
    status: order.status,
    deliveryDate: order.deliveryDate,
    completedAt: order.completedAt,
    cancelledAt: order.cancelledAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    service: service ? serviceJson(service) : null,
    squad: squad ? { id: squad.id, name: squad.name, avatar: squad.avatar ?? null, ratingAvg: squad.ratingAvg ?? 0, reviewCount: squad.reviewCount ?? 0 } : null,
    buyer,
    deliveries,
    reviewed: !!review,
    isViewerMember,
    canAct: isViewerMember && order.buyerId !== viewerId,
  };
}

// List squad orders for the current user (as buyer or as a squad member)
router.get("/squad-orders", authenticate, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!.id;
  const asBuyer = await db
    .select({ row: squadOrdersTable })
    .from(squadOrdersTable)
    .where(eq(squadOrdersTable.buyerId, user))
    .orderBy(desc(squadOrdersTable.createdAt));
  const asMember = await db
    .select({ row: squadOrdersTable })
    .from(squadOrdersTable)
    .innerJoin(squadServicesTable, eq(squadOrdersTable.serviceId, squadServicesTable.id))
    .innerJoin(squadMembersTable, eq(squadServicesTable.squadId, squadMembersTable.squadId))
    .where(and(eq(squadMembersTable.userId, user), ne(squadOrdersTable.buyerId, user)))
    .orderBy(desc(squadOrdersTable.createdAt));
  const merged: Record<string, typeof squadOrdersTable.$inferSelect> = {};
  for (const r of [...asBuyer, ...asMember]) merged[r.row.id] = r.row;
  const rows = Object.values(merged);
  const data = await Promise.all(rows.map((o) => squadOrderJson(o, user)));
  res.json({ success: true, data });
});

// Single squad order
router.get("/squad-orders/:id", authenticate, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!.id;
  const [order] = await db.select().from(squadOrdersTable).where(eq(squadOrdersTable.id, String(req.params.id))).limit(1);
  if (!order) {
    res.status(404).json({ success: false, message: "Order not found" });
    return;
  }
  if (order.buyerId !== user && !(await isSquadMemberOfService(order.serviceId, user))) {
    res.status(403).json({ success: false, message: "Forbidden" });
    return;
  }
  res.json({ success: true, data: await squadOrderJson(order, user) });
});

// Purchase a squad service (buyer)
router.post("/squad-orders", authenticate, async (req: Request, res: Response): Promise<void> => {
  const buyerId = req.user!.id;
  const { serviceId, requirements } = req.body || {};
  if (!serviceId) {
    res.status(400).json({ success: false, message: "serviceId is required" });
    return;
  }
  const [service] = await db.select().from(squadServicesTable).where(eq(squadServicesTable.id, serviceId)).limit(1);
  if (!service || service.status !== "ACTIVE") {
    res.status(400).json({ success: false, message: "Service is not available" });
    return;
  }
  const [membership] = await db
    .select({ squadId: squadMembersTable.squadId })
    .from(squadMembersTable)
    .where(and(eq(squadMembersTable.squadId, service.squadId), eq(squadMembersTable.userId, buyerId)))
    .limit(1);
  if (membership) {
    res.status(400).json({ success: false, message: "You can't purchase your own circle's service" });
    return;
  }
  const [squad] = await db.select().from(squadsTable).where(eq(squadsTable.id, service.squadId)).limit(1);
  if (!squad || !squad.isActive) {
    res.status(400).json({ success: false, message: "Service is not available" });
    return;
  }
  const [buyerWallet] = await db.select({ balance: freelanceWalletsTable.balance }).from(freelanceWalletsTable).where(eq(freelanceWalletsTable.userId, buyerId)).limit(1);
  if ((buyerWallet?.balance ?? 0) < service.priceInr) {
    res.status(400).json({ success: false, message: "Insufficient wallet balance. Please add funds and try again." });
    return;
  }

  let order: typeof squadOrdersTable.$inferSelect;
  try {
    const [created] = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(squadOrdersTable)
        .where(and(
          eq(squadOrdersTable.buyerId, buyerId),
          eq(squadOrdersTable.serviceId, serviceId),
          or(
            eq(squadOrdersTable.status, "PENDING"),
            eq(squadOrdersTable.status, "ACCEPTED"),
            eq(squadOrdersTable.status, "IN_PROGRESS"),
            eq(squadOrdersTable.status, "REVISION_REQUESTED")
          )
        ))
        .limit(1);
      if (existing) throw new Error("DUPLICATE_ORDER");
      return tx
        .insert(squadOrdersTable)
        .values({
          squadId: service.squadId,
          serviceId,
          buyerId,
          priceInr: service.priceInr,
          revisions: service.revisions,
          requirements: requirements ? String(requirements).trim().slice(0, 5000) : null,
          deliveryDate: new Date(Date.now() + (service.deliveryDays || 7) * 86400000),
        })
        .returning();
    });
    order = created;
  } catch (err: any) {
    if (err instanceof Error && err.message === "DUPLICATE_ORDER") {
      res.status(400).json({ success: false, message: "You already have an active order for this service" });
      return;
    }
    throw err;
  }

  await db.update(squadServicesTable).set({ orderCount: service.orderCount + 1, updatedAt: new Date() }).where(eq(squadServicesTable.id, serviceId));

  const convMsg = `📦 *New Order*\n\n${req.user!.firstName} placed an order for "${service.title}".${requirements ? `\n\nRequirements:\n${String(requirements).trim()}` : ""}\n\n_Coordinate with the team here._`;
  const convId = await squadOrderConversationId(order, req.app);
  if (convId) {
    await db.insert(messagesTable).values({ conversationId: convId, senderId: buyerId, messageText: convMsg, attachments: [] });
    await db.update(conversationsTable).set({ lastMessageAt: new Date() }).where(eq(conversationsTable.id, convId));
  }

  if (squad.leaderId !== buyerId) {
    const notif = { type: "NEW_ORDER", title: "New order received!", message: `${req.user!.firstName} placed an order for "${service.title}"`, linkUrl: "/dashboard#squad-orders" };
    await db.insert(notificationsTable).values({ userId: squad.leaderId, ...notif });
    try {
      req.app?.get("io")?.to(`user:${squad.leaderId}`).emit("notification:new", notif);
    } catch {}
    const [leaderRow] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, squad.leaderId)).limit(1);
    if (leaderRow?.email) {
      sendNotificationEmail(leaderRow.email, "New order received!", `${req.user!.firstName} placed an order for "${service.title}"`, "/dashboard#squad-orders").catch(() => {});
    }
  }

  res.status(201).json({ success: true, message: "Order placed successfully!", data: { order } });
});

// Accept a squad order (any squad member)
router.put("/squad-orders/:id/accept", authenticate, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!.id;
  const [order] = await db.select().from(squadOrdersTable).where(eq(squadOrdersTable.id, String(req.params.id))).limit(1);
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (!(await isSquadMemberOfService(order.serviceId, user))) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
  if (order.status !== "PENDING") { res.status(400).json({ success: false, message: "Order not in pending state" }); return; }
  await db.update(squadOrdersTable).set({ status: "ACCEPTED", updatedAt: new Date() }).where(eq(squadOrdersTable.id, order.id));
  const notif = { type: "ORDER_ACCEPTED", title: "Order accepted!", message: "Your order has been accepted by the circle.", linkUrl: "/dashboard#squad-orders" };
  await db.insert(notificationsTable).values({ userId: order.buyerId, ...notif });
  try { req.app?.get("io")?.to(`user:${order.buyerId}`).emit("notification:new", notif); } catch {}
  res.json({ success: true, message: "Order accepted" });
});

// Deliver work on a squad order (any squad member)
router.put("/squad-orders/:id/deliver", authenticate, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!.id;
  const { note, link } = req.body || {};
  const [order] = await db.select().from(squadOrdersTable).where(eq(squadOrdersTable.id, String(req.params.id))).limit(1);
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (!(await isSquadMemberOfService(order.serviceId, user))) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
  if (!["ACCEPTED", "IN_PROGRESS", "REVISION_REQUESTED"].includes(order.status)) {
    res.status(400).json({ success: false, message: "Order cannot be delivered in current state" });
    return;
  }
  const claimResult = await db.execute(
    sql`UPDATE ${sql.identifier("squad_orders")} SET status = 'DELIVERED', updated_at = NOW() WHERE id = ${order.id} AND status IN ('ACCEPTED', 'IN_PROGRESS', 'REVISION_REQUESTED')`
  );
  if (claimResult.rowCount === 0) {
    res.status(400).json({ success: false, message: "Order cannot be delivered in current state" });
    return;
  }
  const [lastDelivery] = await db
    .select()
    .from(squadOrderDeliveriesTable)
    .where(eq(squadOrderDeliveriesTable.orderId, order.id))
    .orderBy(desc(squadOrderDeliveriesTable.revisionNumber))
    .limit(1);
  const revisionNumber = lastDelivery ? lastDelivery.revisionNumber + 1 : 0;
  await db.insert(squadOrderDeliveriesTable).values({
    orderId: order.id,
    note: note ? String(note).trim().slice(0, 5000) : null,
    link: link ? String(link).trim().slice(0, 1000) : null,
    revisionNumber,
  });
  const notif = { type: "ORDER_DELIVERED", title: "Work delivered!", message: "The circle has delivered your work. Please review.", linkUrl: "/dashboard#squad-orders" };
  await db.insert(notificationsTable).values({ userId: order.buyerId, ...notif });
  try { req.app?.get("io")?.to(`user:${order.buyerId}`).emit("notification:new", notif); } catch {}
  const dconvId = await squadOrderConversationId(order, req.app);
  if (dconvId) {
    const dmsg = `📦 *Work Delivered!*${revisionNumber > 0 ? " (again)" : ""}\n\n${note ? `${note}` : "The circle has delivered the work."}${link ? `\n\n🔗 Deliverable: ${link}` : ""}\n\n_Please review the work and release payment when you're satisfied._`;
    await db.insert(messagesTable).values({ conversationId: dconvId, senderId: user, messageText: dmsg, attachments: [] });
    await db.update(conversationsTable).set({ lastMessageAt: new Date() }).where(eq(conversationsTable.id, dconvId));
  }
  res.json({ success: true, message: "Work delivered" });
});

// Request a revision on a squad order (buyer, capped by order.revisions)
router.put("/squad-orders/:id/revision", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { revisionNote } = req.body || {};
  const user = req.user!.id;
  const [order] = await db.select().from(squadOrdersTable).where(eq(squadOrdersTable.id, String(req.params.id))).limit(1);
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.buyerId !== user) { res.status(403).json({ success: false, message: "Only the buyer can request a revision" }); return; }
  if (order.status !== "DELIVERED") { res.status(400).json({ success: false, message: "Work has not been delivered" }); return; }
  const [deliveryCount] = await db
    .select({ value: count() })
    .from(squadOrderDeliveriesTable)
    .where(eq(squadOrderDeliveriesTable.orderId, order.id));
  if (Number(deliveryCount.value) > Number(order.revisions)) {
    res.status(400).json({ success: false, message: `Maximum revisions (${order.revisions}) reached` });
    return;
  }
  await db.update(squadOrdersTable).set({ status: "REVISION_REQUESTED", updatedAt: new Date() }).where(eq(squadOrdersTable.id, order.id));
  const [squadForRev] = await db.select().from(squadsTable).where(eq(squadsTable.id, order.squadId)).limit(1);
  if (squadForRev?.leaderId) {
    const notif = { type: "REVISION_REQUESTED", title: "Revision requested", message: revisionNote ? `The buyer requested a revision: ${revisionNote}` : "The buyer has requested a revision on the delivered work.", linkUrl: "/dashboard#squad-orders" };
    await db.insert(notificationsTable).values({ userId: squadForRev.leaderId, ...notif });
    try { req.app?.get("io")?.to(`user:${squadForRev.leaderId}`).emit("notification:new", notif); } catch {}
  }
  const rconvId = await squadOrderConversationId(order, req.app);
  if (rconvId) {
    const rmsg = `🔄 *Revision requested*${revisionNote ? `:\n\n${revisionNote}` : ". Please review and update the work."}`;
    await db.insert(messagesTable).values({ conversationId: rconvId, senderId: user, messageText: rmsg, attachments: [] });
    await db.update(conversationsTable).set({ lastMessageAt: new Date() }).where(eq(conversationsTable.id, rconvId));
  }
  res.json({ success: true, message: "Revision requested" });
});

// Complete a squad order (buyer releases payment)
router.put("/squad-orders/:id/complete", authenticate, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!.id;
  const [order] = await db.select().from(squadOrdersTable).where(eq(squadOrdersTable.id, String(req.params.id))).limit(1);
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.buyerId !== user) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
  if (order.status !== "DELIVERED") { res.status(400).json({ success: false, message: "Order has not been delivered" }); return; }

  const claimResult = await db.execute(
    sql`UPDATE ${sql.identifier("squad_orders")} SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW() WHERE id = ${order.id} AND status = 'DELIVERED'`
  );
  if (claimResult.rowCount === 0) {
    res.status(409).json({ success: false, message: "Order already completed" });
    return;
  }
  const [squad] = await db.select().from(squadsTable).where(eq(squadsTable.id, order.squadId)).limit(1);
  const sellerId = squad?.leaderId ?? order.squadId;

  const memberRows = await db
    .select({ userId: squadMembersTable.userId })
    .from(squadMembersTable)
    .where(eq(squadMembersTable.squadId, order.squadId));
  const splitMembers = memberRows.length
    ? memberRows.map((m) => m.userId)
    : [sellerId];
  const perShare = Math.floor(order.priceInr / splitMembers.length);
  let rem = order.priceInr - perShare * splitMembers.length;
  const grossShares = splitMembers.map((userId) => {
    const amount = perShare + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    return { userId, amount };
  });
  const creditRecipients: { userId: string; grossAmount: number; commission: number; commissionPct: number; netAmount: number }[] = [];
  for (const gs of grossShares) {
    const mPlan = await getActivePlanForUser(gs.userId);
    const mPct = mPlan.serviceFeePercent;
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

  try {
    await db.transaction(async (tx) => {
      const deductResult = await tx.execute(
        sql`UPDATE ${freelanceWalletsTable} SET balance = balance - ${order.priceInr}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${order.buyerId} AND balance >= ${order.priceInr}`
      );
      if (deductResult.rowCount === 0) throw new Error("Insufficient funds");
      await tx.insert(transactionsTable).values({ userId: order.buyerId, type: "SERVICE_PAYMENT", amount: order.priceInr, description: `Payment for squad order #${order.id.slice(-8)}`, status: "COMPLETED" });
      for (const m of creditRecipients) {
        if (m.netAmount <= 0) continue;
        const creditResult = await tx.execute(
          sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${m.netAmount}, total_earned = COALESCE(total_earned, 0) + ${m.netAmount}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${m.userId}`
        );
        if (creditResult.rowCount === 0) {
          await tx.insert(freelanceWalletsTable).values({ userId: m.userId, balance: m.netAmount, totalEarned: m.netAmount, updatedAt: new Date() });
        }
        await tx.insert(transactionsTable).values({ userId: m.userId, type: "SERVICE_EARNING", amount: m.netAmount, description: `Your share of squad order #${order.id.slice(-8)} after ${m.commissionPct}% commission`, status: "COMPLETED" });
        if (m.commission > 0) {
          await tx.insert(transactionsTable).values({ userId: m.userId, type: "COMMISSION", amount: m.commission, description: `Platform commission (${m.commissionPct}%) on your squad order share`, status: "COMPLETED" });
        }
      }
    });
  } catch (e) {
    await db.execute(sql`UPDATE ${sql.identifier("squad_orders")} SET status = 'DELIVERED', updated_at = NOW() WHERE id = ${order.id}`);
    if (e instanceof Error && e.message === "Insufficient funds") {
      res.status(400).json({ success: false, message: "You don't have enough funds in your wallet. Please add funds and try again." });
    } else {
      res.status(500).json({ success: false, message: "Payment processing failed. Please try again." });
    }
    return;
  }

  await db.insert(notificationsTable).values({ userId: order.buyerId, type: "PAYMENT_SENT", title: "Payment sent", message: `₹${order.priceInr} deducted from your wallet for squad order #${order.id.slice(-8)}`, linkUrl: "/dashboard#squad-orders" });
  for (const m of creditRecipients) {
    await db.insert(notificationsTable).values({ userId: m.userId, type: "ORDER_COMPLETED", title: "Order completed!", message: `You received ₹${m.netAmount} for squad order #${order.id.slice(-8)} (₹${m.grossAmount} share, ${m.commissionPct}% commission: ₹${m.commission}).`, linkUrl: "/dashboard#squad-orders" });
  }

  res.json({ success: true, message: `Order completed! ₹${order.priceInr} split equally across ${creditRecipients.length} team member${creditRecipients.length === 1 ? '' : 's'} (₹${totalCommission} total commission).` });
});

// Rate a squad after a completed squad order (buyer reviews the circle)
router.post("/squads/orders/:id/review", authenticate, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!.id;
  const { rating, reviewText } = req.body || {};
  const ratingNum = Number(rating);
  if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
    res.status(400).json({ success: false, message: "Rating must be 1-5" });
    return;
  }
  const [order] = await db.select().from(squadOrdersTable).where(eq(squadOrdersTable.id, String(req.params.id))).limit(1);
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.buyerId !== user) { res.status(403).json({ success: false, message: "Only the buyer can review" }); return; }
  if (order.status !== "COMPLETED") { res.status(400).json({ success: false, message: "Order must be completed before reviewing" }); return; }
  const [existing] = await db.select().from(squadReviewsTable).where(eq(squadReviewsTable.squadOrderId, order.id)).limit(1);
  if (existing) { res.status(400).json({ success: false, message: "Review already submitted" }); return; }

  await db.insert(squadReviewsTable).values({
    squadId: order.squadId,
    reviewerId: user,
    rating: ratingNum,
    reviewText: reviewText != null && String(reviewText).trim() ? String(reviewText).trim().slice(0, 1000) : null,
    source: "ORDER",
    squadOrderId: order.id,
  });
  await refreshSquadRating(order.squadId);

  const members = await db.select({ userId: squadMembersTable.userId }).from(squadMembersTable).where(eq(squadMembersTable.squadId, order.squadId));
  const [squad] = await db.select().from(squadsTable).where(eq(squadsTable.id, order.squadId)).limit(1);
  const notifBase = { type: "SQUAD_REVIEW", title: "Your circle was rated!", message: `A buyer rated ${squad?.name ?? "your circle"} ${ratingNum}★ for squad order #${order.id.slice(-8)}.`, linkUrl: "/dashboard#grit-circle" };
  for (const m of members) {
    await db.insert(notificationsTable).values({ userId: m.userId, ...notifBase });
    try { req.app?.get("io")?.to(`user:${m.userId}`).emit("notification:new", notifBase); } catch {}
  }

  res.json({ success: true, message: "Review submitted!" });
});

// Cancel a squad order (buyer or squad member)
router.put("/squad-orders/:id/cancel", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { reason } = req.body || {};
  const user = req.user!.id;
  const [order] = await db.select().from(squadOrdersTable).where(eq(squadOrdersTable.id, String(req.params.id))).limit(1);
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  const memberOk = order.buyerId === user || (await isSquadMemberOfService(order.serviceId, user));
  if (!memberOk) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
  if (["COMPLETED", "CANCELLED"].includes(order.status)) { res.status(400).json({ success: false, message: "Order cannot be cancelled" }); return; }
  await db.update(squadOrdersTable).set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() }).where(eq(squadOrdersTable.id, order.id));
  res.json({ success: true, message: "Order cancelled" });
});

export default router;