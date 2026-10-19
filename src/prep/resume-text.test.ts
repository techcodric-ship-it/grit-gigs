// Zero-dep resume text extraction: TXT reads directly, DOCX unzips through a
// hand-rolled central-directory parse, PDF inflates streams (FlateDecode and
// plain) and maps text-showing operators. All fixtures are built in-memory —
// no fixture files, no network, no DB.

import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { extractResumeText } from "./resume-text";

// ---- fixture builders ----

function buildDocx(paragraphs: string[]): Buffer {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs.map((p) => `<w:p><w:r><w:t>${esc(p)}</w:t></w:r></w:p>`).join("") +
    "</w:body></w:document>";
  const data = Buffer.from(xml, "utf8");
  const name = "word/document.xml";
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt32LE(0, 14); // crc32 (our parser never checks it)
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const localRec = Buffer.concat([local, Buffer.from(name, "latin1"), data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  const centralRec = Buffer.concat([central, Buffer.from(name, "latin1")]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRec.length, 12);
  eocd.writeUInt32LE(localRec.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localRec, centralRec, eocd]);
}

function buildPdf(content: string, compress = false): Buffer {
  const raw = Buffer.from(content, "latin1");
  const streamData = compress ? deflateSync(raw) : raw;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${streamData.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n${streamData.toString("latin1")}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  let pdf = "%PDF-1.4\n";
  const off: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    off.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of off) pdf += String(o).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

const RESUME_LINES =
  "BT /F1 14 Tf 72 740 Td (Amit Sharma) Tj ET\n" +
  "BT /F1 11 Tf 72 716 Td (Senior Software Engineer) Tj ET\n" +
  "BT /F1 11 Tf 72 692 Td (Skills: Java, SQL, React) Tj ET\n";

// ---- tests ----

describe("resume text extraction: plain text files", () => {
  it("reads txt/md directly, strips BOM and normalises line endings", () => {
    const buf = Buffer.from("\uFEFFLine one\r\nLine two\r\n\r\n\r\nLine three\n", "utf8");
    const out = extractResumeText(buf, "notes.txt");
    expect(out.ok).toBe(true);
    expect((out as { text: string }).text).toBe("Line one\nLine two\n\nLine three");
  });

  it("rejects an empty text file and an unsupported extension", () => {
    const empty = extractResumeText(Buffer.from("   \n\t\n  "), "resume.txt");
    expect(empty.ok).toBe(false);
    expect((empty as { error: string }).error).toContain("looks empty");
    const bad = extractResumeText(Buffer.from("anything"), "resume.doc");
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toContain("Upload a PDF, DOCX or text file");
  });
});

describe("resume text extraction: DOCX (zip central dir, node:zlib only)", () => {
  it("unzips word/document.xml and strips tags to paragraph text", () => {
    const doc = buildDocx([
      "Senior Java Developer at Acme Corp",
      "Built microservices &#8212; cut p95 latency 40% & saved \u20B92L/quarter",
      "Skills: Java, Spring Boot, Kafka, SQL",
    ]);
    const out = extractResumeText(doc, "resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(out.ok).toBe(true);
    const text = (out as { text: string }).text;
    expect(text).toContain("Senior Java Developer at Acme Corp");
    expect(text).toContain("cut p95 latency 40% & saved \u20B92L/quarter");
    expect(text.split("\n").length).toBeGreaterThanOrEqual(3);
  });

  it("fails honestly on a corrupt or non-zip docx", () => {
    const junk = Buffer.from("this is definitely not a zip archive padding padding padding...");
    const out = extractResumeText(junk, "resume.docx");
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toContain("re-save it as .docx");
  });
});

describe("resume text extraction: PDF (inflate streams, read BT..ET ops)", () => {
  it("extracts text from an uncompressed PDF", () => {
    const out = extractResumeText(buildPdf(RESUME_LINES), "resume.pdf", "application/pdf");
    expect(out.ok).toBe(true);
    const text = (out as { text: string }).text;
    expect(text).toContain("Amit Sharma");
    expect(text).toContain("Senior Software Engineer");
    expect(text).toContain("Skills: Java, SQL, React");
  });

  it("extracts text from a FlateDecode (zlib-compressed) PDF", () => {
    const out = extractResumeText(buildPdf(RESUME_LINES, true), "resume.pdf");
    expect(out.ok).toBe(true);
    expect((out as { text: string }).text).toContain("Amit Sharma");
  });

  it("maps CID-style hex strings through a ToUnicode CMap", () => {
    const content =
      "begincmap\n1 beginbfchar\n<0048> <0048>\n<0065> <0065>\n<006C> <006C>\n<006F> <006F>\nendbfchar\nendcmap\n" +
      "BT /F1 12 Tf 72 700 Td <00480065006C006C006F> Tj ET\n" +
      "BT /F1 12 Tf 72 680 Td (Interview practice session prepared for the panel) Tj ET\n";
    const out = extractResumeText(buildPdf(content), "resume.pdf");
    expect(out.ok).toBe(true);
    const text = (out as { text: string }).text;
    expect(text).toContain("Hello");
    expect(text).toContain("Interview practice session prepared for the panel");
  });

  it("hands back an actionable error for image-only / unreadable PDFs", () => {
    const imageOnly = buildPdf("q 100 0 0 100 0 0 cm /Im0 Do Q\n");
    const out = extractResumeText(imageOnly, "scan.pdf");
    expect(out.ok).toBe(false);
    const msg = (out as { error: string }).error;
    expect(msg).toContain("Paste the text instead");
    expect(msg).toContain("DOCX");
  });
});
