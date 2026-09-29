import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "./index";

/**
 * One-off migration: add community_order_deliveries.link so sellers can
 * attach a deliverable URL when delivering a community order.
 * Run with:  npx tsx src/db/migrate-community-delivery-link.ts
 * Idempotent - safe to run multiple times.
 */
async function main() {
  const sqlPath = join(process.cwd(), "migrations", "migrate-community-delivery-link.sql");
  const sql = readFileSync(sqlPath, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("Community delivery link migration applied successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Community delivery link migration FAILED:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
  await pool.end();
}

main();
