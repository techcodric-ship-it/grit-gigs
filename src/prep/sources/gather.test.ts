// Orchestrator tests: error isolation, dedupe, caps, caching.

import { describe, it, expect } from "vitest";
import { gatherSources, SourceCache, MAX_DOCS_TOTAL, type CompanyRef } from "./gather";
import type { SourceAdapter, SourceDocument } from "./types";

const doc = (url: string, label: SourceDocument["label"] = "OFFICIAL"): SourceDocument => ({
  url,
  title: "T",
  publisher: "P",
  label,
  fetchedAt: "2026-10-18T12:00:00.000Z",
  text: "text",
});

const adapter = (name: string, fn: SourceAdapter["collect"]): SourceAdapter => ({ name, collect: fn });

const company: CompanyRef = { name: "Acme", domain: "acme.example", website: "https://acme.example" };

describe("gatherSources", () => {
  it("merges documents from all adapters and runs each once", async () => {
    const a = adapter("a", async () => ({ documents: [doc("https://a.example/1")], errors: [] }));
    const b = adapter("b", async () => ({ documents: [doc("https://b.example/1", "NEWS")], errors: [] }));
    const result = await gatherSources(company, [a, b], new SourceCache());
    expect(result.adaptersRun).toEqual(["a", "b"]);
    expect(result.documents.map((d) => d.url).sort()).toEqual(["https://a.example/1", "https://b.example/1"]);
  });
  it("isolates adapter crashes into errors", async () => {
    const boom = adapter("boom", async () => {
      throw new Error("kaboom");
    });
    const ok = adapter("ok", async () => ({ documents: [doc("https://ok.example/")], errors: ["soft-fail"] }));
    const result = await gatherSources(company, [boom, ok], new SourceCache());
    expect(result.documents.length).toBe(1);
    expect(result.errors.some((e) => e.startsWith("boom:adapter-crashed"))).toBe(true);
    expect(result.errors.some((e) => e.startsWith("ok:soft-fail"))).toBe(true);
  });
  it("de-duplicates by URL", async () => {
    const a = adapter("a", async () => ({ documents: [doc("https://same.example/")], errors: [] }));
    const b = adapter("b", async () => ({ documents: [doc("https://same.example/")], errors: [] }));
    const result = await gatherSources(company, [a, b], new SourceCache());
    expect(result.documents.length).toBe(1);
  });
  it("caps total documents", async () => {
    const many = adapter("many", async () => ({
      documents: Array.from({ length: MAX_DOCS_TOTAL + 5 }, (_, i) => doc(`https://many.example/${i}`)),
      errors: [],
    }));
    const result = await gatherSources(company, [many], new SourceCache());
    expect(result.documents.length).toBe(MAX_DOCS_TOTAL);
  });
  it("serves from cache without re-running adapters", async () => {
    let calls = 0;
    const counting = adapter("count", async () => {
      calls++;
      return { documents: [doc("https://count.example/")], errors: [] };
    });
    const cache = new SourceCache();
    await gatherSources(company, [counting], cache);
    await gatherSources(company, [counting], cache);
    expect(calls).toBe(1);
  });
});

describe("SourceCache", () => {
  it("expires after ttl", async () => {
    const cache = new SourceCache(1);
    cache.set("k", { documents: [], errors: [], adaptersRun: [] });
    await new Promise((r) => setTimeout(r, 5));
    expect(cache.get("k")).toBeNull();
  });
});
