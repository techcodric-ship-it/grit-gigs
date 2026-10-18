// Prep monetization - DB layer. Shared-wallet writes mirror the referral
// credit pattern (balance + transactions row in one transaction). Imports of
// ../db are confined to this wrapper so the pure module stays test-friendly.

import { and, eq, gt, count, sql } from "drizzle-orm";
import { db, freelanceWalletsTable, transactionsTable } from "../db";
import {
  prepEntitlementsTable,
  prepCreditAwardsTable,
  prepReportsTable,
  prepProofSubmissionsTable,
  type PrepEntitlement,
  type PrepProofSubmission,
} from "./schema";
import {
  PREP_PROOF_AWARD_INR,
  PREP_PRO_PRICE_INR,
  isEntitlementActive,
  proofAwardReason,
  proExpiryFrom,
} from "./monetization";

type PgTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function getActiveEntitlement(userId: string, now: Date = new Date()): Promise<PrepEntitlement | null> {
  const rows = await db
    .select()
    .from(prepEntitlementsTable)
    .where(
      and(
        eq(prepEntitlementsTable.userId, userId),
        eq(prepEntitlementsTable.status, "ACTIVE"),
        gt(prepEntitlementsTable.expiresAt, now),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Rolling-24h count of report generations created by this user. */
export async function countReportsLast24h(userId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ c: count() })
    .from(prepReportsTable)
    .where(and(eq(prepReportsTable.createdBy, userId), gt(prepReportsTable.createdAt, since)));
  return Number(rows[0]?.c ?? 0);
}

export type PurchaseResult =
  | { ok: true; entitlement: PrepEntitlement }
  | { ok: false; reason: "already-active" | "insufficient-balance" };

/** Buy 30 days of Prep Pro from the wallet balance, atomically:
 * balance is debited with `balance >= price` in the UPDATE's WHERE so two
 * concurrent purchases can never double-spend; the partial unique index on
 * (user_id, kind) WHERE status='ACTIVE' rejects a duplicate entitlement and
 * rolls the whole transaction back. */
export async function purchasePro(userId: string): Promise<PurchaseResult> {
  const existing = await getActiveEntitlement(userId);
  if (existing && isEntitlementActive(existing)) return { ok: false, reason: "already-active" };
  const price = PREP_PRO_PRICE_INR;
  try {
    return await db.transaction(async (tx): Promise<PurchaseResult> => {
      const debited = await tx.execute(
        sql`UPDATE ${freelanceWalletsTable} SET balance = balance - ${price}, updated_at = NOW()
             WHERE ${freelanceWalletsTable.userId} = ${userId} AND balance >= ${price}`,
      );
      if ((debited as { rowCount?: number }).rowCount === 0) {
        return { ok: false, reason: "insufficient-balance" };
      }
      const now = new Date();
      const inserted = await tx
        .insert(prepEntitlementsTable)
        .values({
          userId,
          kind: "PREP_PRO",
          status: "ACTIVE",
          pricePaidInr: price,
          startedAt: now,
          expiresAt: proExpiryFrom(now),
        })
        .returning();
      const entitlement = inserted[0];
      if (!entitlement) return { ok: false, reason: "insufficient-balance" };
      await tx.insert(transactionsTable).values({
        userId,
        type: "SUBSCRIPTION",
        amount: price,
        paymentMethod: "wallet",
        description: "Prep Pro - 30 days",
        status: "COMPLETED",
      });
      return { ok: true, entitlement };
    });
  } catch (err) {
    // Unique violation on (user_id, kind) WHERE ACTIVE: someone raced us.
    if ((err as { code?: string }).code === "23505") return { ok: false, reason: "already-active" };
    throw err;
  }
}

async function creditProofAwardTx(tx: PgTx, submissionId: string, userId: string, amount: number): Promise<void> {
  const reason = proofAwardReason(submissionId);
  const inserted = await tx.execute(
    sql`INSERT INTO ${prepCreditAwardsTable} (user_id, reason, amount_inr)
        VALUES (${userId}, ${reason}, ${amount}) ON CONFLICT (reason) DO NOTHING`,
  );
  if ((inserted as { rowCount?: number }).rowCount === 0) return; // already paid once
  const credited = await tx.execute(
    sql`UPDATE ${freelanceWalletsTable}
        SET balance = balance + ${amount},
            total_earned = COALESCE(total_earned, 0) + ${amount},
            updated_at = NOW()
        WHERE ${freelanceWalletsTable.userId} = ${userId}`,
  );
  if ((credited as { rowCount?: number }).rowCount === 0) {
    await tx.insert(freelanceWalletsTable).values({
      userId,
      balance: amount,
      bonusBalance: 0,
      totalEarned: amount,
      updatedAt: new Date(),
    });
  }
  await tx.insert(transactionsTable).values({
    userId,
    type: "SERVICE_EARNING",
    amount,
    description: "Prep proof contribution reward",
    status: "COMPLETED",
  });
}

/** Flip PENDING -> APPROVED/REJECTED and, on approval, credit the submitter
 * exactly once - status flip + payout share one transaction, so a crash can't
 * approve without paying or pay without approving. */
export async function reviewAndAward(
  id: string,
  decision: "APPROVED" | "REJECTED",
  note: string | null,
  reviewerId: string | null,
): Promise<PrepProofSubmission | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(prepProofSubmissionsTable)
      .set({
        status: decision,
        reviewNote: note,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
      })
      .where(
        and(eq(prepProofSubmissionsTable.id, id), eq(prepProofSubmissionsTable.status, "PENDING")),
      )
      .returning();
    const row = rows[0];
    if (!row) return null;
    if (decision === "APPROVED" && row.submittedBy) {
      await creditProofAwardTx(tx, row.id, row.submittedBy, PREP_PROOF_AWARD_INR);
    }
    return row;
  });
}
