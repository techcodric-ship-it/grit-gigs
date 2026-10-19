// Zero-dependency resume text extraction for the prep resume check.
// TXT reads directly; DOCX unzips via node:zlib (central-directory parse);
// PDF inflates FlateDecode streams and maps text-showing operators (ToUnicode
// CMaps when present, Latin-1 simple fonts otherwise).
//
// NO npm package was added on purpose: the deploy pipeline is git reset +
// pm2 restart with no install step, so a new dependency would crash production
// ("Cannot find module"). PDFs we cannot read honestly fail with an actionable
// message instead of feeding mojibake to the AI.

import { inflateRawSync, inflateSync } from "node:zlib";

export type ExtractResult = { ok: true; text: string } | { ok: false; error: string };

const MIN_TEXT_CHARS = 40;

const PDF_NO_TEXT =
  "Couldn't read text from this PDF (scanned/image PDFs and some fonts aren't supported here). Paste the text instead or upload the DOCX.";
const DOCX_BAD =
  "Couldn't read that DOCX file - re-save it as .docx or paste the text instead.";

function clean(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function printableRatio(text: string): number {
  if (!text.length) return 0;
  let good = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x20 && c <= 0x7e) || c === 0x0a || c === 0x09 || (c >= 0xa0 && c <= 0x24f)) good++;
  }
  return good / text.length;
}

function safeChar(cp: number): string {
  try {
    return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
  } catch {
    return "";
  }
}

export function extractResumeText(buf: Buffer, filename: string, mime?: string): ExtractResult {
  const name = String(filename || "").toLowerCase();
  const type = String(mime || "").toLowerCase();
  if (/\.(txt|md|csv|text)$/.test(name) || type.startsWith("text/")) {
    const text = clean(buf.toString("utf8"));
    if (!text) return { ok: false, error: "That text file looks empty." };
    return { ok: true, text };
  }
  if (name.endsWith(".docx") || type.includes("wordprocessingml")) return extractDocx(buf);
  if (name.endsWith(".pdf") || type.includes("pdf")) return extractPdf(buf);
  return { ok: false, error: "Upload a PDF, DOCX or text file (.txt/.md)." };
}

// ---- DOCX: ZIP central directory -> word/document.xml -> tag strip ----

function findZipEntry(buf: Buffer, want: string): Buffer | null {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (name === want) {
      if (localOff + 30 > buf.length) return null;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function extractDocx(buf: Buffer): ExtractResult {
  try {
    const xmlBuf = findZipEntry(buf, "word/document.xml");
    if (!xmlBuf) return { ok: false, error: DOCX_BAD };
    const xml = xmlBuf.toString("utf8");
    const text = clean(
      xml
        .replace(/<w:tab\b[^>]*\/>/g, "\t")
        .replace(/<w:br\b[^>]*\/>/g, "\n")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => safeChar(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_m, d: string) => safeChar(parseInt(d, 10)))
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'"),
    );
    if (!text) return { ok: false, error: "That DOCX has no readable text." };
    return { ok: true, text };
  } catch {
    return { ok: false, error: DOCX_BAD };
  }
}

// ---- PDF: inflate streams, build ToUnicode maps, read BT..ET text ops ----

function pdfNoText(): ExtractResult {
  return { ok: false, error: PDF_NO_TEXT };
}

function tryInflate(raw: Buffer): Buffer | null {
  // The slice up to "endstream" may carry the PDF's EOL byte; zlib can reject
  // it, so also try a trailing-newline-trimmed copy (original first — a valid
  // stream may legitimately end with 0x0a).
  const variants: Buffer[] = [raw];
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d)) end--;
  if (end !== raw.length && end > 0) variants.push(raw.subarray(0, end));
  for (const v of variants) {
    try {
      return inflateSync(v);
    } catch {
      /* fall through */
    }
    try {
      return inflateRawSync(v);
    } catch {
      /* fall through */
    }
  }
  return null;
}

function collectPdfStreams(buf: Buffer): string[] {
  const out: string[] = [];
  const hay = buf.toString("latin1");
  let idx = 0;
  while (idx < hay.length) {
    const s = hay.indexOf("stream", idx);
    if (s === -1) break;
    if (s >= 3 && hay.slice(s - 3, s) === "end") {
      idx = s + 6;
      continue;
    }
    let dataStart = s + 6;
    if (hay[dataStart] === "\r") dataStart++;
    if (hay[dataStart] === "\n") dataStart++;
    const e = hay.indexOf("endstream", dataStart);
    if (e === -1) break;
    const raw = buf.subarray(dataStart, e);
    const decoded = tryInflate(raw) ?? raw; // uncompressed content stream
    out.push(decoded.toString("latin1"));
    idx = e + 9;
  }
  return out;
}

function hexToBytes(hex: string): number[] {
  const h = hex.replace(/[^0-9a-fA-F]/g, "");
  const bytes: number[] = [];
  for (let i = 0; i + 1 < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
  if (h.length % 2 === 1) bytes.push(parseInt(h[h.length - 1] + "0", 16));
  return bytes;
}

function utf16HexToText(hex: string): string {
  const h = hex.replace(/[^0-9a-fA-F]/g, "");
  let out = "";
  for (let i = 0; i + 3 < h.length; i += 4) {
    const cp = parseInt(h.slice(i, i + 4), 16);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 7 < h.length) {
      const lo = parseInt(h.slice(i + 4, i + 8), 16);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        out += safeChar(0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00));
        i += 4;
        continue;
      }
    }
    out += safeChar(cp);
  }
  return out;
}

function collectCMaps(streams: string[], cmap: Map<string, string>): void {
  for (const s of streams) {
    if (!s.includes("beginbfchar") && !s.includes("beginbfrange")) continue;
    // bfchar: <src> <dst>
    const charBlock = /beginbfchar([\s\S]*?)endbfchar/g;
    let m: RegExpExecArray | null;
    while ((m = charBlock.exec(s))) {
      const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
      let p: RegExpExecArray | null;
      while ((p = pairRe.exec(m[1]))) {
        cmap.set(p[1].toLowerCase(), utf16HexToText(p[2]));
      }
    }
    // bfrange: <lo> <hi> <dst> | <lo> <hi> [ <d1> <d2> ... ]
    const rangeBlock = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = rangeBlock.exec(s))) {
      const rangeRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
      let r: RegExpExecArray | null;
      while ((r = rangeRe.exec(m[1]))) {
        const lo = parseInt(r[1], 16);
        const hi = parseInt(r[2], 16);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65535) continue;
        if (r[4] !== undefined) {
          // dst is UTF-16BE hex; base code unit of the range's first glyph
          const base = utf16beFirstCode(r[4]);
          if (base === null) continue;
          for (let c = lo; c <= hi; c++) {
            cmap.set(c.toString(16).padStart(r[1].length, "0"), safeChar(base + (c - lo)));
          }
        } else if (r[5] !== undefined) {
          const items = r[5].match(/<([0-9a-fA-F]+)>/g) || [];
          for (let i = 0; i < items.length && lo + i <= hi; i++) {
            const dstHex = items[i].slice(1, -1);
            cmap.set((lo + i).toString(16).padStart(r[1].length, "0"), utf16HexToText(dstHex));
          }
        }
      }
    }
  }
}

function utf16beFirstCode(hex: string): number | null {
  const h = hex.replace(/[^0-9a-fA-F]/g, "");
  if (h.length < 4) return null;
  return parseInt(h.slice(0, 4), 16);
}

function decodePdfBytes(bytes: number[], cmap: Map<string, string>, keyWidth: number): string {
  if (!cmap.size) {
    return bytes.map((b) => (b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x09 ? String.fromCharCode(b) : b >= 0xa0 ? String.fromCharCode(b) : "").join("");
  }
  // Pick the byte width (from cmap key lengths) with the better hit rate.
  const widths = keyWidth === 2 ? [2, 1] : [1, 2];
  let best = "";
  let bestHits = -1;
  for (const w of widths) {
    let out = "";
    let hits = 0;
    let i = 0;
    while (i < bytes.length) {
      if (i + w <= bytes.length) {
        const key = bytes.slice(i, i + w).map((b) => b.toString(16).padStart(2, "0")).join("");
        const mapped = cmap.get(key);
        if (mapped !== undefined) {
          out += mapped;
          hits++;
          i += w;
          continue;
        }
      }
      const b = bytes[i];
      out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "";
      i++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = out;
    }
  }
  return best;
}

function pdfTextFromContent(s: string, cmap: Map<string, string>, keyWidth: number): string {
  if (!s.includes("BT") || !(s.includes("Tj") || s.includes("TJ") || s.includes("'"))) return "";
  let out = "";
  const blockRe = /BT([\s\S]*?)ET/g;
  let b: RegExpExecArray | null;
  while ((b = blockRe.exec(s))) {
    const body = b[1];
    const tokRe = /\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]+>|Tj|TJ|'|T\*|Td|TD|Tm/g;
    let pending: number[] | null = null;
    let t: RegExpExecArray | null;
    while ((t = tokRe.exec(body))) {
      const tok = t[0];
      if (tok[0] === "(") {
        pending = literalStringBytes(tok.slice(1, -1));
      } else if (tok[0] === "<") {
        pending = hexToBytes(tok.slice(1, -1));
      } else if (tok === "Tj" || tok === "TJ" || tok === "'") {
        if (pending) {
          out += decodePdfBytes(pending, cmap, keyWidth);
          pending = null;
        }
        if (tok === "'") out += "\n";
      } else if (tok === "T*" || tok === "Td" || tok === "TD") {
        if (pending) {
          out += decodePdfBytes(pending, cmap, keyWidth);
          pending = null;
        }
        out += "\n";
      }
    }
    if (pending) out += decodePdfBytes(pending, cmap, keyWidth);
    out += "\n";
  }
  return out;
}

function literalStringBytes(s: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "\\") {
      bytes.push(s.charCodeAt(i) & 0xff);
      continue;
    }
    const next = s[++i];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      let oct = next;
      while (oct.length < 3 && i + 1 < s.length && s[i + 1] >= "0" && s[i + 1] <= "7") {
        oct += s[++i];
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      continue;
    }
    const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
    if (next in map) bytes.push(map[next]);
    else if (next === "\n") continue;
    else if (next === "\r") {
      if (s[i + 1] === "\n") i++;
    } else bytes.push(next.charCodeAt(0) & 0xff);
  }
  return bytes;
}

function extractPdf(buf: Buffer): ExtractResult {
  try {
    const streams = collectPdfStreams(buf);
    if (!streams.length) return pdfNoText();
    const cmap = new Map<string, string>();
    collectCMaps(streams, cmap);
    let keyWidth = 1;
    if (cmap.size) {
      const tally = new Map<number, number>();
      for (const k of cmap.keys()) {
        const len = Math.ceil(k.length / 2);
        tally.set(len, (tally.get(len) || 0) + 1);
      }
      keyWidth = (tally.get(2) || 0) >= (tally.get(1) || 0) ? 2 : 1;
    }
    let text = "";
    for (const s of streams) text += pdfTextFromContent(s, cmap, keyWidth);
    text = clean(text);
    if (text.replace(/\s/g, "").length < MIN_TEXT_CHARS || printableRatio(text) < 0.7) return pdfNoText();
    return { ok: true, text };
  } catch {
    return pdfNoText();
  }
}
