import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "./index";

/**
 * One-off migration: 4-tier plan_id enum -> 3-tier (starter/pro/squad).
 * Run with:  npx tsx src/db/migrate-plan-tiers.ts
 * Idempotent — safe to run multiple times.
 */
async function main() {
  const sqlPath = join(process.cwd(), "migrations", "migrate-plan-tiers.sql");
  const sql = readFileSync(sqlPath, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("Plan tier migration applied successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Plan tier migration FAILED:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
  await pool.end();
}

main();
