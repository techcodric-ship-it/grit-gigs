// 1200x630 share card. sharp is already a dependency, so no new image stack
// is added. The PDF export is assembled by hand (a single JPEG XObject), which
// avoids pulling in a PDF writer at deploy time.

import sharp from "sharp";
import type { TierName } from "./config";

export interface CardData {
  displayName: string;
  headline?: string | null;
  score: number;
  tier: TierName;
  verification: string;
  skills: string[];
  proofItems: { title: string; label: string }[];
  /** Free cards carry the Grit&Gigs watermark. */
  watermark: boolean;
  /** When false the tier is the hero and the number is withheld. */
  showScore: boolean;
}

const TIER_COLOR: Record<TierName, string> = {
  Starter: "#9A9AA6",
  Rising: "#7FB2FF",
  Solid: "#5EE0B0",
  Elite: "#C9B8FF",
  Legend: "#FFD479",
};

function escapeXml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(value: string, max: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function wrap(value: string, maxChars: number, maxLines: number): string[] {
  const words = String(value ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) break;
    } else {
      current = next;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines) {
    const joined = lines.join(" ");
    if (joined.length < String(value ?? "").trim().length) {
      lines[maxLines - 1] = `${truncate(lines[maxLines - 1], Math.max(4, maxChars - 1))}`;
    }
  }
  return lines;
}

export function cardSvg(data: CardData): string {
  const accent = TIER_COLOR[data.tier] ?? TIER_COLOR.Starter;
  const name = truncate(data.displayName || "Grit&Gigs member", 34);
  const headlineLines = data.headline ? wrap(data.headline, 46, 2) : [];
  const skills = (data.skills ?? []).slice(0, 5).map((s) => truncate(s, 18));
  const skillLines = wrap(skills.join("  ·  "), 44, 2);
  const proof = (data.proofItems ?? []).slice(0, 3);

  const hero = data.showScore ? String(data.score) : data.tier.toUpperCase();
  const heroSize = data.showScore ? 176 : 74;

  const proofRows = proof
    .map((item, i) => {
      const y = 356 + i * 66;
      return `
        <circle cx="676" cy="${y - 7}" r="4" fill="${accent}" />
        <text x="694" y="${y}" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="21" font-weight="600" fill="#F2F2F6">${escapeXml(truncate(item.title, 40))}</text>
        <text x="694" y="${y + 23}" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="15" fill="#7E7E8C">${escapeXml(truncate(item.label, 46))}</text>`;
    })
    .join("");

  const watermark = data.watermark
    ? `<text x="1128" y="592" text-anchor="end" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="21" font-weight="800" fill="#2C2C36">Grit&amp;Gigs</text>
       <text x="1128" y="566" text-anchor="end" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="13" fill="#22222B">gritandgigs.in</text>`
    : `<text x="1128" y="588" text-anchor="end" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="14" fill="#33333E">gritandgigs.in</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B0B11"/>
      <stop offset="0.55" stop-color="#0A0A0F"/>
      <stop offset="1" stop-color="#12101C"/>
    </linearGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#6C3FE8"/>
      <stop offset="1" stop-color="#2A1B5C"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="6" fill="url(#rule)"/>
  <rect x="604" y="86" width="1" height="420" fill="#1E1E28"/>

  <text x="72" y="108" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="16" font-weight="700" letter-spacing="4" fill="#77778A">PROOF SCORE</text>
  <text x="72" y="${data.showScore ? 286 : 258}" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="${heroSize}" font-weight="800" letter-spacing="-4" fill="#FFFFFF">${escapeXml(hero)}</text>
  <text x="72" y="${data.showScore ? 348 : 326}" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="${data.showScore ? 40 : 30}" font-weight="800" fill="${accent}">${escapeXml(data.tier)}</text>
  <text x="72" y="${data.showScore ? 388 : 364}" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="20" fill="#8E8E9A">${escapeXml(data.verification)}</text>

  <text x="72" y="${data.showScore ? 468 : 444}" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="27" font-weight="700" fill="#F2F2F6">${escapeXml(name)}</text>
  ${headlineLines
    .map(
      (line, i) =>
        `<text x="72" y="${(data.showScore ? 500 : 476) + i * 27}" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="19" fill="#9C9CAA">${escapeXml(line)}</text>`,
    )
    .join("")}

  <text x="640" y="108" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="3" fill="#77778A">TOP SKILLS</text>
  ${skillLines
    .map(
      (line, i) =>
        `<text x="640" y="${152 + i * 34}" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="24" font-weight="600" fill="#E7E7EF">${escapeXml(line)}</text>`,
    )
    .join("")}

  <text x="640" y="300" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="3" fill="#77778A">STRONGEST PROOF</text>
  ${proofRows}

  <rect x="72" y="556" width="1056" height="1" fill="#1E1E28"/>
  <text x="72" y="592" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="14" fill="#5E5E6C">Evidence-weighted summary, not a hiring verdict.</text>
  ${watermark}
</svg>`;
}

export async function renderCardPng(data: CardData): Promise<Buffer> {
  return sharp(Buffer.from(cardSvg(data)), { density: 144 }).png({ compressionLevel: 9 }).toBuffer();
}

/** Minimal single-page PDF containing the card as a JPEG. */
export async function renderCardPdf(data: CardData): Promise<Buffer> {
  const jpeg = await sharp(Buffer.from(cardSvg(data))).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
  return buildSingleImagePdf(jpeg, 1200, 630);
}

export function buildSingleImagePdf(jpeg: Buffer, width: number, height: number): Buffer {
  const header = Buffer.from("%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n", "latin1");
  const objects: Buffer[] = [
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "latin1"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n", "latin1"),
    Buffer.from(
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
      "latin1",
    ),
    Buffer.concat([
      Buffer.from(
        `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        "latin1",
      ),
      jpeg,
      Buffer.from("\nendstream\nendobj\n", "latin1"),
    ]),
    (() => {
      const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
      return Buffer.from(
        `5 0 obj\n<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream\nendobj\n`,
        "latin1",
      );
    })(),
  ];

  const offsets: number[] = [];
  let cursor = header.length;
  for (const object of objects) {
    offsets.push(cursor);
    cursor += object.length;
  }
  const xrefStart = cursor;
  const xrefLines = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefStart),
    "%%EOF",
    "",
  ];
  return Buffer.concat([header, ...objects, Buffer.from(xrefLines.join("\n"), "latin1")]);
}
