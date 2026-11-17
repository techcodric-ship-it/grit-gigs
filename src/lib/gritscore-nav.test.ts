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
