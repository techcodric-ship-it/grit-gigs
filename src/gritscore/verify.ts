import type { VerificationTier } from "./config";

export interface VerificationItem {
  evidenceType: string;
  evidenceStatus: string;
}

/**
 * Derive the public verification badge from what was actually checked:
 *  - any confirmed referee  → third_party_confirmed
 *  - every proof-bearing item reachable (no dead/duplicate) and at least one
 *    positively checked → evidence_checked
 *  - otherwise              → self_reported (and the score is capped at 600)
 *
 * "blocked" (401/403/429) is treated as unverified but not as a lie: sites
 * like LinkedIn refuse bots, and punishing that would punish real people.
 */
export function resolveVerificationTier(
  items: VerificationItem[],
  confirmedReferees: number,
): VerificationTier {
  if (confirmedReferees > 0) return "third_party_confirmed";
  const withProof = items.filter((i) => i.evidenceType && i.evidenceType !== "none");
  if (withProof.length === 0) return "self_reported";
  const bad = withProof.some((i) => i.evidenceStatus === "dead" || i.evidenceStatus === "duplicate" || i.evidenceStatus === "invalid");
  const checked = withProof.some((i) => i.evidenceStatus === "ok");
  if (!bad && checked) return "evidence_checked";
  return "self_reported";
}

/** Public label. Never "verified professional" — the wording stays factual. */
export function verificationLabel(tier: VerificationTier): string {
  switch (tier) {
    case "third_party_confirmed":
      return "Third-party confirmed";
    case "evidence_checked":
      return "Evidence checked";
    default:
      return "Self-reported";
  }
}

/** Exact score visibility rule for public cards. The owner decides whether
 *  the number is public; the tier stays visible either way. Confidence is
 *  communicated by the "provisional" label while proof is still thin. */
export function canShowExactScore(input: {
  showExactScore: boolean;
  score: number | null;
}): boolean {
  return input.showExactScore && input.score != null;
}
