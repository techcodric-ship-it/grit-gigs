import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "../src/db";
import { assertDemoTargetAllowed, DemoTargetError } from "../src/demo/guard";
import { DEMO_LISTINGS, DEMO_PEOPLE, createdAtFor } from "../src/demo/dataset";

/**
 * Seed the demo marketplace into a NON-PRODUCTION database.
 *
 * Fabricated people, projects, swaps and engagement. Refuses to touch the
 * production database: see src/demo/guard.ts.
 *
 * Usage:
 *   $env:DATABASE_URL = "postgres://user:pw@localhost:5432/gritgigs_demo"
 *   npm run demo:seed
 *
 * Writes only rows whose owner email starts with "demo+", so cleanup is two
 * DELETEs and re-running is safe. The listings carry no marker in their
 * caption text: they sit in the live feed alongside the seeded content
 * scripts/seed-community.ts has always put there, unmarked. Demo rows stay
 * identifiable by owner, which is what the cleanup below keys on.
 *
 * Uses pool.query rather than drizzle's execute: this is the node-postgres
 * driver, where db.execute(sql.raw(...)) does not forward bind parameters, so
 * every $1 below would fail with "there is no parameter $1".
 */

const PREFIX = "demo+";

// Requirements text per listing, so the order rows read like real work rather
// than ten identical placeholders.
const ORDER_NOTE: Record<string, string> = {
  "p-brand-kit": "Logo, two colourways and a one-page usage guide. Two revision rounds included.",
  "p-ops-dashboard": "Order tracking, status pipeline and a weekly exceptions view. Seeded with 6 months of sample data.",
  "p-onboarding-copy": "14 help articles plus the welcome email sequence. Written in British English to match the product.",
  "p-sales-bi": "Revenue by channel, cohort retention and a rep leaderboard. Built as a Power BI template plus the source workbook.",
  "p-clinic-social": "Monthly management, 12 posts, before-and-after with signed consent forms. Report on the 1st.",
  "p-booking-app": "Booking, reminders and reschedule flow for three clinics. Android and iOS from one codebase.",
  "b-logo-for-site": "Logo and one-page brand treatment in exchange for React work on the landing page.",
  "b-copy-for-code": "Writing help on the pricing and about pages in exchange for React work.",
  "b-analytics-for-brand": "Analytics setup and a monthly report in exchange for SQL help on the events table.",
  "b-reels-for-sql": "15 edited reels in exchange for SQL tutoring, one hour a week for a month.",
};

function target(): string {
  const t = process.env.DEMO_SEED_TARGET ?? process.env.DATABASE_URL;
  if (!t) {
    console.error("No database URL available to seed.");
    process.exit(1);
  }
  return t;
}

async function main() {
  const targetUrl = target();

  try {
    assertDemoTargetAllowed(targetUrl);
  } catch (e) {
    if (e instanceof DemoTargetError) {
      console.error(`\nRefusing to run: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  const host = new URL(targetUrl).hostname;
  const connected = new URL(process.env.DATABASE_URL!).hostname;
  console.log(`Target accepted: ${host}`);
  if (host !== connected) {
    console.error(
      `\nWARNING: DEMO_SEED_TARGET is ${host} but this process connects to ${connected}.\n` +
        "Set both to the same demo database or the rows land somewhere else.\n",
    );
  }

  const passwordHash = await bcrypt.hash("demo-password-not-valid", 10);

  // Idempotency: clear the previous demo set before inserting. Posts have no
  // natural unique key, so without this a re-run duplicates every listing.
  // Keyed on owner rather than on a caption marker, since the captions are
  // stored unmarked.
  const cleared = await pool.query(
    `DELETE FROM community_posts
      WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`${PREFIX}%`],
  );
  if (cleared.rowCount) console.log(`cleared ${cleared.rowCount} previous demo post(s)`);

  for (const p of DEMO_PEOPLE) {
    await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, bio, city, tagline,
                          skills_offered, skills_needed, is_available)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
       ON CONFLICT (email) DO NOTHING`,
      [
        `${PREFIX}${p.key}@example.invalid`,
        passwordHash,
        p.firstName,
        p.lastName,
        p.bio,
        p.city,
        p.tagline,
        p.skillsOffered,
        p.skillsNeeded,
      ],
    );
  }
  console.log(`people: ${DEMO_PEOPLE.length} (existing demo accounts skipped)`);

  let posts = 0;
  const postIds: { id: string; listing: (typeof DEMO_LISTINGS)[number] }[] = [];
  for (const l of DEMO_LISTINGS) {
    const res = await pool.query(
      `INSERT INTO community_posts
         (user_id, kind, content, cover_url, tags, price_inr, want_inr, want_text,
          delivery_days, location, is_remote, status, like_count, comment_count, created_at)
       SELECT u.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
       FROM users u WHERE u.email = $1
       RETURNING id`,
      [
        `${PREFIX}${l.ownerKey}@example.invalid`,
        l.kind,
        l.content,
        l.coverImage,
        l.tags,
        l.priceInr ?? null,
        l.wantInr ?? null,
        l.wantText ?? null,
        l.deliveryDays ?? null,
        l.location,
        l.isRemote,
        l.status,
        l.likeCount,
        l.commentCount,
        // Anchored to now, not the fixed epoch the tests use. The feed sorts by
        // created_at DESC, so demo posts dated relative to a constant land at the
        // very bottom of the feed - they were invisible in production for exactly
        // that reason.
        createdAtFor(l, new Date()),
      ],
    );
    if (res.rowCount) {
      posts += res.rowCount;
      postIds.push({ id: res.rows[0].id, listing: l });
    }
  }
  console.log(`listings: ${posts}`);

  // The feed derives workStatus from the latest live community_orders row, so a
  // listing with no order renders as OPEN and never shows Completed or Pending.
  // Seeding one order per listing is what puts the ribbon on the card.
  // Counterparty is always another demo person, never a real user.
  let orders = 0;
  for (const { id, listing } of postIds) {
    const owner = `${PREFIX}${listing.ownerKey}@example.invalid`;
    const others = DEMO_PEOPLE.map((p) => `${PREFIX}${p.key}@example.invalid`).filter(
      (e) => e !== owner,
    );
    const buyer = others[orders % others.length];
    const at = createdAtFor(listing, new Date());
    const res = await pool.query(
      `INSERT INTO community_orders
         (post_id, buyer_id, seller_id, kind, status, requirements, amount,
          revisions_used, delivered_at, completed_at, created_at, updated_at)
       SELECT $1, b.id, s.id, $2::community_order_kind, $3::community_order_status,
              $4, $5, $6,
              CASE WHEN $10 THEN $7::timestamptz ELSE NULL END,
              CASE WHEN $10 THEN $7::timestamptz ELSE NULL END,
              $7::timestamp, $7::timestamp
       FROM users b, users s
       WHERE b.email = $8 AND s.email = $9`,
      [
        id,
        listing.kind,
        listing.workStatus,
        ORDER_NOTE[listing.key] ?? "Scope agreed in chat.",
        listing.priceInr ?? null,
        listing.workStatus === "COMPLETED" ? 1 : 0,
        at,
        buyer,
        owner,
        listing.workStatus === "COMPLETED",
      ],
    );
    if (res.rowCount) orders += res.rowCount;
  }
  console.log(`orders: ${orders}`);

  console.log(
    "\nDone. To remove every demo row:\n" +
      `  DELETE FROM community_posts WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'demo+%');\n` +
      `  DELETE FROM users WHERE email LIKE '${PREFIX}%';`,
  );
  await pool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});