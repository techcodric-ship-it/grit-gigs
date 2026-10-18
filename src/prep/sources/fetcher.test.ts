// Bounded fetching and HTML text extraction tests (stubbed network).

import { describe, it, expect } from "vitest";
import { fetchPage, htmlToText, extractTitle, MAX_BYTES, MAX_TEXT_CHARS, type FetchLike } from "./fetcher";

function stubFetch(body: string, contentType = "text/html; charset=utf-8", status = 200): FetchLike {
  const bytes = new TextEncoder().encode(body);
  return async () => ({
    ok: status < 400,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
    arrayBuffer: async () => bytes.buffer,
  });
}

describe("htmlToText", () => {
  it("strips tags, scripts, styles and comments", () => {
    const html = "<html><head><style>.x{}</style><title>T</title></head><body><!--c--><p>Hello <b>World</b></p><script>var x=1;</script></body></html>";
    expect(htmlToText(html)).toBe("T Hello World");
  });
  it("decodes common entities", () => {
    expect(htmlToText("a&amp;b&nbsp;c&lt;d")).toBe("a&b c<d");
  });
});

describe("extractTitle", () => {
  it("extracts and decodes the title", () => {
    expect(extractTitle("<html><head><title>Acme &amp; Co</title></head></html>")).toBe("Acme & Co");
  });
  it("returns empty when missing", () => {
    expect(extractTitle("<html><body>no title</body></html>")).toBe("");
  });
});

describe("fetchPage", () => {
  it("returns bounded text and title for HTML", async () => {
    const page = await fetchPage("https://example.com", stubFetch("<html><head><title>Acme</title></head><body><p>Hi</p></body></html>"));
    expect(page.title).toBe("Acme");
    expect(page.text).toBe("Acme Hi");
    expect(page.status).toBe(200);
  });
  it("caps very large bodies at MAX_BYTES", async () => {
    const huge = "<html><body>" + "x".repeat(MAX_BYTES + 50_000) + "</body></html>";
    const page = await fetchPage("https://example.com", stubFetch(huge));
    expect(page.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  });
  it("keeps plain text for non-HTML content types", async () => {
    const page = await fetchPage("https://example.com/x", stubFetch("line one\nline two", "text/plain"));
    expect(page.text).toBe("line one line two");
    expect(page.title).toBe("");
  });
  it("surfaces HTTP errors via status", async () => {
    const page = await fetchPage("https://example.com/missing", stubFetch("nope", "text/html", 404));
    expect(page.status).toBe(404);
  });
});
