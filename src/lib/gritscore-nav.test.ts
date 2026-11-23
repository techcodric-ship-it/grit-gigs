import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../public/${path}`, import.meta.url)), "utf8");
const html = (page: string) => read(page);
const css = () => read("assets/feed.css");

// On a phone the desktop sidebars are hidden, so the top-nav icon is the only
// route into GritScore. The edit-profile page (settings.html) has no sidebar at
// all, so it needs the icon at every width — including desktop.
const APP_PAGES = [
  "feed.html",
  "explore.html",
  "messages.html",
  "notifications.html",
  "orders.html",
  "wallet.html",
  "profile.html",
  "buy-more.html",
  "settings.html",
];

describe("GritScore top-nav link", () => {
  it.each(APP_PAGES)("%s has exactly one GritScore shortcut", (page) => {
    const source = html(page);
    const matches = source.match(/<a[^>]*class="gritscore-nav"[^>]*>/g) ?? [];
    expect(matches, `${page} is missing the GritScore nav icon`).toHaveLength(1);
    expect(matches[0]).toContain('href="/gritscore"');
    expect(matches[0]).toContain('aria-label="GritScore"');
  });

  it("never hides the shortcut on desktop (edit-profile has no sidebar)", () => {
    expect(css()).not.toMatch(/a\.gritscore-nav\s*\{\s*display:\s*none/);
  });

  it("shrinks the icon row so seven icons fit a 320px phone", () => {
    expect(css()).toMatch(/\.topnav \.icons \{ gap: 1px; \}/);
    expect(css()).toMatch(/\.topnav \.icons a \{ width: 34px; height: 34px; \}/);
  });
});

describe("GritScore New flag", () => {
  it("lives in the shared sidebars so it does not disappear on /gritscore", () => {
    expect(read("assets/app-left-sidebar.css")).toContain('.app-left-sidebar a[href="/gritscore"] .app-side-label::after');
    expect(read("assets/app-left-sidebar.css")).toMatch(/content:\s*"New";/);
    expect(read("assets/feed-sidebar.css")).toContain('.feed-left-sidebar a[href="/gritscore"] span:last-child::after');
    expect(read("assets/feed-sidebar.css")).toMatch(/content:\s*"New";/);
    expect(css()).not.toContain('a[href="/gritscore"]');
  });

  it("shows a compact flag in the GritScore header when the sidebar is hidden", () => {
    expect(html("gritscore/index.html")).toContain('<span class="gs-new-flag">New</span>');
    expect(read("assets/gritscore.css")).toContain(".gs-new-flag {");
    expect(read("assets/gritscore.css")).toMatch(/\.gs-new-flag[\s\S]{0,260}font-size: 8px/);
    expect(read("assets/gritscore.css")).toMatch(/@media \(min-width: 1000px\) \{\s*\.gs-new-flag \{ display: none; \}/);
  });
});
