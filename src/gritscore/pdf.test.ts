import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { decodePdfHex, decodePdfLiteral, extractPdfText, extractTextFromContent, isPdf, PdfExtractionError } from "./pdf";

function pdfWith(content: Buffer | string, compress: boolean): Buffer {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "latin1");
  const payload = compress ? zlib.deflateSync(body) : body;
  const dict = compress ? "<< /Length 1 /Filter /FlateDecode >>" : "<< /Length 1 >>";
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n" + dict + "\nstream\n", "latin1"),
    payload,
    Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
  ]);
}

describe("pdf detection and decoding", () => {
  it("detects the PDF magic bytes", () => {
    expect(isPdf(Buffer.from("%PDF-1.7 rest"))).toBe(true);
    expect(isPdf(Buffer.from("PK\u0003\u0004 docx"))).toBe(false);
  });

  it("decodes escapes and octal sequences", () => {
    expect(decodePdfLiteral("hello \\(world\\)")).toBe("hello (world)");
    expect(decodePdfLiteral("a\\142c")).toBe("abc");
    expect(decodePdfLiteral("line\\nnext")).toBe("line\nnext");
  });

  it("decodes UTF-16BE hex strings", () => {
    expect(decodePdfHex("FEFF00480065006C006C006F")).toBe("Hello");
    expect(decodePdfHex("48656c6c6f")).toBe("Hello");
  });
});

describe("content stream parsing", () => {
  it("reads Tj, TJ and hex strings", () => {
    const text = extractTextFromContent(
      "BT /F1 12 Tf 72 720 Td (Hello world) Tj 0 -14 Td [(Kerned) -500 (text)] TJ <486578> Tj ET",
    );
    expect(text).toContain("Hello world");
    expect(text).toContain("Kerned");
    expect(text).toContain("text");
    expect(text).toContain("Hex");
  });

  it("ignores strings that are not text-show operators", () => {
    const text = extractTextFromContent("BT /F1 12 Tf (Not shown) Tf (Shown) Tj ET");
    expect(text).not.toContain("Not shown");
    expect(text).toContain("Shown");
  });
});

describe("extractPdfText", () => {
  it("extracts plain content streams", () => {
    const pdf = pdfWith(
      "BT /F1 14 Tf (Senior Product Designer at Acme, 2021 to 2024) Tj 0 -16 Td (Owned the design system for eight products) Tj ET",
      false,
    );
    expect(extractPdfText(pdf)).toContain("Senior Product Designer at Acme");
  });

  it("inflates FlateDecode content streams", () => {
    const pdf = pdfWith(
      "BT /F1 14 Tf (Built the billing system that processed 12000 invoices) Tj 0 -16 Td (Led a team of four engineers) Tj ET",
      true,
    );
    const text = extractPdfText(pdf);
    expect(text).toContain("billing system");
    expect(text).toContain("team of four engineers");
  });

  it("rejects non-PDFs", () => {
    expect(() => extractPdfText(Buffer.from("just text"))).toThrow(PdfExtractionError);
  });

  it("rejects password-protected PDFs", () => {
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj << /Encrypt 2 0 R >>\nstream\n", "latin1"),
      Buffer.from("nothing here", "latin1"),
      Buffer.from("\nendstream\nendobj\n", "latin1"),
    ]);
    expect(() => extractPdfText(pdf)).toThrow(/password-protected/i);
  });

  it("rejects image-only PDFs instead of returning empty text", () => {
    const pdf = pdfWith("BT ET", false);
    expect(() => extractPdfText(pdf)).toThrow(/no readable text/i);
  });
});
