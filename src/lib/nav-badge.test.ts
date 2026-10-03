import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// The unread counters in the top bar (messages, notifications) are the only
// nav element whose styling depends on the PARENT anchor, because feed.css
// scopes the pill to ".badge .cnt". An anchor missing class="badge" still
// renders the number correctly as far as the DOM is concerned, so nothing
// throws and no test used to notice - it just showed up as a large bare
// digit sitting next to the icon.

const ROOT = resolve(__dirname, "..", "..");
const html = (p: string) => readFileSync(resolve(ROOT, "public", p), "utf8");
const css = () => readFileSync(resolve(ROOT, "public", "assets", "feed.css"), "utf8");

// Every page that renders the top-bar icon row.
const PAGES = [
  "buy-more.html",
  "explore.html",
  "feed.html",
  "messages.html",
  "notifications.html",
  "orders.html",
  "profile.html",
  "settings.html",
  "wallet.html",
];

const openTags = (s: string) => [...s.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);

// Quote-aware: splits a tag's attributes without being fooled by a value that
// itself contains spaces or slashes, e.g. title="Grit&Gigs home".
const classList = (tag: string) => {
  const m = /\bclass\s*=\s*"([^"]*)"/.exec(tag);
  return m ? m[1].trim().split(/\s+/).filter(Boolean) : [];
};

describe("nav unread badges", () => {
  it("ships the .badge .cnt rule the counters rely on", () => {
    expect(css()).toMatch(/\.badge\s*\{[^}]*position:\s*relative/);
    expect(css()).toMatch(/\.badge \.cnt\s*\{[^}]*position:\s*absolute/);
  });

  it.each(PAGES)("%s puts every .cnt inside a .badge anchor", (page) => {
    const anchors = [...html(page).matchAll(/<a\b[^>]*>(?:(?!<\/a>).)*?<\/a>/gs)]
      .map((m) => m[0])
      .filter((a) => a.includes('class="cnt"'));
    expect(anchors.length, `${page} has no .cnt badge to check`).toBeGreaterThan(0);
    for (const a of anchors) {
      const open = /^<a\b[^>]*>/.exec(a)![0];
      expect(classList(open), `${page}: ${open}`).toContain("badge");
    }
  });

  it.each(PAGES)("%s never repeats the class attribute on one anchor", (page) => {
    // A naive insert of class="badge" into an anchor that already had a class
    // produces two class attributes. The browser keeps only the first and
    // drops the rest, so the badge goes unstyled while the markup still
    // "contains" class="badge".
    for (const tag of openTags(html(page))) {
      expect((tag.match(/\bclass\s*=/g) ?? []).length, `${page}: ${tag}`).toBeLessThanOrEqual(1);
    }
  });

  it.each(PAGES)("%s has well-formed anchor tags", (page) => {
    // Merging two class attributes with a regex can tear the tag apart and
    // leave an orphan fragment such as `on"` with no attribute name. No other
    // test parses these tags, so the active-tab highlight would just stop
    // rendering with a green build. Accepts quoted values, single-quoted
    // values, unquoted values and boolean attributes; rejects stray fragments.
    const wellFormed =
      /^<a(?:\s+[a-zA-Z][\w-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*>$/;
    for (const tag of openTags(html(page))) {
      expect(tag, `${page}: malformed anchor ${tag}`).toMatch(wellFormed);
    }
  });

  it.each(PAGES)("%s keeps the active tab's highlight class", (page) => {
    // messages.html and notifications.html mark their own nav tab with "on".
    const self = page === "messages.html"
      ? 'href="/messages.html"'
      : page === "notifications.html"
        ? 'href="/notifications.html"'
        : null;
    if (!self) return;
    const tag = openTags(html(page)).find((t) => t.includes(self));
    expect(classList(tag!), `${page} lost its active-tab class`).toContain("on");
    expect(classList(tag!), `${page} active tab must still carry badge`).toContain("badge");
  });

  it.each(["msgBadge", "notifBadge"])("%s exists and starts hidden", (id) => {
    for (const page of PAGES) {
      const el = new RegExp(`<span[^>]*id="${id}"[^>]*>`).exec(html(page))?.[0];
      expect(el, `${page} is missing #${id}`).toBeTruthy();
      expect(el, `${page} #${id} would flash a 0 before the fetch resolves`).toContain("display:none");
    }
  });

  it.each(PAGES)("%s loads the stylesheet that styles the badges", (page) => {
    expect(html(page)).toMatch(/<link[^>]*href="\/assets\/feed\.css\?v=\d+"/);
  });

  it("pins a single feed.css version across every page that loads it", () => {
    // The badge pill only appears once the browser refetches feed.css. One page
    // left on an older ?v= keeps serving cached CSS against the new markup, so
    // that page alone still shows the bare digit. Scanning the whole directory
    // rather than a hand-kept list, because the page that gets missed is
    // exactly the one nobody remembered to include.
    const dir = resolve(ROOT, "public");
    const versions = new Map<string, string[]>();
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".html"))) {
      const v = html(f).match(/feed\.css\?v=(\d+)/)?.[1];
      if (!v) continue;
      versions.set(v, [...(versions.get(v) ?? []), f]);
    }
    expect(versions.size, `mixed feed.css versions: ${JSON.stringify([...versions])}`).toBe(1);
  });
});