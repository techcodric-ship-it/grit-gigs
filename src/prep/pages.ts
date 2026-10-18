// Flag-gated static page serving for /prep.
// With FEATURE_PREP off, every /prep path redirects to /feed so the feature is
// invisible. With the flag on, files under public/prep are served with
// extensionless URLs (/prep/aptitude -> public/prep/aptitude.html).

import path from "node:path";
import fs from "node:fs";
import type { Request, Response, NextFunction } from "express";
import { isPrepEnabled } from "./feature";

export function makePrepPages(publicRoot: string) {
  const prepRoot = path.normalize(path.join(publicRoot, "prep"));
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isPrepEnabled()) {
      res.redirect(302, "/feed");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    // req.path here is relative to the /prep mount.
    const rel = String(req.path || "/").replace(/^\/+/, "");
    const candidates = rel === "" || rel === "/"
      ? ["index.html"]
      : [rel, `${rel}.html`, path.join(rel, "index.html")];
    for (const candidate of candidates) {
      const abs = path.normalize(path.join(prepRoot, candidate));
      if (!abs.startsWith(prepRoot + path.sep) && abs !== prepRoot) continue; // traversal guard
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        // Prep pages are noindex in v1 (legal sensitivity).
        res.set("X-Robots-Tag", "noindex");
        res.sendFile(abs);
        return;
      }
    }
    next();
  };
}
