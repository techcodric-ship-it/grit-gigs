import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "./index";

/**
 * One-off migration: add projects.escrow_amount + projects.escrow_held_at so a
 * client's agreed bid amount is held in their wallet at accept time.
 * Run with:  npx tsx src/db/migrate-project-escrow.ts
 * Idempotent - safe to run multiple times.
 */
async function main() {
  const sqlPath = join(process.cwd(), "migrations", "migrate-project-escrow.sql");
  const sql = readFileSync(sqlPath, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("Project escrow migration applied successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Project escrow migration FAILED:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
  await pool.end();
}

main();
