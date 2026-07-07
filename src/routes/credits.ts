import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, freelanceWalletsTable, transactionsTable, notificationsTable } from "../db";
import { authenticate } from "../middlewares/authenticate";

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

function razorpayConfigured(): boolean {
  return !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
}

const router: IRouter = Router();

router.post("/credits/create-order", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { amount } = req.body;
  if (!amount || Number(amount) < 1) {
    res.status(400).json({ success: false, message: "Invalid amount. Minimum ₹1." });
    return;
  }
  if (!razorpayConfigured()) {
    res.status(503).json({ success: false, message: "Payment gateway not configured" });
    return;
  }
  const amtInr = Number(amount);
  const amountInPaise = Math.round(amtInr * 100);

  try {
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    const receipt = `cr_${Date.now()}_${req.user!.id.substring(0,4)}`;
    const rzResp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
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

    // Store order→user mapping for webhook fallback
    await db.insert(transactionsTable).values({
      userId: req.user!.id,
      type: "CREDIT_PURCHASE",
      amount: amtInr,
      status: "PENDING",
      paymentMethod: "razorpay",
      gatewayTxnId: order.id,
      description: `Pending wallet top-up ₹${amtInr}`,
    });

    res.json({ success: true, data: { order, key: RAZORPAY_KEY_ID } });
  } catch (err) {
    res.status(502).json({ success: false, message: "Failed to create payment order" });
  }
});

router.post("/credits/verify-payment", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { razorpayOrderId, razorpayPaymentId, amount } = req.body;
  if (!razorpayConfigured()) {
    res.status(503).json({ success: false, message: "Payment gateway not configured" });
    return;
  }
  const amtInr = Number(amount);
  if (!amtInr || amtInr < 1) {
    res.status(400).json({ success: false, message: "Invalid amount" });
    return;
  }
  // Idempotency: skip if this order was already processed
  if (razorpayOrderId) {
    const [existing] = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(eq(transactionsTable.gatewayTxnId, razorpayOrderId))
      .limit(1);
    if (existing) {
      res.json({ success: true, message: "Already processed" });
      return;
    }
  }
  // Atomically add funds to wallet (INSERT if wallet doesn't exist)
  const addResult = await db.execute(
    sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${amtInr}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${req.user!.id}`
  );
  if (addResult.rowCount === 0) {
    await db.insert(freelanceWalletsTable).values({
      userId: req.user!.id,
      balance: amtInr,
      totalEarned: 0,
      updatedAt: new Date(),
    });
  }

  // Update pending transaction to completed (or insert if none pending)
  if (razorpayOrderId) {
    const [pending] = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(eq(transactionsTable.gatewayTxnId, razorpayOrderId))
      .limit(1);
    if (pending) {
      await db
        .update(transactionsTable)
        .set({ status: "COMPLETED", gatewayTxnId: razorpayPaymentId || "", updatedAt: new Date() })
        .where(eq(transactionsTable.id, pending.id));
    } else {
      await db.insert(transactionsTable).values({
        userId: req.user!.id,
        type: "CREDIT_PURCHASE",
        amount: amtInr,
        status: "COMPLETED",
        paymentMethod: "razorpay",
        gatewayTxnId: razorpayPaymentId || "",
        description: `Added ₹${amtInr.toLocaleString("en-IN")} to wallet`,
      });
    }
  }
  await db.insert(notificationsTable).values({
    userId: req.user!.id,
    type: "CREDITS_ADDED",
    title: `₹${amtInr.toLocaleString("en-IN")} added!`,
    message: "Your wallet has been topped up successfully.",
    linkUrl: "/dashboard.html",
  });
  res.json({ success: true, message: "Amount added successfully" });
});

// Polling endpoint — check if order has been paid (checks Razorpay API directly so UPI QR works)
router.get("/credits/check-order/:orderId", authenticate, async (req: Request, res: Response): Promise<void> => {
  const orderId = req.params.orderId as string;
  // First check our DB
  const [txn] = await db
    .select({ id: transactionsTable.id, status: transactionsTable.status, amount: transactionsTable.amount, gatewayTxnId: transactionsTable.gatewayTxnId })
    .from(transactionsTable)
    .where(eq(transactionsTable.gatewayTxnId, orderId))
    .limit(1);
  if (txn?.status === "COMPLETED") {
    res.json({ success: true, data: { status: "COMPLETED" } });
    return;
  }
  // Check Razorpay directly for payments linked to this order
  if (txn?.gatewayTxnId && razorpayConfigured()) {
    try {
      const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
      const rzResp = await fetch("https://api.razorpay.com/v1/orders/" + txn.gatewayTxnId + "/payments", {
        headers: { Authorization: "Basic " + auth },
      });
      if (rzResp.ok) {
        const rzData = await rzResp.json() as { items?: { status: string; id: string }[] };
        const captured = (rzData.items || []).find((p: { status: string }) => p.status === "captured" || p.status === "authorized");
        if (captured) {
          // Credit wallet immediately
          await db.execute(
            sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${txn.amount}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${req.user!.id}`
          );
          await db.update(transactionsTable)
            .set({ status: "COMPLETED", gatewayTxnId: captured.id, updatedAt: new Date() })
            .where(eq(transactionsTable.id, txn.id));
          await db.insert(notificationsTable).values({
            userId: req.user!.id,
            type: "CREDITS_ADDED",
            title: `₹${Number(txn.amount).toLocaleString("en-IN")} added!`,
            message: "Your wallet has been topped up successfully.",
            linkUrl: "/dashboard.html",
          });
          res.json({ success: true, data: { status: "COMPLETED" } });
          return;
        }
      }
    } catch {}
  }
  res.json({ success: true, data: { status: txn?.status || "PENDING" } });
});

// Recover pending payments — checks Razorpay for captured orders and credits wallet
router.post("/credits/check-pending", authenticate, async (req: Request, res: Response): Promise<void> => {
  const pending = await db
    .select({ id: transactionsTable.id, gatewayTxnId: transactionsTable.gatewayTxnId, amount: transactionsTable.amount })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.userId, req.user!.id), eq(transactionsTable.status, "PENDING")));
  if (pending.length === 0) {
    res.json({ success: true, message: "No pending payments", data: { credited: false } });
    return;
  }
  let credited = false;
  let totalAmount = 0;
  let cleaned = 0;
  for (const txn of pending) {
    if (!txn.gatewayTxnId) continue;
    try {
      const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
      // Check payments linked to this order
      const payResp = await fetch("https://api.razorpay.com/v1/orders/" + txn.gatewayTxnId + "/payments", {
        headers: { Authorization: "Basic " + auth },
      });
      if (!payResp.ok) continue;
      const payData = await payResp.json() as { items?: { status: string; id: string }[] };
      const payments = payData.items || [];
      const captured = payments.find((p: { status: string }) => p.status === "captured" || p.status === "authorized");
      if (captured) {
        // Credit wallet
        await db.execute(
          sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${txn.amount}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${req.user!.id}`
        );
        await db.update(transactionsTable)
          .set({ status: "COMPLETED", gatewayTxnId: captured.id, updatedAt: new Date() })
          .where(eq(transactionsTable.id, txn.id));
        totalAmount += txn.amount;
        credited = true;
      } else if (payments.some((p: { status: string }) => p.status === "failed") || payments.length === 0) {
        // Payment failed or never attempted — check order status too
        let shouldFail = payments.some((p: { status: string }) => p.status === "failed");
        if (payments.length === 0) {
          const ordResp = await fetch("https://api.razorpay.com/v1/orders/" + txn.gatewayTxnId, {
            headers: { Authorization: "Basic " + auth },
          });
          if (ordResp.ok) {
            const ordData = await ordResp.json() as { status: string; attempt_count?: number };
            shouldFail = ordData.status === "attempted" || (ordData.status === "created" && (ordData.attempt_count ?? 0) > 0);
          }
        }
        if (shouldFail) {
          await db.update(transactionsTable)
            .set({ status: "FAILED", updatedAt: new Date() })
            .where(eq(transactionsTable.id, txn.id));
          cleaned++;
        }
      }
    } catch { continue; }
  }
  if (credited) {
    res.json({ success: true, data: { credited: true, amount: totalAmount, cleaned } });
  } else {
    res.json({ success: true, message: cleaned > 0 ? `Marked ${cleaned} failed payment(s) as FAILED` : "No captured payments found", data: { credited: false, cleaned } });
  }
});

// Diagnostic: check Razorpay account status
router.get("/credits/diagnose", authenticate, async (req: Request, res: Response): Promise<void> => {
  if (!razorpayConfigured()) {
    res.json({ success: false, message: "Payment gateway not configured" });
    return;
  }
  try {
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    // Check a recent failed payment for error details
    const [failed] = await db
      .select({ gatewayTxnId: transactionsTable.gatewayTxnId })
      .from(transactionsTable)
      .where(and(eq(transactionsTable.userId, req.user!.id), eq(transactionsTable.status, "FAILED")))
      .limit(1);
    let failureReason: any = null;
    if (failed?.gatewayTxnId) {
      const payResp = await fetch("https://api.razorpay.com/v1/orders/" + failed.gatewayTxnId + "/payments", {
        headers: { Authorization: "Basic " + auth },
      });
      if (payResp.ok) {
        const payData = await payResp.json() as { items?: any[] };
        const failedPayment = (payData.items || []).find((p: any) => p.status === "failed");
        if (failedPayment) {
          failureReason = {
            id: failedPayment.id,
            status: failedPayment.status,
            error_description: (failedPayment as any).error_description,
            error_code: (failedPayment as any).error_code,
            error_source: (failedPayment as any).error_source,
            error_step: (failedPayment as any).error_step,
            error_reason: (failedPayment as any).error_reason,
          };
        }
      }
    }
    // Try to get account info
    const acResp = await fetch("https://api.razorpay.com/v1/orders?limit=3", {
      headers: { Authorization: "Basic " + auth },
    });
    const recentOrders = acResp.ok ? await acResp.json() : null;
    res.json({ success: true, data: { failureReason, recentOrders } });
  } catch (e: any) {
    res.json({ success: false, message: e.message });
  }
});

// ── Manual UPI payment request (no PG) ──
router.post("/credits/upi-request", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { amount } = req.body;
  if (!amount || Number(amount) < 1) {
    res.status(400).json({ success: false, message: "Invalid amount. Minimum ₹1." });
    return;
  }
  const amtInr = Number(amount);
  try {
    const [txn] = await db.insert(transactionsTable).values({
      userId: req.user!.id,
      type: "CREDIT_PURCHASE",
      amount: amtInr,
      status: "PENDING",
      paymentMethod: "upi_manual",
      description: `UPI wallet top-up ₹${amtInr} — awaiting admin confirmation`,
    }).returning({ id: transactionsTable.id });
    res.json({ success: true, data: { txnId: txn.id, amount: amtInr, upiId: "amuthavanan.e@ptyes", payeeName: "Grit&Gigs" } });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to create payment request" });
  }
});

export default router;
