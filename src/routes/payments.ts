import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db, withdrawalRequestsTable, transactionsTable, freelanceWalletsTable, notificationsTable } from "../db";
import { verifyWebhookSignature } from "../lib/razorpay";

const router: IRouter = Router();

const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";

/**
 * POST /payments/webhook — Razorpay webhook for payout status updates.
 */
router.post("/payments/webhook", async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers["x-razorpay-signature"] as string;
  const body = JSON.stringify(req.body);

  if (RAZORPAY_WEBHOOK_SECRET && !verifyWebhookSignature(body, signature, RAZORPAY_WEBHOOK_SECRET)) {
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
      await db
        .update(withdrawalRequestsTable)
        .set({ status: "FAILED", gatewayTxnId: payoutId || withdrawal.gatewayTxnId })
        .where(eq(withdrawalRequestsTable.id, withdrawal.id));

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

    // Look up the pending transaction by order ID
    const [pending] = await db
      .select({ userId: transactionsTable.userId, amount: transactionsTable.amount })
      .from(transactionsTable)
      .where(eq(transactionsTable.gatewayTxnId, orderId))
      .limit(1);

    if (!pending) {
      res.status(200).json({ success: true, message: "No pending order found" });
      return;
    }

    const amtInr = pending.amount;
    await db.execute(
      sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${amtInr}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${pending.userId}`
    );
    await db
      .update(transactionsTable)
      .set({ status: "COMPLETED", gatewayTxnId: paymentId, updatedAt: new Date() })
      .where(eq(transactionsTable.gatewayTxnId, orderId));
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
