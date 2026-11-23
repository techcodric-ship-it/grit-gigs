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
const FEED_PAGE = file("public/feed.html");

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
    expect(FEED_APP).toMatch(/<video class="clip-player" controls muted loop playsinline preload="metadata"/);
    expect(FEED_APP).toMatch(/<source src="' \+ esc\(clipSrc\(med\.url\)\) \+ '" type="' \+ mime \+ '">/);
    expect(FEED_APP).toContain("function clipSrc(u) { return /#/.test(u) ? u : u + '#t=0.1'; }");
    expect(FEED_APP).toMatch(/kind-stamp">CLIP/);
    expect(FEED_APP).not.toMatch(/data-vsrc/);
    expect(FEED_APP).not.toMatch(/kind-stamp">REEL/);
  });

  it("starts visible clips muted instead of waiting for a click", () => {
    expect(FEED_APP).toMatch(/function startClip\(video\)[\s\S]{0,200}video\.play\(\)/);
    expect(FEED_APP).toMatch(/new IntersectionObserver\(function \(entries\)/);
    expect(FEED_APP).toMatch(/rootMargin: '160px 0px', threshold: 0\.35/);
    expect(FEED_APP).toMatch(/dataset\.userPaused/);
  });

  it("counts a view once per browser session on play and detail open", () => {
    expect(FEED_APP).toMatch(/function watchClip\(video, postId\)[\s\S]{0,240}notePostView\(postId\)/);
    expect(FEED_APP).toMatch(/watchClip\(player, p\.id\)/);
    expect(FEED_APP).toMatch(/function openPost\(postId\)[\s\S]{0,200}notePostView\(postId\)/);
    expect(FEED_APP).toMatch(/viewCountPromise\.then\(function \(n\) \{ if \(n !== null\) patchViewCount\(postId, n\); \}\)/);
    expect(FEED_APP).toMatch(/sessionStorage\.setItem\(key, String\(Date\.now\(\) \+ 30 \* 60 \* 1000\)\)/);
  });

  it("counts a real feed impression once a card is meaningfully visible", () => {
    expect(FEED_APP).toContain("function renderPost(row, opts)");
    expect(FEED_APP).toContain("watchImpression(el, p.id, opts)");
    expect(FEED_APP).toContain("function watchImpression(card, postId, opts)");
    expect(FEED_APP).toContain("notePostView(e.target.dataset.id)");
    expect(FEED_APP).toContain("rootMargin: '0px 0px -10% 0px', threshold: 0.3");
    expect(FEED_PAGE).toContain("c.renderPost(row, { countImpression: true })");
    expect(FEED_PAGE).toContain("c.renderPost(r.d.data, { countImpression: true })");
    expect(FEED_APP).toContain("containerEl.appendChild(renderPost(r.d.data));");
  });

  it("stores and returns view counts", () => {
    expect(SCHEMA).toMatch(/viewCount: integer\("view_count"\)\.default\(0\)\.notNull\(\)/);
    expect(INDEX).toMatch(/view_count INTEGER DEFAULT 0 NOT NULL/);
    expect(INDEX).toMatch(/ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0 NOT NULL/);
    expect(COMMUNITY).toMatch(/router\.post\("\/community\/posts\/:id\/view", optionalAuth/);
    expect(COMMUNITY).toMatch(/set\(\{ viewCount: sql`\$\{communityPostsTable\.viewCount\} \+ 1` \}\)/);
    expect(COMMUNITY).toContain("views: sql<number>`COALESCE(SUM(GREATEST(${communityPostsTable.viewCount}, CASE WHEN ${communityPostsTable.likeCount} > 0 THEN ${communityPostsTable.likeCount} + 1 ELSE 0 END)), 0)`");
  });

  it("keeps views ahead of likes on older posts", () => {
    expect(COMMUNITY).toContain("function visibleViewCount");
    expect(COMMUNITY).toContain("post: { ...post, viewCount: visibleViewCount(post) }");
    expect(COMMUNITY).toContain("GREATEST(${communityPostsTable.viewCount}, CASE WHEN ${communityPostsTable.likeCount} > 0 THEN ${communityPostsTable.likeCount} + 1 ELSE 0 END)");
    expect(INDEX).toContain("UPDATE community_posts");
    expect(INDEX).toContain("SET view_count = GREATEST(view_count, like_count + 1)");
    expect(INDEX).toContain("WHERE like_count > 0 AND view_count < like_count + 1");
  });

  it("shows a polished view metric with matching SVG stat icons", () => {
    expect(FEED_APP).toContain('var HEART_ICON = \'<span class="i"><svg');
    expect(FEED_APP).toContain('var COMMENT_ICON = \'<span class="i"><svg');
    expect(FEED_APP).toContain('var EYE_ICON = \'<span class="i"><svg');
    expect(FEED_APP).toContain('var SHARE_ICON = \'<span class="i"><svg');
    expect(FEED_APP).toContain("' + HEART_ICON + '<span class=\"c\">'");
    expect(FEED_APP).toContain("' + COMMENT_ICON + '<span class=\"c\">'");
    expect(FEED_APP).toContain("' + EYE_ICON + '<span class=\"v\" data-view-count=\"'");
    expect(FEED_APP).toContain('<span class=\"lbl\">views</span>');
    expect(FEED_APP).toContain("' + SHARE_ICON + '</button>'");
    expect(FEED_APP).not.toContain(">◉<");
    expect(FEED_APP).not.toContain(">♥<");
    expect(FEED_APP).not.toContain(">💬<");
  });

  it("shows view counts on feed and profile/explore tiles", () => {
    expect(PROFILE).toContain("var TILE_EYE = '<span class=\"i\"><svg");
    expect(EXPLORE).toContain("var TILE_EYE = '<span class=\"i\"><svg");
    expect(PROFILE).toContain("' + TILE_HEART + '<b>'");
    expect(EXPLORE).toContain("' + TILE_COMMENT + '<b>'");
    expect(PROFILE).toMatch(/tile-stats[\s\S]{0,620}<b data-view-count=/);
    expect(EXPLORE).toMatch(/tile-stats[\s\S]{0,620}<b data-view-count=/);
    expect(PROFILE).toMatch(/<b id="pViews">0<\/b>views/);
    expect(PROFILE).toMatch(/\$\('pViews'\)\.textContent = d\.views/);
    expect(PROFILE).toContain(".tile[data-post-id=\"' + postId + '\"] .tile-stats");
    expect(PROFILE).toMatch(/c\.patchViewCount\(postId, nn\.viewCount\)/);
    expect(PROFILE).toContain("':scope > .tstat > b'");
    expect(FEED_CSS).toMatch(/\.card-actions \.views \{[^}]*border-radius: 9px/);
    expect(FEED_CSS).toMatch(/\.card-actions \.views \{[^}]*background: linear-gradient/);
    expect(FEED_CSS).toMatch(/\.grid \.tile \.tile-stats \{[^}]*backdrop-filter: blur\(8px\)/);
    expect(FEED_CSS).toMatch(/font-variant-numeric: tabular-nums/);
  });

  it.each(CACHE_PAGES)("%s busts the feed asset cache", (page) => {
    const s = file(`public/${page}`);
    expect(s).toMatch(/feed\.css\?v=46/);
    expect(s).toMatch(/feed-app\.js\?v=45/);
    expect(s).not.toMatch(/feed\.css\?v=45/);
    expect(s).not.toMatch(/feed-app\.js\?v=44/);
  });
});
