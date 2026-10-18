// Prep monetization - pure logic only (no imports from ../db so tests stay
// DATABASE_URL-free).
//
// Model:
// - Prep Pro: a 30-day prep-scoped entitlement stored in prep_entitlements.
//   The shared plan_id / transaction_type enums are untouched; purchase is
//   funded from the existing wallet balance (Razorpay top-ups are unchanged).
// - Free tier: PREP_FREE_DAILY_REPORTS report generations per rolling 24h,
//   enforced server-side on BOTH report-creating routes (POST /reports and
//   GET /companies/:slug/report). Cached report reads stay free.
// - Contributor earnings: approving a proof submission credits the submitter's
//   wallet once, keyed by prep_credit_awards.reason = proof-award:<id>, whose
//   UNIQUE index makes double-payment impossible even across retries.

export const PREP_PRO_PRICE_INR = 199;
export const PREP_PRO_DAYS = 30;
export const PREP_PROOF_AWARD_INR = 25;
export const FREE_DAILY_REPORTS_DEFAULT = 3;

/** Parse PREP_FREE_DAILY_REPORTS. 0 disables generation for free users,
 *  huge/garbage values fall back to the default, never to unlimited. */
export function resolveFreeDailyReports(env: string | number | undefined): number {
  const raw = typeof env === "number" ? env : Number.parseInt(String(env ?? ""), 10);
  if (!Number.isFinite(raw) || raw < 0) return FREE_DAILY_REPORTS_DEFAULT;
  return Math.min(raw, 100);
}

export function isEntitlementActive(
  row: { status: string; expiresAt: Date | string } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!row) return false;
  if (row.status !== "ACTIVE") return false;
  const expires = row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
  return expires.getTime() > now.getTime();
}

export function proExpiryFrom(now: Date, days: number = PREP_PRO_DAYS): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Free users get `limit` generations per rolling 24h; Pro users are unlimited. */
export function canGenerateReport(reportsToday: number, isPro: boolean, limit: number): boolean {
  if (isPro) return true;
  return reportsToday < limit;
}

/** Idempotency key for a proof-contribution payout. One award per submission. */
export function proofAwardReason(submissionId: string): string {
  return `proof-award:${submissionId}`;
}
