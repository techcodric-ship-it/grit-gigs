import PDFDocument from "pdfkit";

interface InvoiceData {
  invoiceNo: string;
  date: Date;
  fromName: string;
  fromEmail: string;
  toName: string;
  toEmail: string;
  items: { description: string; amount: number }[];
  subtotal: number;
  commission: number;
  total: number;
  status: string;
}

export function generateInvoicePdf(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];

      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Header
      doc.fontSize(24).font("Helvetica-Bold").text("INVOICE", { align: "right" });
      doc.moveDown(0.5);
      doc.fontSize(10).font("Helvetica").fillColor("#666")
        .text(`Invoice #: ${data.invoiceNo}`, { align: "right" })
        .text(`Date: ${data.date.toLocaleDateString("en-IN")}`, { align: "right" })
        .text(`Status: ${data.status}`, { align: "right" });

      doc.moveDown(1);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").stroke();
      doc.moveDown(1);

      // From / To
      doc.fontSize(12).font("Helvetica-Bold").fillColor("#000").text("From:");
      doc.fontSize(10).font("Helvetica").fillColor("#333")
        .text(data.fromName)
        .text(data.fromEmail);

      doc.moveDown(0.5);
      doc.fontSize(12).font("Helvetica-Bold").fillColor("#000").text("To:");
      doc.fontSize(10).font("Helvetica").fillColor("#333")
        .text(data.toName)
        .text(data.toEmail);

      doc.moveDown(1);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").stroke();
      doc.moveDown(1);

      // Table header
      const startY = doc.y;
      doc.rect(50, startY, 545, 20).fillColor("#6C63FF").fill();
      doc.fillColor("#fff").fontSize(10).font("Helvetica-Bold");
      doc.text("Description", 60, startY + 5, { width: 300 });
      doc.text("Amount", 400, startY + 5, { width: 150, align: "right" });

      doc.moveDown(1.5);

      // Items
      let y = doc.y;
      for (const item of data.items) {
        doc.fillColor("#333").fontSize(10).font("Helvetica");
        doc.text(item.description, 60, y, { width: 300 });
        doc.text(`₹${item.amount.toFixed(2)}`, 400, y, { width: 150, align: "right" });
        y += 20;
      }

      doc.y = y;
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").stroke();
      doc.moveDown(0.5);

      // Totals
      const totalX = 350;
      doc.fontSize(10).font("Helvetica").fillColor("#333");
      doc.text("Subtotal:", totalX, doc.y, { width: 100 });
      doc.text(`₹${data.subtotal.toFixed(2)}`, 460, doc.y - 12, { width: 100, align: "right" });

      doc.moveDown(0.5);
      doc.text(`Commission (${data.commission > 0 ? "included" : "none"}):`, totalX, doc.y);
      doc.text(`₹${data.commission.toFixed(2)}`, 460, doc.y - 12, { width: 100, align: "right" });

      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").stroke();

      doc.moveDown(0.5);
      doc.fontSize(12).font("Helvetica-Bold").fillColor("#000");
      doc.text("Total:", totalX, doc.y);
      doc.text(`₹${data.total.toFixed(2)}`, 460, doc.y - 15, { width: 100, align: "right" });

      // Footer
      doc.moveDown(3);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").stroke();
      doc.moveDown(0.5);
      doc.fontSize(8).font("Helvetica").fillColor("#999")
        .text("Grit&Gigs", { align: "center" })
        .text("Thank you for your business!", { align: "center" });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
