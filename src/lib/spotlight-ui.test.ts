import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The Spotlight explainer page shipped laid out sideways because it defined a
// `.wrap` class and feed.css also defines `.wrap` as a flex row. Nothing in the
// test suite or the deploy script looked at CSS, so a 200 response and a green
// build both said "fine". These tests treat the static pages as part of the
// product: a collision or a stale cache-buster is a build failure.

const ROOT = resolve(__dirname, "..", "..");
const html = (p: string) => readFileSync(resolve(ROOT, "public", p), "utf8");
const css = () => readFileSync(resolve(ROOT, "public", "assets", "feed.css"), "utf8");

const FEED_PAGES = [
  "feed.html",
  "profile.html",
  "explore.html",
  "spotlight-boost.html",
  "buy-more.html",
  "messages.html",
  "notifications.html",
  "orders.html",
  "settings.html",
  "wallet.html",
];

// Selectors defined outside any scoped wrapper. feed.css is a global
// stylesheet, so anything a page adds under one of these names silently
// inherits whatever feed.css already decided.
function stripComments(cssText: string): string {
  return cssText.replace(/\/\*[\s\S]*?\*\//g, "");
}

function styleBlocks(source: string): string[] {
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => stripComments(m[1]));
}

function unscopedClasses(source: string): Set<string> {
  const out = new Set<string>();
  for (const cssText of styleBlocks(source)) {
    for (const m of cssText.matchAll(/(^|[},])\s*\.([a-zA-Z][\w-]*)\s*[,{]/g)) {
      out.add(m[2]);
    }
  }
  return out;
}

function feedCssClasses(): Set<string> {
  const out = new Set<string>();
  for (const m of css().matchAll(/(^|[},])\s*\.([a-zA-Z][\w-]*)\s*[,{]/g)) out.add(m[2]);
  return out;
}

describe("static page CSS isolation", () => {
  it("the explainer page defines no class that feed.css also defines", () => {
    // This is the exact bug: both sides owned ".wrap".
    const collide = [...unscopedClasses(html("spotlight-boost.html"))].filter((c) =>
      feedCssClasses().has(c),
    );
    expect(collide).toEqual([]);
  });

  it("the explainer page wraps every rule in its own namespace", () => {
    const blocks = styleBlocks(html("spotlight-boost.html"));
    expect(blocks.length).toBeGreaterThan(0);
    // Comments are stripped first: they name the classes that used to collide,
    // and they are documentation rather than selectors.
    for (const rule of blocks.join("\n").matchAll(/(^|[};])\s*([^{};@]+?)\s*\{/g)) {
      const selector = rule[2].trim();
      if (selector.startsWith("@")) continue;
      expect(selector.startsWith(".sboost")).toBe(true);
    }
  });

  it("the explainer page resets display on its own wrapper", () => {
    // Belt and braces: if someone reintroduces flex here the page dies sideways
    // again, and this catches it even if the class name is unique.
    expect(html("spotlight-boost.html")).toMatch(/\.sboost\s*\{[^}]*display:\s*block/);
  });
});

describe("Spotlight markup hooks", () => {
  it("reads gig text from content, because community_posts has no title", () => {
    // `p.title` is always undefined here and rendered as "Untitled".
    const profile = html("profile.html");
    expect(profile).toContain("p.content");
    expect(profile).not.toMatch(/p\.title\s*\|\|\s*'/);
  });

  it("gives every profile row a text column and a button column", () => {
    const profile = html("profile.html");
    expect(profile).toContain('class="psp-main"');
    expect(profile).toContain('class="psp-meta"');
    expect(profile).toContain('class="psp-chip"');
  });

  it("ships CSS for every Spotlight class the pages reference", () => {
    // A renamed class in markup with no matching rule renders unstyled, which
    // is how the old panel looked misaligned.
    const styles = css();
    const needed = [
      ".pspot-head",
      ".pspot-eyebrow",
      ".pspot-title",
      ".pspot-more",
      ".psp-row",
      ".psp-main",
      ".psp-name",
      ".psp-meta",
      ".psp-chip",
      ".psp-live",
      ".psp-btn",
      ".spcard-eyebrow",
      ".spcard-title",
      ".spcard-sub",
      ".spcard-stat",
      ".spcard-prices",
      ".spcard-cta",
      ".spcard-more",
      ".spot-demand",
      ".spot-demand-box",
    ];
    for (const sel of needed) {
      expect(styles.includes(sel), `feed.css is missing ${sel}`).toBe(true);
    }
  });

  it("has left no dead selectors from earlier iterations", () => {
    // Removed when the cards were rebuilt; keeping them invites reuse-by-accident.
    const styles = css();
    for (const dead of [".psp-txt", ".psp-kind", ".psp-stats", ".spc-body", ".spc-prices", ".spc-cta", ".spot-promo-card"]) {
      expect(styles.includes(dead), `dead selector ${dead} is still in feed.css`).toBe(false);
    }
  });
});

describe("asset cache versioning", () => {
  it("points every feed page at the same feed.css version", () => {
    // One page left behind serves old CSS against new markup and looks broken.
    const versions = new Map<string, string[]>();
    for (const page of FEED_PAGES) {
      const v = html(page).match(/feed\.css\?v=(\d+)/)?.[1];
      expect(v, `${page} does not pin a feed.css version`).toBeTruthy();
      versions.set(v!, [...(versions.get(v!) ?? []), page]);
    }
    expect(versions.size).toBe(1);
  });

  it("points every feed page at the same feed-app.js version", () => {
    const versions = new Set(
      FEED_PAGES.map((page) => html(page).match(/feed-app\.js\?v=(\d+)/)?.[1]),
    );
    expect([...versions].filter(Boolean).length).toBe(1);
  });
});

describe("Spotlight honesty", () => {
  it("states plainly that views and leads are not guaranteed", () => {
    const boost = html("spotlight-boost.html");
    expect(boost).toMatch(/No guaranteed view/i);
    expect(boost).toMatch(/No guaranteed leads/i);
    expect(boost).toMatch(/reaches no one/i);
  });

  it("never turns a disclaimer into a promise", () => {
    // "No guaranteed views" is a disclaimer and must stay allowed; what must
    // never appear is a number attached to a guarantee.
    const boost = html("spotlight-boost.html");
    expect(boost).not.toMatch(/guarantee[sd]?\s+\d/i);
    expect(boost).not.toMatch(/\d+\s*\+?\s*(views?|reach|reached|opens?|clicks?|leads?)\s+(every|guaranteed)/i);
    expect(boost).not.toMatch(/\bup to \d+\s*\+?\s*(views?|leads?)/i);
  });

  it("prices the packs exactly as the server charges", () => {
    const boost = html("spotlight-boost.html");
    expect(boost).toContain("&#8377;50");
    expect(boost).toContain("&#8377;199");
    expect(boost).toContain("&#8377;499");
  });

  it("shows an honest zero instead of a fabricated number", () => {
    const feed = html("feed.html");
    expect(feed).toContain("Post a gig first");
    expect(feed).toContain("Check the number before you pay");
  });
});
