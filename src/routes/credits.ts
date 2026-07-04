import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, freelanceWalletsTable, transactionsTable, notificationsTable } from "../db";
import { authenticate } from "../middlewares/authenticate";

const router: IRouter = Router();

router.post("/credits/create-order", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { amount } = req.body;
  if (!amount || Number(amount) < 1) {
    res.status(400).json({ success: false, message: "Invalid amount. Minimum ₹1." });
    return;
  }
  const amtInr = Number(amount);
  const amountInPaise = Math.round(amtInr * 100);
  const razorpayKeyId = process.env["RAZORPAY_KEY_ID"] ?? "";
  if (!razorpayKeyId || razorpayKeyId === "rzp_test_sandbox" || razorpayKeyId.includes("test_xx")) {
    res.json({
      success: true,
      data: {
        order: { id: `mock_${Date.now()}`, amount: amountInPaise },
        razorpayKeyId: "sandbox",
        sandbox: true,
      },
    });
    return;
  }
  res.status(503).json({ success: false, message: "Payment gateway not configured" });
});

router.post("/credits/verify-payment", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { razorpayOrderId, razorpayPaymentId, amount, sandbox } = req.body;
  if (!sandbox) {
    res.status(400).json({ success: false, message: "Live payment verification requires Razorpay configuration" });
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
  const [wallet] = await db.select().from(freelanceWalletsTable).where(eq(freelanceWalletsTable.userId, req.user!.id));
  if (!wallet) {
    res.status(404).json({ success: false, message: "Wallet not found" });
    return;
  }
  await db
    .update(freelanceWalletsTable)
    .set({ balance: wallet.balance + amtInr, updatedAt: new Date() })
    .where(eq(freelanceWalletsTable.id, wallet.id));
  await db.insert(transactionsTable).values({
    userId: req.user!.id,
    type: "CREDIT_PURCHASE",
    amount: amtInr,
    status: "COMPLETED",
    paymentMethod: "razorpay",
    gatewayTxnId: razorpayOrderId ?? razorpayPaymentId ?? "sandbox",
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
