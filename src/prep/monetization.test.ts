// Prep monetization: pure entitlement/quota logic + source-level wiring
// (DB layer is exercised against a real DB in deploy, so its SQL invariants
// are asserted from source here).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PREP_PRO_DAYS,
  PREP_PRO_PRICE_INR,
  PREP_PROOF_AWARD_INR,
  FREE_DAILY_REPORTS_DEFAULT,
  canGenerateReport,
  isEntitlementActive,
  proExpiryFrom,
  proofAwardReason,
  resolveFreeDailyReports,
} from "./monetization";

const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

describe("resolveFreeDailyReports", () => {
  it("defaults when unset or garbage", () => {
    expect(resolveFreeDailyReports(undefined)).toBe(FREE_DAILY_REPORTS_DEFAULT);
    expect(resolveFreeDailyReports("")).toBe(FREE_DAILY_REPORTS_DEFAULT);
    expect(resolveFreeDailyReports("abc")).toBe(FREE_DAILY_REPORTS_DEFAULT);
    expect(resolveFreeDailyReports(-1)).toBe(FREE_DAILY_REPORTS_DEFAULT);
  });
  it("accepts sane overrides, including 0 (hard block) and a 100 cap", () => {
    expect(resolveFreeDailyReports(0)).toBe(0);
    expect(resolveFreeDailyReports("7")).toBe(7);
    expect(resolveFreeDailyReports(99999)).toBe(100);
  });
});

describe("isEntitlementActive", () => {
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);
  it("requires ACTIVE status AND unexpired", () => {
    expect(isEntitlementActive(null)).toBe(false);
    expect(isEntitlementActive({ status: "ACTIVE", expiresAt: future })).toBe(true);
    expect(isEntitlementActive({ status: "ACTIVE", expiresAt: past })).toBe(false);
    expect(isEntitlementActive({ status: "EXPIRED", expiresAt: future })).toBe(false);
    expect(isEntitlementActive({ status: "CANCELED", expiresAt: future })).toBe(false);
  });
  it("accepts string timestamps", () => {
    expect(isEntitlementActive({ status: "ACTIVE", expiresAt: future.toISOString() })).toBe(true);
    expect(isEntitlementActive({ status: "ACTIVE", expiresAt: past.toISOString() })).toBe(false);
  });
  it("treats the exact expiry instant as expired", () => {
    const now = new Date();
    expect(isEntitlementActive({ status: "ACTIVE", expiresAt: now }, now)).toBe(false);
  });
});

describe("proExpiryFrom", () => {
  it("is exactly PREP_PRO_DAYS ahead", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(proExpiryFrom(now).getTime() - now.getTime()).toBe(PREP_PRO_DAYS * 86_400_000);
  });
});

describe("canGenerateReport", () => {
  it("free users are capped, Pro users are unlimited", () => {
    expect(canGenerateReport(0, false, 3)).toBe(true);
    expect(canGenerateReport(2, false, 3)).toBe(true);
    expect(canGenerateReport(3, false, 3)).toBe(false);
    expect(canGenerateReport(50, false, 3)).toBe(false);
    expect(canGenerateReport(9999, true, 3)).toBe(true);
  });
  it("a zero limit blocks free generation entirely", () => {
    expect(canGenerateReport(0, false, 0)).toBe(false);
    expect(canGenerateReport(0, true, 0)).toBe(true);
  });
});

describe("proofAwardReason", () => {
  it("is unique per submission (the UNIQUE index keys on it)", () => {
    expect(proofAwardReason("abc")).toBe("proof-award:abc");
    expect(proofAwardReason("abc")).not.toBe(proofAwardReason("abd"));
  });
});

describe("wiring (source-level)", () => {
  const router = read("src/prep/router.ts");
  const dbLayer = read("src/prep/monetization-db.ts");
  const ddl = read("src/prep/db.ts");
  const schema = read("src/prep/schema.ts");
  const index = read("public/prep/index.html");

  it("quota is enforced on BOTH report-creating routes", () => {
    const calls = router.match(/checkReportQuota\(req\.user!\.id\)/g) ?? [];
    expect(calls.length).toBe(2); // POST /reports + GET /companies/:slug/report
    expect(router).toContain('code: "UPGRADE_REQUIRED"');
    expect(router).toContain("res.status(402)");
    expect(router).toContain("canGenerateReport");
    expect(router).toContain("resolveFreeDailyReports(process.env.PREP_FREE_DAILY_REPORTS)");
  });

  it("cached report reads stay free (quota check sits after the existing-return)", () => {
    const getIdx = router.indexOf('prepRouter.get("/companies/:slug/report"');
    const cachedIdx = router.indexOf("const existing = await latestReportForCompany", getIdx);
    const quotaIdx = router.indexOf("await checkReportQuota", cachedIdx);
    const createIdx = router.indexOf("await createReport", getIdx);
    expect(getIdx).toBeGreaterThan(-1);
    expect(cachedIdx).toBeGreaterThan(getIdx);
    expect(quotaIdx).toBeGreaterThan(cachedIdx); // only reached when no cached report
    expect(createIdx).toBeGreaterThan(quotaIdx);
  });

  it("pro endpoints exist behind the flag gate + auth, rate-limited", () => {
    const gateIdx = router.indexOf("prepRouter.use(");
    const statusIdx = router.indexOf('prepRouter.get("/pro/status"');
    const buyIdx = router.indexOf('prepRouter.post("/pro/purchase"');
    expect(statusIdx).toBeGreaterThan(gateIdx);
    expect(buyIdx).toBeGreaterThan(gateIdx);
    expect(router).toContain("purchaseLimiter");
    expect(router).toContain("proLimiter");
    expect(router).toContain('reason === "already-active"');
    expect(router).toContain("Not enough wallet balance");
  });

  it("review flow approves AND pays in one transaction via reviewAndAward", () => {
    expect(router).toContain("reviewAndAward(");
    expect(router).not.toContain("reviewSubmission(");
    expect(dbLayer).toContain("db.transaction(async (tx)");
    expect(dbLayer).toContain("eq(prepProofSubmissionsTable.status, \"PENDING\")");
  });

  it("payout idempotency: award insert is ON CONFLICT DO NOTHING keyed on reason", () => {
    expect(dbLayer).toContain("ON CONFLICT (reason) DO NOTHING");
    expect(dbLayer).toContain("proofAwardReason(submissionId)");
    expect(dbLayer).toContain("PREP_PROOF_AWARD_INR");
  });

  it("wallet debit is atomic (balance >= price in the UPDATE) with 23505 race fallback", () => {
    expect(dbLayer).toContain("balance >= ${price}");
    expect(dbLayer).toContain('"23505"');
    expect(dbLayer).toContain('"already-active"');
    expect(dbLayer).toContain('"insufficient-balance"');
  });

  it("uses only existing transaction_type enum values (SUBSCRIPTION / SERVICE_EARNING)", () => {
    expect(dbLayer).toContain('type: "SUBSCRIPTION"');
    expect(dbLayer).toContain('type: "SERVICE_EARNING"');
    expect(dbLayer).not.toMatch(/type: "(?!SUBSCRIPTION"|SERVICE_EARNING")/);
  });

  it("prep DDL adds both tables with the two uniqueness guarantees", () => {
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS prep_entitlements");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS prep_credit_awards");
    expect(ddl).toContain("ON prep_entitlements (user_id, kind) WHERE status = 'ACTIVE'");
    expect(ddl).toContain("ON prep_credit_awards (reason)");
    expect(schema).toContain('pgTable("prep_entitlements"');
    expect(schema).toContain('pgTable("prep_credit_awards"');
    expect(schema).not.toMatch(/pgEnum\("prep_/); // no new enums (shared enums untouched)
  });

  it("home page shows quota + buy flow with the quoted price", () => {
    expect(index).toContain("/api/prep/pro/status");
    expect(index).toContain("/api/prep/pro/purchase");
    expect(index).toContain("Buy Prep Pro — ₹199 / 30 days");
    expect(index).toContain("report generations left today");
    expect(index).toContain("se_token");
  });

  it("constants stay in sync with the page copy", () => {
    expect(PREP_PRO_PRICE_INR).toBe(199);
    expect(PREP_PRO_DAYS).toBe(30);
    expect(PREP_PROOF_AWARD_INR).toBeGreaterThan(0);
    expect(index).toContain("₹" + PREP_PRO_PRICE_INR);
  });
});
