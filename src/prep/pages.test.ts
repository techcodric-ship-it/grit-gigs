// Source-level tests for Prep Phase 1 wiring: nav injection, prep home shell,
// router flag ordering, and app.ts mounts. Mirrors the source-level style of
// src/lib/nav-badge.test.ts.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const ICON_NAV_PAGES = [
  "buy-more.html",
  "explore.html",
  "feed.html",
  "messages.html",
  "notifications.html",
  "orders.html",
  "profile.html",
  "settings.html",
  "wallet.html",
];

describe("prep nav script tag on icon-nav pages", () => {
  for (const page of ICON_NAV_PAGES) {
    it(`${page} loads /js/prep-nav.js`, () => {
      expect(read(`public/${page}`)).toMatch(/<script src="\/js\/prep-nav\.js\?v=\d+" defer><\/script>/);
    });
  }
});

describe("prep-nav.js flag gating", () => {
  const src = read("public/js/prep-nav.js");
  it("fetches the public flag endpoint", () => {
    expect(src).toContain("/api/prep/flag");
  });
  it("only injects when the flag response is enabled", () => {
    expect(src).toMatch(/d\.data && d\.data\.enabled/);
  });
  it("inserts the Prep icon FIRST, ahead of the Home/Feed button", () => {
    expect(src).toContain("var first = row.firstElementChild;");
    expect(src).toContain("row.insertBefore(a, first)");
    expect(src).not.toContain('row.insertBefore(a, profile)');
  });
  it("is idempotent (skips if a /prep link already exists)", () => {
    expect(src).toContain('a[href="/prep"]');
    expect(src).toContain('querySelector(\'a[href="/prep"]\')');
  });
});

describe("prep home shell", () => {
  const home = read("public/prep/index.html");
  it("exists and is noindex", () => {
    expect(home).toContain('<meta name="robots" content="noindex"/>');
  });
  it("has a unique title (not the generic site title)", () => {
    expect(home).toContain("<title>Prep — company reports | Grit&amp;Gigs</title>");
  });
  it("links its own prep.css and the prep nav script", () => {
    expect(home).toMatch(/\/prep\/prep\.css\?v=\d+/);
    expect(home).toMatch(/\/js\/prep-nav\.js\?v=\d+/);
  });
  it("searches /api/prep/companies and builds report links", () => {
    expect(home).toContain("/api/prep/companies?q=");
    expect(home).toContain("/prep/report/");
  });
});

describe("prep router flag ordering", () => {
  const src = read("src/prep/router.ts");
  it("serves GET /flag before the flag-off 404 gate", () => {
    const flagIdx = src.indexOf('prepRouter.get("/flag"');
    const gateIdx = src.indexOf('prepRouter.use(');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeLessThan(gateIdx);
  });
  it("returns 404 (not 403) for everything else while the flag is off", () => {
    expect(src).toMatch(/res\.status\(404\)\.json\(\{ success: false, message: "Not found" \}\)/);
  });
});

describe("app.ts prep mounts", () => {
  const src = read("src/app.ts");
  it("mounts the prep API router", () => {
    expect(src).toContain('app.use("/api/prep", prepRouter)');
  });
  it("mounts flag-gated prep pages before static", () => {
    const prepIdx = src.indexOf('app.use("/prep", makePrepPages(publicPath))');
    const staticIdx = src.indexOf("app.use(express.static(publicPath))");
    expect(prepIdx).toBeGreaterThan(-1);
    expect(staticIdx).toBeGreaterThan(-1);
    expect(prepIdx).toBeLessThan(staticIdx);
  });
});

describe("prep pages middleware", () => {
  const src = read("src/prep/pages.ts");
  it("redirects to /feed while the flag is off", () => {
    expect(src).toContain('res.redirect(302, "/feed")');
  });
  it("guards against path traversal", () => {
    expect(src).toContain("traversal guard");
  });
  it("serves prep pages with noindex", () => {
    expect(src).toContain('res.set("X-Robots-Tag", "noindex")');
  });
});

describe("prep DDL is additive only", () => {
  const src = read("src/prep/db.ts");
  it("only creates prep_-prefixed tables", () => {
    const tables = [...src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) expect(t).toMatch(/^prep_/);
  });
  it("uses IF NOT EXISTS everywhere", () => {
    expect(src).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(src).not.toMatch(/CREATE INDEX (?!IF NOT EXISTS)/);
  });
});
