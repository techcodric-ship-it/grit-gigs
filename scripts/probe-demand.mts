import "dotenv/config";
import { db, pool } from "../src/db";
import { searchLogsTable, communityPostsTable } from "../src/db/schema/community";
import { gte, sql, desc, and, inArray, or, ilike } from "drizzle-orm";

// 1. Real search volume per term, last 7 and 30 days.
for (const days of [7, 30]) {
  const rows = await db
    .select({ term: searchLogsTable.term, n: sql`count(*)::int` })
    .from(searchLogsTable)
    .where(gte(searchLogsTable.createdAt, new Date(Date.now() - days * 864e5)))
    .groupBy(searchLogsTable.term)
    .orderBy(desc(sql`count(*)`));
  const total = rows.reduce((a, r) => a + r.n, 0);
  console.log(`searches last ${days}d: ${total} across ${rows.length} terms`);
  if (days === 7) for (const r of rows.slice(0, 8)) console.log(`   ${String(r.n).padStart(3)}  ${r.term}`);
}

// 2. Do posts actually carry tags a boost could match?
const tagged = await db
  .select({ kind: communityPostsTable.kind, n: sql`count(*)::int` })
  .from(communityPostsTable)
  .where(sql`array_length(tags,1) > 0`)
  .groupBy(communityPostsTable.kind);
console.log("\nposts WITH tags:", JSON.stringify(tagged));

// 3. How many users own a boostable gig/project at all? That is the true ceiling.
const owners = await db
  .select({ n: sql`count(DISTINCT user_id)::int` })
  .from(communityPostsTable)
  .where(inArray(communityPostsTable.kind, ["GIG", "PROJECT"]));
console.log("users owning a boostable gig/project:", owners[0].n);

// 4. How many own exactly one (the solo freelancer case the boost targets)?
const solo = await db.execute(
  sql`SELECT count(*)::int AS n FROM (
        SELECT user_id FROM community_posts
         WHERE kind IN ('GIG','PROJECT')
         GROUP BY user_id HAVING count(*) = 1) t`,
);
console.log("users with exactly one gig/project:", (solo as any).rows[0].n);

// 5. Dry-run of GET /community/spotlight/demand for real tag sets that exist in
// production, using the same matching rule as loadSpotlightPins(). This is what
// the buyer will literally be shown before paying, so it is worth eyeballing.
const recent = await db
  .select({ term: searchLogsTable.term, userId: searchLogsTable.userId })
  .from(searchLogsTable)
  .where(gte(searchLogsTable.createdAt, new Date(Date.now() - 7 * 864e5)))
  .limit(5000);

const realTags = await db
  .select({ tags: communityPostsTable.tags })
  .from(communityPostsTable)
  .where(inArray(communityPostsTable.kind, ["GIG", "PROJECT"]))
  .limit(200);

const normalize = (v: string) =>
  String(v || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9+# ]/g, "")
    .trim();

function tagMatchesSignature(tag: string, viewer: string[]): boolean {
  const t = normalize(tag);
  if (!t) return false;
  return viewer.some((s) => {
    if (!s) return false;
    if (s === t) return true;
    const sp = t.split(" ");
    if (sp.length > 1 && s.replace(/\s+/g, "").includes(sp.join(""))) return true;
    const ss = s.split(" ");
    if (ss.length > 1 && t.replace(/\s+/g, "").includes(ss.join(""))) return true;
    return s.includes(t) || t.includes(s);
  });
}

console.log("\n--- demand endpoint dry run ---");
const seen = new Set<string>();
let withDemand = 0;
for (const row of realTags) {
  const tags = (row.tags || []).slice(0, 5);
  const key = tags.join(",");
  if (!tags.length || seen.has(key)) continue;
  seen.add(key);

  const perTerm = tags.map((tag) => {
    let n = 0;
    for (const r of recent) if (tagMatchesSignature(tag, [normalize(r.term)])) n += 1;
    return { term: tag, searches: n };
  });
  const total = perTerm.reduce((a, t) => a + t.searches, 0);
  if (total > 0) withDemand++;
  if (seen.size <= 6) {
    console.log(
      `tags=[${tags.join(", ")}] -> ${total} searches (${perTerm
        .map((t) => `${t.term}:${t.searches}`)
        .join(" ")})`,
    );
  }
}
console.log(`tag sets checked: ${seen.size}, with any demand: ${withDemand}`);

await pool.end();