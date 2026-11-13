// GritScore — single source of truth for every tunable number.
//
// One rule the whole feature depends on: the score is arithmetic, never an AI
// opinion. Weights, evidence values, tier cutoffs and verification caps all
// live here so the score can be explained and audited in one place. Admin
// overrides are validated against this file (see getScoreConfig).

export type EvidenceType =
  | "liveLink"
  | "github"
  | "published"
  | "certificate"
  | "file"
  | "screenshot"
  | "none";

export type VerificationTier =
  | "self_reported"
  | "evidence_checked"
  | "third_party_confirmed";

export type TierName = "Starter" | "Rising" | "Solid" | "Elite" | "Legend";

export const SCORE_MIN = 300;
export const SCORE_RANGE = 600;
export const SCORE_MAX = SCORE_MIN + SCORE_RANGE;

/** Evidence strength, 0..1. A link that can be opened beats a screenshot of a
 *  link; an unverifiable claim is worth almost nothing but is never zero, so a
 *  single weak item does not produce a misleading 300. */
export const EVIDENCE_VALUE: Record<EvidenceType, number> = {
  liveLink: 1.0,
  github: 1.0,
  published: 1.0,
  certificate: 1.0,
  file: 0.7,
  screenshot: 0.5,
  none: 0.1,
};

export interface ScoreWeights {
  proof: number;
  skillDepth: number;
  impact: number;
  consistency: number;
  clarity: number;
}

/** Weights sum to 1. Freeze so an accidental mutation cannot silently change
 *  every score in the product. */
export const DEFAULT_WEIGHTS: Readonly<ScoreWeights> = Object.freeze({
  proof: 0.3,
  skillDepth: 0.25,
  impact: 0.2,
  consistency: 0.15,
  clarity: 0.1,
});

export interface ScoreConfig {
  weights: ScoreWeights;
  evidenceValue: Record<EvidenceType, number>;
  caps: Record<VerificationTier, number | null>;
  tiers: { name: TierName; min: number }[];
  /** skillDepth saturates with item count: 1 - exp(-n / saturateAfter). */
  saturateAfter: number;
}

export const DEFAULT_CONFIG: ScoreConfig = {
  weights: { ...DEFAULT_WEIGHTS },
  evidenceValue: { ...EVIDENCE_VALUE },
  caps: {
    self_reported: 600,
    evidence_checked: null,
    third_party_confirmed: null,
  },
  tiers: [
    { name: "Legend", min: 850 },
    { name: "Elite", min: 750 },
    { name: "Solid", min: 650 },
    { name: "Rising", min: 500 },
    { name: "Starter", min: 300 },
  ],
  saturateAfter: 2.5,
};

/** GritScore Pro is a separate entitlement — never user_subscriptions.planId,
 *  because the platform Pro plan is ₹499/month and ₹99 must not unlock it. */
export const GRITSCORE_PRO = {
  priceInr: 99,
  days: 30,
  scope: "gritscore",
  name: "GritScore Pro",
} as const;

export const LIMITS = {
  resumeBytes: 5 * 1024 * 1024,
  proofBytes: 5 * 1024 * 1024,
  maxItems: 8,
  maxSkillsPerItem: 12,
  /** Free tier: one scorecard in total. */
  freeScans: 1,
  /** Pro: generous but bounded, so abuse stays cheap to stop. */
  proScans: 20,
  /** New scans per hour, before the plan quota is even considered. */
  scansPerHour: 6,
  /** Public reviews per IP per hour. */
  reviewsPerHour: 5,
  /** A single card may invite this many referees before the plan cap applies. */
  maxRefereeInvites: 8,
  /** Lowercase, URL-safe slug base; a random suffix keeps it unique. */
  slugLength: 10,
} as const;

/** Public card designs. The first one is the free default: one polished card
 *  is included on every plan. The rest are Pro-only so the upgrade has a
 *  visible, useful benefit instead of a vague "more features" promise. */
export const CARD_TEMPLATES = [
  { id: "violet", name: "Violet", mood: "Confident and modern", pro: false },
  { id: "ink", name: "Ink", mood: "Editorial black and white", pro: true },
  { id: "paper", name: "Paper", mood: "Warm, calm and understated", pro: true },
  { id: "ocean", name: "Ocean", mood: "Cool blue, product-minded", pro: true },
  { id: "ember", name: "Ember", mood: "Bold, warm and energetic", pro: true },
  { id: "mono", name: "Mono", mood: "Sharp minimal grid", pro: true },
] as const;

export type CardTemplate = (typeof CARD_TEMPLATES)[number]["id"];
export const DEFAULT_CARD_TEMPLATE: CardTemplate = "violet";
export const CARD_TEMPLATE_IDS = CARD_TEMPLATES.map((t) => t.id) as CardTemplate[];

export function isCardTemplate(value: unknown): value is CardTemplate {
  return typeof value === "string" && (CARD_TEMPLATE_IDS as string[]).includes(value);
}

export const PUBLIC_LABELS = {
  scoreName: "Proof Score",
  disclaimer:
    "This is a self-declared Proof Score, not a hiring verdict, background check or credit score. It summarises evidence a person chose to show.",
  watermark: "Grit&Gigs",
} as const;

/** Exact score is shown publicly only once enough items carry checked
 *  evidence; below that the tier is shown so a thin profile cannot present
 *  itself as a precise number. */
export const EXACT_SCORE_MIN_VERIFIED = 3;
