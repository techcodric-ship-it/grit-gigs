// AI prep plan persistence (db-wrapped so vitest imports of pure modules
// never touch the database: only routes call these).

import { and, count, eq, gte } from "drizzle-orm";
import { db } from "../db";
import type { PrepAiPlanPayload } from "./ai";
import { prepAiPlanRequestsTable, prepAiPlansTable } from "./schema";

export interface CachedAiPlan {
  plan: PrepAiPlanPayload;
  model: string | null;
}

const PLAN_CACHE_TTL_MS = 30 * 60 * 1000;

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Cached plans are short-lived: a combo regenerates after 30 minutes so
 * fresh sources and a recovered AI provider both show up without a nuke. */
export async function getCachedAiPlan(companyId: string, roleKey: string): Promise<CachedAiPlan | null> {
  const rows = await db
    .select()
    .from(prepAiPlansTable)
    .where(
      and(
        eq(prepAiPlansTable.companyId, companyId),
        eq(prepAiPlansTable.roleKey, roleKey),
        gte(prepAiPlansTable.createdAt, new Date(Date.now() - PLAN_CACHE_TTL_MS)),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { plan: row.plan as PrepAiPlanPayload, model: row.model ?? null };
}

/** Latest regeneration wins (unique key = company + role). */
export async function saveAiPlan(
  companyId: string,
  roleKey: string,
  plan: PrepAiPlanPayload,
  model: string,
): Promise<void> {
  await db
    .insert(prepAiPlansTable)
    .values({ companyId, roleKey, plan, model })
    .onConflictDoUpdate({
      target: [prepAiPlansTable.companyId, prepAiPlansTable.roleKey],
      set: { plan, model, createdAt: new Date() },
    });
}

export async function countAiPlanRequestsToday(userId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(prepAiPlanRequestsTable)
    .where(
      and(
        eq(prepAiPlanRequestsTable.userId, userId),
        gte(prepAiPlanRequestsTable.createdAt, startOfUtcDay()),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

export async function recordAiPlanRequest(userId: string): Promise<void> {
  await db.insert(prepAiPlanRequestsTable).values({ userId });
}
