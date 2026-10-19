// Prep monetization - DB layer. The Prep Pro entitlement is granted ONLY by
// completeProOrder() after Razorpay confirms a captured payment; nothing here
// can activate it by balance or button click. Shared-wallet writes are limited
// to the proof-award credit. Imports of ../db are confined to this wrapper so
// the pure module stays test-friendly.

import { and, eq, gt, count, or, sql } from "drizzle-orm";
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

export type ProOrderRow = {
  id: string;
  userId: string;
  amount: number;
  status: string;
  description: string | null;
};

/** Record a Razorpay order as a PENDING transaction tagged PREP_PRO:. The
 * description prefix is what separates prep orders from plan subscriptions
 * (they share the SUBSCRIPTION type) — verify rejects anything else. */
export async function createProPendingOrder(userId: string, gatewayOrderId: string): Promise<void> {
  await db.insert(transactionsTable).values({
    userId,
    type: "SUBSCRIPTION",
    amount: PREP_PRO_PRICE_INR,
    paymentMethod: "razorpay",
    description: "PREP_PRO:Prep Pro - 30 days",
    status: "PENDING",
    gatewayOrderId,
    gatewayTxnId: gatewayOrderId,
  });
}

/** The Prep Pro order for a gateway order id, owned by this user. */
export async function findProOrder(gatewayOrderId: string, userId: string): Promise<ProOrderRow | null> {
  const rows = await db
    .select({
      id: transactionsTable.id,
      userId: transactionsTable.userId,
      amount: transactionsTable.amount,
      status: transactionsTable.status,
      description: transactionsTable.description,
    })
    .from(transactionsTable)
    .where(
      and(
        or(
          eq(transactionsTable.gatewayOrderId, gatewayOrderId),
          eq(transactionsTable.gatewayTxnId, gatewayOrderId),
        ),
        eq(transactionsTable.userId, userId),
        eq(transactionsTable.type, "SUBSCRIPTION"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || !row.description || !row.description.startsWith("PREP_PRO:")) return null;
  return row;
}

/** Gateway-confirmed capture -> the PENDING txn flips to COMPLETED and the
 * 30-day entitlement is granted in ONE transaction, so a crash can't take the
 * money without granting or grant without recording. The conditional UPDATE
 * (WHERE status='PENDING') is the single source of truth for first-completion
 * wins, and the partial unique index on (user_id, kind) WHERE status='ACTIVE'
 * rejects a duplicate grant — the unique-violation fallback still records the
 * capture so the payment never disappears. */
export async function completeProOrder(
  userId: string,
  gatewayOrderId: string,
  gatewayTxnId: string,
): Promise<
  { ok: true; entitlement: PrepEntitlement } | { ok: false; reason: "already-active" | "stale-order" }
> {
  const markCompleted = async (tx: PgTx): Promise<boolean> => {
    const done = await tx
      .update(transactionsTable)
      .set({ status: "COMPLETED", gatewayTxnId })
      .where(
        and(
          eq(transactionsTable.gatewayOrderId, gatewayOrderId),
          eq(transactionsTable.userId, userId),
          eq(transactionsTable.status, "PENDING"),
        ),
      )
      .returning();
    return done.length > 0;
  };
  try {
    return await db.transaction(async (tx): Promise<
      { ok: true; entitlement: PrepEntitlement } | { ok: false; reason: "already-active" | "stale-order" }
    > => {
      if (!(await markCompleted(tx))) return { ok: false, reason: "stale-order" };
      const now = new Date();
      const inserted = await tx
        .insert(prepEntitlementsTable)
        .values({
          userId,
          kind: "PREP_PRO",
          status: "ACTIVE",
          pricePaidInr: PREP_PRO_PRICE_INR,
          startedAt: now,
          expiresAt: proExpiryFrom(now),
        })
        .returning();
      const entitlement = inserted[0];
      if (!entitlement) return { ok: false, reason: "already-active" };
      return { ok: true, entitlement };
    });
  } catch (err) {
    // Unique violation on (user_id, kind) WHERE ACTIVE: a concurrent checkout
    // already granted the entitlement. The tx rolled back, so record the
    // capture on its own — the money is real either way.
    if ((err as { code?: string }).code === "23505") {
      await db
        .update(transactionsTable)
        .set({ status: "COMPLETED", gatewayTxnId })
        .where(
          and(
            eq(transactionsTable.gatewayOrderId, gatewayOrderId),
            eq(transactionsTable.userId, userId),
            eq(transactionsTable.status, "PENDING"),
          ),
        );
      return { ok: false, reason: "already-active" };
    }
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
