// News adapter tests with stubbed RSS responses.

import { describe, it, expect } from "vitest";
import { parseNewsRss, newsSearchUrl, makeNewsAdapter } from "./news";
import type { FetchLike } from "./fetcher";

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>News</title>
<item>
  <title>Acme Corp reports strong quarter</title>
  <link>https://news.example.com/acme-quarter</link>
  <pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate>
  <source url="https://news.example.com">The Sample Times</source>
</item>
<item>
  <title><![CDATA[Acme opens new plant]]></title>
  <link>https://news.example.com/acme-plant</link>
  <pubDate>Tue, 13 Oct 2026 08:30:00 GMT</pubDate>
  <source url="https://news.example.com">Wire Desk</source>
</item>
<item>
  <title>No link item should be skipped</title>
  <pubDate>bad-date</pubDate>
</item>
</channel></rss>`;

const xmlFetch: FetchLike = async () => ({
  ok: true,
  status: 200,
  headers: { get: () => "application/rss+xml" },
  text: async () => FIXTURE,
  arrayBuffer: async () => new TextEncoder().encode(FIXTURE).buffer,
});

const stubUrlOptions = { resolve: async () => ["93.184.216.34"] };

describe("parseNewsRss", () => {
  it("parses title, url, publisher and date", () => {
    const items = parseNewsRss(FIXTURE);
    expect(items.length).toBe(2);
    expect(items[0]).toEqual({
      title: "Acme Corp reports strong quarter",
      url: "https://news.example.com/acme-quarter",
      publishedAt: "2026-10-12T10:00:00.000Z",
      sourceName: "The Sample Times",
    });
  });
  it("decodes CDATA and skips items without link", () => {
    const items = parseNewsRss(FIXTURE);
    expect(items[1]!.title).toBe("Acme opens new plant");
    expect(items.some((i) => i.title.includes("skipped"))).toBe(false);
  });
  it("respects the limit", () => {
    expect(parseNewsRss(FIXTURE, 1).length).toBe(1);
  });
});

describe("newsSearchUrl", () => {
  it("encodes the company query", () => {
    expect(newsSearchUrl("Acme Corp")).toContain("q=Acme%20Corp%20company");
  });
});

describe("makeNewsAdapter", () => {
  const adapter = makeNewsAdapter({ fetchImpl: xmlFetch, urlOptions: stubUrlOptions });
  it("produces NEWS-labelled documents with publisher metadata", async () => {
    const { documents, errors } = await adapter.collect({ name: "Acme Corp", domain: null, website: null });
    expect(errors).toEqual([]);
    expect(documents.length).toBe(2);
    expect(documents[0]!.label).toBe("NEWS");
    expect(documents[0]!.publisher).toBe("The Sample Times");
    expect(documents[0]!.publishedAt).toBe("2026-10-12T10:00:00.000Z");
  });
  it("collects errors instead of throwing when fetch fails", async () => {
    const failing = makeNewsAdapter({
      fetchImpl: async () => {
        throw new Error("offline");
      },
      urlOptions: stubUrlOptions,
    });
    const { documents, errors } = await failing.collect({ name: "Acme", domain: null, website: null });
    expect(documents).toEqual([]);
    expect(errors.some((e) => e.includes("news-fetch-failed"))).toBe(true);
  });
});
