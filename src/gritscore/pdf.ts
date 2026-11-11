// Dependency-free PDF text extraction.
//
// Why hand-rolled: the production deploy does `git reset --hard` and restarts
// pm2, it does NOT run `npm install`. Adding `pdf-parse`/`pdfjs-dist` would
// ship a require() the server cannot resolve and every GritScore scan would
// crash with "Cannot find module". Node already gives us zlib, which is the
// only primitive a text-PDF reader actually needs.
//
// Coverage: digitally generated PDFs (Word, Google Docs, Canva, LaTeX) with
// FlateDecode or uncompressed content streams. Scanned/image-only PDFs and
// encrypted PDFs are detected and rejected with an honest message so the UI
// can ask for pasted text instead of silently scoring an empty resume.

import zlib from "node:zlib";

export class PdfExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfExtractionError";
  }
}

export function isPdf(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

const LITERAL_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  "(": "(",
  ")": ")",
  "\\": "\\",
};

/** Decode a PDF literal string body (without the surrounding parentheses). */
export function decodePdfLiteral(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    if (next === "\r") {
      if (raw[i + 1] === "\n") i++;
      continue; // line continuation
    }
    if (next === "\n") continue;
    if (/[0-7]/.test(next)) {
      let oct = next;
      for (let k = 0; k < 2; k++) {
        const c = raw[i + 1];
        if (c && /[0-7]/.test(c)) {
          oct += c;
          i++;
        } else break;
      }
      out += String.fromCharCode(parseInt(oct, 8));
      continue;
    }
    out += LITERAL_ESCAPES[next] ?? next;
  }
  return out;
}

/** Decode a PDF hex string. UTF-16BE (BOM FEFF) is common in modern exports. */
export function decodePdfHex(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  if (clean.length === 0) return "";
  const even = clean.length % 2 === 0 ? clean : clean + "0";
  const bytes = Buffer.from(even, "hex");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }
  // Single-byte encoding falls back to latin1 (WinAnsi ≈ latin1 for ASCII).
  return bytes.toString("latin1");
}

function readLiteral(content: string, start: number): { text: string; next: number } | null {
  let depth = 1;
  let i = start + 1;
  for (; i < content.length; i++) {
    const ch = content[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  return { text: decodePdfLiteral(content.slice(start + 1, i)), next: i + 1 };
}

const TEXT_SHOW_OPS = /^\s*(Tj|TJ|'|")/;

/** Pull visible text out of one decoded content stream. */
export function extractTextFromContent(content: string): string {
  let out = "";
  let i = 0;
  while (i < content.length) {
    const ch = content[i];

    if (ch === "(") {
      const lit = readLiteral(content, i);
      if (!lit) break;
      const after = content.slice(lit.next, lit.next + 12);
      if (TEXT_SHOW_OPS.test(after)) out += lit.text;
      i = lit.next;
      continue;
    }

    // Skip dictionaries (<< ... >>) so their keys are never read as text.
    if (ch === "<" && content[i + 1] === "<") {
      const end = content.indexOf(">>", i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }

    if (ch === "<") {
      const end = content.indexOf(">", i + 1);
      if (end === -1) break;
      const after = content.slice(end + 1, end + 13);
      if (TEXT_SHOW_OPS.test(after)) out += decodePdfHex(content.slice(i + 1, end));
      i = end + 1;
      continue;
    }

    if (ch === "[") {
      const end = content.indexOf("]", i + 1);
      if (end === -1) break;
      const after = content.slice(end + 1, end + 13);
      if (/^\s*TJ/.test(after)) {
        const arr = content.slice(i + 1, end);
        // Strings in the array, plus a space when kerning pushes a word apart.
        const parts = arr.match(/\((?:[^()\\]|\\.|\((?:[^()\\]|\\.)*\))*\)|<[0-9a-fA-F\s]*>|-?\d+(?:\.\d+)?/g) ?? [];
        for (let p = 0; p < parts.length; p++) {
          const part = parts[p];
          if (part.startsWith("(")) out += decodePdfLiteral(part.slice(1, -1));
          else if (part.startsWith("<")) out += decodePdfHex(part.slice(1, -1));
          else {
            const kern = Number(part);
            if (Number.isFinite(kern) && kern <= -120) out += " ";
          }
        }
      }
      i = end + 1;
      continue;
    }

    if (content.startsWith("Td", i) || content.startsWith("TD", i) || content.startsWith("T*", i) || content.startsWith("ET", i)) {
      out += "\n";
      i += 2;
      continue;
    }

    i++;
  }
  return out;
}

function inflate(bytes: Buffer): Buffer | null {
  const opts = { finishFlush: zlib.constants.Z_SYNC_FLUSH } as const;
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
    try {
      const out = fn(bytes, opts);
      if (out.length > 0) return out;
    } catch {
      /* try the next codec */
    }
  }
  return null;
}

function cleanText(raw: string): string {
  return raw
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Total characters that look like actual language rather than glyph noise. */
function meaningfulLength(text: string): number {
  return (text.match(/[A-Za-z0-9\u00C0-\u024F\u0900-\u097F]/g) ?? []).length;
}

const MAX_STREAMS = 600;
const MAX_INFLATED_BYTES = 40 * 1024 * 1024;

/**
 * Extract text from a PDF buffer. Throws PdfExtractionError when the file is
 * encrypted, truncated, or carries no readable text — the caller shows a
 * "paste your resume instead" path rather than scoring nothing.
 */
export function extractPdfText(buffer: Buffer): string {
  if (!isPdf(buffer)) {
    throw new PdfExtractionError("That file is not a PDF. Upload a PDF resume, or paste the text.");
  }
  const latin = buffer.toString("latin1");
  if (/\/Encrypt\b/.test(latin)) {
    throw new PdfExtractionError("This PDF is password-protected. Remove the password, or paste your resume text.");
  }

  const chunks: string[] = [];
  let cursor = 0;
  let streams = 0;
  let inflatedBytes = 0;

  while (streams < MAX_STREAMS) {
    const marker = latin.indexOf("stream", cursor);
    if (marker === -1) break;
    streams++;

    // The EOL after "stream" is part of the marker, not the data.
    let start = marker + "stream".length;
    if (latin[start] === "\r" && latin[start + 1] === "\n") start += 2;
    else if (latin[start] === "\n" || latin[start] === "\r") start += 1;

    const end = latin.indexOf("endstream", start);
    if (end === -1) break;
    const raw = buffer.subarray(start, end);
    cursor = end + "endstream".length;

    if (raw.length === 0 || raw.length > 8 * 1024 * 1024) continue;

    let decoded: Buffer | null = null;
    if (raw.includes(0x00) || /\/FlateDecode/.test(latin.slice(Math.max(0, marker - 600), marker))) {
      decoded = inflate(raw);
    }
    // Uncompressed content streams: only accept them when they look like page
    // content, otherwise font/ICC bytes would be parsed as text.
    if (!decoded && raw.toString("latin1").includes("BT")) decoded = raw;
    if (!decoded) continue;

    inflatedBytes += decoded.length;
    if (inflatedBytes > MAX_INFLATED_BYTES) break;

    const content = decoded.toString("latin1");
    if (!content.includes("BT") && !content.includes("Tj") && !content.includes("TJ")) continue;
    chunks.push(extractTextFromContent(content));
  }

  const text = cleanText(chunks.join("\n"));
  if (meaningfulLength(text) < 40) {
    throw new PdfExtractionError(
      "This PDF has no readable text — it may be a scan or image. Paste your resume text instead.",
    );
  }
  return text.slice(0, 60_000);
}
