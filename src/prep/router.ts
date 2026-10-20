// /api/prep router. Mounted from src/app.ts (src/routes/index.ts is off-limits
// while the Focus Rooms work is in progress). FEATURE_PREP gates everything
// except GET /flag, which the nav uses to decide whether to inject the icon.

import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import { count, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { authenticate } from "../middlewares/authenticate";
import { adminAuth } from "../middlewares/adminAuth";
import { uploadToSupabase } from "../lib/storage";
import { isPrepEnabled } from "./feature";
import { ensurePrepDb } from "./db";
import { resolveCompany, createPendingCompany, slugifyCompanyName } from "./companies";
import { gatherSourcesWithBudget } from "./sources/gather";
import {
  fallbackPlan,
  fallbackPlanQuestions,
  generateAnswerScores,
  generatePrepPlan,
  generatePrepQuestions,
  generateResumeCheck,
  summarizeReport,
  type AnswerScore,
  type PrepAiPlanPayload,
} from "./ai";
import { countAiPlanRequestsToday, getCachedAiPlan, recordAiPlanRequest, saveAiPlan } from "./ai-plans";
import { countResumeChecksToday, recordResumeCheck } from "./resume-checks";
import { countAnswerScoresToday, recordAnswerScore } from "./answer-scores";
import { PACKS_PER_USER_PER_DAY, countPackSubmissionsToday, findDuplicatePackQuestion, insertPackQuestion, listPackQuestions } from "./packs-db";
import { extractResumeText } from "./resume-text";
import { aptitudeWeights, trackForRole, weightsFromPlanTopics, type AptitudeWeights } from "./role-skills";
import { APTITUDE_TOPICS, prepAptitudeQuestionsTable, prepCompaniesTable, prepInterviewQuestionsTable, prepReportsTable } from "./schema";
import { clampCount, pickQuiz, pickQuizWeighted, scoreQuiz, signQuizToken, toPublicQuestion, verifyQuizToken } from "./aptitude";
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
  MOCK_DEFAULT_COUNT,
  SAMPLE_QUESTION_CODES,
  TODAY_DRILL_SIZE,
  aggregateFeedback,
  cleanPackText,
  dailyDrillCodes,
  dailyDrillQuestions,
  INTERVIEW_BANK,
  isValidCategory,
  isValidTrack,
  normalizePackQuestion,
  pickMock,
  sampleInterviewQuestions,
  signInterviewMock,
  summarizeAiScores,
  toPublicInterviewQuestion,
  utcDayIndex,
  utcDayLabel,
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

const statsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, try again shortly." },
});

// Public aggregates for the live counters on the prep pages — counts only,
// never anything row-level. The pages keep honest static fallbacks.
prepRouter.get("/stats", statsLimiter, prepDbGate, async (_req: Request, res: Response): Promise<void> => {
  try {
    const [companies] = await db.select({ n: count() }).from(prepCompaniesTable);
    const [reports] = await db.select({ n: count() }).from(prepReportsTable);
    const [aptitude] = await db.select({ n: count() }).from(prepAptitudeQuestionsTable);
    const [interview] = await db.select({ n: count() }).from(prepInterviewQuestionsTable);
    res.json({
      success: true,
      data: {
        companies: Number(companies.n ?? 0),
        reports: Number(reports.n ?? 0),
        aptitudeQuestions: Number(aptitude.n ?? 0),
        interviewQuestions: Number(interview.n ?? 0),
      },
    });
  } catch (err) {
    console.error("[prep] stats failed:", err);
    res.status(500).json({ success: false, message: "Stats unavailable" });
  }
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

// ---- AI prep plan (company + role, used by aptitude & interview pages) ----
// Grounded like a report: gather bounded sources, let Gemini shape them into
// a plan (skills, rounds, questions, topic weightage), cache per company+role
// for 30 minutes. Free tier: 5 fresh AI research runs per day, Prep Pro
// unlimited; cache hits and non-AI fallbacks never consume the allowance —
// when research is used up the route still returns the role-tuned plan
// (limited: true), so a search never dead-ends on an error.

const aiPlanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many AI plan requests, try again shortly." },
});

const FREE_AI_PLANS_PER_DAY = 5;

const aiPlanBody = z.object({
  company: z.string().min(2).max(200),
  role: z.string().min(2).max(120),
});

// Fallback plans still carry REAL company questions when members have filed
// any: the role profile stays the skeleton, the pack supplies the specifics.
// MEMBER_REPORTED is stated in each question's why — never presented as web
// research (grounded stays false, sources stay empty).
async function planWithPackQuestions(
  company: { id: string; name: string },
  role: string,
): Promise<ReturnType<typeof fallbackPlan>> {
  const plan = fallbackPlan(company.name, role);
  try {
    const pack = await listPackQuestions(company.id);
    if (!pack.length) return plan;
    const roleKey = role.toLowerCase();
    const matchesRole = (r: string | null): boolean => {
      const rk = (r || "").toLowerCase();
      return !!rk && (rk.includes(roleKey) || roleKey.includes(rk));
    };
    const fromPack = [...pack]
      .sort((a, b) => Number(matchesRole(b.role)) - Number(matchesRole(a.role)))
      .slice(0, 6)
      .map((q) => ({
        question: q.question.slice(0, 300),
        topic: (q.category || "Interview").slice(0, 80),
        difficulty: "Medium" as const,
        why: `Member-reported from a real ${company.name} interview — not web research.`,
      }));
    plan.questions = [...fromPack, ...plan.questions].slice(0, 10);
  } catch {
    // pack table unavailable: the role plan still stands on its own
  }
  return plan;
}

prepRouter.post("/ai/plan", authenticate, aiPlanLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  const parsed = aiPlanBody.safeParse({
    company: String(req.body?.company ?? "").trim().slice(0, 200),
    role: String(req.body?.role ?? "").trim().slice(0, 120),
  });
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Choose a company and a role (at least 2 characters each)." });
    return;
  }
  const { company: companyName, role } = parsed.data;
  const roleKey = role.toLowerCase();
  try {
    // Same company resolution as reports: exact row reuse, else a PENDING row.
    const exact = (await resolveCompany(db, companyName)).find((c) => c.score === 3);
    let company = exact ? await findCompanyBySlug(exact.slug) : null;
    if (!company) {
      company = await createPendingCompany(db, { name: companyName, createdBy: req.user!.id });
    }

    // Cache hit first — never burns the daily allowance.
    const cached = await getCachedAiPlan(company.id, roleKey);
    if (cached) {
      res.json({ success: true, data: { plan: cached.plan, cached: true, aiUsed: true } });
      return;
    }

    const isProUser = isEntitlementActive(await getActiveEntitlement(req.user!.id));
    if (!isProUser) {
      const used = await countAiPlanRequestsToday(req.user!.id);
      if (used >= FREE_AI_PLANS_PER_DAY) {
        // The free allowance only gates live AI research. A searched company +
        // role must ALWAYS land on a plan — when research is used up for the
        // day, answer with the role-tuned plan (limited: true) instead of an
        // error the user cannot act on.
        const plan = await planWithPackQuestions(company, role);
        res.json({
          success: true,
          data: { plan, cached: false, aiUsed: false, limited: true, used, limit: FREE_AI_PLANS_PER_DAY },
        });
        return;
      }
    }

    const gathered = await gatherSourcesWithBudget(
      { name: company.name, domain: company.domain, website: company.website },
      12_000,
    );
    const generated = await generatePrepPlan({ company: { name: company.name }, role, gathered });
    const plan = generated ? generated.plan : await planWithPackQuestions(company, role);
    plan.sources = gathered.documents.slice(0, 6).map((d) => ({ label: d.label, url: d.url, publisher: d.publisher }));
    plan.grounded = plan.sources.length > 0 && generated !== null;

    if (generated) {
      // Only genuine AI generations count against the free allowance.
      await recordAiPlanRequest(req.user!.id);
      await saveAiPlan(company.id, roleKey, plan, generated.model);
      res.status(201).json({ success: true, data: { plan, cached: false, aiUsed: true } });
      return;
    }
    // No AI this pass: return the honest starter plan without caching it,
    // so the very next attempt can pick up a recovered provider.
    res.status(201).json({ success: true, data: { plan, cached: false, aiUsed: false } });
  } catch (err) {
    // Never dead-end: company resolution or research failing still answers
    // with the role-tuned starter plan — searching must always show results.
    console.error("[prep] ai plan failed:", err);
    const plan = fallbackPlan(companyName, role);
    res.status(201).json({ success: true, data: { plan, cached: false, aiUsed: false } });
  }
});

// ---- Plan question regeneration (the plan card's "generate new questions") ----
// A text-only AI pass for the company+role already on screen: the client sends
// the questions it currently shows (plus the cached plan's own join in) as the
// avoid list, so nothing comes back twice. Same daily allowance as plan
// research - only genuine AI answers count against it - and, like the plan, it
// never dead-ends: quota used up, AI unconfigured or the provider failing all
// answer from the local role + interview-bank pools (aiUsed: false).

prepRouter.post(
  "/ai/plan/questions",
  authenticate,
  aiPlanLimiter,
  prepDbGate,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = aiPlanBody.safeParse({
      company: String(req.body?.company ?? "").trim().slice(0, 200),
      role: String(req.body?.role ?? "").trim().slice(0, 120),
    });
    if (!parsed.success) {
      res.status(400).json({ success: false, message: "Choose a company and a role (at least 2 characters each)." });
      return;
    }
    const { company: companyName, role } = parsed.data;
    const roleKey = role.toLowerCase();
    const avoid = (Array.isArray(req.body?.avoid) ? req.body.avoid : [])
      .map((q: unknown) => String(q ?? "").replace(/\s+/g, " ").trim().slice(0, 300))
      .filter((q: string) => q.length > 0)
      .slice(0, 40);
    try {
      const exact = (await resolveCompany(db, companyName)).find((c) => c.score === 3);
      let company = exact ? await findCompanyBySlug(exact.slug) : null;
      if (!company) {
        company = await createPendingCompany(db, { name: companyName, createdBy: req.user!.id });
      }
      // The cached plan's own questions are on screen too - never roll them back.
      const cached = await getCachedAiPlan(company.id, roleKey);
      if (cached?.plan?.questions?.length) {
        for (const q of cached.plan.questions) avoid.push(q.question);
      }

      const isProUser = isEntitlementActive(await getActiveEntitlement(req.user!.id));
      const overQuota = !isProUser && (await countAiPlanRequestsToday(req.user!.id)) >= FREE_AI_PLANS_PER_DAY;
      if (!overQuota) {
        const out = await generatePrepQuestions({ company: { name: company.name }, role, avoid });
        if (out) {
          await recordAiPlanRequest(req.user!.id);
          res.status(201).json({ success: true, data: { questions: out.questions, aiUsed: true, limited: false } });
          return;
        }
      }
      res.json({
        success: true,
        data: { questions: fallbackPlanQuestions(role, avoid), aiUsed: false, limited: overQuota },
      });
    } catch (err) {
      console.error("[prep] ai plan questions failed:", err);
      res.json({ success: true, data: { questions: fallbackPlanQuestions(role, avoid), aiUsed: false, limited: false } });
    }
  },
);

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

// Aptitude and interview SESSIONS are Prep Pro perks (browse + quiz + mock +
// submit). Runs after authenticate; free accounts get an explicit 402 the UI
// turns into the upgrade card instead of a dead button.
async function requirePrepPro(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const entitlement = await getActiveEntitlement(req.user!.id);
    if (isEntitlementActive(entitlement)) { next(); return; }
    res.status(402).json({
      success: false,
      code: "UPGRADE_REQUIRED",
      message: "Aptitude and interview sessions are part of Prep Pro. Upgrade to unlock every session.",
      priceInr: PREP_PRO_PRICE_INR,
      days: PREP_PRO_DAYS,
    });
  } catch (err) {
    console.error("[prep] pro session gate failed:", err);
    res.status(500).json({ success: false, message: "Could not check your plan. Try again." });
  }
}

/**
 * Cached plan for a company+role lookup — EXACT existing rows only, never
 * creates PENDING companies (aptitude/mock must not litter the catalogue).
 * Null on any miss or failure; callers fall back to role defaults.
 */
async function cachedPlanFor(companyName: string, role: string): Promise<PrepAiPlanPayload | null> {
  if (!companyName || role.trim().length < 2) return null;
  try {
    const exact = (await resolveCompany(db, companyName)).find((c) => c.score === 3);
    if (!exact) return null;
    const company = await findCompanyBySlug(exact.slug);
    if (!company) return null;
    const cached = await getCachedAiPlan(company.id, role.trim().toLowerCase());
    return cached?.plan ?? null;
  } catch {
    return null;
  }
}

prepRouter.get("/aptitude/topics", authenticate, requirePrepPro, prepDbGate, async (_req: Request, res: Response): Promise<void> => {
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

prepRouter.get("/aptitude/quiz", authenticate, aptitudeLimiter, requirePrepPro, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const rawTopic = typeof req.query.topic === "string" ? req.query.topic : "";
    const topic = (APTITUDE_TOPICS as readonly string[]).includes(rawTopic) ? rawTopic : null;
    const company = String(req.query.company ?? "").trim().slice(0, 200);
    const role = String(req.query.role ?? "").trim().slice(0, 120);
    const requested = clampCount(req.query.count, 20);
    const rows = await db
      .select()
      .from(prepAptitudeQuestionsTable)
      .where(topic ? eq(prepAptitudeQuestionsTable.topic, topic) : sql`1=1`);
    if (!rows.length) {
      res.status(404).json({ success: false, message: "No questions available" });
      return;
    }
    // Target weighting: with a role set, the drill samples by what that role
    // actually asks — preferring the researched plan's own aptitudeTopics
    // when a cached plan exists, else the curated role profile.
    let weights: AptitudeWeights | null = null;
    let focus: { topic: string; weight: number }[] | null = null;
    let focusSource: "plan" | "role" | null = null;
    if (role) {
      const plan = await cachedPlanFor(company, role);
      if (plan && plan.aptitudeTopics.length) {
        weights = weightsFromPlanTopics(plan.aptitudeTopics);
        focus = plan.aptitudeTopics.slice(0, 6).map((t) => ({ topic: t.topic, weight: Number(t.weight) || 0 }));
        focusSource = "plan";
      } else {
        weights = aptitudeWeights(role);
        focus = (Object.keys(weights) as (keyof AptitudeWeights)[]).map((k) => ({ topic: k, weight: weights![k] }));
        focusSource = "role";
      }
    }
    const picked = weights
      ? pickQuizWeighted(rows, Math.min(requested, rows.length), weights)
      : pickQuiz(rows, Math.min(requested, rows.length));
    const ids = picked.map((r) => r.id);
    const token = signQuizToken({ ids, topic }, quizSecret());
    res.json({
      success: true,
      data: {
        questions: picked.map(toPublicQuestion),
        token,
        total: picked.length,
        target: role ? { company, role, focus, focusSource } : null,
      },
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

prepRouter.post("/aptitude/submit", authenticate, aptitudeLimiter, requirePrepPro, prepDbGate, async (req: Request, res: Response): Promise<void> => {
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

// Free taste of quality: three universally-asked questions WITH guidance, no
// auth — this is what sells Prep Pro. The full bank, mocks and feedback stay
// Pro-gated. Never dead-ends: falls back to the in-repo bank copy.
prepRouter.get("/interview/sample", interviewLimiter, prepDbGate, async (_req: Request, res: Response): Promise<void> => {
  const fallback = sampleInterviewQuestions().map((q, i) => ({
    id: `sample-${i}`,
    code: q.code,
    track: q.track,
    category: q.category,
    difficulty: q.difficulty,
    question: q.question,
    guidance: q.guidance,
  }));
  try {
    const rows = await db.select().from(prepInterviewQuestionsTable);
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const picked = SAMPLE_QUESTION_CODES.map((c) => byCode.get(c)).filter((r): r is NonNullable<typeof r> => !!r);
    const out = picked.length
      ? picked.map((r) => ({
          id: r.id,
          code: r.code,
          track: r.track,
          category: r.category,
          difficulty: r.difficulty,
          question: r.question,
          guidance: r.guidance,
        }))
      : fallback;
    res.json({ success: true, data: { questions: out } });
  } catch (err) {
    console.error("[prep] interview sample failed:", err);
    res.json({ success: true, data: { questions: fallback } });
  }
});

// Daily drill: public like the sample — everyone sees the SAME six questions
// for a whole UTC day, then a fresh mix (seed = calendar date, so every node
// and every refresh agrees). Never dead-ends: the in-repo bank fallback
// answers when the DB is down or seeded short.
prepRouter.get("/interview/today", interviewLimiter, prepDbGate, async (_req: Request, res: Response): Promise<void> => {
  const now = new Date();
  const dayIndex = utcDayIndex(now);
  const day = utcDayLabel(now);
  const fallback = dailyDrillQuestions(undefined, TODAY_DRILL_SIZE, dayIndex).map((q, i) => ({
    id: `today-${i}`,
    code: q.code,
    track: q.track,
    category: q.category,
    difficulty: q.difficulty,
    question: q.question,
    guidance: q.guidance,
  }));
  try {
    const rows = await db.select().from(prepInterviewQuestionsTable);
    const sorted = [...rows].sort((a, b) => a.code.localeCompare(b.code));
    const codes = dailyDrillCodes(sorted.map((r) => r.code), TODAY_DRILL_SIZE, dayIndex);
    const byCode = new Map(sorted.map((r) => [r.code, r]));
    const picked = codes.map((c) => byCode.get(c)).filter((r): r is NonNullable<typeof r> => !!r);
    const out = picked.length
      ? picked.map((r) => ({
          id: r.id,
          code: r.code,
          track: r.track,
          category: r.category,
          difficulty: r.difficulty,
          question: r.question,
          guidance: r.guidance,
        }))
      : fallback;
    res.json({ success: true, data: { day, questions: out } });
  } catch (err) {
    console.error("[prep] daily drill failed:", err);
    res.json({ success: true, data: { day, questions: fallback } });
  }
});

/**
 * Company+role research brief for the mock: cached plan first, else one live
 * gather+AI pass (saved to cache). Research failure NEVER kills the session —
 * the brief downgrades to an honest standard role mock, never an invented
 * "company facts" story.
 */
async function interviewBriefFor(companyName: string, role: string): Promise<{
  company: string;
  role: string;
  grounded: boolean;
  overview: string;
  rounds: { name: string; focus: string }[];
  skillsRequired: string[];
  expect: { question: string; topic: string }[];
  sources: { label: string; url: string; publisher: string }[];
}> {
  const rolePlan = fallbackPlan(companyName || "the role", role);
  let plan: PrepAiPlanPayload | null = await cachedPlanFor(companyName, role);
  if (!plan && companyName) {
    try {
      const exact = (await resolveCompany(db, companyName)).find((c) => c.score === 3);
      const company = exact ? await findCompanyBySlug(exact.slug) : null;
      if (company) {
        const gathered = await gatherSourcesWithBudget(
          { name: company.name, domain: company.domain, website: company.website },
          12_000,
        );
        const generated = await generatePrepPlan({ company: { name: company.name }, role, gathered });
        const fresh = generated ? generated.plan : fallbackPlan(company.name, role);
        fresh.sources = gathered.documents.slice(0, 6).map((d) => ({ label: d.label, url: d.url, publisher: d.publisher }));
        fresh.grounded = fresh.sources.length > 0 && generated !== null;
        if (generated) await saveAiPlan(company.id, role.trim().toLowerCase(), fresh, generated.model);
        plan = fresh;
      }
    } catch (err) {
      console.error("[prep] interview brief research failed:", err);
    }
  }
  const sourcePlan = plan ?? rolePlan;
  const overview = plan
    ? plan.overview
    : `No verified public sources were found for ${companyName.slice(0, 120)} yet, so this mock runs the standard ${role} pattern - run the company report first to research ${companyName.slice(0, 80)} properly.`;
  return {
    company: companyName,
    role,
    grounded: plan ? plan.grounded : false,
    overview,
    rounds: sourcePlan.rounds.length ? sourcePlan.rounds : rolePlan.rounds,
    skillsRequired: sourcePlan.skillsRequired.length ? sourcePlan.skillsRequired : rolePlan.skillsRequired,
    expect: (sourcePlan.questions.length ? sourcePlan.questions : rolePlan.questions)
      .slice(0, 4)
      .map((q) => ({ question: q.question, topic: q.topic })),
    sources: plan ? plan.sources : [],
  };
}

prepRouter.get("/interview/mock", authenticate, interviewLimiter, requirePrepPro, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const track = isValidTrack(req.query.track) ? req.query.track : null;
    const company = String(req.query.company ?? "").trim().slice(0, 200);
    const role = String(req.query.role ?? "").trim().slice(0, 120);
    // Role-targeted mocks pick the track the role actually interviews on.
    const effTrack = track ?? trackForRole(role) ?? null;
    const rows = await db
      .select()
      .from(prepInterviewQuestionsTable)
      .where(effTrack ? eq(prepInterviewQuestionsTable.track, effTrack) : sql`1=1`);
    if (!rows.length) {
      res.status(404).json({ success: false, message: "No interview questions available" });
      return;
    }
    const brief = role.length >= 2 ? await interviewBriefFor(company, role) : null;
    const picked = pickMock(rows, req.query.count ?? MOCK_DEFAULT_COUNT);
    const ids = picked.map((r) => r.id);
    const token = signInterviewMock(ids, effTrack, quizSecret());
    res.json({
      success: true,
      data: { questions: picked.map(toPublicInterviewQuestion), token, total: picked.length, brief },
    });
  } catch (err) {
    console.error("[prep] interview mock failed:", err);
    res.status(500).json({ success: false, message: "Could not build the mock session" });
  }
});

// Mock submit: the client sends the answers the candidate actually TYPED —
// the coach reads them, scores each 0-10 and returns a stronger version.
// Self-rating was removed: the panel cares what you SAID, not how you felt.
// One AI call scores the whole batch; AI down still answers with per-question
// guidance, so feedback never dead-ends.
const mockSubmitBody = z.object({
  token: z.string().min(1).max(4000),
  answers: z.record(z.string(), z.string().max(1500)).default({}),
});

prepRouter.post("/interview/mock/submit", authenticate, interviewLimiter, requirePrepPro, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  const parsed = mockSubmitBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "token and typed answers are required" });
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
    const feedback = aggregateFeedback(publicRows, {}, payload.ids);
    const items = feedback.items.map((it) => ({
      id: it.id,
      code: it.code,
      question: it.question,
      category: it.category,
      difficulty: it.difficulty,
      guidance: it.guidance,
      answer: cleanPackText(parsed.data.answers[it.id], 1500),
    }));
    const answered = items.filter((it) => it.answer.length >= 2);
    const scores = answered.length
      ? await generateAnswerScores({
          items: answered.map((it) => ({ question: it.question, category: it.category, answer: it.answer })),
        })
      : null;
    const scoreById = new Map<string, AnswerScore>();
    if (scores) {
      answered.forEach((it, i) => {
        const s = scores[i];
        if (s) scoreById.set(it.id, s);
      });
    }
    const scoredItems = items.map((it) => {
      const s = scoreById.get(it.id);
      return s
        ? { ...it, score: s.score, verdict: s.verdict, strengths: s.strengths, improvements: s.improvements, better: s.better }
        : { ...it, score: null as number | null, verdict: "", strengths: [] as string[], improvements: [] as string[], better: "" };
    });
    const { readiness, weakestCategory } = summarizeAiScores(
      scoredItems.filter((it) => it.score !== null).map((it) => ({ category: it.category, score: it.score as number })),
    );
    res.json({
      success: true,
      data: {
        readiness,
        weakestCategory,
        answered: answered.length,
        total: scoredItems.length,
        aiUsed: readiness !== null,
        note:
          readiness !== null
            ? null
            : answered.length
              ? "AI scoring is unavailable right now - the guidance for each answer is below."
              : "Type your answers - the AI interviewer scores what you write.",
        items: scoredItems,
      },
    });
  } catch (err) {
    console.error("[prep] interview submit failed:", err);
    res.status(500).json({ success: false, message: "Feedback generation failed" });
  }
});

// ---- Free daily AI answer score (1/day; Pro unlimited) ----
// The same coach as the mock, pointed at ONE question from today's drill or
// the sample — the free taste that sells Prep Pro. The typed answer is
// analysed in memory and NEVER stored; only the usage count persists. Quota
// exhausted or AI unavailable still answers with the question's guidance.

const answerScoreLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many scores requested, try again shortly." },
});

const FREE_ANSWER_SCORES_PER_DAY = 1;

const answerScoreBody = z.object({
  code: z.string().min(1).max(64),
  answer: z.string().min(20).max(1500),
});

prepRouter.post("/interview/answer/score", authenticate, answerScoreLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  const parsed = answerScoreBody.safeParse({
    code: String(req.body?.code ?? "").trim().slice(0, 64),
    answer: String(req.body?.answer ?? "").trim().slice(0, 1500),
  });
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Type at least 20 characters of your answer." });
    return;
  }
  const { code, answer } = parsed.data;
  const limit = FREE_ANSWER_SCORES_PER_DAY;
  try {
    const rows = await db.select().from(prepInterviewQuestionsTable).where(eq(prepInterviewQuestionsTable.code, code));
    const bankRow = rows[0] ?? INTERVIEW_BANK.find((q) => q.code === code) ?? null;
    if (!bankRow) {
      res.status(400).json({ success: false, message: "Unknown question - refresh the page and try again." });
      return;
    }
    const isProUser = isEntitlementActive(await getActiveEntitlement(req.user!.id));
    let used = 0;
    if (!isProUser) used = await countAnswerScoresToday(req.user!.id);
    if (!isProUser && used >= limit) {
      res.json({ success: true, data: { scored: false, limited: true, used, limit, guidance: bankRow.guidance } });
      return;
    }
    const scores = await generateAnswerScores({
      items: [{ question: bankRow.question, category: bankRow.category, answer }],
    });
    if (scores && scores[0]) {
      if (!isProUser) await recordAnswerScore(req.user!.id); // only genuine scores count
      res.status(201).json({
        success: true,
        data: { scored: true, limited: false, used: used + 1, limit, result: scores[0], guidance: bankRow.guidance },
      });
      return;
    }
    res.json({
      success: true,
      data: {
        scored: false,
        limited: false,
        used,
        limit,
        guidance: bankRow.guidance,
        note: "AI scoring is unavailable right now - try again in a few minutes.",
      },
    });
  } catch (err) {
    console.error("[prep] answer score failed:", err);
    res.json({
      success: true,
      data: {
        scored: false,
        limited: false,
        used: 0,
        limit,
        guidance: "",
        note: "AI scoring is unavailable right now - try again in a few minutes.",
      },
    });
  }
});

// ---- Company question packs (member-reported; never presented as verified) ----
// The questions candidates say they were actually asked. Free members see the
// count plus one sample; Prep Pro opens the full pack. Submissions are
// MEMBER_REPORTED and unverified by design — every read path must keep that
// label honest. Packs must not litter the ACTIVE company catalogue, so unknown
// names become PENDING companies (same rule as aptitude/mock).

const packSubmitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many pack submissions, try again shortly." },
});

prepRouter.get("/interview/packs", authenticate, interviewLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  const company = String(req.query.company ?? "").trim().slice(0, 200);
  if (company.length < 2) {
    res.status(400).json({ success: false, message: "Enter a company name (2+ characters)." });
    return;
  }
  try {
    const isProUser = isEntitlementActive(await getActiveEntitlement(req.user!.id));
    const exact = (await resolveCompany(db, company)).find((c) => c.score === 3);
    const co = exact ? await findCompanyBySlug(exact.slug) : null;
    if (!co) {
      res.json({
        success: true,
        data: { found: false, company, total: 0, isPro: isProUser, questions: [], reported: true },
      });
      return;
    }
    const rows = await listPackQuestions(co.id);
    const publicRows = rows.map((r) => ({
      id: r.id,
      question: r.question,
      category: r.category,
      role: r.role,
      context: r.context,
      askedAt: r.createdAt.toISOString().slice(0, 10),
    }));
    res.json({
      success: true,
      data: {
        found: true,
        companyId: co.id,
        company: co.name,
        total: publicRows.length,
        isPro: isProUser,
        reported: true,
        questions: isProUser ? publicRows.slice(0, 50) : publicRows.slice(0, 1),
      },
    });
  } catch (err) {
    console.error("[prep] interview packs failed:", err);
    res.json({ success: true, data: { found: false, company, total: 0, isPro: false, questions: [], reported: true } });
  }
});

const packSubmitBody = z.object({
  company: z.string().min(2).max(200),
  role: z.string().max(120).optional(),
  category: z.string().max(30).optional(),
  question: z.string().min(10).max(500),
  context: z.string().max(280).optional(),
});

prepRouter.post("/interview/packs/submit", authenticate, packSubmitLimiter, prepDbGate, async (req: Request, res: Response): Promise<void> => {
  const parsed = packSubmitBody.safeParse({
    company: cleanPackText(req.body?.company, 200),
    role: cleanPackText(req.body?.role, 120) || undefined,
    category: cleanPackText(req.body?.category, 30) || undefined,
    question: cleanPackText(req.body?.question, 500),
    context: cleanPackText(req.body?.context, 280) || undefined,
  });
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Company (2+ chars) and a question (10-500 chars) are required." });
    return;
  }
  const { company, role = "", context = "" } = parsed.data;
  const category =
    parsed.data.category && (INTERVIEW_CATEGORIES as readonly string[]).includes(parsed.data.category)
      ? parsed.data.category
      : "technical";
  try {
    const used = await countPackSubmissionsToday(req.user!.id);
    if (used >= PACKS_PER_USER_PER_DAY) {
      res.status(429).json({
        success: false,
        message: `You shared ${PACKS_PER_USER_PER_DAY} questions today - thanks! Come back tomorrow.`,
      });
      return;
    }
    const exact = (await resolveCompany(db, company)).find((c) => c.score === 3);
    let co = exact ? await findCompanyBySlug(exact.slug) : null;
    if (!co) co = await createPendingCompany(db, { name: company, createdBy: req.user!.id });
    if (await findDuplicatePackQuestion(co.id, normalizePackQuestion(parsed.data.question))) {
      res.json({ success: true, data: { duplicate: true, message: "That question is already in the pack - thanks anyway." } });
      return;
    }
    await insertPackQuestion({
      companyId: co.id,
      role,
      category,
      question: parsed.data.question,
      context,
      submittedBy: req.user!.id,
    });
    res.status(201).json({
      success: true,
      data: { duplicate: false, company: co.name, message: "Shared - your question is live in the pack." },
    });
  } catch (err) {
    console.error("[prep] interview pack submit failed:", err);
    res.status(500).json({ success: false, message: "Could not share the question. Try again." });
  }
});

// ---- Resume vs target role gap check (free AI taste: 1/day; Pro unlimited) ----
// The resume TEXT is analysed in memory and NEVER stored — only the usage
// count is persisted (prep_resume_checks). Free tier gets one live AI check
// per day; an exhausted allowance or an unavailable AI still answers with the
// target role's skill checklist, so the page always lands on something
// actionable instead of a dead error.

const resumeCheckLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many resume checks, try again shortly." },
});

const FREE_RESUME_CHECKS_PER_DAY = 1;

const resumeCheckBody = z.object({
  text: z.string().min(100).max(12000),
  company: z.string().max(200).optional(),
  role: z.string().max(120).optional(),
});

prepRouter.post(
  "/resume/check",
  authenticate,
  resumeCheckLimiter,
  prepDbGate,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = resumeCheckBody.safeParse({
      text: String(req.body?.text ?? "").trim().slice(0, 12000),
      company: req.body?.company ? String(req.body.company).trim().slice(0, 200) : undefined,
      role: req.body?.role ? String(req.body.role).trim().slice(0, 120) : undefined,
    });
    if (!parsed.success) {
      res.status(400).json({ success: false, message: "Paste at least 100 characters of your resume text." });
      return;
    }
    const { text, company = "", role = "" } = parsed.data;
    try {
      // Target context: exact cached plan only (never creates companies), else
      // the role profile's skills — so the check is useful without a company.
      const plan = company && role ? await cachedPlanFor(company, role) : null;
      const skills = (plan ? plan.skillsRequired : fallbackPlan(company, role).skillsRequired).slice(0, 8);
      const target = company || role ? { company, role } : null;
      const limit = FREE_RESUME_CHECKS_PER_DAY;

      const isProUser = isEntitlementActive(await getActiveEntitlement(req.user!.id));
      let used = 0;
      if (!isProUser) used = await countResumeChecksToday(req.user!.id);
      if (!isProUser && used >= limit) {
        res.json({
          success: true,
          data: { check: null, aiUsed: false, limited: true, used, limit, target, checklist: skills },
        });
        return;
      }

      const generated = await generateResumeCheck({ resume: text, company, role, skillsRequired: skills });
      if (generated) {
        await recordResumeCheck(req.user!.id); // only genuine AI checks count
        res.status(201).json({
          success: true,
          data: { check: generated.check, aiUsed: true, limited: false, used: used + 1, limit, target, checklist: skills },
        });
        return;
      }
      // AI unconfigured/failed: honest checklist, no usage consumed, never 500.
      res.json({
        success: true,
        data: {
          check: null,
          aiUsed: false,
          limited: false,
          used,
          limit,
          target,
          checklist: skills,
          note: "AI check is unavailable right now - try again in a few minutes.",
        },
      });
    } catch (err) {
      console.error("[prep] resume check failed:", err);
      res.status(500).json({ success: false, message: "Could not run the resume check. Try again." });
    }
  },
);

// ---- Resume file upload (PDF / DOCX / TXT) -> plain text for the check ----
// The file lives only in request memory: extraction happens in-process with
// zero npm dependencies (the deploy pipeline runs no install step, so a new
// package would crash production). Nothing about the file or its text is
// ever written to disk or stored in the database.

const resumeDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

const resumeUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many uploads, try again shortly." },
});

prepRouter.post(
  "/resume/upload",
  authenticate,
  resumeUploadLimiter,
  prepDbGate,
  resumeDocUpload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      res.status(400).json({ success: false, message: "Attach a file first (PDF, DOCX or .txt)." });
      return;
    }
    const originalName = String(req.file.originalname || "resume").slice(0, 160);
    const extracted = extractResumeText(req.file.buffer, originalName, req.file.mimetype);
    if (!extracted.ok) {
      res.status(400).json({ success: false, message: extracted.error });
      return;
    }
    const full = extracted.text;
    res.json({
      success: true,
      data: {
        text: full.slice(0, 12000),
        chars: Math.min(full.length, 12000),
        totalChars: full.length,
        name: originalName,
        truncated: full.length > 12000,
      },
    });
  },
);

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
  max: 30,
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
