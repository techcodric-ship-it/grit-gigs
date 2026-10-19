// /api/prep router. Mounted from src/app.ts (src/routes/index.ts is off-limits
// while the Focus Rooms work is in progress). FEATURE_PREP gates everything
// except GET /flag, which the nav uses to decide whether to inject the icon.

import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { authenticate } from "../middlewares/authenticate";
import { adminAuth } from "../middlewares/adminAuth";
import { uploadToSupabase } from "../lib/storage";
import { isPrepEnabled } from "./feature";
import { ensurePrepDb } from "./db";
import { resolveCompany, createPendingCompany, slugifyCompanyName } from "./companies";
import { gatherSourcesWithBudget } from "./sources/gather";
import { summarizeReport } from "./ai";
import { APTITUDE_TOPICS, prepAptitudeQuestionsTable, prepInterviewQuestionsTable } from "./schema";
import { clampCount, pickQuiz, scoreQuiz, signQuizToken, toPublicQuestion, verifyQuizToken } from "./aptitude";
import {
  PROOF_FILE_MAX_BYTES,
  isAllowedProofMime,
  normalizeMultipartFields,
  parseProofSubmission,
  publicSubmission,
  reviewDecisionSchema,
} from "./proof";
import {
  companyExists,
  insertSubmission,
  listApprovedPayRows,
  listApprovedPlacementRows,
  listMySubmissions,
  listPendingSubmissions,
} from "./proof-db";
import {
  PREP_PRO_DAYS,
  PREP_PRO_PRICE_INR,
  canGenerateReport,
  isEntitlementActive,
  resolveFreeDailyReports,
} from "./monetization";
import {
  completeProOrder,
  countReportsLast24h,
  createProPendingOrder,
  findProOrder,
  getActiveEntitlement,
  reviewAndAward,
} from "./monetization-db";
import { buildPayAggregate, buildPlacementAggregate, resolveMinSample } from "./aggregates";
import {
  INTERVIEW_CATEGORIES,
  INTERVIEW_TRACKS,
  MOCK_DEFAULT_COUNT,
  aggregateFeedback,
  isValidCategory,
  isValidTrack,
  pickMock,
  signInterviewMock,
  toPublicInterviewQuestion,
  verifyInterviewMock,
} from "./interview";
import {
  buildReportSkeleton,
  createReport,
  findCompanyBySlug,
  getReportById,
  latestReportForCompany,
  listRecentReportsForUser,
  publicReport,
  updateReportAi,
} from "./reports";

export const prepRouter = Router();

// Cheap public probe for the nav; must answer even while Prep is disabled.
// paymentsConfigured tells the UI (and ops) whether checkout can run at all —
// a boolean only, never any credential.
prepRouter.get("/flag", (_req: Request, res: Response): void => {
  res.json({ success: true, data: { enabled: isPrepEnabled(), paymentsConfigured: razorpayConfigured() } });
});

// Everything below is invisible while the flag is off: 404, not 403, so the
// feature is not advertised to users or crawlers.
prepRouter.use((_req: Request, res: Response, next: NextFunction): void => {
  if (!isPrepEnabled()) {
    res.status(404).json({ success: false, message: "Not found" });
    return;
  }
  next();
});

const prepDbGate = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await ensurePrepDb();
    next();
  } catch (err) {
    console.error("[prep] database not ready:", err);
    res.status(503).json({ success: false, message: "Prep is temporarily unavailable" });
  }
};

const companiesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, try again shortly." },
});

const searchQuery = z.object({ q: z.string().min(1).max(200) });

prepRouter.get("/companies", companiesLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  const parsed = searchQuery.safeParse({ q: String(req.query.q ?? "") });
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Query q (1-200 chars) is required" });
    return;
  }
  try {
    const matches = await resolveCompany(db, parsed.data.q);
    // Fresh databases have no rows, and a dead-end search is a broken product:
    // every valid query always gets at least one candidate — the typed name
    // itself. The report flow provisions the real PENDING row lazily, only
    // when the candidate is actually opened, so stray searches don't litter
    // prep_companies.
    if (!matches.length) {
      const typed = parsed.data.q.trim().slice(0, 200);
      matches.push({
        id: "",
        slug: slugifyCompanyName(typed) || "company",
        name: typed,
        domain: null,
        status: "NEW",
        score: 0,
      });
    }
    res.json({ success: true, data: { matches, needsCreation: false } });
  } catch (err) {
    console.error("[prep] company search failed:", err);
    res.status(500).json({ success: false, message: "Company search failed" });
  }
});

const createCompanyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, try again shortly." },
});

const createBody = z.object({
  name: z.string().min(2).max(200),
  website: z.string().max(500).optional(),
  domain: z.string().max(200).optional(),
});

prepRouter.post("/companies", authenticate, createCompanyLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  const parsed = createBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "name (2-200 chars) is required" });
    return;
  }
  try {
    const company = await createPendingCompany(db, {
      name: parsed.data.name,
      website: parsed.data.website ?? null,
      domain: parsed.data.domain ?? null,
      createdBy: req.user!.id,
    });
    res.status(201).json({
      success: true,
      data: { company: { id: company.id, slug: company.slug, name: company.name, status: company.status } },
    });
  } catch (err) {
    console.error("[prep] company create failed:", err);
    res.status(500).json({ success: false, message: "Could not save the company" });
  }
});

// ---- Company reports ----

const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many report requests, try again shortly." },
});

const reportBody = z.object({
  slug: z.string().min(1).max(160),
  role: z.string().max(120).optional(),
  userType: z.enum(["job-seeker", "student", "employee"]).optional(),
});

// Free-tier quota: rolling 24h generations for non-Pro users, enforced on
// BOTH creation routes. Cached report reads are free.
async function checkReportQuota(
  userId: string,
): Promise<{ ok: true } | { ok: false; used: number; limit: number }> {
  const entitlement = await getActiveEntitlement(userId);
  if (isEntitlementActive(entitlement)) return { ok: true };
  const limit = resolveFreeDailyReports(process.env.PREP_FREE_DAILY_REPORTS);
  const used = await countReportsLast24h(userId);
  if (canGenerateReport(used, false, limit)) return { ok: true };
  return { ok: false, used, limit };
}

function quotaResponse(res: Response, used: number, limit: number): void {
  res.status(402).json({
    success: false,
    code: "UPGRADE_REQUIRED",
    used,
    limit,
    message:
      `Free plan allows ${limit} report generations per day (${used} used). ` +
      "Upgrade to Prep Pro for unlimited reports.",
  });
}

prepRouter.post("/reports", authenticate, reportLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  const parsed = reportBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "slug is required" });
    return;
  }
  try {
    const quota = await checkReportQuota(req.user!.id);
    if (!quota.ok) {
      quotaResponse(res, quota.used, quota.limit);
      return;
    }
    const company = await findCompanyBySlug(parsed.data.slug);
    if (!company) {
      res.status(404).json({ success: false, message: "Company not found" });
      return;
    }
    const gathered = await gatherSourcesWithBudget(
      {
        name: company.name,
        domain: company.domain,
        website: company.website,
      },
      12_000,
    );
    const skeleton = buildReportSkeleton(company, gathered, {
      role: parsed.data.role ?? null,
      userType: parsed.data.userType ?? null,
    });
    const report = await createReport({
      companyId: company.id,
      role: parsed.data.role ?? null,
      userType: parsed.data.userType ?? null,
      skeleton,
      createdBy: req.user!.id,
    });
    const ai = await summarizeReport({ company: { name: company.name }, role: report.role, gathered });
    if (ai) {
      const updated = await updateReportAi(report.id, { summary: ai.summary, model: ai.model });
      if (updated) {
        report.aiSummary = updated.aiSummary;
        report.aiModel = updated.aiModel;
      }
    }
    res.status(201).json({ success: true, data: { report: publicReport(report) } });
  } catch (err) {
    console.error("[prep] report create failed:", err);
    res.status(500).json({ success: false, message: "Report generation failed" });
  }
});

prepRouter.get("/reports/:id", authenticate, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const report = await getReportById(String(req.params.id));
    if (!report) {
      res.status(404).json({ success: false, message: "Report not found" });
      return;
    }
    // Owner-only in v1 (no public sharing yet).
    if (report.createdBy && report.createdBy !== req.user!.id && req.user!.role !== "ADMIN") {
      res.status(404).json({ success: false, message: "Report not found" });
      return;
    }
    res.json({ success: true, data: { report: publicReport(report) } });
  } catch (err) {
    console.error("[prep] report fetch failed:", err);
    res.status(500).json({ success: false, message: "Report fetch failed" });
  }
});

// Signed-in user's own report history for the home page "Recent reports" rail.
prepRouter.get("/my/reports", authenticate, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const reports = await listRecentReportsForUser(req.user!.id, 10);
    res.json({ success: true, data: { reports } });
  } catch (err) {
    console.error("[prep] recent reports failed:", err);
    res.status(500).json({ success: false, message: "Could not load recent reports" });
  }
});

prepRouter.get("/companies/:slug/report", authenticate, reportLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    let company = await findCompanyBySlug(String(req.params.slug));
    if (!company) {
      // Search-led arrival for a company that has no row yet: open it
      // straight into a PENDING company and generate the report as usual.
      // Stale links (old cached search pages, shared URLs) arrive WITHOUT
      // ?name= — deriving the name from the slug itself makes every such URL
      // self-heal: "infosys-bpm" -> "infosys bpm". An exact-name row another
      // request created meanwhile is reused instead of duplicated.
      const queryName = typeof req.query.name === "string" ? req.query.name.trim().slice(0, 200) : "";
      const nameParam =
        queryName.length >= 2
          ? queryName
          : String(req.params.slug).replace(/[-_]+/g, " ").trim().slice(0, 200);
      if (nameParam.length >= 2) {
        const exact = (await resolveCompany(db, nameParam)).find((c) => c.score === 3);
        if (exact) {
          company = await findCompanyBySlug(exact.slug);
        }
        if (!company) {
          company = await createPendingCompany(db, { name: nameParam, createdBy: req.user!.id });
        }
      } else {
        res.status(404).json({ success: false, message: "Company not found" });
        return;
      }
    }
    const role = typeof req.query.role === "string" && req.query.role.trim() ? req.query.role.trim() : null;
    const existing = await latestReportForCompany(company.id, role);
    if (existing) {
      res.json({ success: true, data: { report: publicReport(existing), cached: true } });
      return;
    }
    const quota = await checkReportQuota(req.user!.id);
    if (!quota.ok) {
      quotaResponse(res, quota.used, quota.limit);
      return;
    }
    // 12s hard budget: a report must render even when sources are slow.
    const gathered = await gatherSourcesWithBudget(
      {
        name: company.name,
        domain: company.domain,
        website: company.website,
      },
      12_000,
    );
    const skeleton = buildReportSkeleton(company, gathered, { role, userType: null });
    const report = await createReport({
      companyId: company.id,
      role,
      userType: null,
      skeleton,
      createdBy: req.user!.id,
    });
    const ai = await summarizeReport({ company: { name: company.name }, role: report.role, gathered });
    if (ai) {
      const updated = await updateReportAi(report.id, { summary: ai.summary, model: ai.model });
      if (updated) {
        report.aiSummary = updated.aiSummary;
        report.aiModel = updated.aiModel;
      }
    }
    res.status(201).json({ success: true, data: { report: publicReport(report), cached: false } });
  } catch (err) {
    console.error("[prep] latest report failed:", err);
    res.status(500).json({ success: false, message: "Report generation failed" });
  }
});

// ---- Aptitude practice (Phase 5) ----
// Quiz endpoints are flag-gated + rate-limited. Correct answers never leave
// the server before submit; the quiz rides in a 10-minute signed JWT.

const quizSecret = (): string => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET not configured");
  return s;
};

const aptitudeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many quiz requests, try again shortly." },
});

prepRouter.get("/aptitude/topics", prepDbGate, async (_req: Request, res: Response): Promise<void> => {
  try {
    const rows = await db
      .select({
        topic: prepAptitudeQuestionsTable.topic,
        count: sql<number>`count(*)::int`,
      })
      .from(prepAptitudeQuestionsTable)
      .groupBy(prepAptitudeQuestionsTable.topic);
    const topics = APTITUDE_TOPICS.map((t) => ({
      topic: t,
      count: rows.find((r) => r.topic === t)?.count ?? 0,
    })).filter((t) => t.count > 0);
    res.json({ success: true, data: { topics } });
  } catch (err) {
    console.error("[prep] aptitude topics failed:", err);
    res.status(500).json({ success: false, message: "Could not load topics" });
  }
});

prepRouter.get("/aptitude/quiz", aptitudeLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const rawTopic = typeof req.query.topic === "string" ? req.query.topic : "";
    const topic = (APTITUDE_TOPICS as readonly string[]).includes(rawTopic) ? rawTopic : null;
    const requested = clampCount(req.query.count, 20);
    const rows = await db
      .select()
      .from(prepAptitudeQuestionsTable)
      .where(topic ? eq(prepAptitudeQuestionsTable.topic, topic) : sql`1=1`);
    if (!rows.length) {
      res.status(404).json({ success: false, message: "No questions available" });
      return;
    }
    const picked = pickQuiz(rows, Math.min(requested, rows.length));
    const ids = picked.map((r) => r.id);
    const token = signQuizToken({ ids, topic }, quizSecret());
    res.json({
      success: true,
      data: { questions: picked.map(toPublicQuestion), token, total: picked.length },
    });
  } catch (err) {
    console.error("[prep] aptitude quiz failed:", err);
    res.status(500).json({ success: false, message: "Could not build the quiz" });
  }
});

const submitBody = z.object({
  token: z.string().min(1).max(4000),
  answers: z.record(z.string(), z.number().int().min(0).max(20)),
});

prepRouter.post("/aptitude/submit", aptitudeLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  const parsed = submitBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "token and answers are required" });
    return;
  }
  try {
    const payload = verifyQuizToken(parsed.data.token, quizSecret());
    if (!payload) {
      res.status(400).json({ success: false, message: "Quiz expired or invalid — start again" });
      return;
    }
    const rows = await db
      .select()
      .from(prepAptitudeQuestionsTable)
      .where(inArray(prepAptitudeQuestionsTable.id, payload.ids));
    const score = scoreQuiz(rows, parsed.data.answers, payload.ids);
    res.json({ success: true, data: score });
  } catch (err) {
    console.error("[prep] aptitude submit failed:", err);
    res.status(500).json({ success: false, message: "Scoring failed" });
  }
});

// ---- Interview prep + mock (Phase 6) ----

const interviewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many interview requests, try again shortly." },
});

prepRouter.get("/interview/questions", interviewLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const track = isValidTrack(req.query.track) ? req.query.track : null;
    const category = isValidCategory(req.query.category) ? req.query.category : null;
    const rows = await db.select().from(prepInterviewQuestionsTable);
    // Small bank: filter in JS so validation and ordering stay in one place.
    const filtered = rows.filter(
      (r) => (!track || r.track === track) && (!category || r.category === category),
    );
    filtered.sort((a, b) => a.code.localeCompare(b.code));
    res.json({
      success: true,
      data: {
        tracks: INTERVIEW_TRACKS,
        categories: INTERVIEW_CATEGORIES,
        questions: filtered,
      },
    });
  } catch (err) {
    console.error("[prep] interview questions failed:", err);
    res.status(500).json({ success: false, message: "Could not load questions" });
  }
});

prepRouter.get("/interview/mock", interviewLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const track = isValidTrack(req.query.track) ? req.query.track : null;
    const rows = await db
      .select()
      .from(prepInterviewQuestionsTable)
      .where(track ? eq(prepInterviewQuestionsTable.track, track) : sql`1=1`);
    if (!rows.length) {
      res.status(404).json({ success: false, message: "No interview questions available" });
      return;
    }
    const picked = pickMock(rows, req.query.count ?? MOCK_DEFAULT_COUNT);
    const ids = picked.map((r) => r.id);
    const token = signInterviewMock(ids, track, quizSecret());
    res.json({
      success: true,
      data: { questions: picked.map(toPublicInterviewQuestion), token, total: picked.length },
    });
  } catch (err) {
    console.error("[prep] interview mock failed:", err);
    res.status(500).json({ success: false, message: "Could not build the mock session" });
  }
});

const mockSubmitBody = z.object({
  token: z.string().min(1).max(4000),
  ratings: z.record(z.string(), z.number().int().min(1).max(5)).default({}),
});

prepRouter.post("/interview/mock/submit", interviewLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  const parsed = mockSubmitBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "token and ratings (1-5) are required" });
    return;
  }
  try {
    const payload = verifyInterviewMock(parsed.data.token, quizSecret());
    if (!payload) {
      res.status(400).json({ success: false, message: "Mock session expired or invalid � start again" });
      return;
    }
    const rows = await db
      .select()
      .from(prepInterviewQuestionsTable)
      .where(inArray(prepInterviewQuestionsTable.id, payload.ids));
    const publicRows = rows.map((r) => ({
      ...toPublicInterviewQuestion(r),
      guidance: r.guidance,
    }));
    const feedback = aggregateFeedback(publicRows, parsed.data.ratings, payload.ids);
    res.json({ success: true, data: feedback });
  } catch (err) {
    console.error("[prep] interview submit failed:", err);
    res.status(500).json({ success: false, message: "Feedback generation failed" });
  }
});

// ---- Proof / evidence pipeline (Phase 7) ----
// Raw evidence (optional file) is stored server-side only, never returned to
// clients, and auto-deleted after 30 days by runEvidenceRetention. Aggregates
// (Phase 8) only count APPROVED rows.

const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PROOF_FILE_MAX_BYTES, files: 1 },
});

const proofSubmitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many proof submissions � try again shortly." },
});

const proofListLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, try again shortly." },
});

prepRouter.post("/proof", authenticate, proofSubmitLimiter, prepDbGate, proofUpload.single("file"), async (req: Request, res: Response): Promise<void> => {
  const parsed = parseProofSubmission(normalizeMultipartFields((req.body ?? {}) as Record<string, unknown>));
  if (!parsed.ok) {
    res.status(400).json({ success: false, message: parsed.message });
    return;
  }
  const file = req.file;
  if (file) {
    if (!isAllowedProofMime(file.mimetype)) {
      res.status(400).json({ success: false, message: "File must be a PDF, PNG, JPEG or WEBP" });
      return;
    }
    if (file.size > PROOF_FILE_MAX_BYTES) {
      res.status(400).json({ success: false, message: "File must be 5 MB or smaller" });
      return;
    }
  }
  try {
    if (!(await companyExists(parsed.value.companyId))) {
      res.status(404).json({ success: false, message: "Company not found" });
      return;
    }
    let filePath: string | null = null;
    if (file) {
      const url = await uploadToSupabase(file.buffer, file.originalname, "proof-evidence");
      if (!url) {
        res.status(502).json({ success: false, message: "Evidence storage is unavailable � try again without the file" });
        return;
      }
      filePath = url;
    }
    const row = await insertSubmission(parsed.value, { submittedBy: req.user!.id, filePath });
    res.status(201).json({ success: true, data: { submission: publicSubmission(row) } });
  } catch (err) {
    console.error("[prep] proof submit failed:", err);
    res.status(500).json({ success: false, message: "Submission failed" });
  }
});

prepRouter.get("/proof/my", authenticate, proofListLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const rows = await listMySubmissions(req.user!.id);
    res.json({ success: true, data: { submissions: rows.map(publicSubmission) } });
  } catch (err) {
    console.error("[prep] proof list failed:", err);
    res.status(500).json({ success: false, message: "Could not load submissions" });
  }
});

prepRouter.get("/proof/pending", adminAuth, prepDbGate, async (_req: Request, res: Response): Promise<void> => {
  try {
    const rows = await listPendingSubmissions();
    res.json({ success: true, data: { submissions: rows.map(publicSubmission) } });
  } catch (err) {
    console.error("[prep] proof pending failed:", err);
    res.status(500).json({ success: false, message: "Could not load queue" });
  }
});

prepRouter.post("/proof/:id/review", adminAuth, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  const parsed = reviewDecisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "decision must be APPROVED or REJECTED" });
    return;
  }
  try {
    const updated = await reviewAndAward(
      String(req.params.id),
      parsed.data.decision,
      parsed.data.note ?? null,
      null, // adminAuth does not carry a user id (raw key or role token)
    );
    if (!updated) {
      res.status(404).json({ success: false, message: "Submission not found or already reviewed" });
      return;
    }
    res.json({ success: true, data: { submission: publicSubmission(updated) } });
  } catch (err) {
    console.error("[prep] proof review failed:", err);
    res.status(500).json({ success: false, message: "Review failed" });
  }
});

// ---- Aggregates over approved proof (Phase 8) ----
// PROOF_MIN_SAMPLE is enforced inside the pure builders � the endpoint never
// assembles a response that could bypass it.

const aggregateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, try again shortly." },
});

prepRouter.get("/companies/:slug/pay-aggregates", aggregateLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const company = await findCompanyBySlug(String(req.params.slug));
    if (!company) {
      res.status(404).json({ success: false, message: "Company not found" });
      return;
    }
    const rows = await listApprovedPayRows(company.id);
    const aggregate = buildPayAggregate(rows, resolveMinSample(process.env.PROOF_MIN_SAMPLE));
    res.json({ success: true, data: { company: { name: company.name, slug: company.slug }, aggregate } });
  } catch (err) {
    console.error("[prep] pay aggregates failed:", err);
    res.status(500).json({ success: false, message: "Aggregates unavailable" });
  }
});

prepRouter.get("/companies/:slug/placement-aggregates", aggregateLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const company = await findCompanyBySlug(String(req.params.slug));
    if (!company) {
      res.status(404).json({ success: false, message: "Company not found" });
      return;
    }
    const rows = await listApprovedPlacementRows(company.id);
    const aggregate = buildPlacementAggregate(rows, resolveMinSample(process.env.PROOF_MIN_SAMPLE));
    res.json({ success: true, data: { company: { name: company.name, slug: company.slug }, aggregate } });
  } catch (err) {
    console.error("[prep] placement aggregates failed:", err);
    res.status(500).json({ success: false, message: "Aggregates unavailable" });
  }
});

// ---- Prep Pro (Phase 9) ----
// Paid exclusively through Razorpay: /pro/order creates a gateway order held
// as a PENDING PREP_PRO transaction, and /pro/verify grants the entitlement
// ONLY after Razorpay confirms the payment was captured against that exact
// order and amount (server-side — the client is never trusted). There is no
// wallet path: clicking without paying never activates anything.

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

function razorpayConfigured(): boolean {
  return !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
}

const proLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, try again shortly." },
});

const purchaseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many purchase attempts, try again shortly." },
});

prepRouter.get("/pro/status", authenticate, proLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const entitlement = await getActiveEntitlement(req.user!.id);
    const isPro = isEntitlementActive(entitlement);
    const limit = resolveFreeDailyReports(process.env.PREP_FREE_DAILY_REPORTS);
    const used = isPro ? 0 : await countReportsLast24h(req.user!.id);
    res.json({
      success: true,
      data: {
        isPro,
        expiresAt: isPro && entitlement ? entitlement.expiresAt : null,
        priceInr: PREP_PRO_PRICE_INR,
        days: PREP_PRO_DAYS,
        freeDailyReports: limit,
        reportsUsed: used,
        reportsRemaining: Math.max(0, limit - used),
      },
    });
  } catch (err) {
    console.error("[prep] pro status failed:", err);
    res.status(500).json({ success: false, message: "Could not load Prep Pro status" });
  }
});

prepRouter.post("/pro/order", authenticate, purchaseLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!razorpayConfigured()) {
      res.status(503).json({ success: false, message: "Payment gateway not configured" });
      return;
    }
    const active = await getActiveEntitlement(req.user!.id);
    if (active && isEntitlementActive(active)) {
      res.status(409).json({ success: false, message: "Prep Pro is already active on your account." });
      return;
    }
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    const rzResp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: Math.round(PREP_PRO_PRICE_INR * 100),
        currency: "INR",
        receipt: `prep_pro_${Date.now()}`,
        notes: { purpose: "prep_pro" },
      }),
      // Never let a slow gateway hold the checkout button hostage: 15s hard cap.
      signal: AbortSignal.timeout(15000),
    });
    if (!rzResp.ok) {
      res.status(502).json({ success: false, message: "Could not start checkout" });
      return;
    }
    const order = await rzResp.json() as { id: string };
    // PENDING row maps the gateway order to this user — verify and webhooks
    // resolve through it; the amount lives HERE, never in the client.
    await createProPendingOrder(req.user!.id, order.id);
    res.json({ success: true, data: { order, key: RAZORPAY_KEY_ID, priceInr: PREP_PRO_PRICE_INR } });
  } catch (err) {
    console.error("[prep] pro order failed:", err);
    const timedOut = (err as { name?: string }).name === "TimeoutError";
    res
      .status(502)
      .json({ success: false, message: timedOut ? "Payment gateway timed out. Please try again." : "Could not start checkout" });
  }
});

prepRouter.post("/pro/verify", authenticate, purchaseLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  const { razorpayOrderId, razorpayPaymentId } = req.body as { razorpayOrderId?: string; razorpayPaymentId?: string };
  if (!razorpayConfigured()) {
    res.status(503).json({ success: false, message: "Payment gateway not configured" });
    return;
  }
  if (!razorpayOrderId || !razorpayPaymentId) {
    res.status(400).json({ success: false, message: "Missing payment details" });
    return;
  }
  try {
    const txn = await findProOrder(razorpayOrderId, req.user!.id);
    if (!txn) {
      res.status(404).json({ success: false, message: "Payment order not found" });
      return;
    }
    if (txn.status === "COMPLETED") {
      res.json({ success: true, message: "Already processed" });
      return;
    }

    // Server-side verify with Razorpay — never trust the client. A payment
    // that cannot be confirmed as captured must never activate Prep Pro.
    const amtInr = Number(txn.amount);
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    const pmtResp = await fetch(`https://api.razorpay.com/v1/payments/${razorpayPaymentId}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!pmtResp.ok) {
      res.status(502).json({ success: false, message: "Unable to verify payment with Razorpay" });
      return;
    }
    const payment = await pmtResp.json() as { status: string; amount: number; order_id: string };
    if (payment.status !== "captured") {
      res.status(400).json({ success: false, message: "Payment not captured" });
      return;
    }
    if (payment.order_id !== razorpayOrderId) {
      res.status(400).json({ success: false, message: "Order mismatch" });
      return;
    }
    if (payment.amount !== Math.round(amtInr * 100)) {
      res.status(400).json({ success: false, message: "Amount mismatch" });
      return;
    }

    const result = await completeProOrder(req.user!.id, razorpayOrderId, razorpayPaymentId);
    if (result.ok) {
      res.status(201).json({
        success: true,
        data: {
          entitlement: {
            expiresAt: result.entitlement.expiresAt,
            pricePaidInr: result.entitlement.pricePaidInr,
          },
        },
      });
      return;
    }
    if (result.reason === "already-active") {
      res.status(409).json({ success: false, message: "Prep Pro is already active on your account." });
      return;
    }
    res.json({ success: true, message: "Already processed" });
  } catch (err) {
    console.error("[prep] pro verify failed:", err);
    const timedOut = (err as { name?: string }).name === "TimeoutError";
    res
      .status(502)
      .json({ success: false, message: timedOut ? "Payment gateway timed out. Please try again." : "Verification failed" });
  }
});
