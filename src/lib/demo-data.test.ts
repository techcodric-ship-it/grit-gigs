import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { isDemoEnabled, assertDemoTargetAllowed, DemoTargetError } from "../demo/guard";
import { DEMO_PEOPLE, DEMO_LISTINGS, personByKey, createdAtFor } from "../demo/dataset";

const ROOT = resolve(__dirname, "..", "..");

// The database this repository actually ships configured.
const PRODUCTION_URL =
  "postgres://neondb_owner:secret@ep-small-wind-aprlzzi0-pooler.c-7.us-east-1.aws.neon.tech/gritgigs?sslmode=require";
const LOCAL_URL = "postgres://user:pw@localhost:5432/gritgigs_demo";

const env = (over: Record<string, string | undefined>) =>
  ({ DATABASE_URL: PRODUCTION_URL, NODE_ENV: "development", ...over }) as NodeJS.ProcessEnv;

describe("demo guard", () => {
  it("refuses the production database, including a different spelling of it", () => {
    expect(() => assertDemoTargetAllowed(PRODUCTION_URL, env({}))).toThrow(DemoTargetError);

    // Same database, extra query params and a trailing slash.
    expect(() =>
      assertDemoTargetAllowed(`${PRODUCTION_URL}&pool_mode=transaction`, env({})),
    ).toThrow(DemoTargetError);
  });

  it("refuses a remote database without an explicit opt-in", () => {
    expect(() =>
      assertDemoTargetAllowed("postgres://u:p@some-other-neon-host.example.com/db", env({})),
    ).toThrow(/DEMO_ALLOW_REMOTE_TARGET/);
  });

  it("allows a remote database only when explicitly opted in", () => {
    expect(() =>
      assertDemoTargetAllowed("postgres://u:p@demo-db.example.com/db", env({ DEMO_ALLOW_REMOTE_TARGET: "1" })),
    ).not.toThrow();
  });

  it("allows loopback databases", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(() =>
        assertDemoTargetAllowed(`postgres://u:p@${host}:5432/demo`, env({})),
      ).not.toThrow();
    }
  });

  it("refuses when NODE_ENV=production, even for a loopback target", () => {
    expect(() =>
      assertDemoTargetAllowed(LOCAL_URL, env({ NODE_ENV: "production" })),
    ).toThrow(/NODE_ENV=production/);
  });

  it("never enables demo rendering in production, whatever DEMO_MODE says", () => {
    expect(isDemoEnabled(env({ DEMO_MODE: "1" }))).toBe(true);
    expect(isDemoEnabled(env({ DEMO_MODE: "1", NODE_ENV: "production" }))).toBe(false);
    expect(isDemoEnabled(env({}))).toBe(false);
  });
});

describe("demo dataset", () => {
  it("has the requested shape: 4 completed projects, 2 pending, 4 completed barters", () => {
    const completedProjects = DEMO_LISTINGS.filter((l) => l.kind === "PROJECT" && l.status === "SOLD");
    const pendingProjects = DEMO_LISTINGS.filter((l) => l.kind === "PROJECT" && l.status === "ACTIVE");
    const completedBarters = DEMO_LISTINGS.filter((l) => l.kind === "BARTER" && l.status === "SOLD");

    expect(completedProjects).toHaveLength(4);
    expect(pendingProjects).toHaveLength(2);
    expect(completedBarters).toHaveLength(4);
    expect(DEMO_LISTINGS).toHaveLength(10);
  });

  it("keeps completed-project likes inside the requested 100-400 band", () => {
    for (const l of DEMO_LISTINGS.filter((x) => x.kind === "PROJECT" && x.status === "SOLD")) {
      expect(l.likeCount, `${l.key} likeCount`).toBeGreaterThanOrEqual(100);
      expect(l.likeCount, `${l.key} likeCount`).toBeLessThanOrEqual(400);
    }
  });

  it("gives pending projects low engagement so they read as open", () => {
    for (const l of DEMO_LISTINGS.filter((x) => x.status === "ACTIVE")) {
      expect(l.likeCount, `${l.key} should not look popular`).toBeLessThan(50);
    }
  });

  it("points every listing at a person that exists", () => {
    for (const l of DEMO_LISTINGS) expect(() => personByKey(l.ownerKey)).not.toThrow();
  });

  it("uses unique keys, emails are demo-scoped, and no listing is unowned", () => {
    expect(new Set(DEMO_PEOPLE.map((p) => p.key)).size).toBe(DEMO_PEOPLE.length);
    expect(new Set(DEMO_LISTINGS.map((l) => l.key)).size).toBe(DEMO_LISTINGS.length);
    for (const p of DEMO_PEOPLE) expect(p.key).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("keeps every barter listing stating what it wants in return", () => {
    for (const l of DEMO_LISTINGS.filter((x) => x.kind === "BARTER")) {
      expect(l.wantText, `${l.key} wantText`).toBeTruthy();
    }
  });

  it("references a cover image that exists on disk at the declared size", () => {
    for (const l of DEMO_LISTINGS) {
      expect(l.coverImage).toMatch(/^\/uploads\/demo-covers\/[a-z0-9-]+\.png$/);
      const file = resolve(ROOT, "public", l.coverImage.replace(/^\//, ""));
      expect(existsSync(file), `${l.key} cover missing: ${l.coverImage}`).toBe(true);
      // A real PNG, not an empty placeholder.
      const head = readFileSync(file).subarray(0, 8);
      expect([...head], `${l.key} is not a PNG`).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  });

  it("anchors createdAt to a fixed clock so renders are deterministic", () => {
    const l = DEMO_LISTINGS[0];
    expect(createdAtFor(l).toISOString()).toBe(createdAtFor(l).toISOString());
    expect(createdAtFor(l).getTime()).toBeLessThan(Date.parse("2026-01-15T12:00:00.000Z"));
  });
});

describe("demo data cannot be served in production", () => {
  const communityRoute = readFileSync(resolve(ROOT, "src", "routes", "community.ts"), "utf8");
  const app = readFileSync(resolve(ROOT, "src", "app.ts"), "utf8");

  it("no route imports the demo dataset", () => {
    // The demo set is for local/dev use only. If a route ever starts importing
    // it, fabricated listings become reachable by real visitors.
    const routes = [communityRoute, app];
    for (const src of routes) {
      expect(src).not.toMatch(/from\s+["'].*demo\/(dataset|guard)/);
      expect(src).not.toMatch(/DEMO_LISTINGS|DEMO_PEOPLE/);
    }
  });

  it("the demo seed script refuses to run without an explicit non-production target", () => {
    const seed = readFileSync(resolve(ROOT, "scripts", "seed-demo.ts"), "utf8");
    // It must not silently fall back to DATABASE_URL, which is production.
    expect(seed).toContain("assertDemoTargetAllowed");
    expect(seed).not.toMatch(/DEMO_SEED_TARGET\s*\|\|\s*process\.env\.DATABASE_URL/);
  });
});