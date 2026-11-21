import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const file = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const FEED_APP = file("public/assets/feed-app.js");
const FEED_CSS = file("public/assets/feed.css");
const COMMUNITY = file("src/routes/community.ts");
const SCHEMA = file("src/db/schema/community.ts");
const INDEX = file("src/index.ts");
const PROFILE = file("public/profile.html");
const EXPLORE = file("public/explore.html");

const CACHE_PAGES = [
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

describe("clip rendering and post views", () => {
  it("labels a REEL-backed clip as CLIP and plays the real video", () => {
    expect(FEED_APP).toMatch(/REEL:\s*'CLIP'/);
    expect(FEED_APP).toMatch(/<video src="' \+ esc\(med\.url\) \+ '" controls playsinline preload="metadata"/);
    expect(FEED_APP).toMatch(/kind-stamp">CLIP/);
    expect(FEED_APP).not.toMatch(/data-vsrc/);
    expect(FEED_APP).not.toMatch(/kind-stamp">REEL/);
  });

  it("counts a view once per browser session on play and detail open", () => {
    expect(FEED_APP).toMatch(/addEventListener\('play', function \(\) \{ notePostView\(p\.id\); \}, \{ once: true \}\)/);
    expect(FEED_APP).toMatch(/function openPost\(postId\)[\s\S]{0,200}notePostView\(postId\)/);
    expect(FEED_APP).toMatch(/viewCountPromise\.then\(function \(n\) \{ if \(n !== null\) patchViewCount\(postId, n\); \}\)/);
    expect(FEED_APP).toMatch(/sessionStorage\.setItem\(key, String\(Date\.now\(\) \+ 30 \* 60 \* 1000\)\)/);
  });

  it("stores and returns view counts", () => {
    expect(SCHEMA).toMatch(/viewCount: integer\("view_count"\)\.default\(0\)\.notNull\(\)/);
    expect(INDEX).toMatch(/view_count INTEGER DEFAULT 0 NOT NULL/);
    expect(INDEX).toMatch(/ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0 NOT NULL/);
    expect(COMMUNITY).toMatch(/router\.post\("\/community\/posts\/:id\/view", optionalAuth/);
    expect(COMMUNITY).toMatch(/set\(\{ viewCount: sql`\$\{communityPostsTable\.viewCount\} \+ 1` \}\)/);
    expect(COMMUNITY).toMatch(/views: sql<number>`COALESCE\(SUM\(\$\{communityPostsTable\.viewCount\}\), 0\)`/);
  });

  it("shows view counts in the feed and on profile/explore tiles", () => {
    expect(FEED_APP).toMatch(/class="views" title="Views">◉<span class="v" data-view-count=/);
    expect(PROFILE).toMatch(/<b id="pViews">0<\/b>views/);
    expect(PROFILE).toMatch(/\$\('pViews'\)\.textContent = d\.views/);
    expect(PROFILE).toMatch(/tile-stats[\s\S]{0,220}data-view-count=/);
    expect(EXPLORE).toMatch(/tile-stats[\s\S]{0,220}data-view-count=/);
    expect(FEED_CSS).toMatch(/\.card-actions \.views/);
    expect(FEED_CSS).toMatch(/\.grid \.tile \.tile-stats/);
  });

  it.each(CACHE_PAGES)("%s busts the feed asset cache", (page) => {
    const s = file(`public/${page}`);
    expect(s).toMatch(/feed\.css\?v=42/);
    expect(s).toMatch(/feed-app\.js\?v=42/);
    expect(s).not.toMatch(/feed\.css\?v=41/);
    expect(s).not.toMatch(/feed-app\.js\?v=41/);
  });
});
