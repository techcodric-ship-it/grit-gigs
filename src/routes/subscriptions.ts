import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, notificationsTable, userSubscriptionsTable } from "../db";
import { authenticate } from "../middlewares/authenticate";
import { PLANS, getPlan, getOrCreateSubscription, type PlanConfig } from "../lib/subscriptions";

const router: IRouter = Router();

// Shapes a PlanConfig for the public API / dashboard UI (price in ₹, a
// human-readable feature list, commission %) while src/lib/subscriptions.ts
// keeps the raw numeric fields other routes (orders/projects/services) use
// for actual enforcement.
function planToClientJson(plan: PlanConfig) {
  const features: string[] = [
    plan.monthlyProposalCredits === -1
      ? "Unlimited free proposal credits/month"
      : `${plan.monthlyProposalCredits} free proposal credits/month`,
    plan.maxActiveGigs === -1
      ? "Unlimited active gig listings"
      : `${plan.maxActiveGigs} active gig listings`,
    plan.portfolioSlots === -1
      ? "Unlimited portfolio items"
      : `${plan.portfolioSlots} portfolio items`,
    `${plan.serviceFeePercent}% platform fee on completed work`,
  ];
  if (plan.featuredProposalsPerMonth > 0) {
    features.push(`${plan.featuredProposalsPerMonth} featured proposal${plan.featuredProposalsPerMonth > 1 ? "s" : ""}/month`);
  }
  if (plan.badge) features.push(`${plan.badge} verified badge on your profile`);

  return {
    id: plan.id,
    name: plan.name,
    price: plan.priceInr,
    billingCycle: plan.id === "free" ? "forever" : "monthly",
    commission: plan.serviceFeePercent,
    serviceFeePercent: plan.serviceFeePercent,
    monthlyProposalCredits: plan.monthlyProposalCredits,
    maxActiveGigs: plan.maxActiveGigs,
    portfolioSlots: plan.portfolioSlots,
    featuredProposalsPerMonth: plan.featuredProposalsPerMonth,
    badge: plan.badge,
    description: plan.description,
    features,
  };
}

// GET /subscriptions/plans — public, used on the pricing/Upgrade Plan page.
router.get("/subscriptions/plans", (_req, res) => {
  res.json({ success: true, data: { plans: PLANS.map(planToClientJson) } });
});

// GET /subscriptions/my-plan — the user's current plan + remaining monthly credits.
router.get("/subscriptions/my-plan", authenticate, async (req: Request, res: Response): Promise<void> => {
  const sub = await getOrCreateSubscription(req.user!.id);
  const plan = getPlan(sub.planId);
  const daysLeft = sub.expiresAt
    ? Math.max(0, Math.ceil((sub.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;
  res.json({
    success: true,
    data: {
      planId: sub.planId,
      plan: planToClientJson(plan),
      daysLeft,
      planActivatedAt: sub.startedAt,
      planExpiresAt: sub.expiresAt,
      proposalCreditsRemaining: sub.proposalCreditsRemaining,
      featuredProposalsRemaining: sub.featuredProposalsRemaining,
    },
  });
});

// POST /subscriptions/subscribe — activate or upgrade a plan.
router.post("/subscriptions/subscribe", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { planId } = req.body;
  const plan = PLANS.find((p) => p.id === planId);
  if (!plan) {
    res.status(400).json({ success: false, message: "Invalid plan" });
    return;
  }

  const userId = req.user!.id;
  const sub = await getOrCreateSubscription(userId);

  if (sub.planId === plan.id && sub.expiresAt && sub.expiresAt.getTime() > Date.now()) {
    res.status(400).json({ success: false, message: `You're already on the ${plan.name} plan until ${sub.expiresAt.toDateString()}.` });
    return;
  }

  const now = new Date();
  const expiresAt = plan.id === "free" ? null : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await db
    .update(userSubscriptionsTable)
    .set({
      planId: plan.id,
      startedAt: now,
      expiresAt,
      proposalCreditsRemaining: plan.monthlyProposalCredits,
      featuredProposalsRemaining: plan.featuredProposalsPerMonth,
      creditsResetAt: now,
      updatedAt: now,
    })
    .where(eq(userSubscriptionsTable.id, sub.id));

  await db.insert(notificationsTable).values({
    userId,
    type: "SUBSCRIPTION",
    title: `${plan.name} plan activated!`,
    message: plan.id === "free"
      ? "You're back on the Free plan."
      : `You now get ${plan.monthlyProposalCredits === -1 ? "unlimited" : plan.monthlyProposalCredits} free proposals/month, ${plan.serviceFeePercent}% platform fee, and ${plan.maxActiveGigs === -1 ? "unlimited" : plan.maxActiveGigs} active gig listings.`,
    linkUrl: "/dashboard.html",
  });

  try { req.app?.get("io")?.emit("profile:updated", { userId }); } catch {}

  res.json({
    success: true,
    message: `Subscribed to the ${plan.name} plan`,
    data: { planId: plan.id, planActivatedAt: now, planExpiresAt: expiresAt, plan: planToClientJson(plan) },
  });
});

export default router;
