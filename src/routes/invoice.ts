import { Router, type IRouter } from "express";
import { db, usersTable, transactionsTable, ordersTable, freelanceWalletsTable } from "../db";
import { eq } from "drizzle-orm";
import { authenticate } from "../middlewares/authenticate";
import { generateInvoicePdf } from "../lib/invoice";

const router: IRouter = Router();

router.get("/invoices/:transactionId", authenticate, async (req, res): Promise<void> => {
  try {
    const txId = String(req.params.transactionId);
    const userId = req.user!.id;

    const [tx] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txId));

    if (!tx) {
      res.status(404).json({ success: false, message: "Transaction not found" });
      return;
    }

    // Only the transaction owner can download
    if (tx.userId !== userId) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const [user] = await db
      .select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    const invoiceNo = `INV-${tx.id.slice(0, 8).toUpperCase()}-${tx.createdAt?.getFullYear() || new Date().getFullYear()}`;
    const commission = tx.type === "SERVICE_EARNING" || tx.type === "COMMISSION" ? tx.amount * 0.1 : 0;
    const subtotal = tx.type === "SERVICE_EARNING" || tx.type === "SERVICE_PAYMENT" ? tx.amount : tx.amount;

    const pdf = await generateInvoicePdf({
      invoiceNo,
      date: tx.createdAt || new Date(),
      fromName: "Grit&Gigs",
      fromEmail: "finance@gritandgigs.com",
      toName: `${user.firstName} ${user.lastName}`.trim(),
      toEmail: user.email,
      items: [{ description: `${tx.type.replace(/_/g, " ")} — ${tx.description || "Transaction"}`, amount: subtotal }],
      subtotal,
      commission: Math.round(commission * 100) / 100,
      total: tx.type === "COMMISSION" ? commission : tx.amount,
      status: tx.status,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${invoiceNo}.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to generate invoice" });
  }
});

export default router;
