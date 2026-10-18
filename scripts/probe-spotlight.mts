// Read-only verification for the Spotlight packs/engagement work. Applies NO
// schema changes and NO writes: it only reports what production currently has
// and whether the migration statements would be needed.
import "dotenv/config";
import { pool } from "../src/db";

async function main() {
  const c = await pool.connect();
  try {
    const cols = await c.query(
      `SELECT column_name, data_type, column_default, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'post_boosts'
        ORDER BY ordinal_position`,
    );
    console.log("post_boosts columns:");
    for (const r of cols.rows) {
      console.log(`  ${r.column_name} ${r.data_type} default=${r.column_default ?? "-"} null=${r.is_nullable}`);
    }
    console.log("has plan_id:", cols.rows.some((r) => r.column_name === "plan_id"));

    const tbl = await c.query(
      `SELECT to_regclass('boost_impressions') IS NOT NULL AS present`,
    );
    const impressionsExist = tbl.rows[0].present;
    console.log("boost_impressions exists:", impressionsExist);

    const idx = await c.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename IN ('boost_impressions','post_boosts') ORDER BY indexname`,
    );
    console.log("indexes:");
    for (const r of idx.rows) console.log(`  ${r.indexname}`);

    if (impressionsExist) {
      const boosts = await c.query(
        `SELECT b.id, b.plan_id, b.amount, b.extend_count, b.expires_at,
                count(i.id)::int AS rows_n
           FROM post_boosts b
           LEFT JOIN boost_impressions i ON i.boost_id = b.id
          GROUP BY b.id ORDER BY b.created_at DESC LIMIT 10`,
      );
      console.log(`boosts: ${boosts.rows.length}`);
      for (const r of boosts.rows) {
        console.log(`  ${r.id.slice(0, 8)} plan=${r.plan_id ?? "NULL"} amt=${r.amount} ext=${r.extend_count} expires=${r.expires_at.toISOString()} impressions=${r.rows_n}`);
      }
    } else {
      const boosts = await c.query(
        `SELECT id, amount, extend_count, expires_at FROM post_boosts
          ORDER BY created_at DESC LIMIT 10`,
      );
      console.log(`boosts: ${boosts.rows.length} (engagement skipped, table absent)`);
      for (const r of boosts.rows) {
        console.log(`  ${r.id.slice(0, 8)} amt=${r.amount} ext=${r.extend_count} expires=${r.expires_at.toISOString()}`);
      }
    }

    // Validate the exact migration SQL from src/index.ts inside a transaction
    // that is always rolled back, so this probe stays strictly read-only while
    // still proving the DDL parses against the real database.
    console.log("--- migration dry run (rolled back) ---");
    await c.query("BEGIN");
    try {
      await c.query(`ALTER TABLE post_boosts ADD COLUMN IF NOT EXISTS plan_id TEXT NOT NULL DEFAULT 'day1'`);
      await c.query(`
        CREATE TABLE IF NOT EXISTS boost_impressions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          boost_id UUID NOT NULL REFERENCES post_boosts(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          viewed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
          clicked_at TIMESTAMPTZ,
          views INTEGER NOT NULL DEFAULT 1
        )`);
      await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS boost_impressions_boost_user_unique ON boost_impressions(boost_id, user_id)`);
      await c.query(`CREATE INDEX IF NOT EXISTS idx_boost_impressions_boost ON boost_impressions(boost_id)`);

      // Exercise the exact runtime upserts the routes use, against real rows,
      // then undo everything. This catches SQL typos before deploy.
      const seed = await c.query(
        `SELECT id, post_id, user_id FROM post_boosts ORDER BY created_at DESC LIMIT 1`,
      );
      if (!seed.rows.length) {
        console.log("no boost rows to exercise the upsert against");
      } else {
        const b = seed.rows[0];
        const other = await c.query(
          `SELECT id FROM users WHERE id <> $1 LIMIT 1`,
          [b.user_id],
        );
        const viewer = other.rows[0]?.id;
        if (!viewer) {
          console.log("no second user available for the upsert test");
        } else {
          await c.query(
            `INSERT INTO boost_impressions (boost_id, user_id, viewed_at, views)
             VALUES ($1::uuid, $2::uuid, NOW(), 1)
             ON CONFLICT (boost_id, user_id)
             DO UPDATE SET views = boost_impressions.views + 1`,
            [b.id, viewer],
          );
          await c.query(
            `INSERT INTO boost_impressions (boost_id, user_id, viewed_at, views)
             VALUES ($1::uuid, $2::uuid, NOW(), 1)
             ON CONFLICT (boost_id, user_id)
             DO UPDATE SET views = boost_impressions.views + 1`,
            [b.id, viewer],
          );
          const agg = await c.query(
            `SELECT count(*)::int AS reach,
                    COALESCE(SUM(views),0)::int AS impressions,
                    count(clicked_at)::int AS clicks
               FROM boost_impressions WHERE boost_id = $1::uuid`,
            [b.id],
          );
          await c.query(
            `INSERT INTO boost_impressions (boost_id, user_id, viewed_at, clicked_at, views)
             VALUES ($1::uuid, $2::uuid, NOW(), NOW(), 1)
             ON CONFLICT (boost_id, user_id)
             DO UPDATE SET clicked_at = COALESCE(boost_impressions.clicked_at, NOW())`,
            [b.id, viewer],
          );
          const after = await c.query(
            `SELECT count(*)::int AS reach,
                    COALESCE(SUM(views),0)::int AS impressions,
                    count(clicked_at)::int AS clicks
               FROM boost_impressions WHERE boost_id = $1::uuid`,
            [b.id],
          );
          console.log("after 2 renders:", JSON.stringify(agg.rows[0]), "(dedup -> 1 viewer, 2 impressions)");
          console.log("after click:    ", JSON.stringify(after.rows[0]), "(click stamped once)");
          if (agg.rows[0].reach !== 1 || agg.rows[0].impressions !== 2) {
            throw new Error("dedup broken: reach must be 1 and impressions 2");
          }
          if (after.rows[0].clicks !== 1) throw new Error("click did not register");
        }
      }
      console.log("migration SQL + runtime upserts: OK");
    } finally {
      await c.query("ROLLBACK");
      console.log("rolled back (no production change)");
    }
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("probe failed:", e.message);
  process.exit(1);
});