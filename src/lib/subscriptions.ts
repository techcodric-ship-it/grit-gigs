import { eq, sql } from "drizzle-orm";
import { db, userSubscriptionsTable, freelanceWalletsTable } from "../db";
import type { UserSubscription } from "../db/schema/plans";

export type PlanId = "starter" | "pro" | "squad";

export interface PlanConfig {
  id: PlanId;
  name: string;
  /** Cost in ₹ to subscribe for 30 days. 0 = free tier. */
  priceInr: number;
  /** Platform commission charged on completed project payouts / gig orders for sellers on this plan. */
  serviceFeePercent: number;
  /** Project proposal / bid credits granted per week. -1 = unlimited. */
  weeklyBidCredits: number;
  /** Number of ACTIVE gig listings a single member can hold at once. -1 = unlimited. */
  maxActiveGigs: number;
  /** Max number of ACTIVE barter exchange requests allowed at once. -1 = unlimited. */
  maxActiveBarterRequests: number;
  /** Barter match request credits granted per cycle. -1 = unlimited. */
  monthlyBarterMatchCredits: number;
  /** Max number of ACTIVE project listings allowed at once. -1 = unlimited. */
  maxActiveProjects: number;
  /** Portfolio link slots on the public profile. -1 = unlimited. */
  portfolioSlots: number;
  /** "Featured" proposal placements granted per 30-day cycle (highlighted at the top of a project's bid list). */
  featuredProposalsPerMonth: number;
  /** Wallet balance cap in ₹. -1 = unlimited. */
  walletLimit: number;
  /** Max squad members permitted on the plan. 0 = no squad access, 1 = solo only. */
  squadMembers: number;
  badge: "STARTER" | "PRO" | "SQUAD" | null;
  description: string;
}

export const PLANS: PlanConfig[] = [
  {
    id: "starter",
    name: "Starter",
    priceInr: 0,
    serviceFeePercent: 10,
    weeklyBidCredits: 2,
    maxActiveGigs: 3,
    maxActiveBarterRequests: -1,
    monthlyBarterMatchCredits: -1,
    maxActiveProjects: 3,
    portfolioSlots: 3,
    featuredProposalsPerMonth: 0,
    walletLimit: 100000,
    squadMembers: 0,
    badge: null,
    description: "Get started with the basics — no cost, no card.",
  },
  {
    id: "pro",
    name: "Pro",
    priceInr: 499,
    serviceFeePercent: 5,
    weeklyBidCredits: -1,
    maxActiveGigs: -1,
    maxActiveBarterRequests: -1,
    monthlyBarterMatchCredits: -1,
    maxActiveProjects: -1,
    portfolioSlots: 20,
    featuredProposalsPerMonth: 3,
    walletLimit: -1,
    squadMembers: 1,
    badge: "PRO",
    description: "Unlimited gigs and bids, lower fees, a verified badge on your profile.",
  },
  {
    id: "squad",
    name: "Squad",
    priceInr: 1499,
    serviceFeePercent: 1,
    weeklyBidCredits: -1,
    maxActiveGigs: -1,
    maxActiveBarterRequests: -1,
    monthlyBarterMatchCredits: -1,
    maxActiveProjects: -1,
    portfolioSlots: -1,
    featuredProposalsPerMonth: 8,
    walletLimit: -1,
    squadMembers: 6,
    badge: "SQUAD",
    description: "Everything in Pro, up to 6 squad members, 1% commission.",
  },
];

export function getPlan(planId: string | null | undefined): PlanConfig {
  return PLANS.find((p) => p.id === planId) ?? PLANS[0];
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fetches the user's subscription row, creating a default "starter" row the
 * first time a user is seen (handles every existing user transparently —
 * nobody needs a manual migration). Also handles two pieces of housekeeping
 * with no cron job required:
 *   1. If a paid plan's expiresAt has passed, the user is silently
 *      downgraded back to "starter".
 *   2. Weekly: project-bid credits are topped back up to the current plan's
 *      weekly allowance (bidsResetAt).
 *   3. Monthly (every 30 days): featured-proposal credits are topped up and
 *      the gig/project creation counters are reset to 0.
 */
export async function getOrCreateSubscription(userId: string): Promise<UserSubscription> {
  let [sub] = await db
    .select()
    .from(userSubscriptionsTable)
    .where(eq(userSubscriptionsTable.userId, userId))
    .limit(1);

  if (!sub) {
    const defaultPlan = getPlan("starter");
    const now = new Date();
    [sub] = await db
      .insert(userSubscriptionsTable)
      .values({
        userId,
        planId: "starter",
        proposalCreditsRemaining: defaultPlan.weeklyBidCredits,
        featuredProposalsRemaining: defaultPlan.featuredProposalsPerMonth,
        bidsResetAt: now,
        creditsResetAt: now,
      })
      .returning();
    return sub;
  }

  const now = Date.now();
  let needsUpdate = false;
  const patch: Partial<typeof userSubscriptionsTable.$inferInsert> = {};

  // Expired paid plan → fall back to Starter, reset credits to Starter's limits.
  if (sub.planId !== "starter" && sub.expiresAt && sub.expiresAt.getTime() < now) {
    const starterPlan = getPlan("starter");
    patch.planId = "starter";
    patch.expiresAt = null;
    patch.proposalCreditsRemaining = starterPlan.weeklyBidCredits;
    patch.featuredProposalsRemaining = starterPlan.featuredProposalsPerMonth;
    patch.bidsResetAt = new Date();
    patch.creditsResetAt = new Date();
    needsUpdate = true;
  }

  const effectivePlan = getPlan((patch.planId as PlanId) ?? sub.planId);

  // Weekly project-bid credit refresh. A missing bidsResetAt (legacy rows or
  // freshly created rows before the field was seeded) is treated as due so
  // credits always top back up each week.
  const bidsResetAt = sub.bidsResetAt;
  if ((!bidsResetAt || now - bidsResetAt.getTime() >= SEVEN_DAYS_MS)) {
    patch.proposalCreditsRemaining = effectivePlan.weeklyBidCredits;
    patch.bidsResetAt = new Date();
    needsUpdate = true;
  }

  // Clamp leftover credits to the plan's weekly allowance. Older builds seeded
  // some Starter rows above their 2-credit max, which used to show as
  // "3 / 2" in the dashboard even when the member never bid that week.
  if (effectivePlan.weeklyBidCredits !== -1 && (patch.proposalCreditsRemaining ?? sub.proposalCreditsRemaining) > effectivePlan.weeklyBidCredits) {
    patch.proposalCreditsRemaining = effectivePlan.weeklyBidCredits;
    needsUpdate = true;
  }

  // Monthly credit + creation-counter refresh.
  const creditsResetAt = sub.creditsResetAt;
  if (creditsResetAt && now - creditsResetAt.getTime() >= THIRTY_DAYS_MS) {
    const effectivePlan = getPlan((patch.planId as PlanId) ?? sub.planId);
    patch.featuredProposalsRemaining = effectivePlan.featuredProposalsPerMonth;
    patch.gigsCreatedThisCycle = 0;
    patch.projectsCreatedThisCycle = 0;
    patch.creditsResetAt = new Date();
    needsUpdate = true;
  }

  if (needsUpdate) {
    patch.updatedAt = new Date();
    [sub] = await db
      .update(userSubscriptionsTable)
      .set(patch)
      .where(eq(userSubscriptionsTable.id, sub.id))
      .returning();
  }

  return sub;
}

export async function getActivePlanForUser(userId: string): Promise<PlanConfig> {
  const sub = await getOrCreateSubscription(userId);
  return getPlan(sub.planId);
}

/**
 * Atomically consumes one gig-creation slot for the current 30-day cycle.
 * Returns true when the slot is granted (or the plan allows unlimited),
 * false when the plan's monthly gig quota is exhausted. limit = -1 means
 * unlimited.
 */
export async function consumeGigCreation(userId: string, limit: number): Promise<boolean> {
  if (limit === -1) return true;
  const res = await db.execute(
    sql`UPDATE ${userSubscriptionsTable} SET gigs_created_this_cycle = gigs_created_this_cycle + 1, updated_at = NOW() WHERE ${userSubscriptionsTable.userId} = ${userId} AND gigs_created_this_cycle < ${limit}`
  );
  return Number(res.rowCount) > 0;
}

/**
 * Atomically consumes one project-creation slot for the current 30-day cycle.
 * Returns true when the slot is granted (or the plan allows unlimited),
 * false when the plan's monthly project quota is exhausted. limit = -1 means
 * unlimited.
 */
export async function consumeProjectCreation(userId: string, limit: number): Promise<boolean> {
  if (limit === -1) return true;
  const res = await db.execute(
    sql`UPDATE ${userSubscriptionsTable} SET projects_created_this_cycle = projects_created_this_cycle + 1, updated_at = NOW() WHERE ${userSubscriptionsTable.userId} = ${userId} AND projects_created_this_cycle < ${limit}`
  );
  return Number(res.rowCount) > 0;
}

export async function isWalletCreditAllowed(userId: string, addAmountInr: number): Promise<{ allowed: boolean; limit: number; current: number; planName: string }> {
  const plan = await getActivePlanForUser(userId);
  if (plan.walletLimit === -1) return { allowed: true, limit: -1, current: 0, planName: plan.name };
  const [wallet] = await db
    .select({ balance: freelanceWalletsTable.balance })
    .from(freelanceWalletsTable)
    .where(eq(freelanceWalletsTable.userId, userId))
    .limit(1);
  const current = Number(wallet?.balance ?? 0);
  return { allowed: current + addAmountInr <= plan.walletLimit, limit: plan.walletLimit, current, planName: plan.name };
}
