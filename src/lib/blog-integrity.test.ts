import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// The blog is the main organic acquisition surface, and every post is hand
// written HTML. These guard the failure modes that are invisible in a browser
// preview but cost real search traffic: a dead internal link, a canonical
// pointing nowhere, or a JSON-LD block that does not parse (which silently
// kills the rich result).

const ROOT = resolve(__dirname, "..", "..");
const PUBLIC = resolve(ROOT, "public");
const posts = readdirSync(PUBLIC).filter((f) => /^blog-.*\.html$/.test(f));

describe("blog posts", () => {
  it("ships more than one post", () => {
    expect(posts.length).toBeGreaterThan(1);
  });

  it.each(posts)("%s has one h1, a description and a canonical", (file) => {
    const s = readFileSync(resolve(PUBLIC, file), "utf8");
    expect((s.match(/<h1/g) || []).length, `${file} must have exactly one h1`).toBe(1);
    const desc = s.match(/<meta name="description" content="([^"]{60,})"/);
    expect(desc, `${file} needs a meta description of at least 60 chars`).not.toBeNull();
    expect(s).toMatch(/<link rel="canonical" href="https:\/\/www\.gritandgigs\.in\/[^"]+"/);
    expect(s).toMatch(/name="viewport"/);
  });

  it.each(posts)("%s has parseable structured data", (file) => {
    const s = readFileSync(resolve(PUBLIC, file), "utf8");
    const blocks = [...s.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(blocks.length, `${file} needs JSON-LD`).toBeGreaterThan(0);
    for (const b of blocks) {
      // Throws on malformed JSON, which is the whole point.
      expect(() => JSON.parse(b[1]), `${file} has malformed JSON-LD`).not.toThrow();
    }
  });

  it.each(posts)("%s is valid UTF-8 with no mangled characters", (file) => {
    const raw = readFileSync(resolve(PUBLIC, file));
    const s = raw.toString("utf8");
    expect(s.includes("\uFFFD"), `${file} contains U+FFFD, so rupee signs or dashes are broken`).toBe(false);
    expect(Buffer.from(s, "utf8").equals(raw), `${file} is not a clean UTF-8 round-trip`).toBe(true);
  });

  it.each(posts)("%s links to no missing page", (file) => {
    const s = readFileSync(resolve(PUBLIC, file), "utf8");
    const links = [...new Set([...s.matchAll(/href="(\/[^"#?]*?)"/g)].map((m) => m[1]))];
    const broken = links.filter((l) => {
      if (l === "/") return false;
      // Strip the leading slash: resolve() treats "/x" as filesystem-absolute
      // and would look outside public/ entirely.
      const rel = l.replace(/^\//, "").replace(/\/$/, "");
      return !existsSync(resolve(PUBLIC, rel + ".html")) && !existsSync(resolve(PUBLIC, rel));
    });
    expect(broken, `${file} links to missing ${broken.join(", ")}`).toEqual([]);
  });

  // og:image lives in a content attribute, so the href check above cannot see
  // it. A dead one still renders fine in a browser and only shows up as a blank
  // card on LinkedIn and WhatsApp, which is where most of these posts are read.
  it.each(posts)("%s points og:image at a file that exists", (file) => {
    const s = readFileSync(resolve(PUBLIC, file), "utf8");
    const img = /<meta property="og:image" content="([^"]+)"/.exec(s)?.[1];
    expect(img, `${file} has no og:image`).toBeTruthy();
    const rel = new URL(img!).pathname.replace(/^\//, "");
    expect(existsSync(resolve(PUBLIC, rel)), `${file} og:image missing: ${img}`).toBe(true);
  });

  it.each(posts)("%s styles itself from a stylesheet that exists", (file) => {
    // Relative hrefs escape the absolute-href check, so a typo'd stylesheet
    // path renders as an unstyled page instead of failing anything.
    const s = readFileSync(resolve(PUBLIC, file), "utf8");
    const sheets = [...s.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    expect(sheets.length, `${file} has no stylesheet`).toBeGreaterThan(0);
    for (const href of sheets) {
      const rel = href.replace(/^\//, "");
      expect(existsSync(resolve(PUBLIC, rel)), `${file} stylesheet missing: ${href}`).toBe(true);
    }
  });
});

describe("blog index and sitemap", () => {
  const index = readFileSync(resolve(PUBLIC, "blog.html"), "utf8");
  const sitemap = readFileSync(resolve(PUBLIC, "sitemap.xml"), "utf8");

  it("links only to posts that exist", () => {
    const linked = [...new Set([...index.matchAll(/href="(\/blog-[^"#?]*)"/g)].map((m) => m[1]))];
    expect(linked.length).toBeGreaterThan(5);
    for (const l of linked) {
      const rel = l.replace(/^\//, "");
      expect(existsSync(resolve(PUBLIC, rel + ".html")), `blog.html links to missing ${l}`).toBe(true);
    }
  });

  it("only lists sitemap URLs that exist", () => {
    // Match the path only: a bare /(\/[^<]+)/ would capture "//www.host/path"
    // because the origin itself contains slashes.
    const locs = [...new Set(
      [...sitemap.matchAll(/<loc>https:\/\/www\.gritandgigs\.in([^<]*)<\/loc>/g)].map((m) => m[1]),
    )];
    expect(locs.length).toBeGreaterThan(5);
    for (const l of locs) {
      const rel = l.replace(/^\//, "").replace(/\/$/, "");
      // The bare origin maps to index.html, not "public/.html".
      const file = rel === "" ? "index.html" : rel + ".html";
      expect(existsSync(resolve(PUBLIC, file)), `sitemap lists missing ${l}`).toBe(true);
    }
  });

  it("indexes a post in its sitemap", () => {
    // Any post linked from the index must also be discoverable.
    const linked = [...new Set([...index.matchAll(/href="(\/blog-[^"#?]*)"/g)].map((m) => m[1]))];
    const notMapped = linked.filter((l) => !sitemap.includes(`<loc>https://www.gritandgigs.in${l}</loc>`));
    expect(notMapped, `indexed but absent from sitemap: ${notMapped.join(", ")}`).toEqual([]);
  });
});