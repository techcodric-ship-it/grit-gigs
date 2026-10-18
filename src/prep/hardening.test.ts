// Phase 10 hardening regressions: link-scheme safety, parser robustness,
// noindex coverage, denylist completeness, and render-sink discipline.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseNewsRss } from "./sources/news";
import { SOURCE_DENYLIST, isDeniedHost } from "./sources/urls";

const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const PREP_PAGES = [
  "public/prep/index.html",
  "public/prep/report.html",
  "public/prep/aptitude.html",
  "public/prep/interview.html",
  "public/prep/proof.html",
];

function rss(link: string, date = "Mon, 05 Jan 2026 10:00:00 GMT"): string {
  return `<rss><channel><item><title><![CDATA[Headline]]></title><link>${link}</link><pubDate>${date}</pubDate><source url="https://example.com">Example</source></item></channel></rss>`;
}

describe("news parser hardening", () => {
  it("keeps http(s) links", () => {
    expect(parseNewsRss(rss("https://news.example.com/a"))).toHaveLength(1);
    expect(parseNewsRss(rss("http://news.example.com/a"))).toHaveLength(1);
  });
  it("drops javascript:, data:, mailto: and relative links (href-scheme defence)", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>x</script>",
      "mailto:a@b.c",
      "/relative/story",
      "vbscript:x",
    ]) {
      expect(parseNewsRss(rss(bad)), bad).toHaveLength(0);
    }
  });
  it("never throws on hostile/garbage pubDate (invalid -> undefined)", () => {
    const items = parseNewsRss(rss("https://n.example.com/a", "not a date"));
    expect(items).toHaveLength(1);
    expect(items[0]!.publishedAt).toBeUndefined();
    expect(() => parseNewsRss(rss("https://n.example.com/a", "<script>"))).not.toThrow();
    const empty = parseNewsRss(rss("https://n.example.com/a", ""));
    expect(empty[0]!.publishedAt).toBeUndefined();
  });
});

describe("report page link/render safety", () => {
  const page = read("public/prep/report.html");
  it("defines an href scheme guard and uses it at every external-link sink", () => {
    expect(page).toContain("function safeUrl(");
    expect(page).toMatch(/function safeUrl\(u\) \{\s*\n\s*return \/\^https\?:\\\/\\\/\//);
    const bareEscHrefs = page.match(/href="' \+ esc\((?!safeUrl)/g) ?? [];
    const guardedHrefs = page.match(/href="' \+ esc\(safeUrl\(/g) ?? [];
    expect(guardedHrefs.length).toBeGreaterThanOrEqual(2);
    expect(bareEscHrefs.length).toBe(0);
  });
  it("user/server strings hit textContent sinks, not HTML, for name/role/summary", () => {
    expect(page).toContain('getElementById("rpName").textContent');
    expect(page).toContain('getElementById("rpMeta").textContent');
    expect(page).toContain('getElementById("rpSummary").textContent');
    expect(page).not.toMatch(/rpName"\)\.innerHTML/);
    expect(page).not.toMatch(/rpMeta"\)\.innerHTML/);
  });
});

describe("noindex + crawl surface", () => {
  it("every prep page carries the meta robots noindex tag", () => {
    for (const p of PREP_PAGES) {
      expect(read(p), p).toContain('<meta name="robots" content="noindex"/>');
    }
  });
  it("server sets X-Robots-Tag on both prep serving branches", () => {
    const pages = read("src/prep/pages.ts");
    expect((pages.match(/X-Robots-Tag/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(pages).toContain('"X-Robots-Tag", "noindex"');
  });
  it("robots.txt disallows /prep/ and the sitemap never lists it", () => {
    expect(read("public/robots.txt")).toContain("Disallow: /prep/");
    expect(read("public/sitemap.xml")).not.toContain("/prep");
  });
  it("flag-off serving keeps prep invisible (302 to /feed before any file IO)", () => {
    const pages = read("src/prep/pages.ts");
    const offIdx = pages.indexOf("if (!isPrepEnabled())");
    expect(offIdx).toBeGreaterThan(-1);
    expect(pages.slice(offIdx, offIdx + 200)).toContain("res.redirect(302, \"/feed\")");
    expect(offIdx).toBeLessThan(pages.indexOf("fs.existsSync"));
  });
});

describe("esc() discipline across prep pages", () => {
  it("all five pages define the esc() helper", () => {
    for (const p of PREP_PAGES) {
      expect(read(p), p).toContain("function esc(");
    }
  });
  it("aggregates lists escape role and college labels (from member payloads)", () => {
    const page = read("public/prep/report.html");
    expect(page).toContain("esc(r.role)");
    expect(page).toContain("esc(c.college)");
  });
});

describe("source denylist completeness", () => {
  it("all six barred brands are present", () => {
    for (const d of [
      "glassdoor.com",
      "ambitionbox.com",
      "linkedin.com",
      "indeed.com",
      "naukri.com",
      "monster.com",
    ]) {
      expect(SOURCE_DENYLIST, d).toContain(d);
    }
  });
  it("suffix matching blocks lookalike subdomains", () => {
    expect(isDeniedHost("jobs.glassdoor.com")).toBe(true);
    expect(isDeniedHost("in.indeed.com")).toBe(true);
    expect(isDeniedHost("careers.example.com")).toBe(false);
  });
});

describe("quota + abuse surface", () => {
  const router = read("src/prep/router.ts");
  it("report role input stays length-capped server-side", () => {
    expect(router).toMatch(/role: z\.string\(\)\.max\(120\)/);
  });
  it("every mutating prep endpoint is rate-limited", () => {
    expect(router).toMatch(/post\("\/reports", authenticate, reportLimiter/);
    expect(router).toMatch(/post\("\/companies", authenticate, createCompanyLimiter/);
    expect(router).toMatch(/post\("\/aptitude\/submit", aptitudeLimiter/);
    expect(router).toMatch(/post\("\/interview\/mock\/submit", interviewLimiter/);
    expect(router).toMatch(/post\("\/proof", authenticate, proofSubmitLimiter/);
    expect(router).toMatch(/post\("\/pro\/purchase", authenticate, purchaseLimiter/);
  });
  it("aggregates endpoints are rate-limited too", () => {
    expect(router).toMatch(/get\("\/companies\/:slug\/pay-aggregates", aggregateLimiter/);
    expect(router).toMatch(/get\("\/companies\/:slug\/placement-aggregates", aggregateLimiter/);
  });
});
