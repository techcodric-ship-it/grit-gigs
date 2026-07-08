import { eq } from "drizzle-orm";
import { db, userSubscriptionsTable } from "../db";
import type { UserSubscription } from "../db/schema/plans";

export type PlanId = "free" | "starter" | "pro" | "elite";

export interface PlanConfig {
  id: PlanId;
  name: string;
  /** Cost in ₹ to subscribe for 30 days. 0 = free. */
  priceInr: number;
  /** Platform commission charged on completed project payouts / gig orders for sellers on this plan. */
  serviceFeePercent: number;
  /** Free proposal credits granted per 30-day cycle. -1 = unlimited. */
  monthlyProposalCredits: number;
  /** Max number of ACTIVE gig listings allowed at once. -1 = unlimited. */
  maxActiveGigs: number;
  /** Max number of ACTIVE barter exchange requests allowed at once. -1 = unlimited. */
  maxActiveBarterRequests: number;
  /** Monthly barter match request credits granted per 30-day cycle. -1 = unlimited. */
  monthlyBarterMatchCredits: number;
  /** Max number of ACTIVE project listings allowed at once. -1 = unlimited. */
  maxActiveProjects: number;
  /** Portfolio link slots on the public profile. -1 = unlimited. */
  portfolioSlots: number;
  /** "Featured" proposal placements granted per 30-day cycle (highlighted at the top of a project's bid list). */
  featuredProposalsPerMonth: number;
  badge: "PRO" | "ELITE" | null;
  description: string;
}

export const PLANS: PlanConfig[] = [
  {
    id: "free",
    name: "Free",
    priceInr: 0,
    serviceFeePercent: 10,
    monthlyProposalCredits: 3,
    maxActiveGigs: 3,
    maxActiveBarterRequests: -1,
    monthlyBarterMatchCredits: -1,
    maxActiveProjects: 3,
    portfolioSlots: 3,
    featuredProposalsPerMonth: 0,
    badge: null,
    description: "Get started with the basics — no cost, no card.",
  },
  {
    id: "starter",
    name: "Starter",
    priceInr: 1,
    serviceFeePercent: 9,
    monthlyProposalCredits: 10,
    maxActiveGigs: 8,
    maxActiveBarterRequests: -1,
    monthlyBarterMatchCredits: -1,
    maxActiveProjects: 8,
    portfolioSlots: 8,
    featuredProposalsPerMonth: 1,
    badge: null,
    description: "For freelancers picking up momentum.",
  },
  {
    id: "pro",
    name: "Pro",
    priceInr: 525,
    serviceFeePercent: 8,
    monthlyProposalCredits: 30,
    maxActiveGigs: 20,
    maxActiveBarterRequests: -1,
    monthlyBarterMatchCredits: -1,
    maxActiveProjects: 20,
    portfolioSlots: 20,
    featuredProposalsPerMonth: 5,
    badge: "PRO",
    description: "More proposals, lower fees, a verified badge on your profile.",
  },
  {
    id: "elite",
    name: "Elite",
    priceInr: 1470,
    serviceFeePercent: 5,
    monthlyProposalCredits: -1,
    maxActiveGigs: -1,
    maxActiveBarterRequests: -1,
    monthlyBarterMatchCredits: -1,
    maxActiveProjects: -1,
    portfolioSlots: -1,
    featuredProposalsPerMonth: 15,
    badge: "ELITE",
    description: "Unlimited proposals and listings, the lowest fees, top visibility.",
  },
];

export function getPlan(planId: string | null | undefined): PlanConfig {
  return PLANS.find((p) => p.id === planId) ?? PLANS[0];
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Fetches the user's subscription row, creating a default "free" row the
 * first time a user is seen (handles every existing user transparently —
 * nobody needs a manual migration). Also handles two pieces of monthly
 * housekeeping with no cron job required:
 *   1. If a paid plan's expiresAt has passed, the user is silently
 *      downgraded back to "free".
 *   2. If creditsResetAt is more than 30 days old, proposal/featured
 *      credits are topped back up to the current plan's monthly allowance.
 */
export async function getOrCreateSubscription(userId: string): Promise<UserSubscription> {
  let [sub] = await db
    .select()
    .from(userSubscriptionsTable)
    .where(eq(userSubscriptionsTable.userId, userId))
    .limit(1);

  if (!sub) {
    const defaultPlan = getPlan("free");
    [sub] = await db
      .insert(userSubscriptionsTable)
      .values({
        userId,
        planId: "free",
        proposalCreditsRemaining: defaultPlan.monthlyProposalCredits,
        featuredProposalsRemaining: defaultPlan.featuredProposalsPerMonth,
      })
      .returning();
    return sub;
  }

  const now = Date.now();
  let needsUpdate = false;
  const patch: Partial<typeof userSubscriptionsTable.$inferInsert> = {};

  // Expired paid plan → fall back to free, reset credits to Free plan's limits.
  if (sub.planId !== "free" && sub.expiresAt && sub.expiresAt.getTime() < now) {
    const freePlan = getPlan("free");
    patch.planId = "free";
    patch.expiresAt = null;
    patch.proposalCreditsRemaining = freePlan.monthlyProposalCredits;
    patch.featuredProposalsRemaining = freePlan.featuredProposalsPerMonth;
    patch.creditsResetAt = new Date();
    needsUpdate = true;
  }

  // Monthly credit refresh.
  const creditsResetAt = sub.creditsResetAt;
  if (creditsResetAt && now - creditsResetAt.getTime() >= THIRTY_DAYS_MS) {
    const effectivePlan = getPlan((patch.planId as PlanId) ?? sub.planId);
    patch.proposalCreditsRemaining = effectivePlan.monthlyProposalCredits;
    patch.featuredProposalsRemaining = effectivePlan.featuredProposalsPerMonth;
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
