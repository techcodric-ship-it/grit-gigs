// Official-site adapter tests with stubbed network and DNS.

import { describe, it, expect } from "vitest";
import { makeOfficialAdapter, CAREERS_PATHS } from "./official";
import type { FetchLike } from "./fetcher";

const page = (title: string, body: string) => {
  const html = `<html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;
  const bytes = new TextEncoder().encode(html);
  return {
    ok: true,
    status: 200,
    headers: { get: () => "text/html; charset=utf-8" },
    text: async () => html,
    arrayBuffer: async () => bytes.buffer,
  };
};

const seen: string[] = [];
const stubFetch: FetchLike = async (url) => {
  seen.push(url);
  if (url.endsWith("/robots.txt")) return page("robots", "User-agent: *\nDisallow: /secret/");
  if (url.includes("/careers")) return page("Careers at Acme", "We are hiring engineers, designers and analysts across our offices in Bengaluru, Pune and remote teams.");
  return page("Acme Corp", "Acme builds widgets. About us, products, contact.");
};
const stubUrlOptions = { resolve: async () => ["93.184.216.34"] };

describe("makeOfficialAdapter", () => {
  it("fetches the official site with label OFFICIAL", async () => {
    seen.length = 0;
    const adapter = makeOfficialAdapter({ fetchImpl: stubFetch, urlOptions: stubUrlOptions, maxDocs: 1 });
    const { documents, errors } = await adapter.collect({ name: "Acme Corp", domain: "acme.example", website: "https://acme.example" });
    expect(errors).toEqual([]);
    expect(documents.length).toBe(1);
    expect(documents[0]!.label).toBe("OFFICIAL");
    expect(documents[0]!.publisher).toBe("Acme Corp");
    expect(documents[0]!.url).toBe("https://acme.example/");
    expect(documents[0]!.text).toContain("Acme builds widgets");
  });
  it("also collects careers pages when maxDocs allows", async () => {
    const adapter = makeOfficialAdapter({ fetchImpl: stubFetch, urlOptions: stubUrlOptions, maxDocs: 1 + CAREERS_PATHS.length });
    const { documents } = await adapter.collect({ name: "Acme", domain: null, website: "https://acme.example" });
    expect(documents.length).toBeGreaterThan(1);
    expect(documents.some((d) => d.url.includes("/careers"))).toBe(true);
  });
  it("reports an error when no website is known", async () => {
    const adapter = makeOfficialAdapter({ fetchImpl: stubFetch, urlOptions: stubUrlOptions });
    const { documents, errors } = await adapter.collect({ name: "Acme", domain: null, website: null });
    expect(documents).toEqual([]);
    expect(errors).toEqual(["no-website-known"]);
  });
  it("does not fetch denylisted hosts", async () => {
    seen.length = 0;
    const adapter = makeOfficialAdapter({ fetchImpl: stubFetch, urlOptions: stubUrlOptions });
    const { documents, errors } = await adapter.collect({
      name: "Acme",
      domain: null,
      website: "https://www.glassdoor.com",
    });
    expect(documents).toEqual([]);
    expect(errors.some((e) => e.includes("denied-host"))).toBe(true);
    expect(seen.filter((u) => u.includes("glassdoor"))).toEqual([]);
  });
});
