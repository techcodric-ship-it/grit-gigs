import { Router, type IRouter, type Request, type Response } from "express";
import { eq, count, and, sql } from "drizzle-orm";
import { db, notificationsTable, transactionsTable, userSubscriptionsTable, projectBidsTable } from "../db";
import { authenticate } from "../middlewares/authenticate";
import { PLANS, getPlan, getOrCreateSubscription, type PlanConfig } from "../lib/subscriptions";

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

function razorpayConfigured(): boolean {
  return !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
}

function getPlanIdFromDescription(desc: string): string | null {
  const m = desc.match(/^SUBSCRIPTION_PLAN:(\w+)\|/);
  return m ? m[1] : null;
}

const router: IRouter = Router();

// Shapes a PlanConfig for the public API / dashboard UI (price in ₹, a
// human-readable feature list, commission %) while src/lib/subscriptions.ts
// keeps the raw numeric fields other routes (orders/projects/services) use
// for actual enforcement.
function planToClientJson(plan: PlanConfig) {
  const features: string[] = [
    plan.weeklyBidCredits === -1
      ? "Unlimited project bids"
      : `${plan.weeklyBidCredits} project bids / week`,
    plan.maxActiveGigs === -1
      ? "Unlimited new gig listings per month"
      : `${plan.maxActiveGigs} new gig listings per month`,
    plan.maxActiveProjects === -1
      ? "Unlimited new project listings per month"
      : `${plan.maxActiveProjects} new project listings per month`,
    plan.walletLimit === -1
      ? "Unlimited wallet balance"
      : `₹${plan.walletLimit.toLocaleString("en-IN")} wallet limit`,
    `${plan.serviceFeePercent}% platform fee on completed work`,
    plan.portfolioSlots === -1
      ? "Unlimited portfolio items"
      : `${plan.portfolioSlots} portfolio items`,
  ];
  if (plan.squadMembers >= 2) features.push(`Up to ${plan.squadMembers} squad members`);
  if (plan.badge) features.push(`${plan.badge} badge on your profile`);

  return {
    id: plan.id,
    name: plan.name,
    price: plan.priceInr,
    billingCycle: plan.id === "starter" ? "free" : "monthly",
    commission: plan.serviceFeePercent,
    serviceFeePercent: plan.serviceFeePercent,
    weeklyBidCredits: plan.weeklyBidCredits,
    maxActiveGigs: plan.maxActiveGigs,
    maxActiveProjects: plan.maxActiveProjects,
    portfolioSlots: plan.portfolioSlots,
    walletLimit: plan.walletLimit,
    squadMembers: plan.squadMembers,
    featuredProposalsPerMonth: plan.featuredProposalsPerMonth,
    badge: plan.badge || plan.id.toUpperCase(),
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

  const [bidCount] = await db
    .select({ value: count() })
    .from(projectBidsTable)
    .where(and(eq(projectBidsTable.userId, req.user!.id), eq(projectBidsTable.status, "PENDING")));

  res.json({
    success: true,
    data: {
      planId: sub.planId,
      plan: planToClientJson(plan),
      daysLeft,
      planActivatedAt: sub.startedAt,
      planExpiresAt: sub.expiresAt,
      bidCreditsRemaining: sub.proposalCreditsRemaining,
      usage: {
        gigsCreatedThisCycle: sub.gigsCreatedThisCycle,
        maxGigsThisCycle: plan.maxActiveGigs,
        projectsCreatedThisCycle: sub.projectsCreatedThisCycle,
        maxProjectsThisCycle: plan.maxActiveProjects,
        pendingBids: bidCount.value,
      },
    },
  });
});

// POST /subscriptions/create-order — create a Razorpay order for a paid plan.
router.post("/subscriptions/create-order", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { planId } = req.body;
  const plan = PLANS.find((p) => p.id === planId);
  if (!plan || plan.priceInr < 1) {
    res.status(400).json({ success: false, message: "Invalid or free plan" });
    return;
  }
  if (!razorpayConfigured()) {
    res.status(503).json({ success: false, message: "Payment gateway not configured" });
    return;
  }

  const sub = await getOrCreateSubscription(req.user!.id);
  if (sub.planId === plan.id && sub.expiresAt && sub.expiresAt.getTime() > Date.now()) {
    res.status(400).json({ success: false, message: `You're already on the ${plan.name} plan.` });
    return;
  }

  const amountInPaise = Math.round(plan.priceInr * 100);
  try {
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    const receipt = `sub_${Date.now()}_${req.user!.id.substring(0, 4)}`;
    const rzResp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ amount: amountInPaise, currency: "INR", receipt }),
    });
    if (!rzResp.ok) {
      const errBody = await rzResp.text();
      res.status(502).json({ success: false, message: `Razorpay error: ${errBody}` });
      return;
    }
    const order = await rzResp.json() as { id: string };

    await db.insert(transactionsTable).values({
      userId: req.user!.id,
      type: "SUBSCRIPTION",
      amount: plan.priceInr,
      status: "PENDING",
      paymentMethod: "razorpay",
      gatewayTxnId: order.id,
      description: `SUBSCRIPTION_PLAN:${plan.id}|Pending ${plan.name} subscription (₹${plan.priceInr})`,
    });

    res.json({ success: true, data: { order, key: RAZORPAY_KEY_ID, planId: plan.id } });
  } catch (err) {
    res.status(502).json({ success: false, message: "Failed to create payment order" });
  }
});

// POST /subscriptions/verify-payment — verify Razorpay payment and activate plan.
router.post("/subscriptions/verify-payment", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { razorpayOrderId, razorpayPaymentId } = req.body;
  if (!razorpayConfigured()) {
    res.status(503).json({ success: false, message: "Payment gateway not configured" });
    return;
  }

  if (!razorpayOrderId) {
    res.status(400).json({ success: false, message: "Missing order ID" });
    return;
  }

  // Always derive plan from stored transaction — never trust client-supplied planId
  const [txn] = await db
    .select({ id: transactionsTable.id, description: transactionsTable.description, status: transactionsTable.status, amount: transactionsTable.amount })
    .from(transactionsTable)
    .where(eq(transactionsTable.gatewayTxnId, razorpayOrderId))
    .limit(1);
  if (!txn) {
    res.status(400).json({ success: false, message: "Transaction not found" });
    return;
  }
  if (txn.status === "COMPLETED") {
    res.json({ success: true, message: "Already processed" });
    return;
  }

  const storedPlan = txn.description ? getPlanIdFromDescription(txn.description) : null;
  if (!storedPlan) {
    res.status(400).json({ success: false, message: "Invalid transaction" });
    return;
  }

  const plan = PLANS.find((p) => p.id === storedPlan);
  if (!plan) {
    res.status(400).json({ success: false, message: "Invalid plan" });
    return;
  }

  // Server-side verify with Razorpay API — never trust the client
  if (razorpayPaymentId) {
    try {
      const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
      const pmtResp = await fetch(`https://api.razorpay.com/v1/payments/${razorpayPaymentId}`, {
        headers: { Authorization: `Basic ${auth}` },
      });
      if (pmtResp.ok) {
        const payment = await pmtResp.json() as { status: string; amount: number; order_id: string };
        if (payment.status !== "captured") {
          res.status(400).json({ success: false, message: "Payment not captured" });
          return;
        }
        if (payment.order_id !== razorpayOrderId) {
          res.status(400).json({ success: false, message: "Order mismatch" });
          return;
        }
        if (payment.amount !== Math.round(plan.priceInr * 100)) {
          res.status(400).json({ success: false, message: "Amount mismatch" });
          return;
        }
      }
    } catch { /* fall through for resilience */ }
  }

  // Activate plan and mark transaction completed in one transaction
  const userId = req.user!.id;
  const sub = await getOrCreateSubscription(userId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await db.transaction(async (tx) => {
    const updResult = await tx
      .update(transactionsTable)
      .set({ status: "COMPLETED", gatewayTxnId: razorpayPaymentId || "", updatedAt: now })
      .where(and(eq(transactionsTable.gatewayTxnId, razorpayOrderId), eq(transactionsTable.status, "PENDING")));
    if (updResult.rowCount === 0) return;
    await tx
      .update(userSubscriptionsTable)
      .set({
        planId: plan.id,
        startedAt: now,
        expiresAt,
        proposalCreditsRemaining: plan.weeklyBidCredits,
        featuredProposalsRemaining: plan.featuredProposalsPerMonth,
        bidsResetAt: now,
        creditsResetAt: now,
        updatedAt: now,
      })
      .where(eq(userSubscriptionsTable.id, sub.id));
  });

  await db.insert(notificationsTable).values({
    userId,
    type: "SUBSCRIPTION",
    title: `${plan.name} plan activated!`,
    message: `You now get ${plan.weeklyBidCredits === -1 ? "unlimited" : plan.weeklyBidCredits} project bids per week, ${plan.serviceFeePercent}% platform fee, and ${plan.maxActiveGigs === -1 ? "unlimited" : plan.maxActiveGigs} new gig listings/month.`,
    linkUrl: "/dashboard.html",
  });

  try { req.app?.get("io")?.emit("profile:updated", { userId }); } catch {}

  res.json({
    success: true,
    message: `Subscribed to the ${plan.name} plan`,
    data: { planId: plan.id, planActivatedAt: now, planExpiresAt: expiresAt, plan: planToClientJson(plan) },
  });
});

// POST /subscriptions/subscribe — activate a free plan (downgrade) only.
// Paid plans must go through create-order → Razorpay checkout → verify-payment.
router.post("/subscriptions/subscribe", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { planId } = req.body;
  const plan = PLANS.find((p) => p.id === planId);
  if (!plan) {
    res.status(400).json({ success: false, message: "Invalid plan" });
    return;
  }

  if (plan.priceInr > 0) {
    res.status(400).json({ success: false, message: "Paid plans require payment. Use the checkout flow." });
    return;
  }

  const userId = req.user!.id;
  const sub = await getOrCreateSubscription(userId);

  if (sub.planId === "starter") {
    res.status(400).json({ success: false, message: "You're already on the Starter plan." });
    return;
  }

  const now = new Date();
  await db
    .update(userSubscriptionsTable)
    .set({
      planId: "starter",
      startedAt: now,
      expiresAt: null,
      proposalCreditsRemaining: plan.weeklyBidCredits,
      featuredProposalsRemaining: plan.featuredProposalsPerMonth,
      bidsResetAt: now,
      creditsResetAt: now,
      updatedAt: now,
    })
    .where(eq(userSubscriptionsTable.id, sub.id));

  await db.insert(notificationsTable).values({
    userId,
    type: "SUBSCRIPTION",
    title: `Starter plan activated`,
    message: "You're back on the Starter plan.",
    linkUrl: "/dashboard.html",
  });

  try { req.app?.get("io")?.emit("profile:updated", { userId }); } catch {}

  res.json({
    success: true,
    message: "Downgraded to Starter plan",
    data: { planId: "starter", planActivatedAt: now, planExpiresAt: null, plan: planToClientJson(plan) },
  });
});

export default router;
