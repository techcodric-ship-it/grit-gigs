// Safe alternative to auto-apply bots.
//
// Auto-apply bots submit applications from the candidate's account, which gets
// the candidate banned (LinkedIn prohibits automation) and the applications
// spam-flagged. This module does the opposite: it hands the candidate the
// employer's own application URL and lets them apply as themselves, in their
// own browser, with full control. Nothing is ever submitted on their behalf.

const HTTP_URL = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

// Returns the cleaned external application URL, or null when the job has no
// usable one. Only http(s) URLs are accepted — anything else (javascript:,
// data:, bare text) is rejected so the frontend can never be tricked into
// opening something dangerous from a job row.
export function parseExternalApplyLink(link: unknown): string | null {
  if (typeof link !== "string") return null;
  const cleaned = link.trim();
  if (!cleaned || cleaned.length > 2048) return null;
  if (!HTTP_URL.test(cleaned)) return null;
  return cleaned;
}

// Analytics term for external-apply intent. Stored in search_logs (which the
// platform already uses for demand telemetry) so no schema change is needed.
export function externalApplyLogTerm(jobId: string): string {
  return `job-external:${String(jobId).slice(0, 60)}`.slice(0, 80);
}
