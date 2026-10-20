// Per-user daily free-tier AI answer-score usage (db-wrapped so vitest
// imports of pure modules never touch the database: only routes call these).
// Counts usage only — typed answers are analysed in memory and never stored.

import { and, count, eq, gte } from "drizzle-orm";
import { db } from "../db";
import { prepAnswerScoresTable } from "./schema";

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function countAnswerScoresToday(userId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(prepAnswerScoresTable)
    .where(
      and(
        eq(prepAnswerScoresTable.userId, userId),
        gte(prepAnswerScoresTable.createdAt, startOfUtcDay()),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

export async function recordAnswerScore(userId: string): Promise<void> {
  await db.insert(prepAnswerScoresTable).values({ userId });
}
