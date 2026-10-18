import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// A post published with wrong tags could not be corrected: the composer only
// sends tags when creating, and no route updated a post. The only remedy was
// delete and repost, which loses the likes and comments on it.
//
// PUT /community/posts/:id closes that. These tests are source-level, matching
// the rest of this suite, because there is no route harness to drive a request
// through. The guards are asserted structurally: the ownership check and the
// field whitelist are the two things that would be easy to drop by accident.

const ROOT = resolve(__dirname, "..", "..");
const routes = readFileSync(resolve(ROOT, "src", "routes", "community.ts"), "utf8");

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
    // cleanTags strips #, trims, caps length at 30, de-duplicates case
    // insensitively and caps the count at 5. The de-dupe matters because any
    // client-side de-dupe is bypassable.
    expect(routes).toMatch(/function cleanTags[\s\S]*?seen\.has\(k\)[\s\S]*?slice\(0, 5\)/);
  });

  it("broadcasts a change so open feeds update", () => {
    expect(block).toContain('emitGlobal(req, "community:changed"');
  });
});

