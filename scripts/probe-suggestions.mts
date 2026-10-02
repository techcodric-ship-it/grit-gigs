// Read-only check of the suggestion cleaner against real production search-log
// terms, to confirm the payment dialog no longer shows raw user typos/phrases.
import "dotenv/config";
import { pool } from "../src/db";
import { sql, count, desc, gte } from "drizzle-orm";
import { db } from "../src/db";
import { searchLogsTable } from "../src/db/schema/community";
import { spotSuggestions } from "../src/lib/spotlight";

const raw = await db
  .select({ term: searchLogsTable.term, n: count() })
  .from(searchLogsTable)
  .where(gte(searchLogsTable.createdAt, new Date(Date.now() - 14 * 864e5)))
  .groupBy(searchLogsTable.term)
  .orderBy(desc(count()))
  .limit(40);

console.log(`RAW search terms (${raw.length}) - what the old code showed:`);
console.log("  " + raw.map((r) => r.term).join("  |  "));

const cleaned = spotSuggestions(raw);
console.log(`\nCLEANED (${cleaned.length}) - what ships now:`);
console.log("  " + cleaned.join("  |  "));

console.log("\nper-check:");
const junk = raw.map((r) => r.term).filter((t) => spotSuggestions([{ term: t, n: 1 }]).length === 0);
console.log("  dropped as noise:", junk.length ? junk.join(", ") : "(none)");
const phrases = cleaned.filter((t) => t.includes(","));
console.log("  multi-intent phrases remaining:", phrases.length ? phrases.join(", ") : "(none)");
const dupes = cleaned.filter((t, i) => cleaned.indexOf(t) !== i);
console.log("  duplicates remaining:", dupes.length ? dupes.join(", ") : "(none)");

await pool.end();