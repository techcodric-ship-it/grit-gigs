// Phase 11 regression: /api/prep must be reachable through the real Express
// app. routes/index.ts ends in a terminal 404 catch-all, so the prep router
// has to be mounted BEFORE app.use("/api", router) — otherwise every prep API
// route answers "Route not found" while unit tests stay green.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server } from "node:http";

vi.stubEnv("DATABASE_URL", "postgres://user:pass@127.0.0.1:5432/prep_mount_test");
vi.stubEnv("JWT_SECRET", "test-secret-for-mount-checks");
vi.stubEnv("FEATURE_PREP", "false");

let server: Server;
let base: string;

beforeAll(async () => {
  const { default: app } = await import("../app");
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  vi.unstubAllEnvs();
});

async function get(path: string): Promise<{ status: number; body: unknown; location: string | null }> {
  const res = await fetch(base + path, { redirect: "manual" });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* html or empty */
  }
  return { status: res.status, body, location: res.headers.get("location") };
}

describe("prep API mount order (real app)", () => {
  it("serves the public flag probe instead of the /api catch-all 404", async () => {
    const res = await get("/api/prep/flag");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { enabled: false } });
  });

  it("flag-off gate answers 'Not found', not the catch-all 'Route not found'", async () => {
    const res = await get("/api/prep/companies?q=infosys");
    expect(res.status).toBe(404);
    const body = res.body as { message?: string };
    expect(body.message).toBe("Not found");
    expect(body.message).not.toBe("Route not found");
  });

  it("the shared /api catch-all still answers other routes", async () => {
    const res = await get("/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect((res.body as { message?: string }).message).toBe("Route not found");
  });

  it("flag-off prep pages redirect to /feed", async () => {
    const res = await get("/prep");
    expect(res.status).toBe(302);
    expect(res.location).toBe("/feed");
  });

  it("flag-on prep API reaches the prep gate (DB down -> 503, not 404)", async () => {
    vi.stubEnv("FEATURE_PREP", "true");
    try {
      const res = await get("/api/prep/companies?q=infosys");
      expect(res.status).toBe(503);
      expect((res.body as { message?: string }).message).toBe("Prep is temporarily unavailable");
    } finally {
      vi.stubEnv("FEATURE_PREP", "false");
    }
  });
});

describe("source-level ordering guard", () => {
  it("prep mount precedes the shared /api router mount in app.ts", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "app.ts"), "utf8");
    // Line-anchored so the explanatory comment (which quotes both mounts)
    // cannot satisfy the check.
    const prepIdx = src.search(/^app\.use\("\/api\/prep", prepRouter\);/m);
    const apiIdx = src.search(/^app\.use\("\/api", router\);/m);
    expect(prepIdx).toBeGreaterThan(-1);
    expect(apiIdx).toBeGreaterThan(-1);
    expect(prepIdx).toBeLessThan(apiIdx);
  });
});
