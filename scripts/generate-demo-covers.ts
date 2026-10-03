import { mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import sharp from "sharp";

import { DEMO_LISTINGS } from "../src/demo/dataset";

// Cover images are generated locally with sharp rather than pulled from an
// image host. A remote placeholder service would make the demo depend on an
// outside service being up, and would put third-party URLs in the dataset.
const OUT_DIR = resolve(__dirname, "..", "public", "uploads", "demo-covers");
const W = 1200;
const H = 630;

type Rgb = [number, number, number];

const BRAND: Record<string, [Rgb, Rgb]> = {
  "p-brand-kit": [[124, 58, 237], [236, 72, 153]],
  "p-ops-dashboard": [[15, 118, 110], [59, 130, 246]],
  "p-onboarding-copy": [[217, 119, 6], [239, 68, 68]],
  "p-sales-bi": [[2, 132, 199], [16, 185, 129]],
  "p-clinic-social": [[225, 29, 72], [249, 115, 22]],
  "p-booking-app": [[79, 70, 229], [14, 165, 233]],
  "b-logo-for-site": [[168, 85, 247], [99, 102, 241]],
  "b-copy-for-code": [[13, 148, 136], [5, 150, 105]],
  "b-analytics-for-brand": [[234, 88, 12], [202, 138, 4]],
  "b-reels-for-sql": [[219, 39, 119], [190, 24, 93]],
};

/** Diagonal linear gradient across the full canvas. */
function gradient(from: Rgb, to: Rgb): Buffer {
  const w = 64;
  const h = 64;
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x / (w - 1) + y / (h - 1)) / 2;
      const i = (y * w + x) * 3;
      data[i] = Math.round(from[0] + (to[0] - from[0]) * t);
      data[i + 1] = Math.round(from[1] + (to[1] - from[1]) * t);
      data[i + 2] = Math.round(from[2] + (to[2] - from[2]) * t);
    }
  }
  return data;
}

/** Soft geometric marks so the covers do not read as flat colour blocks. */
function overlay(): Buffer {
  const w = 512;
  const h = 512;
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="120" cy="110" r="150" fill="#ffffff" fill-opacity="0.10"/>
    <circle cx="410" cy="400" r="190" fill="#000000" fill-opacity="0.08"/>
    <rect x="230" y="60" width="150" height="150" rx="28" fill="#ffffff" fill-opacity="0.07"
          transform="rotate(18 305 135)"/>
    <path d="M60 430 C 170 350, 250 470, 360 390" stroke="#ffffff" stroke-opacity="0.16"
          stroke-width="10" fill="none" stroke-linecap="round"/>
  </svg>`;
  return Buffer.from(svg);
}

/** Inset label strip, so a cover is identifiable without opening the post. */
function label(text: string): Buffer {
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="${H - 132}" width="${W}" height="132" fill="#000000" fill-opacity="0.26"/>
    <text x="56" y="${H - 66}" font-family="Segoe UI, Helvetica, Arial, sans-serif"
          font-size="42" font-weight="700" fill="#ffffff">${safe}</text>
  </svg>`;
  return Buffer.from(svg);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log("writing covers to", OUT_DIR);

  for (const listing of DEMO_LISTINGS) {
    const [from, to] = BRAND[listing.key] ?? [[100, 100, 120], [60, 60, 80]];
    const base = sharp(gradient(from, to), { raw: { width: 64, height: 64, channels: 3 } })
      .resize(W, H, { kernel: "cubic" })
      .composite([{ input: overlay(), blend: "over" }])
      .composite([{ input: label(listing.kind === "BARTER" ? "Skill swap" : "Project"), blend: "over" }])
      .png({ compressionLevel: 9 });

    const file = resolve(OUT_DIR, `${listing.key}.png`);
    await base.toFile(file);
    console.log("  ", listing.key, listing.kind, listing.status);
  }

  console.log("done:", DEMO_LISTINGS.length, "covers");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);