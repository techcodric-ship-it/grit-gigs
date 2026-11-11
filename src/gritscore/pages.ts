// Page serving for GritScore.
//
// Two responsibilities:
//  1. /gritscore and /gritscore/* — extensionless static pages out of
//     public/gritscore, same pattern as /prep.
//  2. /score/:slug — the public scorecard shell with per-card Open Graph tags
//     injected server-side, because social scrapers do not run JavaScript.

import fs from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { ensureGritScoreDb, findScanBySlug, listItems } from "./db";
import { verificationLabel } from "./verify";
import { PUBLIC_LABELS } from "./config";

function sendFile(res: Response, abs: string): boolean {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
  res.set("Cache-Control", "no-cache");
  res.sendFile(abs);
  return true;
}

export function makeGritScorePages(publicRoot: string) {
  const gritRoot = path.normalize(path.join(publicRoot, "gritscore"));
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    // req.path is relative to the /gritscore mount.
    const rel = String(req.path || "/").replace(/^\/+/, "");
    const candidates =
      rel === "" || rel === "/"
        ? ["index.html"]
        : [rel, `${rel}.html`, path.join(rel, "index.html")];

    for (const candidate of candidates) {
      const abs = path.normalize(path.join(gritRoot, candidate));
      if (!abs.startsWith(gritRoot + path.sep) && abs !== gritRoot) continue; // traversal guard
      if (sendFile(res, abs)) return;
    }
    next();
  };
}

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

/**
 * /score/:slug — public scorecard shell with OG tags.
 *
 * A private or missing card still returns the shell (200) so the client can
 * show a friendly "this card is private" state; only crawlers get generic
 * tags. The canonical share image is the generated 1200x630 PNG.
 */
export function makeScorePage(publicRoot: string) {
  const shellPath = path.normalize(path.join(publicRoot, "gritscore", "score.html"));
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (!fs.existsSync(shellPath)) {
      next();
      return;
    }

    const slug = String(req.params.slug || "").trim();
    let html = fs.readFileSync(shellPath, "utf8");
    const origin = `${req.protocol}://${req.get("host") || "www.gritandgigs.in"}`;

    try {
      if (/^[a-z0-9][a-z0-9-]{2,60}$/.test(slug)) {
        await ensureGritScoreDb();
        const scan = await findScanBySlug(slug);
        if (scan && scan.isPublic) {
          const items = await listItems(scan.id);
          const skills = (scan.extracted?.skills ?? []).slice(0, 5);
          const title = `${scan.displayName || "Grit&Gigs member"} — ${scan.tier || "Starter"} ${PUBLIC_LABELS.scoreName}`;
          const description =
            scan.summary?.slice(0, 200) ||
            `${verificationLabel(scan.verificationTier)} proof summary${skills.length ? ` covering ${skills.join(", ")}` : ""}.`;
          html = replaceMeta(html, {
            "og:type": "profile",
            "og:title": title,
            "og:description": description,
            "og:url": `${origin}/score/${scan.slug}`,
            "og:image": `${origin}/api/gritscore/public/${scan.slug}/card.png`,
            "og:image:width": "1200",
            "og:image:height": "630",
            "twitter:card": "summary_large_image",
            "twitter:title": title,
            "twitter:description": description,
            "twitter:image": `${origin}/api/gritscore/public/${scan.slug}/card.png`,
          });
          html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(title)}</title>`);
          html = html.replace(
            /<link rel="canonical" href="[^"]*"\s*\/?>/i,
            `<link rel="canonical" href="${origin}/score/${scan.slug}"/>`,
          );
          res.setHeader("Cache-Control", "public, max-age=60");
          res.set("X-Robots-Tag", "index, follow");
          res.type("html").send(html);
          return;
        }
      }
    } catch {
      // DB unavailable: still serve the shell so the page can report the error
      // itself instead of a 500 from the HTML layer.
    }

    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(html);
  };
}
