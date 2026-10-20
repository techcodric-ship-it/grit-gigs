// Company question packs: member-reported questions candidates say they were
// asked. MEMBER_REPORTED by design — unverified, labelled as such on every
// read path; the router owns validation and company resolution.

import { and, count, desc, eq, gte } from "drizzle-orm";
import { db } from "../db";
import { prepCompanyQuestionsTable, type PrepCompanyQuestion } from "./schema";

export const PACKS_PER_USER_PER_DAY = 10;

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function listPackQuestions(companyId: string): Promise<PrepCompanyQuestion[]> {
  return db
    .select()
    .from(prepCompanyQuestionsTable)
    .where(and(eq(prepCompanyQuestionsTable.companyId, companyId), eq(prepCompanyQuestionsTable.status, "VISIBLE")))
    .orderBy(desc(prepCompanyQuestionsTable.createdAt));
}

export async function insertPackQuestion(row: {
  companyId: string;
  role: string;
  category: string;
  question: string;
  context: string;
  submittedBy: string;
}): Promise<void> {
  await db.insert(prepCompanyQuestionsTable).values(row);
}

/** Exact normalized-text duplicate inside the same company — never two twins. */
export async function findDuplicatePackQuestion(companyId: string, normalized: string): Promise<boolean> {
  const rows = await db
    .select({ question: prepCompanyQuestionsTable.question })
    .from(prepCompanyQuestionsTable)
    .where(and(eq(prepCompanyQuestionsTable.companyId, companyId), eq(prepCompanyQuestionsTable.status, "VISIBLE")));
  return rows.some((r) => r.question.replace(/\s+/g, " ").trim().toLowerCase() === normalized);
}

export async function countPackSubmissionsToday(userId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(prepCompanyQuestionsTable)
    .where(
      and(
        eq(prepCompanyQuestionsTable.submittedBy, userId),
        gte(prepCompanyQuestionsTable.createdAt, startOfUtcDay()),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}
