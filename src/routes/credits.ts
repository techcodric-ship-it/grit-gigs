import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db, freelanceWalletsTable, transactionsTable, notificationsTable } from "../db";
import { authenticate } from "../middlewares/authenticate";

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

function razorpayConfigured(): boolean {
  return !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET && !RAZORPAY_KEY_ID.includes("test_xx"));
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
    const rzResp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ amount: amountInPaise, currency: "INR", receipt: `credits_${Date.now()}` }),
    });
    if (!rzResp.ok) {
      const errBody = await rzResp.text();
      res.status(502).json({ success: false, message: `Razorpay error: ${errBody}` });
      return;
    }
    const order = await rzResp.json();
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
  await db.insert(transactionsTable).values({
    userId: req.user!.id,
    type: "CREDIT_PURCHASE",
    amount: amtInr,
    status: "COMPLETED",
    paymentMethod: "razorpay",
    gatewayTxnId: razorpayPaymentId || "",
    description: `Added ₹${amtInr.toLocaleString("en-IN")} to wallet`,
  });
  await db.insert(notificationsTable).values({
    userId: req.user!.id,
    type: "CREDITS_ADDED",
    title: `₹${amtInr.toLocaleString("en-IN")} added!`,
    message: "Your wallet has been topped up successfully.",
    linkUrl: "/dashboard.html",
  });
  res.json({ success: true, message: "Amount added successfully" });
});

export default router;
