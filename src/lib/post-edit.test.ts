import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// A gig posted without keywords could not be corrected: the composer only sends
// tags when creating, the boost modal's keyword picker only sets boost targets,
// and no route updated a post. The only remedy was delete and repost, which
// loses the likes and comments on it.
//
// PUT /community/posts/:id closes that. These tests are source-level, matching
// the rest of this suite, because there is no route harness to drive a request
// through. The guards are asserted structurally: the ownership check and the
// field whitelist are the two things that would be easy to drop by accident.

const ROOT = resolve(__dirname, "..", "..");
const routes = readFileSync(resolve(ROOT, "src", "routes", "community.ts"), "utf8");
const feedJs = readFileSync(resolve(ROOT, "public", "assets", "feed-app.js"), "utf8");
const feedHtml = readFileSync(resolve(ROOT, "public", "feed.html"), "utf8");

function routeBlock(name: string): string {
  const start = routes.indexOf(name);
  expect(start, `${name} not found in community.ts`).toBeGreaterThan(-1);
  // The next route declaration ends this handler.
  const end = routes.indexOf("\n  router.", start + 10);
  return routes.slice(start, end === -1 ? routes.length : end);
}

describe("PUT /community/posts/:id", () => {
  const block = routeBlock('router.put("/community/posts/:id"');

  it("requires authentication", () => {
    expect(block).toMatch(/router\.put\("\/community\/posts\/:id", authenticate/);
  });

  it("refuses to edit someone else's post", () => {
    expect(block).toContain("You can only edit your own posts");
    // Both the owner check and the admin escape, not owner-only.
    expect(block).toMatch(/post\.userId !== req\.user!\.id && req\.user!\.role !== "ADMIN"/);
  });

  it("404s a post that does not exist", () => {
    expect(block).toContain("Post not found");
  });

  it("only writes whitelisted fields, never the raw request body", () => {
    // Spreading req.body here would let a caller reassign userId, set likeCount
    // or force status to SOLD. The patch is assembled field by field.
    expect(block).not.toMatch(/\.set\(\s*req\.body/);
    expect(block).not.toMatch(/\.\.\.req\.body/);
    expect(block).toContain("if (typeof req.body?.content === \"string\")");
    expect(block).toContain("if (req.body?.tags !== undefined) patch.tags = cleanTags(req.body.tags);");
  });

  it("rejects an empty edit and an empty body", () => {
    expect(block).toContain("Nothing to update");
    expect(block).toContain("Post content cannot be empty");
  });

  it("normalises tags through cleanTags rather than trusting input", () => {
    expect(block).toContain("cleanTags(req.body.tags)");
    // cleanTags strips #, trims, caps length at 30 and count at 5.
    expect(routes).toMatch(/function cleanTags[\s\S]*?slice\(0, 5\)/);
  });

  it("broadcasts a change so open feeds update", () => {
    expect(block).toContain('emitGlobal(req, "community:changed"');
  });
});

describe("keyword editor on your own gig", () => {
  it("renders the control only on the signed-in user's own GIG or PROJECT", () => {
    expect(feedJs).toMatch(/if \(isMine && \(kind === 'GIG' \|\| kind === 'PROJECT'\)\)/);
    expect(feedJs).toContain('data-kw-edit=');
  });

  it("says so when there are no keywords yet", () => {
    expect(feedJs).toContain("No keywords yet");
    expect(feedJs).toMatch(/p\.tags && p\.tags\.length \? 'Edit keywords' : 'Add keywords'/);
  });

  it("saves through the PUT endpoint and updates the card in place", () => {
    expect(feedJs).toMatch(/api\('\/community\/posts\/' \+ postId, \{ method: 'PUT', body: \{ tags: tags \} \}\)/);
    expect(feedJs).toMatch(/card\.dataset\.tags = JSON\.stringify\(tags\)/);
  });

  it("applies the same tag normalisation the server does", () => {
    expect(feedJs).toMatch(/replace\(\/\^#\/, ''\)\.slice\(0, 30\)/);
    expect(feedJs).toMatch(/slice\(0, 5\)/);
  });

  it("is wired to a click handler", () => {
    expect(feedJs).toMatch(/closest\('\[data-kw-edit\]'\)/);
    expect(feedJs).toContain("openKeywordModal(kwBtn.getAttribute('data-kw-edit'))");
  });

  it("re-runs the sidebar demand panel after saving", () => {
    expect(feedJs).toContain("window.refreshSpotPromo");
    expect(feedHtml).toContain("window.refreshSpotPromo = loadSpotPromo");
  });

  it("does not close its own modal on an inside click", () => {
    // The generic backdrop handler removes .open on any modal-backdrop click.
    expect(feedJs).toMatch(/bd\.id !== 'phoneModal' && bd\.id !== 'kwModal'/);
  });
});