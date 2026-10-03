import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Three bugs are guarded here, all of which were invisible to HTTP checks:
//  1. mobile had no search at all, because a media query set display:none and
//     nothing replaced it;
//  2. the nav search had no typeahead at all, only an Enter key handler, so
//     nothing happened while typing;
//  3. the typeahead's visibility was set with an inline style as well as a
//     class, so Escape cleared the class and left the panel stuck open.

const ROOT = resolve(__dirname, "..", "..");
const html = (p: string) => readFileSync(resolve(ROOT, "public", p), "utf8");
const css = () => readFileSync(resolve(ROOT, "public", "assets", "feed.css"), "utf8");
const app = () => readFileSync(resolve(ROOT, "public", "assets", "feed-app.js"), "utf8");
const route = () => readFileSync(resolve(ROOT, "src", "routes", "community.ts"), "utf8");

const SEARCH_PAGES = [
  "feed.html",
  "explore.html",
  "notifications.html",
  "profile.html",
  "orders.html",
  "wallet.html",
  "settings.html",
  "buy-more.html",
];

describe("mobile search is reachable", () => {
  it("never hides the nav search behind display:none", () => {
    // This is what made mobile search vanish. The field now collapses to a
    // 34px magnifier and expands on focus.
    const hidden = [...css().matchAll(/\.topnav\s+\.searchbox\s*\{([^}]*)\}/g)].filter((m) =>
      /display:\s*none/.test(m[1]),
    );
    expect(hidden).toEqual([]);
  });

  it("collapses to a magnifier on small screens instead of disappearing", () => {
    const mobile = css().slice(css().indexOf("@media (max-width: 600px)"));
    expect(mobile).toMatch(/\.topnav\.searching/);
    expect(mobile).toMatch(/\.searchwrap\s*\{[^}]*width:\s*34px/);
  });

  it("shows the magnifier glyph while collapsed", () => {
    expect(css()).toMatch(/background-image:\s*url\("data:image\/svg\+xml[^)]*circle/);
  });

  it("lets the open panel win over the collapsed-mobile rule", () => {
    // Both rules are in the same media query; without the .open variant the
    // dropdown would never appear on mobile.
    expect(css()).toMatch(/\.topnav\.searching \.searchwrap\.open \.searchdrop\s*\{\s*display:\s*block/);
  });

  it("breaks out of search mode on Escape", () => {
    expect(app()).toMatch(/e\.key === 'Escape'[\s\S]{0,200}closeMobile\(\)/);
  });
});

describe("nav search typeahead", () => {
  it("gives every page with a search box the dropdown it renders into", () => {
    for (const page of SEARCH_PAGES) {
      const s = html(page);
      expect(s.includes('id="navSearch"'), `${page} lost #navSearch`).toBe(true);
      expect(s.includes('class="searchwrap"'), `${page} has no .searchwrap`).toBe(true);
      expect(s.includes('id="navSearchDrop"'), `${page} has no dropdown`).toBe(true);
      expect(s.includes('id="navSearchCancel"'), `${page} has no cancel button`).toBe(true);
      expect(s.includes('role="combobox"'), `${page} combobox is not wired`).toBe(true);
      // Duplicate ids would make the dropdown ambiguous on the page.
      expect((s.match(/id="navSearchDrop"/g) || []).length, `${page} has duplicate dropdown ids`).toBe(1);
    }
  });

  it("responds while typing, not only on Enter", () => {
    const js = app();
    expect(js).toMatch(/navSearch[\s\S]{0,4000}addEventListener\('input'/);
    // Debounced so a request is not fired per keystroke. The callback body
    // contains parens, so match the trailing delay rather than the arguments.
    const delay = js.match(/searchState\.timer = setTimeout\([\s\S]*?\},\s*(\d+)\);/);
    expect(delay, "typeahead must be debounced").not.toBeNull();
    expect(Number(delay![1])).toBeGreaterThan(0);
    expect(Number(delay![1])).toBeLessThanOrEqual(400);
  });

  it("keeps panel visibility in the class, never in an inline style", () => {
    // An inline display outranks the .open class, so Escape cleared the class
    // and left the panel stuck open.
    expect(app()).not.toMatch(/drop\.style\.display/);
  });

  it("stays silent under two characters and when nothing matches", () => {
    const js = app();
    expect(js).toMatch(/q\.length < 2[\s\S]{0,80}closeSearch\(\)/);
    expect(js).toMatch(/!terms\.length && !posts\.length/);
  });

  it("ignores responses that arrive out of order while typing", () => {
    expect(app()).toMatch(/seq !== searchState\.seq/);
  });

  it("ships CSS for every class the dropdown renders", () => {
    const styles = css();
    for (const sel of [
      ".searchdrop",
      ".sd-group",
      ".sd-row",
      ".sd-ic",
      ".sd-ic-term",
      ".sd-ic-gig",
      ".sd-ic-proj",
      ".sd-txt",
      ".sd-all",
      ".sb-cancel",
    ]) {
      expect(styles.includes(sel), `feed.css is missing ${sel}`).toBe(true);
    }
  });
});

describe("suggestions endpoint", () => {
  it("never writes to search_logs", () => {
    // A typeahead fires one request per few keystrokes. Logging them would
    // record "w", "we", "web" as real searches and inflate the Spotlight
    // demand numbers that are sold to sellers.
    const src = route();
    const start = src.indexOf('"/community/search/suggest"');
    expect(start).toBeGreaterThan(-1);
    // Bound the slice at the next route: the feed handler below it does log.
    const next = src.indexOf("router.get(", start + 10);
    const block = src.slice(start, next > start ? next : start + 4000);
    expect(block).not.toMatch(/searchLogsTable/);
    expect(block).not.toMatch(/\.insert\(/);
  });

  it("escapes LIKE metacharacters instead of interpolating raw input", () => {
    expect(src_hasLikeHelper()).toBe(true);
    expect(route()).toMatch(/likeTerm\(q\)/);
  });
});

function src_hasLikeHelper(): boolean {
  const lib = readFileSync(resolve(ROOT, "src", "lib", "search-suggest.ts"), "utf8");
  return /export function likeTerm/.test(lib) && /\\\\%/.test(lib);
}