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

// Polling endpoint — check if order has been paid
router.get("/credits/check-order/:orderId", authenticate, async (req: Request, res: Response): Promise<void> => {
  const orderId = req.params.orderId as string;
  const [txn] = await db
    .select({ status: transactionsTable.status })
    .from(transactionsTable)
    .where(eq(transactionsTable.gatewayTxnId, orderId))
    .limit(1);
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
  const debug: string[] = [];
  let credited = false;
  let totalAmount = 0;
  for (const txn of pending) {
    if (!txn.gatewayTxnId) { debug.push("No gatewayTxnId"); continue; }
    try {
      const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
      const rzUrl = "https://api.razorpay.com/v1/orders/" + txn.gatewayTxnId + "/payments";
      const rzResp = await fetch(rzUrl, {
        headers: { Authorization: "Basic " + auth },
      });
      if (!rzResp.ok) {
        const errBody = await rzResp.text();
        debug.push(`Razorpay ${rzResp.status}: ${errBody.substring(0,100)}`);
        continue;
      }
      const rzData = await rzResp.json() as { items?: { status: string; id: string }[] };
      const payments = rzData.items || [];
      debug.push(`Order ${txn.gatewayTxnId.substring(0,16)}... has ${payments.length} payments: ${payments.map((p: { status: string }) => p.status).join(",")}`);
      const captured = payments.find((p: { status: string }) => p.status === "captured" || p.status === "authorized");
      if (!captured) continue;
      await db.execute(
        sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${txn.amount}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${req.user!.id}`
      );
      await db.update(transactionsTable)
        .set({ status: "COMPLETED", gatewayTxnId: captured.id, updatedAt: new Date() })
        .where(eq(transactionsTable.id, txn.id));
      totalAmount += txn.amount;
      credited = true;
    } catch (e: any) { debug.push(`Error: ${e.message}`); continue; }
  }
  if (credited) {
    res.json({ success: true, data: { credited: true, amount: totalAmount }, debug });
  } else {
    res.json({ success: true, message: "No captured payments found", data: { credited: false }, debug });
  }
});

export default router;
