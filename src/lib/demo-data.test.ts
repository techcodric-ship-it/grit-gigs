import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { assertDemoTargetAllowed, DemoTargetError } from "../demo/guard";
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

  it("allows a local demo database even when DATABASE_URL points at it", () => {
    // The local development flow deliberately sets DATABASE_URL to the throwaway
    // demo database, so target === DATABASE_URL is the *expected* case there.
    // A blanket "must differ from DATABASE_URL" rule refused exactly this.
    expect(() =>
      assertDemoTargetAllowed(LOCAL_URL, env({ DATABASE_URL: LOCAL_URL })),
    ).not.toThrow();
  });

  it("never allows the live database, even with the remote opt-in set", () => {
    // DEMO_ALLOW_REMOTE_TARGET=1 exists to permit a dedicated demo host. It must
    // not become a way to seed the database the app itself is connected to.
    expect(() =>
      assertDemoTargetAllowed(PRODUCTION_URL, env({ DEMO_ALLOW_REMOTE_TARGET: "1" })),
    ).toThrow(/live database/);
  });

  it("still refuses production when only NODE_ENV says development", () => {
    expect(() =>
      assertDemoTargetAllowed(PRODUCTION_URL, env({ NODE_ENV: "development" })),
    ).toThrow(DemoTargetError);
  });

  it("refuses when NODE_ENV=production, even for a loopback target", () => {
    expect(() =>
      assertDemoTargetAllowed(LOCAL_URL, env({ NODE_ENV: "production" })),
    ).toThrow(/NODE_ENV=production/);
  });

  it("never allows production without the explicit override", () => {
    expect(() => assertDemoTargetAllowed(PRODUCTION_URL, env({}))).toThrow(DemoTargetError);
  });

  it("allows production only behind the explicit override", () => {
    const allow = env({ DEMO_SEED_ALLOW_PRODUCTION: "1" });
    expect(() => assertDemoTargetAllowed(PRODUCTION_URL, allow)).not.toThrow();
    // The override still does not make a bad URL parse.
    expect(() => assertDemoTargetAllowed("not-a-url", allow)).toThrow(DemoTargetError);
  });

  it("still blocks production when the override is absent or misspelled", () => {
    for (const value of [undefined, "", "0", "true", "yes"]) {
      expect(() =>
        assertDemoTargetAllowed(PRODUCTION_URL, env({ DEMO_SEED_ALLOW_PRODUCTION: value })),
      ).toThrow(DemoTargetError);
    }
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
      expect(l.coverImage).toMatch(/^\/uploads\/demo-covers\/[a-z0-9-]+\.jpg$/);
      const file = resolve(ROOT, "public", l.coverImage.replace(/^\//, ""));
      expect(existsSync(file), `${l.key} cover missing: ${l.coverImage}`).toBe(true);
      const head = readFileSync(file).subarray(0, 3);
      expect([...head], `${l.key} is not a JPEG`).toEqual([255, 216, 255]);
      // A real photograph, not a flat generated placeholder: a solid-colour
      // gradient compresses to almost nothing at 1200x630.
      expect(statSync(file).size, `${l.key} cover looks flat/empty`).toBeGreaterThan(25_000);
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