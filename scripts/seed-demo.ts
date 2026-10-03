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
 * Writes only rows whose email starts with "demo+" and whose content carries
 * the [DEMO] tag, so cleanup is two DELETEs and re-running is safe.
 *
 * Uses pool.query rather than drizzle's execute: this is the node-postgres
 * driver, where db.execute(sql.raw(...)) does not forward bind parameters, so
 * every $1 below would fail with "there is no parameter $1".
 */

const PREFIX = "demo+";
const TAG = "[DEMO]";

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
        `${TAG} ${l.content}`,
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
        createdAtFor(l),
      ],
    );
    if (res.rowCount) posts += res.rowCount;
  }
  console.log(`listings: ${posts}`);

  console.log(
    "\nDone. To remove every demo row:\n" +
      `  DELETE FROM community_posts WHERE content LIKE '${TAG}%';\n` +
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