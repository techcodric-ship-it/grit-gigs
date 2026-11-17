// Read-only DB fetch for barter-derived GritScore evidence. Kept separate
// from the pure conversion so it can be unit-tested without a DB connection.
// This module NEVER writes to any barter table.

import { and, desc, eq, inArray, or } from "drizzle-orm";

import {
  barterDeliveriesTable,
  barterMatchesTable,
  barterRequestsTable,
  db,
  pool,
} from "../db";
import { logger } from "../lib/logger";
import {
  BARTER_EVIDENCE_CAP,
  buildBarterDrafts,
  type BarterEvidenceDraft,
  type ReviewRow,
} from "./barter-evidence";

/** Fetch the signed-in user's barter outcomes. Every query degrades to "no
 *  evidence" on error so an older deployment or a barter schema change can
 *  never break GritScore scan creation. */
export async function collectBarterEvidence(userId: string, limit = BARTER_EVIDENCE_CAP): Promise<BarterEvidenceDraft[] | null> {
  try {
    const matches = await db
      .select({
        id: barterMatchesTable.id,
        request1Id: barterMatchesTable.request1Id,
        request2Id: barterMatchesTable.request2Id,
        user1Id: barterMatchesTable.user1Id,
        user2Id: barterMatchesTable.user2Id,
        status: barterMatchesTable.status,
        completedAt: barterMatchesTable.completedAt,
        createdAt: barterMatchesTable.createdAt,
      })
      .from(barterMatchesTable)
      .where(
        and(
          eq(barterMatchesTable.status, "COMPLETED"),
          or(eq(barterMatchesTable.user1Id, userId), eq(barterMatchesTable.user2Id, userId)),
        ),
      )
      .orderBy(desc(barterMatchesTable.completedAt))
      .limit(6);

    const matchIds = matches.map((m) => m.id);
    const requestIds = matches.flatMap((m) => [m.request1Id, m.request2Id]);
    const requests = requestIds.length
      ? await db
          .select({
            id: barterRequestsTable.id,
            userId: barterRequestsTable.userId,
            skillOffered: barterRequestsTable.skillOffered,
            skillNeeded: barterRequestsTable.skillNeeded,
          })
          .from(barterRequestsTable)
          .where(inArray(barterRequestsTable.id, requestIds))
      : [];

    const deliveries = matchIds.length
      ? await db
          .select({
            id: barterDeliveriesTable.id,
            matchId: barterDeliveriesTable.matchId,
            userId: barterDeliveriesTable.userId,
            link: barterDeliveriesTable.link,
            createdAt: barterDeliveriesTable.createdAt,
          })
          .from(barterDeliveriesTable)
          .where(and(inArray(barterDeliveriesTable.matchId, matchIds), eq(barterDeliveriesTable.userId, userId)))
          .orderBy(desc(barterDeliveriesTable.createdAt))
      : [];

    // Reviews live in a raw SQL table (no Drizzle model) and may be absent on
    // older deployments, so this read is isolated in its own try/catch. Only
    // reviews the user RECEIVED are selected; the author is never fetched.
    let reviews: ReviewRow[] = [];
    try {
      const result = await pool.query(
        `SELECT id, match_id, rating, comment, created_at
           FROM barter_reviews
          WHERE reviewee_id = $1
          ORDER BY created_at DESC
          LIMIT 6`,
        [userId],
      );
      reviews = result.rows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        matchId: String(row.match_id),
        rating: Number(row.rating),
        comment: row.comment == null ? null : String(row.comment),
        createdAt: new Date(row.created_at as string),
      }));
    } catch {
      /* barter_reviews may not exist yet — skip review evidence */
    }

    return buildBarterDrafts({ userId, matches, requests, deliveries, reviews, limit });
  } catch (err) {
    // null means "could not read", so callers keep any derived rows already on
    // the card instead of mistaking a transient failure for no barter history.
    logger.warn({ err }, "[gritscore] barter evidence unavailable");
    return null;
  }
}
