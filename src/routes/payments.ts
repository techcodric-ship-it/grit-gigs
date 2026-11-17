import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql, and, or, inArray } from "drizzle-orm";
import { db, withdrawalRequestsTable, transactionsTable, freelanceWalletsTable, notificationsTable } from "../db";
import { verifyWebhookSignature } from "../lib/razorpay";
import { completeGritScoreOrder, notifyGritScorePro } from "../gritscore/db";
import { GRITSCORE_PRO } from "../gritscore/config";
import { trackPurchase } from "../lib/meta-capi";

const router: IRouter = Router();

const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";

/**
 * POST /payments/webhook — Razorpay webhook for payout status updates.
 */
router.post("/payments/webhook", async (req: Request, res: Response): Promise<void> => {
  if (!RAZORPAY_WEBHOOK_SECRET) {
    res.status(503).json({ success: false, message: "Webhook not configured" });
    return;
  }
  const signature = req.headers["x-razorpay-signature"] as string;
  const body = JSON.stringify(req.body);

  if (!verifyWebhookSignature(body, signature, RAZORPAY_WEBHOOK_SECRET)) {
    res.status(400).json({ success: false, message: "Invalid signature" });
    return;
  }

  const event = req.body.event;
  const payload = req.body.payload;

  if (!event || !payload) {
    res.status(400).json({ success: false, message: "Invalid webhook payload" });
    return;
  }

  // Payout events
  if (event.startsWith("payout.")) {
    const payoutId = payload.payout?.entity?.id;
    const status = payload.payout?.entity?.status;
    const referenceId = payload.payout?.entity?.reference_id;
    const failureReason = payload.payout?.entity?.failure_reason || null;

    if (!referenceId) {
      res.status(200).json({ success: true, message: "No reference ID" });
      return;
    }

    // referenceId is our withdrawal request ID
    const [withdrawal] = await db
      .select()
      .from(withdrawalRequestsTable)
      .where(eq(withdrawalRequestsTable.id, referenceId))
      .limit(1);

    if (!withdrawal) {
      res.status(200).json({ success: true, message: "Withdrawal not found" });
      return;
    }

    if (event === "payout.created" || event === "payout.processed") {
      await db
        .update(withdrawalRequestsTable)
        .set({
          status: status === "processed" ? "COMPLETED" : "PROCESSING",
          gatewayTxnId: payoutId || withdrawal.gatewayTxnId,
          processedAt: status === "processed" ? new Date() : withdrawal.processedAt,
        })
        .where(eq(withdrawalRequestsTable.id, withdrawal.id));
    } else if (event === "payout.reversed" || event === "payout.failed") {
      // Idempotency: only process if withdrawal hasn't already been marked FAILED
      const updResult = await db
        .update(withdrawalRequestsTable)
        .set({ status: "FAILED", gatewayTxnId: payoutId || withdrawal.gatewayTxnId })
        .where(and(eq(withdrawalRequestsTable.id, withdrawal.id), inArray(withdrawalRequestsTable.status, ["PENDING", "PROCESSING"])));

      if (updResult.rowCount === 0) {
        res.status(200).json({ success: true, message: "Already processed" });
        return;
      }

      // Refund the amount back to wallet on failure
      if (status === "failed" || event === "payout.reversed") {
        await db.execute(
          sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${withdrawal.amount}, updated_at = NOW() WHERE id = ${withdrawal.walletId}`
        );
        await db.insert(transactionsTable).values({
          userId: withdrawal.userId,
          type: "REFUND",
          amount: withdrawal.amount,
          description: `Payout failed — ₹${withdrawal.amount} refunded${failureReason ? ` (${failureReason})` : ""}`,
          status: "COMPLETED",
        });
        await db.insert(notificationsTable).values({
          userId: withdrawal.userId,
          type: "WITHDRAWAL_FAILED",
          title: "Withdrawal failed",
          message: `Your withdrawal of ₹${withdrawal.amount} failed${failureReason ? `: ${failureReason}` : ""}. Amount has been refunded to your wallet.`,
          linkUrl: "/dashboard.html",
        });
      }
    }

    res.status(200).json({ success: true });
    return;
  }

  // Payment captured — credit wallet (fallback if client-side handler fails)
  if (event === "payment.captured") {
    const paymentId = payload.payment?.entity?.id;
    const orderId = payload.payment?.entity?.order_id;
    const amountPaise = payload.payment?.entity?.amount;
    if (!orderId || !paymentId || !amountPaise) {
      res.status(200).json({ success: true, message: "Missing payment data" });
      return;
    }

    // Look up the transaction by order ID with idempotency check. gatewayOrderId
    // is the permanent key; gatewayTxnId is also matched because it holds the
    // order id until the payment settles and then the payment id.
    const [pending] = await db
      .select({ id: transactionsTable.id, userId: transactionsTable.userId, amount: transactionsTable.amount, status: transactionsTable.status, type: transactionsTable.type, description: transactionsTable.description })
      .from(transactionsTable)
      .where(or(eq(transactionsTable.gatewayOrderId, orderId), eq(transactionsTable.gatewayTxnId, orderId)))
      .limit(1);

    if (!pending) {
      res.status(200).json({ success: true, message: "No pending order found" });
      return;
    }

    // Quota bundles are credited by /community/quota/verify, not as wallet cash.
    // Guarding here stops the same ₹ payment from being credited twice.
    if (pending.type === "QUOTA_BUNDLE") {
      res.status(200).json({ success: true, message: "Quota bundle order - handled by quota verify" });
      return;
    }

    // GritScore Pro orders also share the SUBSCRIPTION type but must never
    // credit wallet cash. They are completed here instead of only via
    // /pro/verify so a capture is never lost when the browser closes before
    // verification runs. The amount is re-checked before anything is granted.
    if (pending.type === "SUBSCRIPTION" && (pending.description || "").startsWith("GRITSCORE_PRO:")) {
      if (Number(amountPaise) !== Math.round(GRITSCORE_PRO.priceInr * 100)) {
        res.status(200).json({ success: true, message: "GritScore Pro amount mismatch" });
        return;
      }
      try {
        const result = await completeGritScoreOrder(pending.userId, orderId, paymentId);
        if (result.ok) {
          await notifyGritScorePro(pending.userId, result.entitlement.expiresAt);
          void trackPurchase({
            eventId: paymentId,
            value: GRITSCORE_PRO.priceInr,
            currency: "INR",
            sourceUrl: "https://www.gritandgigs.in/gritscore",
          });
        }
        res.status(200).json({ success: true, message: "GritScore Pro order handled" });
      } catch (err) {
        console.error("[payments] gritscore pro webhook completion failed:", err);
        res.status(500).json({ success: false, message: "GritScore Pro completion failed" });
      }
      return;
    }

    // Prep is retired. Any legacy PENDING Prep Pro row is acknowledged and
    // ignored so it can never fall through to a wallet-cash credit.
    if (pending.type === "SUBSCRIPTION" && (pending.description || "").startsWith("PREP_PRO:")) {
      res.status(200).json({ success: true, message: "Retired prep order ignored" });
      return;
    }

    if (pending.status === "COMPLETED") {
      res.status(200).json({ success: true, message: "Already processed" });
      return;
    }

    const amtInr = pending.amount;
    await db.transaction(async (tx) => {
      const updResult = await tx
        .update(transactionsTable)
        .set({ status: "COMPLETED", gatewayTxnId: paymentId, description: `Wallet top-up ₹${amtInr}`, updatedAt: new Date() })
        .where(and(eq(transactionsTable.id, pending.id), eq(transactionsTable.status, "PENDING")));
      if (updResult.rowCount === 0) return;
      await tx.execute(
        sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${amtInr}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${pending.userId}`
      );
    });
    await db.insert(notificationsTable).values({
      userId: pending.userId,
      type: "CREDITS_ADDED",
      title: `₹${amtInr.toLocaleString("en-IN")} added!`,
      message: "Your wallet has been topped up successfully.",
      linkUrl: "/dashboard.html",
    });

    res.status(200).json({ success: true });
    return;
  }

  res.status(200).json({ success: true, message: "Unhandled event" });
});

export default router;
