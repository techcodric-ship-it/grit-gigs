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
  it("keeps the header free of a search icon on a phone", () => {
    // The nav magnifier was removed from every page: on a phone the only
    // search is the bar on Explore, above the tabs it filters.
    const mobile = css().slice(css().indexOf("@media (max-width: 600px)"));
    expect(mobile).toMatch(/\.topnav \.searchwrap \{ display: none; \}/);
    expect(mobile).not.toMatch(/searching/);
    expect(mobile).not.toMatch(/background-image: url\("data:image\/svg/);
  });

  it("no longer renders the mobile cancel button", () => {
    for (const page of SEARCH_PAGES) {
      expect(html(page)).not.toContain("navSearchCancel");
      expect(html(page)).not.toContain("sb-cancel");
    }
    expect(css()).not.toContain(".sb-cancel");
    expect(app()).not.toContain("closeMobile");
  });

  it("lets the open panel win over the hidden-mobile rule", () => {
    // The nav wrap is display:none on a phone, but the Explore bar is not, so
    // its .open variant must still be able to show the dropdown.
    expect(css()).toMatch(/\.searchwrap\.open \.searchdrop \{\s*display:\s*block/);
  });
});

describe("nav search typeahead", () => {
  it("gives every page with a search box the dropdown it renders into", () => {
    for (const page of SEARCH_PAGES) {
      const s = html(page);
      expect(s.includes('id="navSearch"'), `${page} lost #navSearch`).toBe(true);
      expect(s.includes('class="searchwrap"'), `${page} has no .searchwrap`).toBe(true);
      expect(s.includes('id="navSearchDrop"'), `${page} has no dropdown`).toBe(true);
      expect(s.includes('role="combobox"'), `${page} combobox is not wired`).toBe(true);
      // Duplicate ids would make the dropdown ambiguous on the page.
      expect((s.match(/id="navSearchDrop"/g) || []).length, `${page} has duplicate dropdown ids`).toBe(1);
    }
  });

  it("responds while typing, not only on Enter", () => {
    const js = app();
    expect(js).toMatch(/function bindSearch\(/);
    expect(js).toMatch(/addEventListener\('input'/);
    // Debounced so a request is not fired per keystroke. The callback body
    // contains parens, so match the trailing delay rather than the arguments.
    const delay = js.match(/\.timer = setTimeout\([\s\S]*?\},\s*(\d+)\);/);
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
    expect(js).toMatch(/q\.length < 2[\s\S]{0,80}closeSearch\(f\)/);
    expect(js).toMatch(/!terms\.length && !posts\.length/);
  });

  it("ignores responses that arrive out of order while typing", () => {
    expect(app()).toMatch(/seq !== f\.seq/);
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
    ]) {
      expect(styles.includes(sel), `feed.css is missing ${sel}`).toBe(true);
    }
  });
});

describe("explore search sits above the filter tabs on mobile", () => {
  const explore = () => html("explore.html");

  it("puts the inline bar directly before the filter tabs", () => {
    const s = explore();
    const bar = s.indexOf('class="exploresearch"');
    const tabs = s.indexOf('class="ex-tabs"');
    expect(bar).toBeGreaterThan(-1);
    expect(tabs).toBeGreaterThan(bar);
    // Only the field's own markup may sit between them: no grid, no other card.
    const between = s.slice(bar, tabs);
    expect(between).not.toMatch(/id="grid"/);
    expect(between).not.toMatch(/class="card/);
    expect((between.match(/<input/g) || []).length).toBe(1);
  });

  it("gives the inline bar its own field, not a duplicate id", () => {
    const s = explore();
    expect(s).toContain('id="exploreSearch"');
    expect(s).toContain('id="exploreSearchDrop"');
    expect((s.match(/id="exploreSearch"/g) || []).length).toBe(1);
    expect((s.match(/id="exploreSearchDrop"/g) || []).length).toBe(1);
    // The nav field still exists for desktop.
    expect(s).toContain('id="navSearch"');
  });

  it("is marked so CSS can target Explore alone", () => {
    expect(explore()).toMatch(/<body class="explorepage">/);
  });

  it("shows only the Explore bar on a phone, and never on desktop", () => {
    const styles = css();
    expect(styles).toMatch(/\.exploresearch \{ display: none; \}/);
    const mobile = styles.slice(styles.indexOf("@media (max-width: 600px)"));
    expect(mobile).toMatch(/\.exploresearch \{ display: block;/);
    expect(mobile).toMatch(/body\.explorepage \.exploresearch \{ display: block;/);
  });

  it("gives the inline field the full column width", () => {
    const styles = css();
    const mobile = styles.slice(styles.indexOf("@media (max-width: 600px)"));
    expect(mobile).toMatch(/\.exploresearch \.searchwrap \{ width: 100%; max-width: none;/);
  });

  it("leaves no stray feed bar behind", () => {
    expect(html("feed.html")).not.toContain("feedsearch");
    expect(html("feed.html")).not.toContain("feedSearch");
    expect(html("feed.html")).not.toContain('class="feedpage"');
    expect(css()).not.toContain(".feedsearch");
  });

  it("binds both fields through the shared typeahead", () => {
    const js = app();
    expect(js).toMatch(/inputId: 'navSearch'/);
    expect(js).toMatch(/inputId: 'exploreSearch'/);
    expect(js).toMatch(/SEARCH_FIELDS\.forEach\(bindSearch\)/);
    // Separate state per field, so one cannot overwrite the other's results.
    expect(js).not.toMatch(/var searchState/);
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