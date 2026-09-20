import { eq, sql } from "drizzle-orm";
import { db, communityQuotasTable } from "../db";

export const FREE_GIG_POSTS = 10;
export const FREE_PROPOSALS = 5;
const CYCLE_MS = 30 * 24 * 60 * 60 * 1000;

export interface QuotaUsage {
  gigPostsUsed: number;
  gigPostsFree: number;
  gigPostsBonus: number;
  proposalsUsed: number;
  proposalsFree: number;
  proposalsBonus: number;
  resetsInMs: number;
}

export const QUOTA_PLANS = {
  gigs5: { id: "gigs5", label: "5 more gig posts", priceInr: 80, gigBonus: 5, propBonus: 0 },
  props5: { id: "props5", label: "5 more proposals", priceInr: 60, gigBonus: 0, propBonus: 5 },
} as const;

export type QuotaPlanId = keyof typeof QUOTA_PLANS;

/**
 * Fetches the user's community quota row, creating one on first use and
 * lazily resetting the monthly counters every 30 days (no cron needed).
 */
export async function getCommunityQuota(userId: string): Promise<QuotaUsage> {
  await db.execute(
    sql`INSERT INTO community_quotas (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`,
  );

  const [row] = await db
    .select()
    .from(communityQuotasTable)
    .where(eq(communityQuotasTable.userId, userId))
    .limit(1);

  const now = Date.now();
  let used = false;
  if (row && now - row.resetAt.getTime() >= CYCLE_MS) {
    await db
      .update(communityQuotasTable)
      .set({ gigPostsUsed: 0, proposalsUsed: 0, resetAt: new Date(), updatedAt: new Date() })
      .where(eq(communityQuotasTable.userId, userId));
    used = true;
  }

  const fresh = used
    ? (await db
        .select()
        .from(communityQuotasTable)
        .where(eq(communityQuotasTable.userId, userId))
        .limit(1))[0]
    : row ?? { gigPostsUsed: 0, gigPostsBonus: 0, proposalsUsed: 0, proposalsBonus: 0, resetAt: new Date(now) };

  return {
    gigPostsUsed: fresh.gigPostsUsed ?? 0,
    gigPostsFree: Math.max(0, FREE_GIG_POSTS - (fresh.gigPostsUsed ?? 0)),
    gigPostsBonus: fresh.gigPostsBonus ?? 0,
    proposalsUsed: fresh.proposalsUsed ?? 0,
    proposalsFree: Math.max(0, FREE_PROPOSALS - (fresh.proposalsUsed ?? 0)),
    proposalsBonus: fresh.proposalsBonus ?? 0,
    resetsInMs: Math.max(0, (fresh.resetAt?.getTime() ?? now) + CYCLE_MS - now),
  };
}

export type QuotaResult = { allowed: boolean; code: "OK" | "QUOTA_GIG" | "QUOTA_PROPOSAL"; usage: QuotaUsage };

async function consume(userId: string, kind: "gig" | "proposal"): Promise<QuotaResult> {
  const usage = await getCommunityQuota(userId);
  const freeLimit = kind === "gig" ? FREE_GIG_POSTS : FREE_PROPOSALS;
  const usedCol = kind === "gig" ? "gig_posts_used" : "proposals_used";
  const bonusCol = kind === "gig" ? "gig_posts_bonus" : "proposals_bonus";

  const res = await db.execute(
    sql`UPDATE community_quotas SET
      ${sql.raw(usedCol)} = CASE WHEN ${sql.raw(usedCol)} < ${freeLimit} THEN ${sql.raw(usedCol)} + 1 ELSE ${sql.raw(usedCol)} END,
      ${sql.raw(bonusCol)} = CASE WHEN ${sql.raw(usedCol)} >= ${freeLimit} AND ${sql.raw(bonusCol)} > 0 THEN ${sql.raw(bonusCol)} - 1 ELSE ${sql.raw(bonusCol)} END,
      updated_at = NOW()
    WHERE user_id = ${userId} AND (${sql.raw(usedCol)} < ${freeLimit} OR ${sql.raw(bonusCol)} > 0)`,
  );

  const allowed = Number(res.rowCount) > 0;
  return {
    allowed,
    code: allowed ? "OK" : kind === "gig" ? "QUOTA_GIG" : "QUOTA_PROPOSAL",
    usage: allowed ? await getCommunityQuota(userId) : usage,
  };
}

export function consumeGigPost(userId: string): Promise<QuotaResult> {
  return consume(userId, "gig");
}

export function consumeProposal(userId: string): Promise<QuotaResult> {
  return consume(userId, "proposal");
}

/** Adds a purchased bundle to the user's bonus pools (never monthly-reset). */
export async function grantQuotaBundle(userId: string, gigBonus = 0, propBonus = 0): Promise<void> {
  await getCommunityQuota(userId);
  await db.execute(
    sql`UPDATE community_quotas SET
      gig_posts_bonus = gig_posts_bonus + ${gigBonus},
      proposals_bonus = proposals_bonus + ${propBonus},
      updated_at = NOW()
    WHERE user_id = ${userId}`,
  );
}