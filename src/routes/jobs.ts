import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, sql, ilike, or, inArray } from "drizzle-orm";
import {
  db,
  jobsTable,
  jobApplicationsTable,
  notificationsTable,
  usersTable,
} from "../db";
import { authenticate, optionalAuth } from "../middlewares/authenticate";
import {
  JOB_TYPES,
  MAX_DESCRIPTION_LEN,
  MAX_TITLE_LEN,
  canManageJob,
  isValidJobType,
  normalizeSkillInput,
  parseJobListQuery,
} from "../lib/skills";

const router: IRouter = Router();

// Shapes a job row for the public listing/apply UI (no internal fields).
function jobToClientJson(
  job: typeof jobsTable.$inferSelect & { applicants?: number; applied?: boolean },
) {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    type: job.type,
    salaryRange: job.salaryRange,
    description: job.description,
    skills: job.skills,
    link: job.link ?? null,
    applicationDeadline: job.applicationDeadline,
    createdAt: job.createdAt,
    isActive: job.isActive,
    applicants: job.applicants ?? 0,
    applied: job.applied ?? false,
  };
}

async function notify(userId: string, type: string, title: string, message: string, linkUrl: string, io: unknown) {
  await db.insert(notificationsTable).values({ userId, type, title, message, linkUrl });
  try {
    (io as { to?: (room: string) => { emit: (ev: string, payload: unknown) => void } })
      ?.to?.(`user:${userId}`)
      .emit("notification:new", { type, title, message, linkUrl });
  } catch {}
}

// GET /jobs — public listing with optional filters (q, skill, type, location)
// and caller-aware "applied" flags.
router.get("/jobs", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const applicantId = req.user ? req.user.id : null;
  const appliedSelect = applicantId
    ? sql<boolean>`EXISTS(SELECT 1 FROM ${jobApplicationsTable} WHERE ${jobApplicationsTable.jobId} = ${jobsTable.id} AND ${jobApplicationsTable.applicantId} = ${applicantId})`
    : sql<boolean>`false`;

  const filters = parseJobListQuery(req.query as Record<string, unknown>);
  const conds = [eq(jobsTable.isActive, true)];
  if (filters.q) {
    const like = `%${filters.q}%`;
    conds.push(or(ilike(jobsTable.title, like), ilike(jobsTable.description, like), ilike(jobsTable.company, like))!);
  }
  if (filters.type) conds.push(eq(jobsTable.type, filters.type));
  if (filters.location) conds.push(ilike(jobsTable.location, `%${filters.location}%`));
  if (filters.skill) conds.push(sql`${filters.skill} = ANY(${jobsTable.skills})`);

  const rows = await db
    .select({
      job: jobsTable,
      applicants: sql<number>`(SELECT count(*) FROM ${jobApplicationsTable} WHERE ${jobApplicationsTable.jobId} = ${jobsTable.id})`,
      applied: appliedSelect,
    })
    .from(jobsTable)
    .where(and(...conds))
    .orderBy(desc(jobsTable.createdAt))
    .limit(100);

  res.json({
    success: true,
    data: rows.map((r) =>
      jobToClientJson({ ...r.job, applicants: Number(r.applicants), applied: Boolean(r.applied) }),
    ),
  });
});

// GET /jobs/mine — the caller's postings (active + closed) with applicant counts.
router.get("/jobs/mine", authenticate, async (req: Request, res: Response): Promise<void> => {
  const rows = await db
    .select({
      job: jobsTable,
      applicants: sql<number>`(SELECT count(*) FROM ${jobApplicationsTable} WHERE ${jobApplicationsTable.jobId} = ${jobsTable.id})`,
      pending: sql<number>`(SELECT count(*) FROM ${jobApplicationsTable} WHERE ${jobApplicationsTable.jobId} = ${jobsTable.id} AND ${jobApplicationsTable.status} = 'PENDING')`,
    })
    .from(jobsTable)
    .where(eq(jobsTable.postedById, req.user!.id))
    .orderBy(desc(jobsTable.createdAt));

  res.json({
    success: true,
    data: rows.map((r) => ({
      ...jobToClientJson({ ...r.job, applicants: Number(r.applicants) }),
      pending: Number(r.pending),
    })),
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

// POST /jobs — any signed-in user can post a role (the Real Jobs marketplace).
router.post("/jobs", authenticate, async (req: Request, res: Response): Promise<void> => {
  const body = req.body || {};
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!title || title.length > MAX_TITLE_LEN) {
    res.status(400).json({ success: false, message: `Job title is required (max ${MAX_TITLE_LEN} characters).` });
    return;
  }
  if (!description || description.length > MAX_DESCRIPTION_LEN) {
    res.status(400).json({ success: false, message: `A job description is required (max ${MAX_DESCRIPTION_LEN} characters).` });
    return;
  }
  const company =
    typeof body.company === "string" && body.company.trim()
      ? body.company.trim().slice(0, 120)
      : `${req.user!.firstName} ${req.user!.lastName}`.trim();
  const type = isValidJobType(body.type) ? body.type : "Full-time";
  const location = typeof body.location === "string" ? body.location.trim().slice(0, 120) || null : null;
  const salaryRange = typeof body.salaryRange === "string" ? body.salaryRange.trim().slice(0, 80) || null : null;
  const link = typeof body.link === "string" && /^https?:\/\//i.test(body.link.trim()) ? body.link.trim().slice(0, 400) : null;
  const skills = normalizeSkillInput(body.skills);

  let applicationDeadline: Date | null = null;
  if (typeof body.applicationDeadline === "string" && body.applicationDeadline) {
    const d = new Date(body.applicationDeadline);
    if (Number.isNaN(d.getTime())) {
      res.status(400).json({ success: false, message: "Application deadline must be a valid date." });
      return;
    }
    applicationDeadline = d;
  }

  const [job] = await db
    .insert(jobsTable)
    .values({
      title,
      company,
      location,
      type,
      salaryRange,
      description,
      skills,
      link,
      postedById: req.user!.id,
      applicationDeadline,
    })
    .returning();

  res.status(201).json({ success: true, message: "Job posted", data: jobToClientJson(job) });
});

// GET /jobs/:id — single job detail (caller-aware).
router.get("/jobs/:id", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const applicantId = req.user ? req.user.id : null;
  const [row] = await db
    .select({
      job: jobsTable,
      applicants: sql<number>`(SELECT count(*) FROM ${jobApplicationsTable} WHERE ${jobApplicationsTable.jobId} = ${jobsTable.id})`,
      applied: applicantId
        ? sql<boolean>`EXISTS(SELECT 1 FROM ${jobApplicationsTable} WHERE ${jobApplicationsTable.jobId} = ${jobsTable.id} AND ${jobApplicationsTable.applicantId} = ${applicantId})`
        : sql<boolean>`false`,
    })
    .from(jobsTable)
    .where(eq(jobsTable.id, String(req.params.id)))
    .limit(1);
  if (!row) {
    res.status(404).json({ success: false, message: "Job not found" });
    return;
  }
  res.json({
    success: true,
    data: jobToClientJson({ ...row.job, applicants: Number(row.applicants), applied: Boolean(row.applied) }),
  });
});

// PATCH /jobs/:id — poster (or admin) edits a job or toggles is_active.
router.patch("/jobs/:id", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, String(req.params.id))).limit(1);
  if (!job) {
    res.status(404).json({ success: false, message: "Job not found" });
    return;
  }
  if (!canManageJob(job, req.user!)) {
    res.status(403).json({ success: false, message: "You can only manage jobs you posted." });
    return;
  }

  const body = req.body || {};
  const patch: Partial<typeof jobsTable.$inferInsert> = {};
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim().slice(0, MAX_TITLE_LEN);
  if (typeof body.description === "string" && body.description.trim()) patch.description = body.description.trim().slice(0, MAX_DESCRIPTION_LEN);
  if (typeof body.company === "string" && body.company.trim()) patch.company = body.company.trim().slice(0, 120);
  if (typeof body.location === "string") patch.location = body.location.trim().slice(0, 120) || null;
  if (typeof body.salaryRange === "string") patch.salaryRange = body.salaryRange.trim().slice(0, 80) || null;
  if (isValidJobType(body.type)) patch.type = body.type;
  if (Array.isArray(body.skills)) patch.skills = normalizeSkillInput(body.skills);
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
  if (typeof body.link === "string") {
    patch.link = /^https?:\/\//i.test(body.link.trim()) ? body.link.trim().slice(0, 400) : null;
  }
  if (body.applicationDeadline !== undefined) {
    if (body.applicationDeadline === null || body.applicationDeadline === "") patch.applicationDeadline = null;
    else {
      const d = new Date(body.applicationDeadline);
      if (Number.isNaN(d.getTime())) {
        res.status(400).json({ success: false, message: "Application deadline must be a valid date." });
        return;
      }
      patch.applicationDeadline = d;
    }
  }
  if (!Object.keys(patch).length) {
    res.status(400).json({ success: false, message: "Nothing to update." });
    return;
  }

  const [updated] = await db
    .update(jobsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(jobsTable.id, job.id))
    .returning();
  res.json({ success: true, message: "Job updated", data: jobToClientJson(updated) });
});

// DELETE /jobs/:id — poster (or admin) removes a job; applications cascade.
router.delete("/jobs/:id", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, String(req.params.id))).limit(1);
  if (!job) {
    res.status(404).json({ success: false, message: "Job not found" });
    return;
  }
  if (!canManageJob(job, req.user!)) {
    res.status(403).json({ success: false, message: "You can only manage jobs you posted." });
    return;
  }
  await db.delete(jobsTable).where(eq(jobsTable.id, job.id));
  res.json({ success: true, message: "Job deleted" });
});

// POST /jobs/:id/apply — submit an application for a job.
router.post("/jobs/:id/apply", authenticate, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const { message } = req.body || {};
  const coverLetter = typeof message === "string" ? message.trim().slice(0, 2000) || null : null;

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
    .values({ jobId: id, applicantId: req.user!.id, message: coverLetter })
    .returning();

  if (job.postedById) {
    await notify(
      job.postedById,
      "JOB_APPLICATION",
      "New job application",
      `${req.user!.firstName}${req.user!.lastName ? ` ${req.user!.lastName}` : ""} applied to "${job.title}".`,
      "/jobs?mine=1",
      req.app?.get("io"),
    );
  }

  res.status(201).json({
    success: true,
    message: "Application submitted",
    data: { applicationId: application.id, status: application.status },
  });
});

// DELETE /jobs/applications/:id — applicant withdraws their own application.
router.delete("/jobs/applications/:id", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [row] = await db
    .select()
    .from(jobApplicationsTable)
    .where(eq(jobApplicationsTable.id, String(req.params.id)))
    .limit(1);
  if (!row) {
    res.status(404).json({ success: false, message: "Application not found" });
    return;
  }
  if (row.applicantId !== req.user!.id) {
    res.status(403).json({ success: false, message: "You can only withdraw your own applications." });
    return;
  }
  if (row.status === "ACCEPTED") {
    res.status(400).json({ success: false, message: "This application was already accepted. Ask the employer to close it." });
    return;
  }
  await db.delete(jobApplicationsTable).where(eq(jobApplicationsTable.id, row.id));
  res.json({ success: true, message: "Application withdrawn" });
});

// GET /jobs/:id/applications — poster (or admin) reviews applicants.
router.get("/jobs/:id/applications", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, String(req.params.id))).limit(1);
  if (!job) {
    res.status(404).json({ success: false, message: "Job not found" });
    return;
  }
  if (!canManageJob(job, req.user!)) {
    res.status(403).json({ success: false, message: "Only the employer can review applications." });
    return;
  }

  const rows = await db
    .select({
      application: jobApplicationsTable,
      applicant: {
        id: usersTable.id,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        city: usersTable.city,
        profilePhoto: usersTable.profilePhoto,
        tagline: usersTable.tagline,
        skillsOffered: usersTable.skillsOffered,
      },
    })
    .from(jobApplicationsTable)
    .innerJoin(usersTable, eq(jobApplicationsTable.applicantId, usersTable.id))
    .where(eq(jobApplicationsTable.jobId, job.id))
    .orderBy(desc(jobApplicationsTable.createdAt));

  res.json({
    success: true,
    data: rows.map((r) => ({
      id: r.application.id,
      status: r.application.status,
      message: r.application.message,
      createdAt: r.application.createdAt,
      applicant: {
        id: r.applicant.id,
        name: `${r.applicant.firstName} ${r.applicant.lastName}`.trim(),
        city: r.applicant.city,
        profilePhoto: r.applicant.profilePhoto,
        tagline: r.applicant.tagline,
        skillsOffered: r.applicant.skillsOffered,
      },
    })),
  });
});

// PATCH /jobs/applications/:id — poster (or admin) updates application status.
router.patch("/jobs/applications/:id", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [row] = await db
    .select({ application: jobApplicationsTable, job: jobsTable })
    .from(jobApplicationsTable)
    .innerJoin(jobsTable, eq(jobApplicationsTable.jobId, jobsTable.id))
    .where(eq(jobApplicationsTable.id, String(req.params.id)))
    .limit(1);
  if (!row) {
    res.status(404).json({ success: false, message: "Application not found" });
    return;
  }
  if (!canManageJob(row.job, req.user!)) {
    res.status(403).json({ success: false, message: "Only the employer can review applications." });
    return;
  }
  const status = String(req.body?.status || "").toUpperCase();
  if (!["REVIEWED", "ACCEPTED", "REJECTED"].includes(status)) {
    res.status(400).json({ success: false, message: "Status must be REVIEWED, ACCEPTED or REJECTED." });
    return;
  }

  const [updated] = await db
    .update(jobApplicationsTable)
    .set({ status: status as "REVIEWED" | "ACCEPTED" | "REJECTED" })
    .where(eq(jobApplicationsTable.id, row.application.id))
    .returning();

  const jobTitle = row.job.title;
  await notify(
    row.application.applicantId,
    "JOB_APPLICATION_UPDATE",
    status === "ACCEPTED" ? "Application accepted" : status === "REJECTED" ? "Application update" : "Application reviewed",
    status === "ACCEPTED"
      ? `Good news — you were accepted for "${jobTitle}".`
      : status === "REJECTED"
        ? `The employer moved on from your application for "${jobTitle}".`
        : `The employer reviewed your application for "${jobTitle}".`,
    "/jobs?tab=applied",
    req.app?.get("io"),
  );

  res.json({ success: true, message: "Application updated", data: { id: updated.id, status: updated.status } });
});

export default router;
export { JOB_TYPES };
