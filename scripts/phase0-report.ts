// Phase 0.1 — read-only impact report for the AI Work Engine rebuild.
// Prints what Phase 0.2/0.3 will affect. NEVER writes. Run: npx tsx scripts/phase0-report.ts
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const OPEN_ORDER_STATES = ["PENDING", "IN_PROGRESS", "DELIVERED", "REVISION"];

async function main(): Promise<void> {
  console.log("=== PHASE 0 IMPACT REPORT (read-only) ===");

  // 1. Open human orders by kind (these keep working through Phase 0 — nothing stranded)
  const openOrders = await pool.query(
    `select kind, status, count(*)::int as n, coalesce(sum(amount),0)::int as inr
       from community_orders
      where status = any($1)
      group by kind, status
      order by kind, status`,
    [OPEN_ORDER_STATES],
  );
  console.log("\n-- open human orders (in-flight, must keep completing) --");
  if (!openOrders.rows.length) console.log("(none)");
  for (const r of openOrders.rows) {
    console.log(`kind=${r.kind} status=${r.status} n=${r.n} inr_locked=${r.inr}`);
  }
  const closedOrders = await pool.query(
    `select status, count(*)::int as n from community_orders
      where not (status = any($1)) group by status`,
    [OPEN_ORDER_STATES],
  );
  console.log("-- closed/cancelled orders (untouched) --");
  for (const r of closedOrders.rows) console.log(`status=${r.status} n=${r.n}`);

  // 2. Active paid Spotlight pins (founder decides: honor, refund, or credit)
  const pins = await pool.query(
    `select count(*)::int as n, coalesce(sum(amount),0)::float as inr
       from post_boosts where expires_at > now()`,
  );
  const expired = await pool.query(
    `select count(*)::int as n from post_boosts where expires_at <= now()`,
  );
  console.log("\n-- spotlight pins --");
  console.log(`active_paid_pins=${pins.rows[0].n} inr_paid=${pins.rows[0].inr}`);
  console.log(`expired_pins=${expired.rows[0].n} (historical only)`);

  // 3. Posts per kind (+ status) — Phase 0.2 hides GIG/BARTER/PROJECT/REEL from default feed
  const posts = await pool.query(
    `select kind, status, count(*)::int as n from community_posts group by kind, status order by kind, status`,
  );
  console.log("\n-- posts per kind --");
  for (const r of posts.rows) console.log(`kind=${r.kind} status=${r.status} n=${r.n}`);

  // 4. AI jobs tables (Phase 1 migration target — should not exist yet)
  const aiTables = await pool.query(
    `select table_name from information_schema.tables
      where table_schema='public' and table_name in ('ai_jobs','ai_job_messages')`,
  );
  console.log("\n-- ai tables present --");
  console.log(aiTables.rows.length ? aiTables.rows.map((r) => r.table_name).join(",") : "(none — migration still to come)");

  console.log("\n=== END REPORT ===");
  await pool.end();
}

main().catch(async (e) => {
  console.error("REPORT FAILED:", e?.message ?? e);
  await pool.end();
  process.exit(1);
});
