import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "./index";

/**
 * One-off migration: add transactions.gateway_order_id so a settled payment can
 * still be found by its Razorpay order id. gateway_txn_id is overwritten with the
 * payment id at settle time, which is what made a successful top-up report
 * "Transaction not found".
 * Run with:  npx tsx src/db/migrate-transaction-gateway-order-id.ts
 * Idempotent - safe to run multiple times.
 */
async function main() {
  const sqlPath = join(process.cwd(), "migrations", "migrate-transaction-gateway-order-id.sql");
  const sql = readFileSync(sqlPath, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("Transaction gateway order id migration applied successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Transaction gateway order id migration FAILED:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
  await pool.end();
}

main();
