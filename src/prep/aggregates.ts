// Aggregates over APPROVED proof submissions (Phase 8). Hard rules:
// - PROOF_MIN_SAMPLE (default 5) is enforced HERE, server-side: below the
//   minimum, only the sample size is returned — never partial distributions;
// - output is aggregate-only: no contributor ids, no payloads, no narratives;
// - every aggregate is labelled MEMBER_REPORTED (with a verified-document
//   count), because these are member submissions reviewed by moderators — not
//   official employer data.

export const DEFAULT_MIN_SAMPLE = 5;

export interface ApprovedPayRow {
  payload: Record<string, unknown>;
  hasVerifiedDocument: boolean;
}

export interface RoleAggregate {
  role: string;
  sampleSize: number;
  medianCtcInr: number;
}

export interface PayAggregate {
  available: boolean;
  reason: "ok" | "below-min-sample" | "no-data";
  sampleSize: number;
  minSample: number;
  sourceLabel: "MEMBER_REPORTED";
  verifiedDocumentCount: number;
  medianCtcInr?: number;
  p25CtcInr?: number;
  p75CtcInr?: number;
  byRole?: RoleAggregate[];
}

export interface PlacementAggregate {
  available: boolean;
  reason: "ok" | "below-min-sample" | "no-data";
  sampleSize: number;
  minSample: number;
  sourceLabel: "MEMBER_REPORTED";
  verifiedDocumentCount: number;
  medianPackageInr?: number;
  byCollege?: { college: string; sampleSize: number; medianPackageInr: number }[];
}

export function resolveMinSample(envValue: unknown): number {
  const n = Number(envValue);
  if (!Number.isFinite(n) || n < 2) return DEFAULT_MIN_SAMPLE;
  return Math.min(Math.floor(n), 100); // sanity cap
}

/** Median of a sorted copy; null for empty input. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Nearest-rank quartiles (q in 0..1) on a sorted copy; null for empty. */
export function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * s.length));
  return s[Math.min(rank, s.length) - 1] ?? null;
}

function readNumber(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
}

export function buildPayAggregate(rows: ApprovedPayRow[], minSample: number): PayAggregate {
  const verified = rows.filter((r) => r.hasVerifiedDocument).length;
  const base = {
    sampleSize: rows.length,
    minSample,
    sourceLabel: "MEMBER_REPORTED" as const,
    verifiedDocumentCount: verified,
  };
  if (rows.length === 0) return { available: false, reason: "no-data", ...base };
  if (rows.length < minSample) return { available: false, reason: "below-min-sample", ...base };

  const ctcs = rows.map((r) => readNumber(r.payload, "ctcInr")).filter((n): n is number => n !== null);
  if (ctcs.length < minSample) {
    return {
      available: false,
      reason: "below-min-sample",
      sampleSize: ctcs.length,
      minSample,
      sourceLabel: "MEMBER_REPORTED",
      verifiedDocumentCount: verified,
    };
  }

  const byRoleMap = new Map<string, number[]>();
  for (const r of rows) {
    const ctc = readNumber(r.payload, "ctcInr");
    const role = readString(r.payload, "role") ?? "Other";
    if (ctc === null) continue;
    const list = byRoleMap.get(role) ?? [];
    list.push(ctc);
    byRoleMap.set(role, list);
  }
  const byRole: RoleAggregate[] = [...byRoleMap.entries()]
    .map(([role, list]) => ({ role, sampleSize: list.length, medianCtcInr: median(list) ?? 0 }))
    .filter((r) => r.sampleSize >= 2) // tiny role slices can fingerprint individuals
    .sort((a, b) => b.sampleSize - a.sampleSize || a.role.localeCompare(b.role));

  return {
    available: true,
    reason: "ok",
    ...base,
    medianCtcInr: median(ctcs) ?? 0,
    p25CtcInr: percentile(ctcs, 0.25) ?? 0,
    p75CtcInr: percentile(ctcs, 0.75) ?? 0,
    byRole,
  };
}

export function buildPlacementAggregate(rows: ApprovedPayRow[], minSample: number): PlacementAggregate {
  const verified = rows.filter((r) => r.hasVerifiedDocument).length;
  const base = {
    sampleSize: rows.length,
    minSample,
    sourceLabel: "MEMBER_REPORTED" as const,
    verifiedDocumentCount: verified,
  };
  if (rows.length === 0) return { available: false, reason: "no-data", ...base };
  if (rows.length < minSample) return { available: false, reason: "below-min-sample", ...base };

  const packages = rows.map((r) => readNumber(r.payload, "packageInr")).filter((n): n is number => n !== null);
  if (packages.length < minSample) {
    return {
      available: false,
      reason: "below-min-sample",
      sampleSize: packages.length,
      minSample,
      sourceLabel: "MEMBER_REPORTED",
      verifiedDocumentCount: verified,
    };
  }

  const byCollegeMap = new Map<string, number[]>();
  for (const r of rows) {
    const pkg = readNumber(r.payload, "packageInr");
    const college = readString(r.payload, "college") ?? "Other";
    if (pkg === null) continue;
    const list = byCollegeMap.get(college) ?? [];
    list.push(pkg);
    byCollegeMap.set(college, list);
  }
  const byCollege = [...byCollegeMap.entries()]
    .map(([college, list]) => ({ college, sampleSize: list.length, medianPackageInr: median(list) ?? 0 }))
    .filter((c) => c.sampleSize >= 2) // same fingerprinting guard as byRole
    .sort((a, b) => b.sampleSize - a.sampleSize || a.college.localeCompare(b.college));

  return {
    available: true,
    reason: "ok",
    ...base,
    medianPackageInr: median(packages) ?? 0,
    byCollege,
  };
}
