import { Router, type IRouter } from "express";
import { db, usersTable, transactionsTable, ordersTable, freelanceWalletsTable } from "../db";
import { eq, and, desc } from "drizzle-orm";
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
    // Commission shown on the invoice = the actual platform commission charged for this earning.
    // For SERVICE_EARNING transactions we look up the matching COMMISSION transaction by the
    // shared reference tail (e.g. project "Title" / milestone "Title" / order #ABC1234) so that
    // zero-commission first projects and non-10% plan rates display correctly.
    let commission = 0;
    if (tx.type === "COMMISSION") {
      commission = tx.amount;
    } else if (tx.type === "SERVICE_EARNING" && tx.description?.startsWith("Payment received for ")) {
      const ref = tx.description.slice("Payment received for ".length);
      const commissionRows = await db
        .select({ amount: transactionsTable.amount, description: transactionsTable.description })
        .from(transactionsTable)
        .where(and(eq(transactionsTable.userId, tx.userId), eq(transactionsTable.type, "COMMISSION")))
        .orderBy(desc(transactionsTable.createdAt))
        .limit(50);
      const matched = commissionRows.find((c) => c.description?.endsWith(ref));
      commission = matched?.amount ?? 0;
    }
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
