// Aggregate builders: PROOF_MIN_SAMPLE enforcement, statistics, privacy.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  median,
  percentile,
  resolveMinSample,
  buildPayAggregate,
  buildPlacementAggregate,
  DEFAULT_MIN_SAMPLE,
} from "./aggregates";

const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const pay = (ctcInr: number, role = "SDE-1", doc = false) => ({
  payload: { role, ctcInr, experienceYears: 2, year: 2025 },
  hasVerifiedDocument: doc,
});
const place = (packageInr: number, college = "NIT Trichy") => ({
  payload: { college, packageInr, year: 2025 },
  hasVerifiedDocument: false,
});

describe("statistics helpers", () => {
  it("median handles odd/even/empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(3); // (2+3)/2 rounds to 3? -> 2.5 rounds to 3? Math.round(2.5)=3
    expect(median([])).toBeNull();
  });
  it("percentile uses nearest-rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8], 0.25)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8], 0.75)).toBe(6);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("resolveMinSample", () => {
  it("defaults to 5 and accepts sane overrides", () => {
    expect(resolveMinSample(undefined)).toBe(DEFAULT_MIN_SAMPLE);
    expect(resolveMinSample("3")).toBe(3);
    expect(resolveMinSample(10)).toBe(10);
  });
  it("rejects junk and dangerous values", () => {
    expect(resolveMinSample("abc")).toBe(5);
    expect(resolveMinSample(1)).toBe(5);
    expect(resolveMinSample(-3)).toBe(5);
    expect(resolveMinSample(100000)).toBe(100);
  });
});

describe("buildPayAggregate", () => {
  it("returns no-data for zero rows", () => {
    const a = buildPayAggregate([], 5);
    expect(a).toMatchObject({ available: false, reason: "no-data", sampleSize: 0 });
    expect(a.medianCtcInr).toBeUndefined();
  });
  it("enforces the minimum server-side: below min => only the count", () => {
    const a = buildPayAggregate([pay(1000000), pay(2000000), pay(3000000), pay(4000000)], 5);
    expect(a.available).toBe(false);
    expect(a.reason).toBe("below-min-sample");
    expect(a.sampleSize).toBe(4);
    expect(a).not.toHaveProperty("medianCtcInr");
    expect(a).not.toHaveProperty("byRole");
  });
  it("respects a raised PROOF_MIN_SAMPLE", () => {
    const rows = Array.from({ length: 6 }, (_, i) => pay(1_000_000 + i * 100_000));
    expect(buildPayAggregate(rows, 5).available).toBe(true);
    expect(buildPayAggregate(rows, 10).available).toBe(false);
    expect(buildPayAggregate(rows, 10).reason).toBe("below-min-sample");
  });
  it("computes median, quartiles and role slices at/above the minimum", () => {
    const rows = [
      pay(1_000_000, "SDE-1"), pay(1_200_000, "SDE-1"), pay(1_400_000, "SDE-1"),
      pay(2_000_000, "SDE-2"), pay(2_400_000, "SDE-2"),
    ];
    const a = buildPayAggregate(rows, 5);
    expect(a.available).toBe(true);
    expect(a.sampleSize).toBe(5);
    expect(a.medianCtcInr).toBe(1_400_000);
    expect(a.p25CtcInr).toBe(1_200_000); // nearest-rank ceil(0.25*5)=2 -> 2nd smallest
    expect(a.p75CtcInr).toBe(2_000_000);
    expect(a.sourceLabel).toBe("MEMBER_REPORTED");
    expect(a.byRole!.map((r) => r.role)).toEqual(["SDE-1", "SDE-2"]);
    expect(a.byRole![0]!.medianCtcInr).toBe(1_200_000);
  });
  it("drops single-sample role slices (fingerprint guard)", () => {
    const rows = [
      pay(1_000_000, "SDE-1"), pay(1_100_000, "SDE-1"), pay(1_200_000, "SDE-1"),
      pay(1_300_000, "SDE-1"), pay(9_900_000, "CTO"), // lone elite slice
    ];
    const a = buildPayAggregate(rows, 5);
    expect(a.available).toBe(true);
    expect(a.byRole!.some((r) => r.role === "CTO")).toBe(false);
  });
  it("counts verified documents separately", () => {
    const rows = [pay(1_000_000, "SDE", true), pay(1_100_000, "SDE"), pay(1_200_000, "SDE"), pay(1_300_000, "SDE"), pay(1_400_000, "SDE")];
    expect(buildPayAggregate(rows, 5).verifiedDocumentCount).toBe(1);
  });
  it("emits aggregate-only JSON (no ids or submitter fields)", () => {
    const rows = Array.from({ length: 5 }, () => pay(1_500_000));
    const json = JSON.stringify(buildPayAggregate(rows, 5));
    expect(json).not.toMatch(/"id"/);
    expect(json).not.toMatch(/submitted/i);
    expect(json).not.toMatch(/userId/i);
  });
});

describe("buildPlacementAggregate", () => {
  it("below minimum leaks no distribution", () => {
    const a = buildPlacementAggregate([place(800000), place(900000)], 5);
    expect(a).toMatchObject({ available: false, reason: "below-min-sample", sampleSize: 2 });
    expect(a).not.toHaveProperty("medianPackageInr");
  });
  it("computes median and college slices at/above the minimum", () => {
    const rows = [
      place(700000, "NIT Trichy"), place(800000, "NIT Trichy"), place(900000, "NIT Trichy"),
      place(1_500_000, "IIT Madras"), place(1_600_000, "IIT Madras"),
    ];
    const a = buildPlacementAggregate(rows, 5);
    expect(a.available).toBe(true);
    expect(a.medianPackageInr).toBe(900_000);
    expect(a.byCollege!.length).toBe(2);
    expect(a.byCollege![0]!.college).toBe("NIT Trichy"); // 3 samples > 2
    expect(a.sourceLabel).toBe("MEMBER_REPORTED");
  });
  it("drops single-sample colleges", () => {
    const rows = [
      place(700000, "NIT Trichy"), place(800000, "NIT Trichy"), place(900000, "NIT Trichy"),
      place(1_000_000, "NIT Trichy"), place(5_000_000, "IIM Ahmedabad"),
    ];
    const a = buildPlacementAggregate(rows, 5);
    expect(a.byCollege!.some((c) => c.college === "IIM Ahmedabad")).toBe(false);
  });
});

describe("aggregate wiring (source-level)", () => {
  const router = read("src/prep/router.ts");
  it("exposes both aggregate endpoints after the flag gate, rate-limited", () => {
    const gateIdx = router.indexOf("prepRouter.use(");
    const payIdx = router.indexOf('prepRouter.get("/companies/:slug/pay-aggregates"');
    const placeIdx = router.indexOf('prepRouter.get("/companies/:slug/placement-aggregates"');
    expect(payIdx).toBeGreaterThan(gateIdx);
    expect(placeIdx).toBeGreaterThan(gateIdx);
    expect(router).toMatch(/aggregateLimiter/);
  });
  it("passes the env-configured PROOF_MIN_SAMPLE into the builders", () => {
    expect(router).toContain("buildPayAggregate(rows, resolveMinSample(process.env.PROOF_MIN_SAMPLE))");
    expect(router).toContain("buildPlacementAggregate(rows, resolveMinSample(process.env.PROOF_MIN_SAMPLE))");
  });
  it("approved-row queries filter on status APPROVED and never select ids out", () => {
    const db = read("src/prep/proof-db.ts");
    expect(db).toContain('eq(prepProofSubmissionsTable.status, "APPROVED")');
    expect(db).toContain("payload: (r.payload ?? {})");
    expect(db).toMatch(/hasVerifiedDocument: Boolean\(r\.filePath\) \|\| r\.fileDeletedAt !== null/);
  });
  const page = read("public/prep/report.html");
  it("report page renders both aggregates with escaping and honest below-min copy", () => {
    expect(page).toContain("/pay-aggregates");
    expect(page).toContain("/placement-aggregates");
    expect(page).toContain("rpPayCard");
    expect(page).toContain("rpPlacementCard");
    expect(page).toContain("esc(r.role)");
    expect(page).toContain("esc(c.college)");
    expect(page).toContain("approved reports so far");
    expect(page).toContain("Member-reported");
  });
});
