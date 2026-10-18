// DB operations for proof submissions (kept separate from proof.ts so the
// pure validation module stays importable in tests without DATABASE_URL).

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { prepCompaniesTable, prepProofSubmissionsTable, type PrepProofSubmission } from "./schema";
import type { ProofSubmission } from "./proof";
import { evidenceExpiry } from "./proof";

export async function companyExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: prepCompaniesTable.id })
    .from(prepCompaniesTable)
    .where(eq(prepCompaniesTable.id, id))
    .limit(1);
  return rows.length > 0;
}

export async function insertSubmission(
  input: ProofSubmission,
  opts: { submittedBy: string; filePath: string | null },
): Promise<PrepProofSubmission> {
  const rows = await db
    .insert(prepProofSubmissionsTable)
    .values({
      companyId: input.companyId,
      kind: input.kind,
      payload: input.payload as unknown as Record<string, unknown>,
      filePath: opts.filePath,
      submittedBy: opts.submittedBy,
      expiresAt: evidenceExpiry(),
    })
    .returning();
  return rows[0] as PrepProofSubmission;
}

export async function listMySubmissions(userId: string): Promise<PrepProofSubmission[]> {
  return db
    .select()
    .from(prepProofSubmissionsTable)
    .where(eq(prepProofSubmissionsTable.submittedBy, userId))
    .orderBy(desc(prepProofSubmissionsTable.createdAt))
    .limit(50);
}

export async function getSubmission(id: string): Promise<PrepProofSubmission | null> {
  const rows = await db
    .select()
    .from(prepProofSubmissionsTable)
    .where(eq(prepProofSubmissionsTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listPendingSubmissions(): Promise<PrepProofSubmission[]> {
  return db
    .select()
    .from(prepProofSubmissionsTable)
    .where(eq(prepProofSubmissionsTable.status, "PENDING"))
    .orderBy(desc(prepProofSubmissionsTable.createdAt))
    .limit(100);
}

export async function reviewSubmission(
  id: string,
  decision: "APPROVED" | "REJECTED",
  note: string | null,
  reviewerId: string | null,
): Promise<PrepProofSubmission | null> {
  const rows = await db
    .update(prepProofSubmissionsTable)
    .set({
      status: decision,
      reviewNote: note,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
    })
    .where(and(eq(prepProofSubmissionsTable.id, id), eq(prepProofSubmissionsTable.status, "PENDING")))
    .returning();
  return rows[0] ?? null;
}
