// Proof/evidence submission logic: per-kind validation schemas, file rules,
// expiry math and the public JSON shape (file paths NEVER leave the server
// through this shape). Pure module — no DB import — so tests stay hermetic.

import { z } from "zod";
import { PROOF_KINDS, type ProofKind, type PrepProofSubmission } from "./schema";

export const PROOF_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const PROOF_RETENTION_DAYS = 30;

export const PROOF_ALLOWED_MIME = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export function isAllowedProofMime(mime: string): boolean {
  return (PROOF_ALLOWED_MIME as readonly string[]).includes(mime.toLowerCase());
}

export function evidenceExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + PROOF_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

const companyRef = z.object({
  companyId: z.string().uuid(),
});

const payRecord = companyRef.extend({
  kind: z.literal("PAY_RECORD"),
  payload: z.object({
    role: z.string().min(2).max(120),
    ctcInr: z.coerce.number().int().min(1).max(100_000_000),
    experienceYears: z.coerce.number().int().min(0).max(50),
    year: z.coerce.number().int().min(2000).max(2030),
  }),
});

const placementRecord = companyRef.extend({
  kind: z.literal("PLACEMENT_RECORD"),
  payload: z.object({
    college: z.string().min(2).max(200),
    packageInr: z.coerce.number().int().min(1).max(100_000_000),
    year: z.coerce.number().int().min(2000).max(2030),
    role: z.string().max(120).optional(),
  }),
});

const interviewExperience = companyRef.extend({
  kind: z.literal("INTERVIEW_EXPERIENCE"),
  payload: z.object({
    role: z.string().min(2).max(120),
    experience: z.string().min(30).max(3000),
  }),
});

export const proofSubmissionSchema = z.discriminatedUnion("kind", [
  payRecord,
  placementRecord,
  interviewExperience,
]);

export type ProofSubmission = z.infer<typeof proofSubmissionSchema>;

export function parseProofSubmission(body: unknown): { ok: true; value: ProofSubmission } | { ok: false; message: string } {
  const parsed = proofSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const label = first?.path.join(".") || "body";
    return { ok: false, message: `Invalid ${label}: ${first?.message ?? "check your inputs"}` };
  }
  return { ok: true, value: parsed.data };
}

export function normalizeMultipartFields(fields: Record<string, unknown>): Record<string, unknown> {
  // Multipart fields arrive as strings; payload arrives as a JSON string.
  const out: Record<string, unknown> = { ...fields };
  if (typeof out.payload === "string") {
    try {
      out.payload = JSON.parse(out.payload);
    } catch {
      delete out.payload;
    }
  }
  return out;
}

/** Server-side row -> client JSON. filePath is deliberately absent. */
export function publicSubmission(row: PrepProofSubmission) {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind as ProofKind,
    status: row.status,
    reviewNote: row.reviewNote ?? null,
    submittedAt: row.createdAt,
    reviewedAt: row.reviewedAt ?? null,
    expiresAt: row.expiresAt,
    fileProvided: Boolean(row.filePath) || row.fileDeletedAt !== null,
    rawEvidenceDeleted: row.fileDeletedAt !== null,
  };
}

export const reviewDecisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().max(500).optional(),
});
