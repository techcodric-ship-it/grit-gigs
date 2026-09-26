import { db, conversationsTable, communityOrdersTable, ordersTable, barterMatchesTable, projectBidsTable, projectsTable } from "../db";
import { eq, and, or, inArray, ne, sql } from "drizzle-orm";

const COMMUNITY_ACCEPTED = ["IN_PROGRESS", "DELIVERED", "REVISION", "COMPLETED"];
const MATCH_ACCEPTED = ["ACCEPTED", "IN_PROGRESS", "DELIVERED", "COMPLETED"];

function pair(a: string, b: string, c1: any, c2: any) {
  return or(and(eq(c1, a), eq(c2, b)), and(eq(c1, b), eq(c2, a)));
}

export async function hasAcceptedDeal(a: string, b: string): Promise<boolean> {
  const [co] = await db
    .select({ id: communityOrdersTable.id })
    .from(communityOrdersTable)
    .where(and(
      pair(a, b, communityOrdersTable.buyerId, communityOrdersTable.sellerId)!,
      inArray(communityOrdersTable.status, COMMUNITY_ACCEPTED as any),
    ))
    .limit(1);
  if (co) return true;

  const [lo] = await db
    .select({ id: ordersTable.id })
    .from(ordersTable)
    .where(and(
      pair(a, b, ordersTable.buyerId, ordersTable.sellerId)!,
      ne(ordersTable.status, "PENDING"),
      ne(ordersTable.status, "CANCELLED"),
    ))
    .limit(1);
  if (lo) return true;

  const [m] = await db
    .select({ id: barterMatchesTable.id })
    .from(barterMatchesTable)
    .where(and(
      pair(a, b, barterMatchesTable.user1Id, barterMatchesTable.user2Id)!,
      inArray(barterMatchesTable.status, MATCH_ACCEPTED as any),
    ))
    .limit(1);
  if (m) return true;

  const [pb] = await db
    .select({ id: projectBidsTable.id })
    .from(projectBidsTable)
    .innerJoin(projectsTable, eq(projectBidsTable.projectId, projectsTable.id))
    .where(and(
      eq(projectBidsTable.status, "ACCEPTED"),
      or(
        and(eq(projectBidsTable.userId, a), eq(projectsTable.userId, b)),
        and(eq(projectBidsTable.userId, b), eq(projectsTable.userId, a)),
      ),
    ))
    .limit(1);
  if (pb) return true;

  return false;
}

export async function hasDirectConversation(a: string, b: string): Promise<boolean> {
  const [cv] = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(
      and(
        pair(a, b, conversationsTable.user1Id, conversationsTable.user2Id)!,
        sql`${conversationsTable.orderId} IS NULL AND ${conversationsTable.matchId} IS NULL AND ${conversationsTable.projectBidId} IS NULL`,
      ),
    )
    .limit(1);
  return !!cv;
}

export async function areConnected(a: string, b: string): Promise<boolean> {
  if (await hasDirectConversation(a, b)) return true;
  return hasAcceptedDeal(a, b);
}
