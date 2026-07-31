import { eq, and, ne, sql } from "drizzle-orm";
import type { Request } from "express";
import {
  db,
  usersTable,
  referralsTable,
  projectsTable,
  freelanceWalletsTable,
  transactionsTable,
  notificationsTable,
} from "../db";

export const REFERRAL_REWARD = 500;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function generateReferralCode(): Promise<string> {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 6; attempt++) {
    let code = "";
    for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.referralCode, code))
      .limit(1);
    if (!existing) return code;
  }
  return "G" + Math.random().toString(36).slice(2, 9).toUpperCase();
}

export function parseRefCodeFromReq(req: Request): string | null {
  const cookieHeader = req.headers.cookie || "";
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("gg_ref=")) {
      const code = decodeURIComponent(trimmed.slice(7)).trim();
      return code || null;
    }
  }
  return null;
}

export async function findReferrerByCode(code: string): Promise<{ id: string } | null> {
  if (!code || code.length > 20) return null;
  const [referrer] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.referralCode, code))
    .limit(1);
  return referrer || null;
}

export async function attachReferral(req: Request, newUserId: string): Promise<void> {
  try {
    const refCode = parseRefCodeFromReq(req);
    if (!refCode) return;
    const referrer = await findReferrerByCode(refCode);
    if (!referrer || referrer.id === newUserId) return;

    const [existingRef] = await db
      .select({ id: referralsTable.id })
      .from(referralsTable)
      .where(eq(referralsTable.referredUserId, newUserId))
      .limit(1);
    if (existingRef) return;

    await db
      .update(usersTable)
      .set({ referredBy: referrer.id, updatedAt: new Date() })
      .where(eq(usersTable.id, newUserId));
    await db.insert(referralsTable).values({
      referrerId: referrer.id,
      referredUserId: newUserId,
    });
  } catch (e) {
    console.error("[referrals] attachReferral failed:", e);
  }
}

export async function creditReferrerReward(tx: Tx, referrerId: string, amount: number, description: string): Promise<void> {
  const res = await tx.execute(
    sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${amount}, bonus_balance = COALESCE(bonus_balance, 0) + ${amount}, total_earned = COALESCE(total_earned, 0) + ${amount}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${referrerId}`
  );
  if ((res as { rowCount?: number }).rowCount === 0) {
    await tx.insert(freelanceWalletsTable).values({
      userId: referrerId,
      balance: amount,
      bonusBalance: amount,
      totalEarned: amount,
      updatedAt: new Date(),
    });
  }
  await tx.insert(transactionsTable).values({
    userId: referrerId,
    type: "REFERRAL_REWARD",
    amount,
    description,
    status: "COMPLETED",
  });
}

export async function reverseReferrerReward(tx: Tx, referrerId: string, amount: number, description: string): Promise<void> {
  await tx.execute(
    sql`UPDATE ${freelanceWalletsTable} SET bonus_balance = GREATEST(COALESCE(bonus_balance, 0) - ${amount}, 0), balance = GREATEST(balance - ${amount}, 0), total_earned = GREATEST(COALESCE(total_earned, 0) - ${amount}, 0), updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${referrerId}`
  );
  await tx.insert(transactionsTable).values({
    userId: referrerId,
    type: "REFUND",
    amount,
    description,
    status: "COMPLETED",
  });
}

export async function processProjectReferral(userId: string, projectId: string): Promise<void> {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user || !user.referredBy) return;

    const [refRow] = await db
      .select()
      .from(referralsTable)
      .where(eq(referralsTable.referredUserId, userId))
      .limit(1);
    if (!refRow) return;

    await db.transaction(async (tx) => {
      const [proj] = await tx.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
      if (!proj) return;

      const [countRes] = await tx
        .select({ c: sql<number>`count(*)` })
        .from(projectsTable)
        .where(and(eq(projectsTable.userId, userId), ne(projectsTable.id, projectId)));
      if (Number(countRes?.c ?? 0) > 0) return;

      const [claimed] = await tx
        .update(referralsTable)
        .set({ status: "PAID", projectId: proj.id, zeroCommissionApplied: true, updatedAt: new Date() })
        .where(and(eq(referralsTable.id, refRow.id), eq(referralsTable.status, "PENDING")))
        .returning();
      if (!claimed) return;

      await tx
        .update(projectsTable)
        .set({ zeroCommission: true, updatedAt: new Date() })
        .where(eq(projectsTable.id, proj.id));

      const amount = Number(claimed.rewardAmount) || REFERRAL_REWARD;
      await creditReferrerReward(
        tx,
        claimed.referrerId,
        amount,
        `Referral reward — ${user.firstName} ${user.lastName} posted "${proj.title}"`
      );
    });

    await db.insert(notificationsTable).values({
      userId: user.referredBy,
      type: "REFERRAL_REWARD",
      title: "Referral reward earned! 🎉",
      message: `You earned ₹${REFERRAL_REWARD} in platform credit — ${user.firstName} ${user.lastName} posted a project. Use it on any service or project.`,
      linkUrl: "/dashboard.html?tab=refer",
    });
    await db.insert(notificationsTable).values({
      userId,
      type: "REFERRAL_BENEFIT",
      title: "0% commission on your first hire! 🎉",
      message: "As a referred member, your first project has 0% platform commission on the hire. Go ahead and pick a freelancer!",
      linkUrl: "/dashboard.html#my-projects",
    });
  } catch (e) {
    console.error("[referrals] processProjectReferral failed:", e);
  }
}
