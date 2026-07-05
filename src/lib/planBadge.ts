import { inArray } from "drizzle-orm";
import { db, userSubscriptionsTable } from "../db";
import { getPlan } from "./subscriptions";

export async function attachPlanBadges(users: any[]): Promise<void> {
  const userIds = users.map((u: any) => u?.id).filter(Boolean);
  if (userIds.length === 0) return;
  const subs = await db
    .select({ userId: userSubscriptionsTable.userId, planId: userSubscriptionsTable.planId })
    .from(userSubscriptionsTable)
    .where(inArray(userSubscriptionsTable.userId, userIds));
  const badgeMap: Record<string, string | null> = {};
  for (const sub of subs) {
    badgeMap[sub.userId] = getPlan(sub.planId).badge;
  }
  for (const user of users) {
    if (user?.id) user.planBadge = badgeMap[user.id] || null;
  }
}

export async function attachPlanBadge(user: any): Promise<void> {
  if (!user?.id) return;
  await attachPlanBadges([user]);
}
