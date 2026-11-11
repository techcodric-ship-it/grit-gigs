// Page serving for GritScore.
//
// Two responsibilities:
//  1. /gritscore and /gritscore/* - extensionless static pages out of
//     public/gritscore, same pattern as /prep.
//  2. /score/:slug - the public scorecard shell with per-card Open Graph tags
//     injected server-side, because social scrapers do not run JavaScript.

import fs from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { ensureGritScoreDb, findScanBySlug } from "./db";
import { renderScoreShell, type ShellCard } from "./shell";

export { renderScoreShell, type ShellCard } from "./shell";

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

/**
 * /score/:slug - public scorecard shell with OG tags.
 *
 * A private or missing card still returns the shell (200) so the client can
 * show a friendly "this card is private" state; crawlers get a noindex shell.
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

    const rawSlug = String(req.params.slug || "").trim();
    const slug = /^[a-z0-9][a-z0-9-]{2,60}$/.test(rawSlug) ? rawSlug : "";
    // A configured APP_URL wins: the Host header is caller-controlled and must
    // not be able to poison the canonical/og:url of a shared card.
    const configured = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
    const origin = configured || `${req.protocol}://${req.get("host") || "www.gritandgigs.in"}`;

    let card: ShellCard | null = null;
    if (slug) {
      try {
        await ensureGritScoreDb();
        const scan = await findScanBySlug(slug);
        if (scan && scan.isPublic) {
          card = {
            slug: scan.slug,
            displayName: scan.displayName,
            tier: scan.tier,
            summary: scan.summary,
            verificationTier: scan.verificationTier,
            skills: scan.extracted?.skills ?? [],
          };
        }
      } catch {
        // DB unavailable: still serve the shell so the page can report the
        // error itself instead of a 500 from the HTML layer.
      }
    }

    const html = renderScoreShell(fs.readFileSync(shellPath, "utf8"), {
      origin,
      slug: rawSlug,
      card,
    });

    if (card) {
      res.setHeader("Cache-Control", "public, max-age=60");
      res.set("X-Robots-Tag", "index, follow");
    } else {
      res.setHeader("Cache-Control", "no-cache");
      res.set("X-Robots-Tag", "noindex, nofollow");
    }
    res.type("html").send(html);
  };
}
