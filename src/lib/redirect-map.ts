import type { Request, Response, NextFunction } from "express";

/**
 * Config-driven 301 map for removed pivot surfaces (Phase 3 removal).
 * Every removed URL pattern MUST appear here; redirect-map.test.ts asserts
 * coverage and that each target resolves to a real page in public/.
 *
 * Mount order matters: this middleware is registered BEFORE express.static
 * in src/app.ts, and after the ".html → extensionless" cleaner, so both
 * /projects and /projects.html land here.
 */

export interface RedirectEntry {
  /** Path pattern: exact "/projects" or prefix "/projects/*". */
  pattern: string;
  /** Fixed target when there is no query logic. */
  target?: string;
  /** Optional query-aware resolver (used by /explore). */
  resolve?: (query: Record<string, string>) => string;
  /** Why this URL was removed — echoed in tests for readable failures. */
  reason: string;
}

export const REMOVED_PAGE_MAP: RedirectEntry[] = [
  { pattern: "/projects", target: "/jobs", reason: "project listings removed (pivot to Jobs)" },
  { pattern: "/projects/*", target: "/jobs", reason: "project detail routes removed" },
  { pattern: "/freelance", target: "/jobs", reason: "gig list surface removed (pivot to Jobs)" },
  { pattern: "/freelance/*", target: "/jobs", reason: "gig detail routes removed" },
  { pattern: "/services", target: "/jobs", reason: "services/gig marketplace removed" },
  { pattern: "/services/*", target: "/jobs", reason: "gig detail routes removed (was /services/:id)" },
  { pattern: "/spotlight-boost", target: "/circle", reason: "Spotlight boost removed" },
  { pattern: "/spotlight", target: "/circle", reason: "Spotlight surface removed" },
  { pattern: "/feed", target: "/circle", reason: "old feed replaced by Grit Circle" },
  { pattern: "/feed/*", target: "/circle", reason: "old feed replaced by Grit Circle" },
  {
    pattern: "/explore",
    reason: "Explore kind=PROJECT/GIG removed; BARTER survives",
    resolve: (query) => {
      const kind = (query.kind || "").toUpperCase();
      if (kind === "BARTER") return "/barter";
      if (kind === "GIG" || kind === "PROJECT" || kind === "") return "/jobs";
      return "/jobs";
    },
  },
  { pattern: "/explore/*", target: "/jobs", reason: "Explore detail routes removed" },
];

/** Test helper: every removed pattern that must stay covered. */
export const REMOVED_PATTERN_COVERAGE: string[] = [
  "/projects",
  "/projects/*",
  "/freelance",
  "/services",
  "/services/*",
  "/spotlight-boost",
  "/spotlight",
  "/feed",
  "/feed/*",
  "/explore",
  "/explore/*",
];

function matches(pattern: string, path: string): boolean {
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    return path === prefix || path.startsWith(prefix + "/");
  }
  return path === pattern;
}

export function resolveRedirect(
  path: string,
  query: Record<string, string>,
): { entry: RedirectEntry; target: string } | null {
  // Exact matches win over prefix matches so /explore beats /explore/*.
  const exact = REMOVED_PAGE_MAP.filter((e) => !e.pattern.endsWith("/*"));
  const prefixes = REMOVED_PAGE_MAP.filter((e) => e.pattern.endsWith("/*"));
  for (const entry of [...exact, ...prefixes]) {
    if (matches(entry.pattern, path)) {
      const target = entry.resolve ? entry.resolve(query) : entry.target!;
      return { entry, target };
    }
  }
  return null;
}

export function removedRedirectMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    next();
    return;
  }
  const hit = resolveRedirect(req.path, (req.query ?? {}) as Record<string, string>);
  if (hit) {
    res.redirect(301, hit.target);
    return;
  }
  next();
}
