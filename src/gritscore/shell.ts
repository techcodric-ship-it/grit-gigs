// Pure HTML transform for the public /score/:slug shell. Kept separate from
// pages.ts so it can be unit-tested without a database connection.

import { PUBLIC_LABELS, type VerificationTier } from "./config";
import { verificationLabel } from "./verify";

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function replaceMeta(html: string, tags: Record<string, string>): string {
  let out = html;
  for (const [key, value] of Object.entries(tags)) {
    const safe = escapeHtml(value);
    if (key.startsWith("og:") || key.startsWith("twitter:")) {
      const prop = key.startsWith("og:") ? "property" : "name";
      const re = new RegExp(`<meta ${prop}="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" content="[^"]*"\\s*/?>`, "i");
      if (re.test(out)) {
        out = out.replace(re, `<meta ${prop}="${key}" content="${safe}"/>`);
        continue;
      }
    }
    const nameRe = new RegExp(`<meta name="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" content="[^"]*"\\s*/?>`, "i");
    if (nameRe.test(out)) {
      out = out.replace(nameRe, `<meta name="${key}" content="${safe}"/>`);
      continue;
    }
    // Unknown tag: append before </head>.
    out = out.replace("</head>", `  <meta ${key.startsWith("og:") ? "property" : "name"}="${key}" content="${safe}"/>\n</head>`);
  }
  return out;
}

export interface ShellCard {
  slug: string;
  displayName?: string | null;
  tier?: string | null;
  summary?: string | null;
  verificationTier: VerificationTier;
  skills: string[];
}

/**
 * A private or missing card still returns the shell (200) so the client can
 * show a friendly "this card is private" state, but it is marked noindex: an
 * indexable soft-404 or a canonical that drops the slug would let dead links
 * compete with real cards in search. Public cards get per-card OG tags because
 * social scrapers never run JavaScript. The share image is the generated
 * 1200x630 PNG, not the generic site image.
 */
export function renderScoreShell(
  html: string,
  input: { origin: string; slug: string; card: ShellCard | null },
): string {
  const slug = String(input.slug || "").trim() || "card";
  const canonical = `${input.origin}/score/${encodeURIComponent(slug)}`;
  const card = input.card;

  if (!card) {
    let out = replaceMeta(html, {
      "og:url": canonical,
      "robots": "noindex, nofollow",
    });
    out = out.replace(
      /<link rel="canonical" href="[^"]*"\s*\/?>/i,
      `<link rel="canonical" href="${canonical}"/>`,
    );
    return out;
  }

  const who = card.displayName || "Grit&Gigs member";
  const title = `${who} - ${card.tier || "Starter"} ${PUBLIC_LABELS.scoreName}`;
  const skills = (card.skills ?? []).slice(0, 5);
  const description =
    card.summary?.slice(0, 200) ||
    `${verificationLabel(card.verificationTier)} proof summary${skills.length ? ` covering ${skills.join(", ")}` : ""}.`;
  const image = `${input.origin}/api/gritscore/public/${encodeURIComponent(card.slug)}/card.png`;

  let out = replaceMeta(html, {
    "og:type": "profile",
    "og:title": title,
    "og:description": description,
    "og:url": canonical,
    "og:image": image,
    "og:image:width": "1200",
    "og:image:height": "630",
    "twitter:card": "summary_large_image",
    "twitter:title": title,
    "twitter:description": description,
    "twitter:image": image,
    "robots": "index, follow",
  });
  out = out.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  out = out.replace(
    /<link rel="canonical" href="[^"]*"\s*\/?>/i,
    `<link rel="canonical" href="${canonical}"/>`,
  );
  return out;
}
