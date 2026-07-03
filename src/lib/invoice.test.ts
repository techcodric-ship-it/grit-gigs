import { describe, it, expect } from "vitest";

describe("invoice generation", () => {
  it("generates a valid PDF buffer", async () => {
    const { generateInvoicePdf } = await import("./invoice");
    const pdf = await generateInvoicePdf({
      invoiceNo: "INV-TEST-001",
      date: new Date(),
      fromName: "Grit&Gigs",
      fromEmail: "test@gritandgigs.com",
      toName: "John Doe",
      toEmail: "john@example.com",
      items: [{ description: "Service Payment — Web Development", amount: 5000 }],
      subtotal: 5000,
      commission: 500,
      total: 4500,
      status: "COMPLETED",
    });

    expect(pdf).toBeInstanceOf(Buffer);
    expect(pdf.length).toBeGreaterThan(100);
    // PDF should start with %PDF
    expect(pdf.slice(0, 4).toString()).toBe("%PDF");
  });
});
