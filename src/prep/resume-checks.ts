// Per-user daily resume-check usage (db-wrapped so vitest imports of pure
// modules never touch the database: only routes call these). Counts usage
// only — resume text is never persisted anywhere.

import { and, count, eq, gte } from "drizzle-orm";
import { db } from "../db";
import { prepResumeChecksTable } from "./schema";

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function countResumeChecksToday(userId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(prepResumeChecksTable)
    .where(
      and(
        eq(prepResumeChecksTable.userId, userId),
        gte(prepResumeChecksTable.createdAt, startOfUtcDay()),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

export async function recordResumeCheck(userId: string): Promise<void> {
  await db.insert(prepResumeChecksTable).values({ userId });
}
