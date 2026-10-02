// Generates branded SVG cover images for the demo walkthrough.
// Deterministic gradients + subtle geometry so each cover looks designed rather
// than like a broken image placeholder. No external assets, no licensing risk.
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = "public/demo/covers";
mkdirSync(OUT, { recursive: true });

// Brand-consistent palettes. Each hue keeps white text legible.
const PALETTES = [
  ["#6C3FE8", "#2E1065"],
  ["#0EA5E9", "#0C4A6E"],
  ["#EC4899", "#701A75"],
  ["#F59E0B", "#78350F"],
  ["#10B981", "#064E3B"],
  ["#8B5CF6", "#3B0764"],
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * @param {string} slug
 * @param {string} label   short kicker, e.g. "COMPLETED PROJECT"
 * @param {string} title   the item title
 * @param {number} idx     palette index
 * @param {string[]} tags  small pill labels
 */
function cover({ slug, label, title, idx, tags = [] }) {
  const [c1, c2] = PALETTES[idx % PALETTES.length];
  // Stable pseudo-random so repeated runs produce identical files.
  const r = (n) => {
    let h = 0;
    for (const ch of slug + n) h = (h * 31 + ch.charCodeAt(0)) % 9973;
    return h;
  };
  const cx = 300 + (r(1) % 400);
  const cy = 120 + (r(2) % 160);
  const tilt = (r(3) % 24) - 12;

  const pills = tags
    .map((t, i) => {
      const x = 48 + i * 150;
      return `<g><rect x="${x}" y="332" width="${22 + t.length * 8}" height="30" rx="15" fill="rgba(255,255,255,0.16)"/>` +
        `<text x="${x + 14}" y="352" font-family="sans-serif" font-size="13" font-weight="600" fill="#fff" opacity="0.92">${esc(t)}</text></g>`;
    })
    .join("");

  // Wrap the title onto up to two lines without a measuring pass.
  const words = title.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > 30) { lines.push(cur.trim()); cur = w; }
    else cur += " " + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  const shown = lines.slice(0, 2);

  // SVG is loaded via <img>, so it cannot reach the page's webfonts. Use a
  // generic sans stack that resolves locally.
  const titleText = shown
    .map((l, i) => `<text x="48" y="${196 + i * 42}" font-family="sans-serif" font-size="34" font-weight="800" fill="#fff">${esc(l)}</text>`)
    .join("");
  const overflow = lines.length > 2 ? `<text x="48" y="${196 + 2 * 42}" font-family="sans-serif" font-size="26" font-weight="700" fill="#fff" opacity="0.6">${esc(lines[2])}…</text>` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400" width="800" height="400" role="img" aria-label="${esc(title)}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.7" cy="0.2" r="0.8">
      <stop offset="0%" stop-color="#fff" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="800" height="400" fill="url(#g)"/>
  <circle cx="${cx}" cy="${cy}" r="180" fill="url(#glow)"/>
  <g transform="rotate(${tilt} ${cx} ${cy})" opacity="0.14">
    <rect x="${cx - 150}" y="${cy - 110}" width="300" height="220" rx="24" fill="none" stroke="#fff" stroke-width="2"/>
    <rect x="${cx - 110}" y="${cy - 70}" width="220" height="140" rx="16" fill="none" stroke="#fff" stroke-width="1.5"/>
  </g>
  <rect x="48" y="52" width="${18 + label.length * 8.5}" height="28" rx="14" fill="#C8F522"/>
  <text x="${57 + label.length * 4}" y="71" font-family="sans-serif" font-size="12" font-weight="800" fill="#0A0A0F" letter-spacing="0.6">${esc(label)}</text>
  ${titleText}
  ${overflow}
  ${pills}
</svg>`;
}

const items = [
  { slug: "bakery-brand-identity", label: "COMPLETED PROJECT", title: "Bakery rebrand with full brand identity", tags: ["Branding", "Logo", "Print"], idx: 0 },
  { slug: "cafe-social-media", label: "COMPLETED PROJECT", title: "Cafe social media management, 3 months", tags: ["Social", "Content", "Monthly"], idx: 1 },
  { slug: "clinic-website", label: "COMPLETED PROJECT", title: "Dental clinic website build and launch", tags: ["Web", "SEO", "Hosting"], idx: 2 },
  { slug: "boutique-packaging", label: "COMPLETED PROJECT", title: "Boutique clothing packaging and label design", tags: ["Packaging", "Print"], idx: 3 },
  { slug: "gym-website-redesign", label: "OPEN OFFER", title: "Gym website redesign, looking for a freelancer", tags: ["Web", "UI", "Budget ₹18k"], idx: 4 },
  { slug: "startup-brand-video", label: "OPEN OFFER", title: "Startup brand video, 60 seconds, local agency", tags: ["Video", "Motion"], idx: 5 },
  { slug: "logo-for-photographer", label: "BARTER", title: "Logo design in exchange for portrait session", tags: ["Design", "Photography"], idx: 1 },
  { slug: "website-for-accountant", label: "BARTER", title: "Small business website for bookkeeping help", tags: ["Web", "Accounts"], idx: 2 },
  { slug: "packaging-for-baker", label: "BARTER", title: "Cookie packaging labels for baked goods advice", tags: ["Print", "Baking"], idx: 3 },
  { slug: "shoot-for-tailor", label: "BARTER", title: "Product photography for a tailoring service", tags: ["Photo", "Fashion"], idx: 0 },
  { slug: "logo-design-fast", label: "GIG", title: "Minimal logo design, 3 concepts, 48 hour delivery", tags: ["Logo", "Fast"], idx: 4 },
  { slug: "resume-writing", label: "GIG", title: "ATS friendly resume writing for freshers", tags: ["Writing", "Career"], idx: 5 },
];

let n = 0;
for (const it of items) {
  writeFileSync(`${OUT}/${it.slug}.svg`, cover(it), "utf8");
  n++;
}
console.log(`wrote ${n} covers to ${OUT}`);