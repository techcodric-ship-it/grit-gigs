import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, sql, count } from "drizzle-orm";
import { db, jobsTable, jobApplicationsTable, notificationsTable } from "../db";
import { authenticate, optionalAuth } from "../middlewares/authenticate";

const router: IRouter = Router();

// Shapes a job row for the public listing/apply UI (no internal fields).
function jobToClientJson(job: typeof jobsTable.$inferSelect & { applicants?: number; applied?: boolean; }) {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    type: job.type,
    salaryRange: job.salaryRange,
    description: job.description,
    skills: job.skills,
    applicationDeadline: job.applicationDeadline,
    createdAt: job.createdAt,
    applicants: job.applicants ?? 0,
    applied: job.applied ?? false,
  };
}

// GET /jobs — public listing of active jobs (optionally aware of the caller so
// we can flag which ones they already applied to).
router.get("/jobs", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const applicantId = req.user ? req.user.id : null;
  const appliedSelect = applicantId
    ? sql<boolean>`EXISTS(SELECT 1 FROM ${jobApplicationsTable} WHERE ${jobApplicationsTable.jobId} = ${jobsTable.id} AND ${jobApplicationsTable.applicantId} = ${applicantId})`
    : sql<boolean>`false`;
  const rows = await db
    .select({
      job: jobsTable,
      applicants: sql<number>`(SELECT count(*) FROM ${jobApplicationsTable} WHERE ${jobApplicationsTable.jobId} = ${jobsTable.id})`,
      applied: appliedSelect,
    })
    .from(jobsTable)
    .where(eq(jobsTable.isActive, true))
    .orderBy(desc(jobsTable.createdAt));

  res.json({
    success: true,
    data: rows.map((r) => jobToClientJson({ ...r.job, applicants: Number(r.applicants), applied: Boolean(r.applied) })),
  });
});

// GET /jobs/applied — the caller's submitted applications.
router.get("/jobs/applied", authenticate, async (req: Request, res: Response): Promise<void> => {
  const rows = await db
    .select({ application: jobApplicationsTable, job: jobsTable })
    .from(jobApplicationsTable)
    .innerJoin(jobsTable, eq(jobApplicationsTable.jobId, jobsTable.id))
    .where(eq(jobApplicationsTable.applicantId, req.user!.id))
    .orderBy(desc(jobApplicationsTable.createdAt));

  res.json({
    success: true,
    data: rows.map((r) => ({
      ...jobToClientJson({ ...r.job, applied: true }),
      applicationId: r.application.id,
      applicationStatus: r.application.status,
      applicationDate: r.application.createdAt,
      message: r.application.message,
    })),
  });
});

// POST /jobs/:id/apply — submit an application for a job.
router.post("/jobs/:id/apply", authenticate, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const { message } = req.body || {};

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.id, id), eq(jobsTable.isActive, true)))
    .limit(1);
  if (!job) {
    res.status(404).json({ success: false, message: "Job not found or no longer active" });
    return;
  }
  if (job.applicationDeadline && job.applicationDeadline.getTime() < Date.now()) {
    res.status(400).json({ success: false, message: "Applications for this job have closed." });
    return;
  }
  if (job.postedById === req.user!.id) {
    res.status(400).json({ success: false, message: "You can't apply to a job you posted." });
    return;
  }

  const [existing] = await db
    .select({ id: jobApplicationsTable.id })
    .from(jobApplicationsTable)
    .where(and(eq(jobApplicationsTable.jobId, id), eq(jobApplicationsTable.applicantId, req.user!.id)))
    .limit(1);
  if (existing) {
    res.status(400).json({ success: false, message: "You've already applied to this job." });
    return;
  }

  const [application] = await db
    .insert(jobApplicationsTable)
    .values({ jobId: id, applicantId: req.user!.id, message: message || null })
    .returning();

  if (job.postedById) {
    await db.insert(notificationsTable).values({
      userId: job.postedById,
      type: "JOB_APPLICATION",
      title: "New job application",
      message: `${req.user!.firstName} ${req.user!.lastName} applied to "${job.title}".`,
      linkUrl: "/admin?tab=jobs",
    });
    try { req.app?.get("io")?.emit("notification:new", { userId: job.postedById }); } catch {}
  }

  res.status(201).json({ success: true, message: "Application submitted", data: { applicationId: application.id, status: application.status } });
});

export default router;
