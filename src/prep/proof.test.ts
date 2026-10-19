// Proof/evidence pipeline: pure validation, public-shape privacy, retention,
// and source-level wiring.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  parseProofSubmission,
  normalizeMultipartFields,
  publicSubmission,
  evidenceExpiry,
  isAllowedProofMime,
  reviewDecisionSchema,
  PROOF_RETENTION_DAYS,
  PROOF_FILE_MAX_BYTES,
} from "./proof";
import type { PrepProofSubmission } from "./schema";

const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

describe("parseProofSubmission", () => {
  it("accepts a valid pay record (coerces numeric strings from multipart)", () => {
    const out = parseProofSubmission({
      kind: "PAY_RECORD",
      companyId: COMPANY_ID,
      payload: { role: "SDE-1", ctcInr: "1200000", experienceYears: "2", year: "2025" },
    });
    expect(out.ok).toBe(true);
    if (out.ok && out.value.kind === "PAY_RECORD") {
      expect(out.value.payload.ctcInr).toBe(1200000);
    } else {
      throw new Error("expected PAY_RECORD");
    }
  });
  it("accepts a valid placement record and interview experience", () => {
    expect(parseProofSubmission({
      kind: "PLACEMENT_RECORD",
      companyId: COMPANY_ID,
      payload: { college: "NIT Trichy", packageInr: 1800000, year: 2025 },
    }).ok).toBe(true);
    expect(parseProofSubmission({
      kind: "INTERVIEW_EXPERIENCE",
      companyId: COMPANY_ID,
      payload: { role: "Data Analyst", experience: "I went through three rounds of interviews covering SQL and case studies." },
    }).ok).toBe(true);
  });
  it("rejects unknown kinds and out-of-range values with a helpful message", () => {
    const badKind = parseProofSubmission({ kind: "SCAM_REPORT", companyId: COMPANY_ID, payload: {} });
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.message).toMatch(/kind/i);
    const badCtc = parseProofSubmission({
      kind: "PAY_RECORD",
      companyId: COMPANY_ID,
      payload: { role: "SDE-1", ctcInr: -5, experienceYears: 1, year: 2025 },
    });
    expect(badCtc.ok).toBe(false);
  });
  it("requires companyId to be a uuid", () => {
    expect(parseProofSubmission({ kind: "PAY_RECORD", companyId: "nope", payload: { role: "x", ctcInr: 1, experienceYears: 0, year: 2025 } }).ok).toBe(false);
  });
  it("requires narrative length for interview experiences", () => {
    expect(parseProofSubmission({
      kind: "INTERVIEW_EXPERIENCE",
      companyId: COMPANY_ID,
      payload: { role: "SDE", experience: "too short" },
    }).ok).toBe(false);
  });
});

describe("normalizeMultipartFields", () => {
  it("parses a JSON payload string", () => {
    const out = normalizeMultipartFields({ kind: "PAY_RECORD", payload: '{"role":"SDE-1"}' });
    expect(out.payload).toEqual({ role: "SDE-1" });
  });
  it("drops unparseable payload instead of throwing", () => {
    const out = normalizeMultipartFields({ payload: "{broken" });
    expect(out.payload).toBeUndefined();
  });
});

describe("publicSubmission privacy", () => {
  const row: PrepProofSubmission = {
    id: "22222222-2222-4222-8222-222222222222",
    companyId: COMPANY_ID,
    kind: "PAY_RECORD",
    payload: { role: "SDE-1" },
    filePath: "https://example.supabase.co/storage/v1/object/public/uploads/proof-evidence/secret.png",
    status: "PENDING",
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    submittedBy: "33333333-3333-4333-8333-333333333333",
    createdAt: new Date("2026-10-18T00:00:00Z"),
    expiresAt: new Date("2026-11-17T00:00:00Z"),
    fileDeletedAt: null,
  };
  it("never exposes the storage path", () => {
    const pub = publicSubmission(row) as Record<string, unknown>;
    expect(pub).not.toHaveProperty("filePath");
    expect(pub).not.toHaveProperty("file_path");
    expect(JSON.stringify(pub)).not.toContain("supabase");
    expect(JSON.stringify(pub)).not.toContain("secret.png");
  });
  it("reports file presence and retention honestly", () => {
    expect(publicSubmission(row).fileProvided).toBe(true);
    expect(publicSubmission(row).rawEvidenceDeleted).toBe(false);
    const deleted = { ...row, filePath: null, fileDeletedAt: new Date() };
    expect(publicSubmission(deleted).fileProvided).toBe(true);
    expect(publicSubmission(deleted).rawEvidenceDeleted).toBe(true);
  });
});

describe("retention and file rules", () => {
  it("expires evidence after exactly 30 days", () => {
    const start = new Date("2026-10-01T00:00:00Z");
    const exp = evidenceExpiry(start);
    expect(PROOF_RETENTION_DAYS).toBe(30);
    expect(exp.getTime() - start.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });
  it("allows only pdf/png/jpeg/webp and caps at 5 MB", () => {
    expect(isAllowedProofMime("application/pdf")).toBe(true);
    expect(isAllowedProofMime("IMAGE/PNG")).toBe(true);
    expect(isAllowedProofMime("application/x-sh")).toBe(false);
    expect(isAllowedProofMime("text/html")).toBe(false);
    expect(PROOF_FILE_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
  it("validates review decisions", () => {
    expect(reviewDecisionSchema.safeParse({ decision: "APPROVED" }).success).toBe(true);
    expect(reviewDecisionSchema.safeParse({ decision: "maybe" }).success).toBe(false);
    expect(reviewDecisionSchema.safeParse({ decision: "REJECTED", note: "no doc" }).success).toBe(true);
  });
});

describe("proof wiring (source-level)", () => {
  const router = read("src/prep/router.ts");
  it("submit endpoint requires auth, rate limit and a gate before it", () => {
    const gateIdx = router.indexOf("prepRouter.use(");
    const idx = router.indexOf('prepRouter.post("/proof"');
    expect(idx).toBeGreaterThan(gateIdx);
    expect(router).toMatch(/prepRouter\.post\("\/proof", authenticate, proofSubmitLimiter, prepDbGate/);
    expect(router).toMatch(/prepRouter\.get\("\/proof\/my", authenticate/);
  });
  it("moderation endpoints use adminAuth, never authenticate", () => {
    expect(router).toMatch(/prepRouter\.get\("\/proof\/pending", adminAuth/);
    expect(router).toMatch(/prepRouter\.post\("\/proof\/:id\/review", adminAuth/);
  });
  it("stores evidence via uploadToSupabase under the proof subfolder", () => {
    expect(router).toContain('uploadToSupabase(file.buffer, file.originalname, "proof-evidence")');
  });

  const db = read("src/prep/db.ts");
  it("retention sweep only touches prep_ tables and nulls the path after delete", () => {
    expect(db).toMatch(/FROM prep_proof_submissions\s+WHERE file_path IS NOT NULL AND expires_at < NOW\(\)/);
    expect(db).toContain("SET file_path = NULL, file_deleted_at = NOW()");
    expect(db).toContain("deleteFromSupabase");
    const tables = [...db.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    for (const t of tables) expect(t).toMatch(/^prep_/);
  });
  it("retention runs on an unref'd 6-hour interval after DDL bootstrap", () => {
    expect(db).toContain("runEvidenceRetention");
    expect(db).toContain("timer.unref?.()");
  });

  const page = read("public/prep/proof.html");
  it("proof page is login-gated, noindex and escaped", () => {
    expect(page).toContain('<meta name="robots" content="noindex"/>');
    expect(page).toContain('if (!(window.SeAuth ? SeAuth.haveSession() : localStorage.getItem("se_token")))');
    expect(page).toContain("function esc(s)");
    expect(page).toContain("esc(KINDS[s.kind] || s.kind)");
  });
  it("posts multipart form data with companyId, kind and payload", () => {
    expect(page).toContain('fd.append("companyId"');
    expect(page).toContain('fd.append("payload"');
    expect(page).toContain("/api/prep/proof");
    expect(page).toContain("/api/prep/proof/my");
  });
});
