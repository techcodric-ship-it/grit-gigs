import { eq, and, sql } from "drizzle-orm";
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

/** Max ₹500 referral rewards a single referrer can earn (anti-abuse). */
export const MAX_REFERRAL_REWARDS_PER_USER = 10;

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

/**
 * Grants the ₹500 referral reward + 0% commission on the referred user's FIRST
 * real payment (first approved milestone) — not when they merely post a
 * project. Runs inside the caller's transaction so nothing is granted if the
 * payment later fails. Anti-abuse guards:
 *   - the referred user AND the referrer must both be KYC-verified,
 *   - referrer and referred must have different phone numbers,
 *   - the referrer must be under MAX_REFERRAL_REWARDS_PER_USER paid referrals.
 * Returns true when the reward was granted (0% commission now applies).
 */
export async function maybeGrantReferralOnFirstPayment(
  tx: Tx,
  userId: string,
  projectId: string,
  currentMilestoneId: string
): Promise<boolean> {
  const [user] = await tx.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user || !user.referredBy) return false;

  const [refRow] = await tx
    .select()
    .from(referralsTable)
    .where(eq(referralsTable.referredUserId, userId))
    .limit(1);
  if (!refRow || refRow.status !== "PENDING") return false;

  // Only the first approved milestone (a real payment) qualifies.
  const prior = (await tx.execute(
    sql`SELECT count(*)::int AS c FROM project_milestones ms INNER JOIN projects p ON p.id = ms.project_id WHERE p.user_id = ${userId} AND ms.status = 'APPROVED' AND ms.id <> ${currentMilestoneId}`
  )) as { rows: { c: number }[] };
  if (Number(prior?.rows?.[0]?.c ?? 0) > 0) return false;

  const [referrer] = await tx
    .select({ kycVerified: usersTable.kycVerified, phone: usersTable.phone })
    .from(usersTable)
    .where(eq(usersTable.id, refRow.referrerId))
    .limit(1);
  if (!referrer || !referrer.kycVerified || !user.kycVerified) return false;
  if (!referrer.phone || !user.phone || referrer.phone === user.phone) return false;

  const paid = (await tx.execute(
    sql`SELECT count(*)::int AS c FROM referrals WHERE referrer_id = ${refRow.referrerId} AND status = 'PAID'`
  )) as { rows: { c: number }[] };
  if (Number(paid?.rows?.[0]?.c ?? 0) >= MAX_REFERRAL_REWARDS_PER_USER) return false;

  const [proj] = await tx
    .select({ title: projectsTable.title })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId))
    .limit(1);

  const [claimed] = await tx
    .update(referralsTable)
    .set({ status: "PAID", projectId, zeroCommissionApplied: true, updatedAt: new Date() })
    .where(and(eq(referralsTable.id, refRow.id), eq(referralsTable.status, "PENDING")))
    .returning();
  if (!claimed) return false;

  await tx
    .update(projectsTable)
    .set({ zeroCommission: true, updatedAt: new Date() })
    .where(eq(projectsTable.id, projectId));

  const amount = Number(claimed.rewardAmount) || REFERRAL_REWARD;
  await creditReferrerReward(
    tx,
    claimed.referrerId,
    amount,
    `Referral reward — ${user.firstName} ${user.lastName} made their first hire${proj ? ` on "${proj.title}"` : ""}`
  );

  await tx.insert(notificationsTable).values({
    userId: user.referredBy,
    type: "REFERRAL_REWARD",
    title: "Referral reward earned! 🎉",
    message: `You earned ₹${amount} in platform credit — ${user.firstName} ${user.lastName} made their first hire. Use it on any service or project.`,
    linkUrl: "/dashboard.html?tab=refer",
  });
  await tx.insert(notificationsTable).values({
    userId,
    type: "REFERRAL_BENEFIT",
    title: "0% commission on your first hire! 🎉",
    message: "As a referred member, your first hire has 0% platform commission.",
    linkUrl: "/dashboard.html#my-projects",
  });

  return true;
}
