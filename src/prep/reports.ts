// Report persistence: create/fetch prep_reports rows and shape them for the
// API. The deterministic skeleton builder lives in report-skeleton.ts (pure,
// no DB import) and is re-exported here for router convenience.

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { prepCompaniesTable, prepReportsTable, type PrepCompany, type PrepReport } from "./schema";
import { buildReportSkeleton, type ReportSkeleton } from "./report-skeleton";

export { buildReportSkeleton };
export type { ReportSkeleton };

export async function findCompanyBySlug(slug: string): Promise<PrepCompany | null> {
  const rows = await db
    .select()
    .from(prepCompaniesTable)
    .where(eq(prepCompaniesTable.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}

export async function createReport(input: {
  companyId: string;
  role?: string | null;
  userType?: string | null;
  skeleton: ReportSkeleton;
  createdBy: string | null;
}): Promise<PrepReport> {
  const inserted = await db
    .insert(prepReportsTable)
    .values({
      companyId: input.companyId,
      role: input.role?.slice(0, 120) ?? null,
      userType: input.userType?.slice(0, 40) ?? null,
      sections: input.skeleton as unknown as Record<string, unknown>,
      sourceCount: input.skeleton.sourceCount,
      createdBy: input.createdBy,
    })
    .returning();
  return inserted[0] as PrepReport;
}

export async function getReportById(id: string): Promise<PrepReport | null> {
  const rows = await db.select().from(prepReportsTable).where(eq(prepReportsTable.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateReportAi(
  id: string,
  ai: { summary: string; model: string },
): Promise<PrepReport | null> {
  const updated = await db
    .update(prepReportsTable)
    .set({ aiSummary: ai.summary.slice(0, 4000), aiModel: ai.model.slice(0, 80) })
    .where(eq(prepReportsTable.id, id))
    .returning();
  return updated[0] ?? null;
}

export async function latestReportForCompany(companyId: string, role: string | null): Promise<PrepReport | null> {
  const roleNorm = role?.slice(0, 120) ?? null;
  const rows = await db
    .select()
    .from(prepReportsTable)
    .where(
      and(
        eq(prepReportsTable.companyId, companyId),
        roleNorm === null
          ? or(isNull(prepReportsTable.role), sql`${prepReportsTable.role} = ''`)
          : eq(prepReportsTable.role, roleNorm),
      ),
    )
    .orderBy(desc(prepReportsTable.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Shape a report for the API: public JSON. */
export function publicReport(report: PrepReport) {
  return {
    id: report.id,
    companyId: report.companyId,
    role: report.role,
    userType: report.userType,
    sections: report.sections,
    aiSummary: report.aiSummary ?? null,
    aiModel: report.aiModel ?? null,
    sourceCount: report.sourceCount,
    createdAt: report.createdAt,
  };
}
