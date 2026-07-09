import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { uploadToSupabase } from "../lib/storage";
import { PROJECT_ROOT } from "../lib/root";
import multer from "multer";
import path from "path";
import fs from "fs";
import { db, kycDocumentsTable, usersTable, notificationsTable } from "../db";
import { authenticate } from "../middlewares/authenticate";

const router: IRouter = Router();

const kycDir = path.join(PROJECT_ROOT, "uploads", "kyc");
fs.mkdirSync(kycDir, { recursive: true });

const kycUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, kycDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `kyc-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".pdf"];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// POST /kyc/submit — upload a government ID or other document
// multipart: docType (string), file (the document image/pdf)
router.post("/kyc/submit", authenticate, (req: Request, res: Response, next: NextFunction) => {
  kycUpload.single("file")(req, res, (err) => {
    if (err) {
      const msg = err instanceof multer.MulterError
        ? `Upload error: ${err.message}`
        : "File upload failed. Please try again.";
      return res.status(400).json({ success: false, message: msg });
    }
    next();
  });
}, async (req: Request, res: Response): Promise<void> => {
  try {
    const { docType } = req.body;
    if (!req.file || !docType) {
      res.status(400).json({ success: false, message: "docType and a file upload are required" }); return;
    }
    const supabaseUrl = await uploadToSupabase(fs.readFileSync(req.file.path), req.file.originalname, "kyc");
    const fileUrl = supabaseUrl || `/uploads/kyc/${req.file.filename}`;

    const [existing] = await db.select().from(kycDocumentsTable).where(eq(kycDocumentsTable.userId, req.user!.id)).limit(1);
    if (existing && existing.status === "APPROVED") {
      res.status(400).json({ success: false, message: "Your KYC is already approved" }); return;
    }

    let doc;
    if (existing) {
      [doc] = await db.update(kycDocumentsTable).set({ docType, fileUrl, status: "PENDING", reviewNotes: null, submittedAt: new Date(), reviewedAt: null }).where(eq(kycDocumentsTable.id, existing.id)).returning();
    } else {
      [doc] = await db.insert(kycDocumentsTable).values({ userId: req.user!.id, docType, fileUrl }).returning();
    }

    await db.insert(notificationsTable).values({
      userId: req.user!.id, type: "KYC",
      title: "KYC document submitted",
      message: "Your identity document has been received and is under review. This usually takes 24 hours.",
      linkUrl: "/dashboard.html?tab=my-profile",
    });

    res.status(201).json({ success: true, message: "KYC document submitted for review", data: { doc } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Something went wrong. Please try again.";
    res.status(500).json({ success: false, message: msg });
  }
});

// GET /kyc/status — user checks their own KYC status
router.get("/kyc/status", authenticate, async (req: Request, res: Response): Promise<void> => {
  const [doc] = await db.select().from(kycDocumentsTable).where(eq(kycDocumentsTable.userId, req.user!.id)).limit(1);
  res.json({ success: true, data: { kyc: doc || null } });
});

// GET /kyc/pending — admin: list all pending docs
router.get("/kyc/pending", authenticate, async (req: Request, res: Response): Promise<void> => {
  if (req.user!.role !== "ADMIN" && req.user!.role !== "MODERATOR") { res.status(403).json({ success: false, message: "Admin only" }); return; }
  const docs = await db.select({ doc: kycDocumentsTable, user: usersTable })
    .from(kycDocumentsTable)
    .innerJoin(usersTable, eq(usersTable.id, kycDocumentsTable.userId))
    .where(eq(kycDocumentsTable.status, "PENDING"));
  res.json({ success: true, data: { docs } });
});

// PUT /kyc/:userId/review — admin: approve or reject
// body: { status: 'APPROVED'|'REJECTED', reviewNotes? }
router.put("/kyc/:userId/review", authenticate, async (req: Request, res: Response): Promise<void> => {
  if (req.user!.role !== "ADMIN" && req.user!.role !== "MODERATOR") { res.status(403).json({ success: false, message: "Admin only" }); return; }
  const { status, reviewNotes } = req.body;
  if (!["APPROVED", "REJECTED"].includes(status)) { res.status(403).json({ success: false, message: "status must be APPROVED or REJECTED" }); return; }
  const targetUserId = req.params.userId as string;

  const [doc] = await db.select().from(kycDocumentsTable).where(eq(kycDocumentsTable.userId, targetUserId)).limit(1);
  if (!doc) { res.status(404).json({ success: false, message: "No KYC document for this user" }); return; }

  await db.update(kycDocumentsTable).set({ status, reviewNotes: reviewNotes || null, reviewedAt: new Date() }).where(eq(kycDocumentsTable.id, doc.id));

  if (status === "APPROVED") {
    await db.update(usersTable).set({ kycVerified: true }).where(eq(usersTable.id, targetUserId));
    try { req.app?.get("io")?.emit("profile:updated", { userId: targetUserId }); } catch {}
  }

  await db.insert(notificationsTable).values({
    userId: targetUserId, type: "KYC",
    title: status === "APPROVED" ? "KYC Approved — You're verified!" : "KYC Review: Action required",
    message: status === "APPROVED"
      ? "Your identity has been verified. A verified badge is now visible on your profile."
      : `Your KYC was not approved. ${reviewNotes ? "Note: " + reviewNotes : "Please re-submit with a clearer document."}`,
    linkUrl: "/dashboard.html?tab=my-profile",
  });

  res.json({ success: true, message: `KYC ${status.toLowerCase()}` });
});

export default router;
