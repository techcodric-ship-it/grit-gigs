import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REMOVED_PAGE_MAP,
  REMOVED_PATTERN_COVERAGE,
  resolveRedirect,
  removedRedirectMiddleware,
} from "./redirect-map";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../../public");

function pageExists(target: string): boolean {
  const clean = target.split("?")[0];
  return fs.existsSync(path.join(publicDir, clean.replace(/^\//, "") + ".html"));
}

describe("removed surface coverage", () => {
  it("covers every removed pattern in the map", () => {
    const patterns = REMOVED_PAGE_MAP.map((e) => e.pattern);
    for (const required of REMOVED_PATTERN_COVERAGE) {
      expect(patterns, `missing redirect for ${required}`).toContain(required);
    }
  });

  it("every fixed target resolves to a real page", () => {
    for (const entry of REMOVED_PAGE_MAP) {
      if (entry.target) {
        expect(pageExists(entry.target), `${entry.pattern} -> ${entry.target} has no page`).toBe(true);
      }
    }
  });

  it("every query-resolved target resolves to a real page", () => {
    const queryCases: Record<string, string>[] = [
      { kind: "PROJECT" },
      { kind: "GIG" },
      { kind: "BARTER" },
      {},
    ];
    for (const query of queryCases) {
      const entry = REMOVED_PAGE_MAP.find((e) => e.resolve);
      expect(entry).toBeTruthy();
      const target = entry!.resolve!(query);
      expect(pageExists(target), `resolve(${JSON.stringify(query)}) -> ${target} has no page`).toBe(true);
    }
  });

  it("every entry documents a reason", () => {
    for (const entry of REMOVED_PAGE_MAP) {
      expect(entry.reason.length).toBeGreaterThan(5);
    }
  });
});

describe("resolveRedirect", () => {
  it("redirects exact project/gig/spotlight/feed paths", () => {
    expect(resolveRedirect("/projects", {})?.target).toBe("/jobs");
    expect(resolveRedirect("/freelance", {})?.target).toBe("/jobs");
    expect(resolveRedirect("/spotlight-boost", {})?.target).toBe("/circle");
    expect(resolveRedirect("/feed", {})?.target).toBe("/circle");
  });

  it("redirects prefix detail routes", () => {
    expect(resolveRedirect("/projects/abc-123", {})?.target).toBe("/jobs");
    expect(resolveRedirect("/services/xyz", {})?.target).toBe("/jobs");
    expect(resolveRedirect("/feed/comments/9", {})?.target).toBe("/circle");
  });

  it("routes explore by kind", () => {
    expect(resolveRedirect("/explore", { kind: "PROJECT" })?.target).toBe("/jobs");
    expect(resolveRedirect("/explore", { kind: "GIG" })?.target).toBe("/jobs");
    expect(resolveRedirect("/explore", { kind: "BARTER" })?.target).toBe("/barter");
    expect(resolveRedirect("/explore", {})?.target).toBe("/jobs");
  });

  it("leaves surviving paths alone", () => {
    expect(resolveRedirect("/barter", {})).toBeNull();
    expect(resolveRedirect("/blog", {})).toBeNull();
    expect(resolveRedirect("/jobs", {})).toBeNull();
    expect(resolveRedirect("/", {})).toBeNull();
  });
});

describe("removedRedirectMiddleware", () => {
  function mockRes() {
    const res = {
      statusCode: 0 as number,
      location: "" as string,
      redirected: false,
      redirect(code: number, target: string) {
        this.statusCode = code;
        this.location = target;
        this.redirected = true;
      },
    };
    return res;
  }

  it("issues a 301 for removed paths and skips everything else", () => {
    const res = mockRes();
    let nextCalled = false;
    removedRedirectMiddleware(
      { method: "GET", path: "/projects", query: {} } as never,
      res as never,
      () => {
        nextCalled = true;
      },
    );
    expect(res.redirected).toBe(true);
    expect(res.statusCode).toBe(301);
    expect(res.location).toBe("/jobs");

    const res2 = mockRes();
    removedRedirectMiddleware(
      { method: "GET", path: "/barter", query: {} } as never,
      res2 as never,
      () => {},
    );
    expect(res2.redirected).toBe(false);

    const res3 = mockRes();
    removedRedirectMiddleware(
      { method: "POST", path: "/projects", query: {} } as never,
      res3 as never,
      () => {},
    );
    expect(res3.redirected).toBe(false);
    expect(nextCalled).toBe(false);
  });
});
