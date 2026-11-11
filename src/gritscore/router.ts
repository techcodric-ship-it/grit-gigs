// GritScore API. Mounted at /api/gritscore *before* the terminal 404 in
// routes/index.ts (see app.ts). Public reads, owner writes, referee links and
// admin tools share one router so the permission model is visible in one file.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import { and, desc, eq, gt, ilike, or, sql } from "drizzle-orm";

import { db, notificationsTable, usersTable } from "../db";
import { authenticate, optionalAuth, requireAdmin } from "../middlewares/authenticate";
import { adminAuth } from "../middlewares/adminAuth";
import { sendNotificationEmail } from "../lib/email";
import { logger } from "../lib/logger";
import { trackPurchase } from "../lib/meta-capi";
import { PROJECT_ROOT } from "../lib/root";
import { uploadToSupabase } from "../lib/storage";

import {
  EVIDENCE_VALUE,
  EXACT_SCORE_MIN_VERIFIED,
  GRITSCORE_PRO,
  LIMITS,
  PUBLIC_LABELS,
  type EvidenceType,
  type VerificationTier,
} from "./config";
import { buildTips, computeScore, type ScoreComponents, type ScoreItemInput } from "./score";
import { resolveVerificationTier, verificationLabel } from "./verify";
import {
  alignExtraction,
  deterministicExtraction,
  extractProfile,
  type ExtractionItemInput,
} from "./ai";
import { classifyEvidence, detectAbuse, detectFileKind, normaliseUrl, checkProofUrl, proofFileKind, proofLabel } from "./evidence";
import { PdfExtractionError, extractPdfText, isPdf } from "./pdf";
import { renderCardPdf, renderCardPng, type CardData } from "./card";
import {
  completeGritScoreOrder,
  countConfirmedReferees,
  countScansLastHour,
  countUserScans,
  createGritScorePendingOrder,
  deleteScanData,
  ensureGritScoreDb,
  findGritScoreOrder,
  findScanById,
  findScanBySlug,
  getActiveGritScorePro,
  getScoreConfig,
  isProActive,
  listItems,
  listReferees,
  listScansForUser,
  listVisibleReviews,
  mergeWeights,
  notifyGritScorePro,
  proExpiryFrom,
  reviewStats,
  saveScoreWeights,
  validateWeights,
} from "./db";
import {
  gritscoreItemsTable,
  gritscoreRefereesTable,
  gritscoreReviewsTable,
  gritscoreScansTable,
  type GritScoreItem,
  type GritScoreScan,
} from "./schema";

const router: IRouter = Router();

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const APP_URL = (process.env.APP_URL || "https://www.gritandgigs.in").trim().replace(/\/+$/, "");

const PROOF_DIR = path.join(PROJECT_ROOT, "uploads", "gritscore");
const MAX_BODY_ITEMS = LIMITS.maxItems;

// ---- Middleware ------------------------------------------------------------

const gritDbGate = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await ensureGritScoreDb();
    next();
  } catch (err) {
    logger.error({ err }, "[gritscore] database not ready");
    res.status(503).json({ success: false, message: "GritScore is temporarily unavailable" });
  }
};

/** Per-user when signed in, otherwise a normalised IP bucket. The IPv6 helper
 *  keeps one user from hopping addresses inside a /64. */
const userKey = (req: Request): string => req.user?.id || ipKeyGenerator(req.ip || "0.0.0.0");

const scanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: LIMITS.scansPerHour,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { success: false, message: "Too many scans this hour. Try again later." },
});

const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: LIMITS.reviewsPerHour,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many reviews from this connection. Try again later." },
});

const purchaseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many purchase attempts. Try again shortly." },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { success: false, message: "Too many requests. Try again shortly." },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(LIMITS.resumeBytes, LIMITS.proofBytes), files: MAX_BODY_ITEMS + 1 },
});

function runUpload(req: Request, res: Response, next: NextFunction): void {
  upload.any()(req, res, (err: unknown) => {
    if (err) {
      const message = (err as { code?: string }).code === "LIMIT_FILE_SIZE" ? "File is larger than 5 MB" : "Upload rejected";
      res.status(400).json({ success: false, message });
      return;
    }
    next();
  });
}

/** Admin page can present either the x-admin-key header or a real ADMIN
 *  session. User-level admins are the safer default; the key remains for the
 *  existing /admin.html tooling. */
function adminGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.headers["x-admin-key"]) {
    adminAuth(req, res, next);
    return;
  }
  void authenticate(req, res, () => requireAdmin(req, res, next));
}

// ---- Small helpers ---------------------------------------------------------

const slugPart = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28) || "card";

async function uniqueSlug(displayName: string): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const suffix = crypto.randomBytes(4).toString("hex").slice(0, 6);
    const candidate = `${slugPart(displayName)}-${suffix}`;
    if (!(await findScanBySlug(candidate))) return candidate;
  }
  return `card-${crypto.randomBytes(8).toString("hex")}`;
}

function ipHash(req: Request): string {
  const secret = process.env.JWT_SECRET || "gritscore";
  const ip = req.ip || "0.0.0.0";
  return crypto.createHash("sha256").update(`${secret}:${ip}`).digest("hex").slice(0, 40);
}

function ownerName(user: Express.User | undefined, fallback: string): string {
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  return name || fallback;
}

function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const s = String(value ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "on" || s === "yes";
}

function baseUrl(): string {
  return APP_URL;
}

const itemInputSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().min(10).max(2000),
  role: z.string().trim().max(160).optional().nullable(),
  startDate: z.string().trim().max(10).optional().nullable(),
  endDate: z.string().trim().max(10).optional().nullable(),
  proofUrl: z.string().trim().max(600).optional().nullable(),
  isCertificate: z.boolean().optional(),
  skills: z.array(z.string().trim().max(60)).max(12).optional(),
});

const scanBodySchema = z.object({
  displayName: z.string().trim().max(120).optional(),
  headline: z.string().trim().max(200).optional(),
  isPublic: z.boolean().optional(),
  storeResume: z.boolean().optional(),
  resumeText: z.string().max(60_000).optional(),
  items: z.array(itemInputSchema).min(1).max(MAX_BODY_ITEMS),
});

const dateSchema = z.string().trim().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/);

function cleanDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = dateSchema.safeParse(String(value));
  return parsed.success ? parsed.data : null;
}

function effectiveEvidence(item: { evidenceType: EvidenceType; evidenceStatus: string }): EvidenceType {
  if (["dead", "duplicate", "invalid"].includes(item.evidenceStatus)) return "none";
  return item.evidenceType;
}

function scoreInputFor(item: {
  evidenceType: string;
  evidenceStatus: string;
  complexity: number;
  clarity: number;
  hasQuantifiedImpact: boolean;
  skills: string[] | null;
  startDate: string | null;
  endDate: string | null;
}): ScoreItemInput {
  return {
    evidenceType: effectiveEvidence({ evidenceType: item.evidenceType as EvidenceType, evidenceStatus: item.evidenceStatus }),
    complexity: item.complexity,
    clarity: item.clarity,
    hasQuantifiedImpact: item.hasQuantifiedImpact,
    skills: item.skills ?? [],
    startDate: item.startDate,
    endDate: item.endDate,
  };
}

function topSkills(scan: GritScoreScan, items: GritScoreItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const value = String(raw ?? "").trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };
  for (const skill of scan.extracted?.skills ?? []) push(skill);
  for (const item of items) for (const skill of item.skills ?? []) push(skill);
  return out.slice(0, 8);
}

function proofItemsFor(items: GritScoreItem[]): { title: string; label: string }[] {
  return [...items]
    .filter((item) => effectiveEvidence(item) !== "none" || item.proofFileUrl)
    .sort((a, b) => (EVIDENCE_VALUE[effectiveEvidence(b)] ?? 0) - (EVIDENCE_VALUE[effectiveEvidence(a)] ?? 0))
    .slice(0, 3)
    .map((item) => ({
      title: item.title,
      label: item.proofUrl ? proofLabel(item.proofUrl) : item.proofFileName || item.role || "Attached file",
    }));
}

async function isOwnerPro(userId: string): Promise<boolean> {
  return isProActive(await getActiveGritScorePro(userId));
}

async function buildCardData(scan: GritScoreScan, items: GritScoreItem[], opts: { ownerView: boolean; isPro: boolean }): Promise<CardData> {
  const verifiedItems = items.filter((item) => item.evidenceStatus === "ok").length;
  const showScore =
    opts.ownerView ||
    Boolean(scan.showExactScore && (opts.isPro || (items.length > 0 && verifiedItems >= EXACT_SCORE_MIN_VERIFIED)));
  return {
    displayName: scan.displayName || "Grit&Gigs member",
    headline: scan.headline,
    score: scan.score ?? 300,
    tier: scan.tier ?? "Starter",
    verification: verificationLabel(scan.verificationTier),
    skills: topSkills(scan, items),
    proofItems: proofItemsFor(items),
    watermark: !opts.isPro,
    showScore,
  };
}

interface ScanView {
  id: string;
  slug: string;
  displayName: string;
  headline: string | null;
  score: number | null;
  tier: string | null;
  verificationTier: VerificationTier;
  verificationLabel: string;
  isPublic: boolean;
  showExactScore: boolean;
  template: string;
  summary: string | null;
  skills: string[];
  roles: string[];
  itemCount: number;
  createdAt: Date;
  publicUrl: string;
}

function scanView(scan: GritScoreScan, itemCount = 0): ScanView {
  return {
    id: scan.id,
    slug: scan.slug,
    displayName: scan.displayName || "Grit&Gigs member",
    headline: scan.headline,
    score: scan.score,
    tier: scan.tier,
    verificationTier: scan.verificationTier,
    verificationLabel: verificationLabel(scan.verificationTier),
    isPublic: scan.isPublic,
    showExactScore: scan.showExactScore,
    template: scan.template,
    summary: scan.summary,
    skills: (scan.extracted?.skills ?? []).slice(0, 30),
    roles: (scan.extracted?.roles ?? []).slice(0, 12),
    itemCount,
    createdAt: scan.createdAt,
    publicUrl: `${baseUrl()}/score/${scan.slug}`,
  };
}

async function recomputeScan(scan: GritScoreScan): Promise<{ items: GritScoreItem[]; isPro: boolean; changed: boolean }> {
  const items = await listItems(scan.id);
  const confirmed = await countConfirmedReferees(scan.id);
  const verificationTier = resolveVerificationTier(items, confirmed);
  const config = await getScoreConfig();
  const input = { items: items.map(scoreInputFor), verificationTier };
  const result = computeScore(input, config);
  const isPro = await isOwnerPro(scan.userId);
  const tips = isPro ? buildTips(result, input.items) : null;
  const changed =
    scan.score !== result.score ||
    scan.verificationTier !== verificationTier ||
    scan.rawScore !== result.rawScore;
  await db
    .update(gritscoreScansTable)
    .set({
      score: result.score,
      rawScore: result.rawScore,
      tier: result.tier,
      verificationTier,
      components: result.components,
      tips,
      updatedAt: new Date(),
    })
    .where(eq(gritscoreScansTable.id, scan.id));
  return { items, isPro, changed };
}

async function requireOwnScan(req: Request, res: Response): Promise<GritScoreScan | null> {
  const id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(400).json({ success: false, message: "Invalid card id" });
    return null;
  }
  const scan = await findScanById(id);
  if (!scan || scan.userId !== req.user!.id) {
    res.status(404).json({ success: false, message: "Card not found" });
    return null;
  }
  return scan;
}

async function storeProofFile(file: { buffer: Buffer; originalname: string }): Promise<{ url: string; name: string }> {
  const uploaded = await uploadToSupabase(file.buffer, file.originalname, "gritscore");
  if (uploaded) return { url: uploaded, name: file.originalname };
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  const ext = (path.extname(file.originalname).toLowerCase().match(/^\.[a-z0-9]{1,6}$/)?.[0]) ?? ".bin";
  const name = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
  fs.writeFileSync(path.join(PROOF_DIR, name), file.buffer);
  return { url: `/uploads/gritscore/${name}`, name: file.originalname };
}

function removeLocalFile(url: string | null | undefined): void {
  if (!url || !url.startsWith("/uploads/gritscore/")) return;
  const name = path.basename(url);
  try {
    fs.unlinkSync(path.join(PROOF_DIR, name));
  } catch {
    /* already gone */
  }
}

// ---- Create a scan ---------------------------------------------------------

router.post(
  "/scans",
  authenticate,
  gritDbGate,
  scanLimiter,
  runUpload,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const rawItems = req.body?.items;
      let parsedItems: unknown;
      try {
        parsedItems = typeof rawItems === "string" ? JSON.parse(rawItems) : rawItems;
      } catch {
        res.status(400).json({ success: false, message: "Work items could not be read. Refresh and try again." });
        return;
      }
      const parsed = scanBodySchema.safeParse({
        displayName: req.body?.displayName,
        headline: req.body?.headline,
        isPublic: asBool(req.body?.isPublic),
        storeResume: asBool(req.body?.storeResume),
        resumeText: req.body?.resumeText,
        items: parsedItems,
      });
      if (!parsed.success) {
        res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Check your work items and try again." });
        return;
      }
      const body = parsed.data;
      const user = req.user!;

      // Plan + abuse limits.
      const pro = await isOwnerPro(user.id);
      const total = await countUserScans(user.id);
      const hourly = await countScansLastHour(user.id);
      if (hourly >= LIMITS.scansPerHour) {
        res.status(429).json({ success: false, message: "Too many scans this hour. Try again later." });
        return;
      }
      if (!pro && total >= LIMITS.freeScans) {
        res.status(402).json({
          success: false,
          code: "PAYWALL",
          message: `Free accounts get ${LIMITS.freeScans} scorecard. GritScore Pro (₹${GRITSCORE_PRO.priceInr} / ${GRITSCORE_PRO.days} days) unlocks unlimited rescans, the full breakdown and watermark-free cards.`,
        });
        return;
      }
      if (pro && total >= LIMITS.proScans) {
        res.status(429).json({ success: false, message: `You have reached ${LIMITS.proScans} active cards. Delete one to create another.` });
        return;
      }

      // Resume: upload, pasted text, or nothing. We never keep the file.
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const resumeFile = files.find((f) => f.fieldname === "resume");
      let resumeText = String(body.resumeText ?? "").trim().slice(0, 60_000);
      if (resumeFile) {
        if (resumeFile.size > LIMITS.resumeBytes) {
          res.status(400).json({ success: false, message: "Resume must be 5 MB or smaller." });
          return;
        }
        try {
          if (isPdf(resumeFile.buffer)) resumeText = extractPdfText(resumeFile.buffer);
          else if (detectFileKind(resumeFile.buffer) === "text") resumeText = resumeFile.buffer.toString("utf8").slice(0, 60_000);
          else {
            res.status(400).json({ success: false, message: "Upload a PDF resume or paste the text." });
            return;
          }
        } catch (err) {
          const message = err instanceof PdfExtractionError ? err.message : "Could not read that PDF.";
          res.status(400).json({ success: false, message, canPaste: true });
          return;
        }
      }

      // Proof files are indexed by field name: proof_0, proof_1, ...
      const proofByIndex = new Map<number, Express.Multer.File>();
      for (const file of files) {
        const match = file.fieldname.match(/^proof_(\d{1,2})$/);
        if (match) proofByIndex.set(Number(match[1]), file);
      }

      // Prior URLs owned by this user, for duplicate detection.
      const priorRows = await db
        .select({ url: gritscoreItemsTable.proofUrl })
        .from(gritscoreItemsTable)
        .innerJoin(gritscoreScansTable, eq(gritscoreItemsTable.scanId, gritscoreScansTable.id))
        .where(eq(gritscoreScansTable.userId, user.id));
      const priorUrls = priorRows.map((r) => r.url).filter((u): u is string => !!u);

      const prepared: {
        input: ExtractionItemInput;
        proofUrl: string | null;
        proofFileUrl: string | null;
        proofFileName: string | null;
        evidenceType: EvidenceType;
        evidenceStatus: string;
        evidenceNote: string;
        skills: string[];
      }[] = [];

      for (let i = 0; i < body.items.length; i++) {
        const item = body.items[i];
        const file = proofByIndex.get(i);
        let fileUrl: string | null = null;
        let fileName: string | null = null;
        let fileKind: "pdf" | "image" | "text" | null = null;
        if (file) {
          if (file.size > LIMITS.proofBytes) {
            res.status(400).json({ success: false, message: `Proof file for item ${i + 1} must be 5 MB or smaller.` });
            return;
          }
          fileKind = proofFileKind(file.originalname);
          const detected = detectFileKind(file.buffer);
          if (!fileKind || detected === "unknown" || (fileKind === "image" && detected !== "image") || (fileKind === "pdf" && detected !== "pdf")) {
            res.status(400).json({ success: false, message: `Proof file for item ${i + 1} is not a valid PDF or image.` });
            return;
          }
          const stored = await storeProofFile(file);
          fileUrl = stored.url;
          fileName = stored.name;
        }
        const evidenceKind = fileKind === "image" ? "screenshot" : fileKind === "pdf" ? "file" : item.isCertificate ? "certificate" : null;
        const evidenceType = classifyEvidence({
          url: item.proofUrl,
          fileName: item.proofUrl ? null : fileName,
          kind: evidenceKind,
        });
        prepared.push({
          input: {
            title: item.title,
            description: item.description,
            role: item.role,
            startDate: cleanDate(item.startDate),
            endDate: cleanDate(item.endDate),
            evidenceType,
            proofUrl: item.proofUrl,
            fileName,
            userSkills: item.skills ?? [],
          },
          proofUrl: item.proofUrl ? String(item.proofUrl).trim() : null,
          proofFileUrl: fileUrl,
          proofFileName: fileName,
          evidenceType,
          evidenceStatus: fileUrl ? "ok" : "unchecked",
          evidenceNote: fileUrl ? "File validated" : "",
          skills: item.skills ?? [],
        });
      }

      const abuse = detectAbuse(
        prepared.map((p) => ({
          title: p.input.title,
          description: p.input.description,
          proofUrl: p.proofUrl,
          evidenceType: p.evidenceType,
        })),
        priorUrls,
      );

      // URL checks and AI extraction run concurrently; neither is allowed to
      // hold the request longer than its own budget.
      const urlChecks = Promise.all(
        prepared.map(async (p) => {
          if (!p.proofUrl || p.proofFileUrl) return null;
          if (p.evidenceType === "none") return { status: "invalid" as const, note: "Not a valid link", httpStatus: null };
          return checkProofUrl(p.proofUrl);
        }),
      );

      const extractionPromise = extractProfile({
        resumeText,
        displayName: body.displayName || ownerName(user, "Grit&Gigs member"),
        items: prepared.map((p) => p.input),
      });

      const [checks, extractionOutcome] = await Promise.all([urlChecks, extractionPromise]);
      const extraction = alignExtraction(
        { resumeText, items: prepared.map((p) => p.input) },
        extractionOutcome.extraction,
      );

      // Merge evidence verdicts into the prepared items.
      for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        if (p.proofFileUrl) {
          p.evidenceStatus = "ok";
          p.evidenceNote = p.evidenceType === "screenshot" ? "Screenshot validated" : "File validated";
          continue;
        }
        const normalised = p.proofUrl ? normaliseUrl(p.proofUrl) : null;
        if (normalised && abuse.duplicateUrls.includes(normalised)) {
          p.evidenceStatus = "duplicate";
          p.evidenceNote = "This proof URL was already used on another item";
          p.evidenceType = "none";
          continue;
        }
        const check = checks[i];
        if (check) {
          p.evidenceStatus = check.status;
          p.evidenceNote = check.note;
          if (check.status === "dead" || check.status === "invalid") p.evidenceType = "none";
        }
      }

      const verificationTier = resolveVerificationTier(
        prepared.map((p) => ({ evidenceType: p.evidenceType, evidenceStatus: p.evidenceStatus })),
        0,
      );
      const config = await getScoreConfig();
      const scoreItems: ScoreItemInput[] = prepared.map((p, i) => ({
        evidenceType: p.evidenceType,
        complexity: extraction.items[i]?.complexity ?? 1,
        clarity: extraction.items[i]?.clarity ?? 1,
        hasQuantifiedImpact: extraction.items[i]?.hasQuantifiedImpact ?? false,
        skills: extraction.items[i]?.skills ?? p.skills,
        startDate: p.input.startDate,
        endDate: p.input.endDate,
      }));
      const result = computeScore({ items: scoreItems, verificationTier }, config);

      const displayName = (body.displayName || ownerName(user, "Grit&Gigs member")).slice(0, 120);
      const slug = await uniqueSlug(displayName);
      const summary = extraction.summary || deterministicExtraction({ resumeText, items: prepared.map((p) => p.input) }).summary;

      const saved = await db.transaction(async (tx) => {
        const [scan] = await tx
          .insert(gritscoreScansTable)
          .values({
            userId: user.id,
            slug,
            displayName,
            headline: (body.headline || extraction.roles[0] || "").slice(0, 200) || null,
            status: "READY",
            resumeText: body.storeResume ? resumeText.slice(0, 60_000) : null,
            resumeStored: Boolean(body.storeResume),
            extracted: {
              skills: extraction.skills,
              roles: extraction.roles,
              items: extraction.items,
              summary,
            },
            summary,
            score: result.score,
            rawScore: result.rawScore,
            tier: result.tier,
            verificationTier,
            components: result.components,
            tips: pro ? buildTips(result, scoreItems) : null,
            isPublic: Boolean(body.isPublic),
            showExactScore: Boolean(body.isPublic),
            template: "violet",
            aiUsed: extractionOutcome.usedAi,
            abuseFlags: abuse.flags,
          })
          .returning();
        if (!scan) throw new Error("scan insert returned no row");

        const insertedItems = await tx
          .insert(gritscoreItemsTable)
          .values(
            prepared.map((p, i) => ({
              scanId: scan.id,
              position: i,
              title: p.input.title,
              description: p.input.description,
              role: p.input.role ? String(p.input.role).slice(0, 160) : null,
              startDate: p.input.startDate ?? null,
              endDate: p.input.endDate ?? null,
              evidenceType: p.evidenceType,
              proofUrl: p.proofUrl,
              proofFileUrl: p.proofFileUrl,
              proofFileName: p.proofFileName,
              evidenceStatus: p.evidenceStatus,
              evidenceNote: p.evidenceNote.slice(0, 200),
              skills: extraction.items[i]?.skills ?? p.skills,
              hasQuantifiedImpact: extraction.items[i]?.hasQuantifiedImpact ?? false,
              impactNotes: extraction.items[i]?.impactNotes ?? "",
              complexity: extraction.items[i]?.complexity ?? 1,
              clarity: extraction.items[i]?.clarity ?? 1,
            })),
          )
          .returning();
        return { scan, items: insertedItems };
      });

      res.status(201).json({
        success: true,
        data: {
          scan: scanView(saved.scan, saved.items.length),
          items: saved.items.map((item) => ({
            id: item.id,
            title: item.title,
            evidenceType: item.evidenceType,
            evidenceStatus: item.evidenceStatus,
            evidenceNote: item.evidenceNote,
            proofUrl: item.proofUrl,
          })),
          score: result.score,
          rawScore: pro ? result.rawScore : null,
          capped: result.capped,
          components: pro ? result.components : null,
          tips: pro ? buildTips(result, scoreItems) : null,
          abuseFlags: abuse.flags,
          aiUsed: extractionOutcome.usedAi,
          isPro: pro,
          limits: { freeScans: LIMITS.freeScans, proScans: LIMITS.proScans },
        },
      });
    } catch (err) {
      logger.error({ err }, "[gritscore] create scan failed");
      res.status(500).json({ success: false, message: "Could not build your card. Try again." });
    }
  },
);

// ---- Owner views -----------------------------------------------------------

router.get("/me", authenticate, gritDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const scans = await listScansForUser(req.user!.id);
    const pro = await getActiveGritScorePro(req.user!.id);
    res.json({
      success: true,
      data: {
        scans: scans.map((s) => scanView(s, s.extracted?.items?.length ?? 0)),
        isPro: isProActive(pro),
        proExpiresAt: pro?.expiresAt ?? null,
        priceInr: GRITSCORE_PRO.priceInr,
        days: GRITSCORE_PRO.days,
        freeScans: LIMITS.freeScans,
        proScans: LIMITS.proScans,
      },
    });
  } catch (err) {
    logger.error({ err }, "[gritscore] me failed");
    res.status(500).json({ success: false, message: "Could not load your cards" });
  }
});

router.get("/scans/:id", authenticate, gritDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const scan = await requireOwnScan(req, res);
    if (!scan) return;
    const items = await listItems(scan.id);
    const referees = await listReferees(scan.id);
    const pro = await isOwnerPro(req.user!.id);
    const stats = await reviewStats(scan.id);
    const reviews = await listVisibleReviews(scan.id);
    res.json({
      success: true,
      data: {
        scan: scanView(scan, items.length),
        summary: scan.summary,
        skills: topSkills(scan, items),
        roles: scan.extracted?.roles ?? [],
        verificationNote: verificationLabel(scan.verificationTier),
        components: pro ? (scan.components as ScoreComponents | null) : null,
        tips: pro ? scan.tips ?? [] : null,
        abuseFlags: scan.abuseFlags ?? [],
        isPro: pro,
        items: items.map((item) => ({
          id: item.id,
          title: item.title,
          description: item.description,
          role: item.role,
          startDate: item.startDate,
          endDate: item.endDate,
          evidenceType: item.evidenceType,
          evidenceStatus: item.evidenceStatus,
          evidenceNote: item.evidenceNote,
          proofUrl: item.proofUrl,
          proofFileName: item.proofFileName,
          skills: item.skills,
          hasQuantifiedImpact: item.hasQuantifiedImpact,
          complexity: item.complexity,
          clarity: item.clarity,
        })),
        referees: referees.map((r) => ({
          id: r.id,
          itemId: r.itemId,
          name: r.name,
          email: r.email ? r.email.replace(/^(.{2}).*(@.*)$/, "$1***$2") : null,
          phone: r.phone ? `***${r.phone.slice(-4)}` : null,
          status: r.status,
          createdAt: r.createdAt,
          link: r.status === "PENDING" ? `${baseUrl()}/gritscore/referee?token=${r.token}` : null,
        })),
        reviews: { count: stats.count, average: stats.average, latest: reviews.slice(0, 5) },
        priceInr: GRITSCORE_PRO.priceInr,
        days: GRITSCORE_PRO.days,
      },
    });
  } catch (err) {
    logger.error({ err }, "[gritscore] scan detail failed");
    res.status(500).json({ success: false, message: "Could not load this card" });
  }
});

router.patch("/scans/:id", authenticate, gritDbGate, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const scan = await requireOwnScan(req, res);
    if (!scan) return;
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof req.body?.isPublic === "boolean") patch.isPublic = req.body.isPublic;
    if (typeof req.body?.showExactScore === "boolean") patch.showExactScore = req.body.showExactScore;
    if (typeof req.body?.displayName === "string") patch.displayName = req.body.displayName.trim().slice(0, 120) || scan.displayName;
    if (typeof req.body?.headline === "string") patch.headline = req.body.headline.trim().slice(0, 200) || null;
    if (typeof req.body?.template === "string" && ["violet", "ink", "paper"].includes(req.body.template)) patch.template = req.body.template;
    const [updated] = await db.update(gritscoreScansTable).set(patch).where(eq(gritscoreScansTable.id, scan.id)).returning();
    res.json({ success: true, data: { scan: scanView(updated ?? scan) } });
  } catch (err) {
    logger.error({ err }, "[gritscore] patch failed");
    res.status(500).json({ success: false, message: "Could not update this card" });
  }
});

router.delete("/scans/:id", authenticate, gritDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const scan = await requireOwnScan(req, res);
    if (!scan) return;
    const items = await listItems(scan.id);
    for (const item of items) removeLocalFile(item.proofFileUrl);
    await deleteScanData(scan);
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    logger.error({ err }, "[gritscore] delete failed");
    res.status(500).json({ success: false, message: "Could not delete this card" });
  }
});

router.post("/scans/:id/recompute", authenticate, gritDbGate, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const scan = await requireOwnScan(req, res);
    if (!scan) return;
    const pro = await isOwnerPro(req.user!.id);
    if (!pro) {
      res.status(402).json({ success: false, code: "PAYWALL", message: "Rescans are a GritScore Pro feature." });
      return;
    }
    const { items } = await recomputeScan(scan);
    const fresh = await findScanById(scan.id);
    const config = await getScoreConfig();
    const input = { items: items.map(scoreInputFor), verificationTier: fresh?.verificationTier ?? scan.verificationTier };
    const result = computeScore(input, config);
    res.json({
      success: true,
      data: {
        scan: scanView(fresh ?? scan, items.length),
        components: result.components,
        tips: buildTips(result, input.items),
        rawScore: result.rawScore,
      },
    });
  } catch (err) {
    logger.error({ err }, "[gritscore] recompute failed");
    res.status(500).json({ success: false, message: "Could not recompute this card" });
  }
});

// ---- Referees --------------------------------------------------------------

router.post("/scans/:id/referee", authenticate, gritDbGate, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const scan = await requireOwnScan(req, res);
    if (!scan) return;
    const pro = await isOwnerPro(req.user!.id);
    const existing = await listReferees(scan.id);
    const cap: number = pro ? LIMITS.maxRefereeInvites : 2;
    if (existing.length >= cap) {
      res.status(429).json({ success: false, message: `You can have ${cap} referee invite${cap === 1 ? "" : "s"} on this plan.` });
      return;
    }
    const itemId = String(req.body?.itemId || "");
    if (!/^[0-9a-f-]{36}$/i.test(itemId)) {
      res.status(400).json({ success: false, message: "Choose which work item the referee is confirming." });
      return;
    }
    const [item] = await db
      .select()
      .from(gritscoreItemsTable)
      .where(and(eq(gritscoreItemsTable.id, itemId), eq(gritscoreItemsTable.scanId, scan.id)))
      .limit(1);
    if (!item) {
      res.status(404).json({ success: false, message: "Work item not found" });
      return;
    }
    const email = String(req.body?.email ?? "").trim().toLowerCase().slice(0, 255);
    const phone = String(req.body?.phone ?? "").trim().slice(0, 30);
    const name = String(req.body?.name ?? "").trim().slice(0, 120);
    if (!email && !phone) {
      res.status(400).json({ success: false, message: "Add a referee email or phone number." });
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ success: false, message: "That referee email does not look valid." });
      return;
    }
    const token = crypto.randomBytes(24).toString("hex");
    const [referee] = await db
      .insert(gritscoreRefereesTable)
      .values({ scanId: scan.id, itemId: item.id, token, name: name || null, email: email || null, phone: phone || null })
      .returning();
    const link = `${baseUrl()}/gritscore/referee?token=${token}`;

    if (email) {
      void sendNotificationEmail(
        email,
        `Confirm a work item for ${scan.displayName || "a Grit&Gigs member"}`,
        `${scan.displayName || "A Grit&Gigs member"} listed "${item.title}" as work they did and named you as a referee. Confirming takes one tap and needs no account. If this is not accurate, decline — that is just as useful.`,
        `/gritscore/referee?token=${token}`,
      ).catch((err: unknown) => logger.warn({ err }, "[gritscore] referee email failed"));
    }

    res.status(201).json({
      success: true,
      data: {
        referee: {
          id: referee?.id,
          name: referee?.name,
          email: referee?.email,
          status: referee?.status ?? "PENDING",
          link,
        },
        emailSent: Boolean(email),
      },
    });
  } catch (err) {
    logger.error({ err }, "[gritscore] referee invite failed");
    res.status(500).json({ success: false, message: "Could not create the referee link" });
  }
});

router.get("/referee/:token", gritDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const token = String(req.params.token || "");
    if (!/^[a-f0-9]{32,64}$/i.test(token)) {
      res.status(404).json({ success: false, message: "This referee link is not valid" });
      return;
    }
    const [referee] = await db.select().from(gritscoreRefereesTable).where(eq(gritscoreRefereesTable.token, token)).limit(1);
    if (!referee) {
      res.status(404).json({ success: false, message: "This referee link is not valid" });
      return;
    }
    const scan = await findScanById(referee.scanId);
    const [item] = referee.itemId
      ? await db.select().from(gritscoreItemsTable).where(eq(gritscoreItemsTable.id, referee.itemId)).limit(1)
      : [];
    res.json({
      success: true,
      data: {
        status: referee.status,
        refereeName: referee.name,
        ownerName: scan?.displayName ?? "A Grit&Gigs member",
        itemTitle: item?.title ?? "a work item",
        itemDescription: item?.description ?? "",
        itemRole: item?.role ?? null,
        respondedAt: referee.respondedAt,
      },
    });
  } catch (err) {
    logger.error({ err }, "[gritscore] referee read failed");
    res.status(500).json({ success: false, message: "Could not load this request" });
  }
});

router.post("/referee/:token", gritDbGate, reviewLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const token = String(req.params.token || "");
    const decision = String(req.body?.decision || "").toUpperCase();
    if (decision !== "CONFIRM" && decision !== "DECLINE") {
      res.status(400).json({ success: false, message: "Choose Confirm or Decline." });
      return;
    }
    const [referee] = await db.select().from(gritscoreRefereesTable).where(eq(gritscoreRefereesTable.token, token)).limit(1);
    if (!referee) {
      res.status(404).json({ success: false, message: "This referee link is not valid" });
      return;
    }
    if (referee.status !== "PENDING") {
      res.status(409).json({ success: false, message: `You already responded (${referee.status.toLowerCase()}).` });
      return;
    }
    await db
      .update(gritscoreRefereesTable)
      .set({ status: decision === "CONFIRM" ? "CONFIRMED" : "DECLINED", respondedAt: new Date() })
      .where(eq(gritscoreRefereesTable.id, referee.id));

    const scan = await findScanById(referee.scanId);
    if (scan) {
      const { items } = await recomputeScan(scan);
      const fresh = await findScanById(scan.id);
      await db.insert(notificationsTable).values({
        userId: scan.userId,
        type: decision === "CONFIRM" ? "GRITSCORE_REFEREE_CONFIRMED" : "GRITSCORE_REFEREE_DECLINED",
        title: decision === "CONFIRM" ? "A referee confirmed your work" : "A referee declined to confirm",
        message:
          decision === "CONFIRM"
            ? `Your card is now ${verificationLabel(fresh?.verificationTier ?? "third_party_confirmed")} and the self-reported cap is lifted.`
            : "A referee declined one work item. You can invite someone else from the card.",
        linkUrl: `/gritscore?card=${scan.id}`,
      });
      res.json({
        success: true,
        data: {
          decision,
          verificationTier: fresh?.verificationTier ?? scan.verificationTier,
          itemCount: items.length,
        },
      });
      return;
    }
    res.json({ success: true, data: { decision } });
  } catch (err) {
    logger.error({ err }, "[gritscore] referee response failed");
    res.status(500).json({ success: false, message: "Could not record your response" });
  }
});

// ---- Public card -----------------------------------------------------------

async function publicPayload(scan: GritScoreScan, viewerId: string | null): Promise<Record<string, unknown> | null> {
  if (!scan.isPublic) return null;
  const items = await listItems(scan.id);
  const ownerPro = await isOwnerPro(scan.userId);
  const verifiedItems = items.filter((i) => i.evidenceStatus === "ok").length;
  const showExact =
    scan.showExactScore && (ownerPro || (items.length > 0 && verifiedItems >= EXACT_SCORE_MIN_VERIFIED));
  const stats = await reviewStats(scan.id);
  const reviews = await listVisibleReviews(scan.id);
  const referees = await listReferees(scan.id);
  const confirmed = referees.filter((r) => r.status === "CONFIRMED").length;
  return {
    scan: {
      slug: scan.slug,
      displayName: scan.displayName || "Grit&Gigs member",
      headline: scan.headline,
      tier: scan.tier,
      verificationTier: scan.verificationTier,
      verificationLabel: verificationLabel(scan.verificationTier),
      score: showExact ? scan.score : null,
      scoreHidden: !showExact,
      summary: scan.summary,
      skills: topSkills(scan, items).slice(0, 8),
      roles: scan.extracted?.roles?.slice(0, 5) ?? [],
      isProCard: ownerPro,
      watermark: !ownerPro,
      confirmedReferees: confirmed,
      checkedItems: verifiedItems,
      itemCount: items.length,
      createdAt: scan.createdAt,
      publicUrl: `${baseUrl()}/score/${scan.slug}`,
    },
    items: items.slice(0, 6).map((item) => ({
      title: item.title,
      description: item.evidenceStatus === "ok" ? item.description.slice(0, 400) : item.description.slice(0, 180),
      role: item.role,
      startDate: item.startDate,
      endDate: item.endDate,
      evidenceType: item.evidenceType,
      evidenceStatus: item.evidenceStatus,
      evidenceNote: item.evidenceNote,
      skills: (item.skills ?? []).slice(0, 6),
      proofUrl: item.evidenceStatus === "ok" || item.evidenceStatus === "blocked" ? item.proofUrl : null,
      proofLabel: item.proofUrl ? proofLabel(item.proofUrl) : item.proofFileName ? "Attached file" : null,
    })),
    reviews: {
      count: stats.count,
      average: stats.average,
      items: reviews.map((r) => ({
        id: r.id,
        name: r.reviewerName,
        stars: r.stars,
        comment: r.comment,
        createdAt: r.createdAt,
      })),
      canReview: viewerId !== scan.userId,
    },
    disclaimer: PUBLIC_LABELS.disclaimer,
    license: PUBLIC_LABELS.scoreName,
  };
}

router.get("/public/:slug", optionalAuth, gritDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const scan = await findScanBySlug(String(req.params.slug || ""));
    if (!scan) {
      res.status(404).json({ success: false, message: "This scorecard does not exist or is private." });
      return;
    }
    const payload = await publicPayload(scan, req.user?.id ?? null);
    if (!payload) {
      res.status(404).json({ success: false, message: "This scorecard does not exist or is private." });
      return;
    }
    res.json({ success: true, data: payload });
  } catch (err) {
    logger.error({ err }, "[gritscore] public read failed");
    res.status(500).json({ success: false, message: "Could not load this scorecard" });
  }
});

router.post("/public/:slug/reviews", optionalAuth, gritDbGate, reviewLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const scan = await findScanBySlug(String(req.params.slug || ""));
    if (!scan || !scan.isPublic) {
      res.status(404).json({ success: false, message: "This scorecard is not available for reviews." });
      return;
    }
    if (req.user?.id === scan.userId) {
      res.status(403).json({ success: false, message: "You cannot review your own scorecard." });
      return;
    }
    const stars = Number(req.body?.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      res.status(400).json({ success: false, message: "Choose a rating from 1 to 5 stars." });
      return;
    }
    const comment = String(req.body?.comment ?? "").trim().slice(0, 800);
    const name = String(req.body?.reviewerName ?? req.body?.name ?? "").trim().slice(0, 120);
    const reviewerName = name || ownerName(req.user, "Anonymous visitor");
    if (!reviewerName) {
      res.status(400).json({ success: false, message: "Add your name with the review." });
      return;
    }
    const email = String(req.body?.reviewerEmail ?? "").trim().toLowerCase().slice(0, 255) || null;
    const hash = ipHash(req);

    if (req.user) {
      const [existing] = await db
        .select({ id: gritscoreReviewsTable.id })
        .from(gritscoreReviewsTable)
        .where(and(eq(gritscoreReviewsTable.scanId, scan.id), eq(gritscoreReviewsTable.reviewerUserId, req.user.id)))
        .limit(1);
      if (existing) {
        res.status(409).json({ success: false, message: "You have already reviewed this scorecard." });
        return;
      }
    } else {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [recent] = await db
        .select({ id: gritscoreReviewsTable.id })
        .from(gritscoreReviewsTable)
        .where(and(eq(gritscoreReviewsTable.scanId, scan.id), eq(gritscoreReviewsTable.ipHash, hash), gt(gritscoreReviewsTable.createdAt, since)))
        .limit(1);
      if (recent) {
        res.status(429).json({ success: false, message: "A review from this connection was already added today." });
        return;
      }
    }

    await db.insert(gritscoreReviewsTable).values({
      scanId: scan.id,
      reviewerUserId: req.user?.id ?? null,
      reviewerName,
      reviewerEmail: email,
      stars,
      comment: comment || null,
      status: "VISIBLE",
      ipHash: hash,
    });
    await db.insert(notificationsTable).values({
      userId: scan.userId,
      type: "GRITSCORE_REVIEW",
      title: `${stars}-star review on your scorecard`,
      message: `${reviewerName} rated your card ${stars}/5${comment ? `: "${comment.slice(0, 120)}"` : ""}.`,
      linkUrl: `/gritscore?card=${scan.id}`,
    });
    const stats = await reviewStats(scan.id);
    res.status(201).json({ success: true, data: { count: stats.count, average: stats.average } });
  } catch (err) {
    logger.error({ err }, "[gritscore] review create failed");
    res.status(500).json({ success: false, message: "Could not add your review" });
  }
});

// ---- Share images ----------------------------------------------------------

router.get("/public/:slug/card.png", gritDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const scan = await findScanBySlug(String(req.params.slug || ""));
    if (!scan || !scan.isPublic) {
      res.status(404).json({ success: false, message: "Card not found" });
      return;
    }
    const items = await listItems(scan.id);
    const pro = await isOwnerPro(scan.userId);
    const png = await renderCardPng(await buildCardData(scan, items, { ownerView: false, isPro: pro }));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(png);
  } catch (err) {
    logger.error({ err }, "[gritscore] public png failed");
    res.status(500).json({ success: false, message: "Could not render the card" });
  }
});

router.get("/public/:slug/card.pdf", gritDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const scan = await findScanBySlug(String(req.params.slug || ""));
    if (!scan || !scan.isPublic) {
      res.status(404).json({ success: false, message: "Card not found" });
      return;
    }
    const pro = await isOwnerPro(scan.userId);
    if (!pro) {
      res.status(402).json({ success: false, code: "PAYWALL", message: "PDF export is a GritScore Pro feature." });
      return;
    }
    const items = await listItems(scan.id);
    const pdf = await renderCardPdf(await buildCardData(scan, items, { ownerView: false, isPro: true }));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="gritscore-${scan.slug}.pdf"`);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(pdf);
  } catch (err) {
    logger.error({ err }, "[gritscore] public pdf failed");
    res.status(500).json({ success: false, message: "Could not render the PDF" });
  }
});

router.get("/scans/:id/card.png", authenticate, gritDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const scan = await requireOwnScan(req, res);
    if (!scan) return;
    const items = await listItems(scan.id);
    const pro = await isOwnerPro(req.user!.id);
    const png = await renderCardPng(await buildCardData(scan, items, { ownerView: true, isPro: pro }));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.send(png);
  } catch (err) {
    logger.error({ err }, "[gritscore] owner png failed");
    res.status(500).json({ success: false, message: "Could not render the card" });
  }
});

router.get("/scans/:id/card.pdf", authenticate, gritDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const scan = await requireOwnScan(req, res);
    if (!scan) return;
    const pro = await isOwnerPro(req.user!.id);
    if (!pro) {
      res.status(402).json({ success: false, code: "PAYWALL", message: "PDF export is a GritScore Pro feature." });
      return;
    }
    const items = await listItems(scan.id);
    const pdf = await renderCardPdf(await buildCardData(scan, items, { ownerView: true, isPro: true }));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="gritscore-${scan.slug}.pdf"`);
    res.send(pdf);
  } catch (err) {
    logger.error({ err }, "[gritscore] owner pdf failed");
    res.status(500).json({ success: false, message: "Could not render the PDF" });
  }
});

// ---- Razorpay: ₹99 / 30 days ----------------------------------------------

function razorpayConfigured(): boolean {
  return Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
}

router.get("/pro/status", authenticate, gritDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const entitlement = await getActiveGritScorePro(req.user!.id);
    res.json({
      success: true,
      data: {
        isPro: isProActive(entitlement),
        expiresAt: entitlement?.expiresAt ?? null,
        priceInr: GRITSCORE_PRO.priceInr,
        days: GRITSCORE_PRO.days,
        name: GRITSCORE_PRO.name,
      },
    });
  } catch (err) {
    logger.error({ err }, "[gritscore] pro status failed");
    res.status(500).json({ success: false, message: "Could not load GritScore Pro status" });
  }
});

router.post("/pro/order", authenticate, gritDbGate, purchaseLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!razorpayConfigured()) {
      res.status(503).json({ success: false, message: "Payment gateway not configured" });
      return;
    }
    const active = await getActiveGritScorePro(req.user!.id);
    if (isProActive(active)) {
      res.status(409).json({ success: false, message: "GritScore Pro is already active on your account." });
      return;
    }
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    const rzResp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: Math.round(GRITSCORE_PRO.priceInr * 100),
        currency: "INR",
        receipt: `gritscore_${Date.now()}`,
        notes: { purpose: "gritscore_pro" },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!rzResp.ok) {
      res.status(502).json({ success: false, message: "Could not start checkout" });
      return;
    }
    const order = (await rzResp.json()) as { id: string };
    await createGritScorePendingOrder(req.user!.id, order.id);
    res.json({ success: true, data: { order, key: RAZORPAY_KEY_ID, priceInr: GRITSCORE_PRO.priceInr } });
  } catch (err) {
    logger.error({ err }, "[gritscore] pro order failed");
    const timedOut = (err as { name?: string }).name === "TimeoutError";
    res.status(502).json({ success: false, message: timedOut ? "Payment gateway timed out. Try again." : "Could not start checkout" });
  }
});

router.post("/pro/verify", authenticate, gritDbGate, purchaseLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!razorpayConfigured()) {
      res.status(503).json({ success: false, message: "Payment gateway not configured" });
      return;
    }
    const { razorpayOrderId, razorpayPaymentId } = (req.body ?? {}) as { razorpayOrderId?: string; razorpayPaymentId?: string };
    if (!razorpayOrderId || !razorpayPaymentId) {
      res.status(400).json({ success: false, message: "Missing payment details" });
      return;
    }
    const txn = await findGritScoreOrder(razorpayOrderId, req.user!.id);
    if (!txn) {
      res.status(404).json({ success: false, message: "Payment order not found" });
      return;
    }
    if (txn.status === "COMPLETED") {
      res.json({ success: true, message: "Already processed" });
      return;
    }
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    const pmtResp = await fetch(`https://api.razorpay.com/v1/payments/${razorpayPaymentId}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!pmtResp.ok) {
      res.status(502).json({ success: false, message: "Unable to verify payment with Razorpay" });
      return;
    }
    const payment = (await pmtResp.json()) as { status: string; amount: number; order_id: string };
    if (payment.status !== "captured" || payment.order_id !== razorpayOrderId || payment.amount !== Math.round(GRITSCORE_PRO.priceInr * 100)) {
      res.status(400).json({ success: false, message: "Payment could not be confirmed" });
      return;
    }
    const result = await completeGritScoreOrder(req.user!.id, razorpayOrderId, razorpayPaymentId);
    if (result.ok) {
      await notifyGritScorePro(req.user!.id, result.entitlement.expiresAt);
      void trackPurchase({
        eventId: razorpayPaymentId,
        value: GRITSCORE_PRO.priceInr,
        currency: "INR",
        email: req.user!.email,
        clientIp: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        sourceUrl: `${baseUrl()}/gritscore`,
      });
      res.status(201).json({
        success: true,
        data: { isPro: true, expiresAt: result.entitlement.expiresAt, priceInr: GRITSCORE_PRO.priceInr },
      });
      return;
    }
    if (result.reason === "already-active") {
      res.status(409).json({ success: false, message: "GritScore Pro is already active on your account." });
      return;
    }
    res.json({ success: true, message: "Already processed" });
  } catch (err) {
    logger.error({ err }, "[gritscore] pro verify failed");
    const timedOut = (err as { name?: string }).name === "TimeoutError";
    res.status(502).json({ success: false, message: timedOut ? "Payment gateway timed out. Try again." : "Verification failed" });
  }
});

// ---- Admin -----------------------------------------------------------------

router.get("/admin/scans", adminGuard, gritDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const q = String(req.query.q ?? "").trim().slice(0, 80);
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 25;
    const where = q
      ? or(ilike(gritscoreScansTable.displayName, `%${q}%`), ilike(gritscoreScansTable.slug, `%${q}%`))
      : undefined;
    const rows = await db
      .select({
        id: gritscoreScansTable.id,
        slug: gritscoreScansTable.slug,
        displayName: gritscoreScansTable.displayName,
        score: gritscoreScansTable.score,
        rawScore: gritscoreScansTable.rawScore,
        tier: gritscoreScansTable.tier,
        verificationTier: gritscoreScansTable.verificationTier,
        isPublic: gritscoreScansTable.isPublic,
        aiUsed: gritscoreScansTable.aiUsed,
        abused: sql<number>`jsonb_array_length(${gritscoreScansTable.abuseFlags})`,
        createdAt: gritscoreScansTable.createdAt,
      })
      .from(gritscoreScansTable)
      .where(where)
      .orderBy(desc(gritscoreScansTable.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage);
    res.json({ success: true, data: { scans: rows, page, perPage } });
  } catch (err) {
    logger.error({ err }, "[gritscore] admin list failed");
    res.status(500).json({ success: false, message: "Could not list scans" });
  }
});

router.get("/admin/scans/:id", adminGuard, gritDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const scan = await findScanById(String(req.params.id || ""));
    if (!scan) {
      res.status(404).json({ success: false, message: "Scan not found" });
      return;
    }
    const items = await listItems(scan.id);
    const config = await getScoreConfig();
    const input = { items: items.map(scoreInputFor), verificationTier: scan.verificationTier };
    const result = computeScore(input, config);
    res.json({
      success: true,
      data: {
        scan,
        items,
        computed: result,
        abuseFlags: scan.abuseFlags ?? [],
        aiUsed: scan.aiUsed,
      },
    });
  } catch (err) {
    logger.error({ err }, "[gritscore] admin detail failed");
    res.status(500).json({ success: false, message: "Could not load scan" });
  }
});

router.post("/admin/scans/:id/recompute", adminGuard, gritDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const scan = await findScanById(String(req.params.id || ""));
    if (!scan) {
      res.status(404).json({ success: false, message: "Scan not found" });
      return;
    }
    await recomputeScan(scan);
    const fresh = await findScanById(scan.id);
    res.json({ success: true, data: { scan: fresh } });
  } catch (err) {
    logger.error({ err }, "[gritscore] admin recompute failed");
    res.status(500).json({ success: false, message: "Could not recompute" });
  }
});

router.get("/admin/config", adminGuard, gritDbGate, async (_req: Request, res: Response): Promise<void> => {
  try {
    const config = await getScoreConfig();
    res.json({
      success: true,
      data: {
        weights: config.weights,
        defaults: mergeWeights(null),
        caps: config.caps,
        tiers: config.tiers,
        evidenceValue: config.evidenceValue,
        saturateAfter: config.saturateAfter,
        priceInr: GRITSCORE_PRO.priceInr,
        days: GRITSCORE_PRO.days,
      },
    });
  } catch (err) {
    logger.error({ err }, "[gritscore] admin config failed");
    res.status(500).json({ success: false, message: "Could not load config" });
  }
});

router.patch("/admin/config", adminGuard, gritDbGate, async (req: Request, res: Response): Promise<void> => {
  try {
    const weights = validateWeights(req.body?.weights);
    if (!weights) {
      res.status(400).json({ success: false, message: "Weights must be five non-negative numbers that sum to 1." });
      return;
    }
    const saved = await saveScoreWeights(weights);
    res.json({ success: true, data: { weights: saved } });
  } catch (err) {
    logger.error({ err }, "[gritscore] admin config write failed");
    res.status(500).json({ success: false, message: "Could not save config" });
  }
});

export { router as gritscoreRouter };
