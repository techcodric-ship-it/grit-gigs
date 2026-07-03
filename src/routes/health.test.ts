import { describe, it, expect } from "vitest";

describe("health route", () => {
  it("exists and exports a router", async () => {
    const mod = await import("./health");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("function");
  });

  it("generates invoice PDF correctly", async () => {
    const { generateInvoicePdf } = await import("../lib/invoice");
    const pdf = await generateInvoicePdf({
      invoiceNo: "INV-TEST-001",
      date: new Date(),
      fromName: "Grit&Gigs",
      fromEmail: "test@gritandgigs.com",
      toName: "John Doe",
      toEmail: "john@example.com",
      items: [{ description: "Payment", amount: 1000 }],
      subtotal: 1000,
      commission: 100,
      total: 900,
      status: "COMPLETED",
    });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.toString("utf8", 0, 4)).toBe("%PDF");
  });
});
