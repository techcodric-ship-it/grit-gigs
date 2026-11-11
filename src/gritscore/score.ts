// Pure GritScore arithmetic. No DB, no network, no AI — so the tests and the
// production path compute exactly the same number from the same inputs.
//
// score = 300 + 600 * Σ(weight_i * component_i)
//
// Components are normalised to 0..1:
//   proof       mean evidence strength
//   skillDepth  mean complexity (1..5 → 0..1) × item-count saturation
//   impact      share of items with a quantified result
//   consistency 50% date coherence + 50% skills coherence
//   clarity     mean clarity (1..5 → 0..1)
//
// Only the self-reported tier is capped (600). Evidence-checked and
// third-party-confirmed cards are uncapped because the evidence behind them
// has been independently verified.

import {
  DEFAULT_CONFIG,
  SCORE_MAX,
  SCORE_MIN,
  SCORE_RANGE,
  type EvidenceType,
  type ScoreConfig,
  type TierName,
  type VerificationTier,
} from "./config";

export interface ScoreItemInput {
  evidenceType: EvidenceType;
  /** 1..5; values outside are clamped. */
  complexity: number;
  /** 1..5; values outside are clamped. */
  clarity: number;
  hasQuantifiedImpact: boolean;
  skills?: string[];
  /** YYYY, YYYY-MM or YYYY-MM-DD. */
  startDate?: string | null;
  endDate?: string | null;
}

export interface ScoreInput {
  items: ScoreItemInput[];
  verificationTier: VerificationTier;
}

export interface ScoreComponents {
  proof: number;
  skillDepth: number;
  impact: number;
  consistency: number;
  clarity: number;
}

export interface ScoreResult {
  /** After the verification cap. This is the number shown to humans. */
  score: number;
  /** Before the cap, kept for admin and recompute audits. */
  rawScore: number;
  capped: boolean;
  tier: TierName;
  weightedSum: number;
  components: ScoreComponents;
  verificationTier: VerificationTier;
  cap: number | null;
  /** Number of items that actually contributed. */
  itemCount: number;
}

const clamp = (n: number, lo: number, hi: number): number =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;

const clamp01 = (n: number): number => clamp(n, 0, 1);

export function evidenceStrength(type: EvidenceType, config: ScoreConfig = DEFAULT_CONFIG): number {
  return clamp01(config.evidenceValue[type] ?? config.evidenceValue.none ?? 0.1);
}

/** YYYY / YYYY-MM / YYYY-MM-DD → month index since year 0, or null. */
export function toMonthIndex(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : 1;
  if (!Number.isFinite(year) || year < 1950 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  return year * 12 + (month - 1);
}

function mergeCoverage(intervals: [number, number][]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curEnd + 1) {
      curEnd = Math.max(curEnd, e);
    } else {
      total += curEnd - curStart + 1;
      curStart = s;
      curEnd = e;
    }
  }
  return total + (curEnd - curStart + 1);
}

/** Date coherence: a continuous, plausible timeline scores high; undated work
 *  is not punished into the floor (0.4) because many real portfolios omit
 *  exact months. */
export function dateCoherence(items: ScoreItemInput[]): number {
  const parsed = items.map((item) => {
    const start = toMonthIndex(item.startDate);
    const end = toMonthIndex(item.endDate);
    return { start, end, impossible: start !== null && end !== null && end < start };
  });
  const dated = parsed.filter((p) => p.start !== null || p.end !== null);
  const impossible = parsed.some((p) => p.impossible);
  if (dated.length === 0) return 0.4;
  if (dated.length === 1) return impossible ? 0.25 : 0.6;

  const starts = dated.map((p) => p.start ?? p.end!).filter((n): n is number => n !== null);
  const ends = dated.map((p) => p.end ?? p.start!).filter((n): n is number => n !== null);
  if (starts.length === 0 || ends.length === 0) return 0.4;
  const minStart = Math.min(...starts);
  const maxEnd = Math.max(...ends);
  const span = Math.max(1, maxEnd - minStart + 1);
  const intervals: [number, number][] = dated
    .map((p): [number, number] => {
      const s = p.start ?? p.end!;
      const e = p.end ?? p.start!;
      return [Math.max(minStart, Math.min(s, e)), Math.min(maxEnd, Math.max(s, e))];
    })
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e));
  const coverage = clamp01(mergeCoverage(intervals) / span);
  return clamp01(0.55 + 0.45 * coverage - (impossible ? 0.3 : 0));
}

/** Skills coherence: items that share at least one skill tell a story; wholly
 *  unrelated skill lists read as a scattergun. Breadth still earns credit, so
 *  a genuinely diverse portfolio is not punished. */
export function skillsCoherence(items: ScoreItemInput[]): number {
  const lists = items
    .map((item) => (item.skills ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))
    .filter((list) => list.length > 0);
  if (lists.length === 0) return 0.4;
  const freq = new Map<string, number>();
  for (const list of lists) {
    for (const skill of new Set(list)) freq.set(skill, (freq.get(skill) ?? 0) + 1);
  }
  const overlappingItems = lists.filter((list) => list.some((s) => (freq.get(s) ?? 0) > 1)).length;
  const overlapRatio = overlappingItems / lists.length;
  const breadth = clamp01(freq.size / 8);
  return clamp01(0.4 + 0.4 * overlapRatio + 0.2 * breadth);
}

export function scoreTier(score: number, config: ScoreConfig = DEFAULT_CONFIG): TierName {
  for (const tier of config.tiers) {
    if (score >= tier.min) return tier.name;
  }
  return "Starter";
}

export function computeScore(input: ScoreInput, config: ScoreConfig = DEFAULT_CONFIG): ScoreResult {
  const items = Array.isArray(input.items) ? input.items : [];
  const n = items.length;

  const proof = n === 0 ? 0 : items.reduce((sum, i) => sum + evidenceStrength(i.evidenceType, config), 0) / n;
  const meanComplexity =
    n === 0 ? 0 : items.reduce((sum, i) => sum + clamp(Number(i.complexity), 1, 5), 0) / n / 5;
  // Diminishing returns: the first items matter most, but adding evidence
  // keeps helping without letting a long list dominate the score.
  const saturation = n === 0 ? 0 : 1 - Math.exp(-n / Math.max(0.1, config.saturateAfter));
  const skillDepth = clamp01(meanComplexity * saturation);
  const impact = n === 0 ? 0 : items.filter((i) => i.hasQuantifiedImpact === true).length / n;
  const consistency = n === 0 ? 0 : clamp01(0.5 * dateCoherence(items) + 0.5 * skillsCoherence(items));
  const clarity = n === 0 ? 0 : items.reduce((sum, i) => sum + clamp(Number(i.clarity), 1, 5), 0) / n / 5;

  const components: ScoreComponents = {
    proof: clamp01(proof),
    skillDepth,
    impact: clamp01(impact),
    consistency,
    clarity,
  };

  const weights = config.weights;
  const weightedSum = clamp01(
    weights.proof * components.proof +
      weights.skillDepth * components.skillDepth +
      weights.impact * components.impact +
      weights.consistency * components.consistency +
      weights.clarity * components.clarity,
  );

  const rawScore = Math.round(SCORE_MIN + SCORE_RANGE * weightedSum);
  const cap = config.caps[input.verificationTier] ?? null;
  const score = cap === null ? rawScore : Math.min(rawScore, cap);
  // A card with no items is a 300 Starter card, never a NaN.
  const safeScore = clamp(score, SCORE_MIN, SCORE_MAX);

  return {
    score: safeScore,
    rawScore: clamp(rawScore, SCORE_MIN, SCORE_MAX),
    capped: cap !== null && rawScore > cap,
    tier: scoreTier(safeScore, config),
    weightedSum,
    components,
    verificationTier: input.verificationTier,
    cap,
    itemCount: n,
  };
}

const pct = (n: number): number => Math.round(n * 100);

/** Deterministic, specific improvement advice for paid cards. Ordered by the
 *  smallest component first, because that is where a point is cheapest. */
export function buildTips(
  result: ScoreResult,
  items: ScoreItemInput[],
): string[] {
  const tips: string[] = [];
  const c = result.components;
  const ranked = (Object.keys(c) as (keyof ScoreComponents)[]).sort((a, b) => c[a] - c[b]);

  const noEvidence = items.filter((i) => i.evidenceType === "none").length;
  const weakEvidence = items.filter((i) => i.evidenceType === "screenshot").length;
  const unquantified = items.filter((i) => !i.hasQuantifiedImpact).length;
  const lowComplexity = items.filter((i) => clamp(i.complexity, 1, 5) <= 2).length;
  const lowClarity = items.filter((i) => clamp(i.clarity, 1, 5) <= 2).length;
  const duplicateSkills = (() => {
    const seen = new Set<string>();
    let dupes = 0;
    for (const item of items) {
      for (const skill of new Set((item.skills ?? []).map((s) => s.toLowerCase()))) {
        if (seen.has(skill)) dupes++;
        seen.add(skill);
      }
    }
    return dupes;
  })();

  for (const key of ranked) {
    if (tips.length >= 4) break;
    if (key === "proof") {
      if (noEvidence > 0)
        tips.push(`Add a working link, repo or file to ${noEvidence} item${noEvidence > 1 ? "s" : ""} with no proof. Proof is 30% of the score.`);
      else if (weakEvidence > 0)
        tips.push(`Replace ${weakEvidence} screenshot${weakEvidence > 1 ? "s" : ""} with an openable link — screenshots are worth half as much.`);
    } else if (key === "skillDepth") {
      if (lowComplexity > 0)
        tips.push(`Describe the hard part of ${lowComplexity} item${lowComplexity > 1 ? "s" : ""}: the constraint you solved, the scale you handled, the trade-off you chose.`);
      else tips.push("Add one more substantial work item — depth rises with the number of real projects, not with adjectives.");
    } else if (key === "impact") {
      if (unquantified > 0)
        tips.push(`Quantify ${unquantified} item${unquantified > 1 ? "s" : ""}: a number, a percentage, a duration, or a count of people served.`);
    } else if (key === "consistency") {
      if (duplicateSkills > 0)
        tips.push("Tighten the skills list — repeating the same skill across items adds no depth and dilutes the story.");
      else tips.push("Add start and end dates to every item so the timeline reads as continuous.");
    } else if (key === "clarity") {
      if (lowClarity > 0)
        tips.push(`Rewrite ${lowClarity} item${lowClarity > 1 ? "s" : ""} in one plain sentence: what you built, for whom, and what changed.`);
    }
  }

  if (result.capped && result.cap !== null) {
    tips.unshift(`Your evidence supports a ${result.rawScore}, but self-reported work is capped at ${result.cap}. Get a referee to confirm and the cap lifts.`);
  }
  if (tips.length === 0) {
    tips.push("This card is strong. Ask a referee to confirm an item to reach third-party confirmed status.");
  }
  return tips.slice(0, 5);
}

/** Human-readable component labels; never expose the numeric formula. */
export const COMPONENT_LABELS: Record<keyof ScoreComponents, string> = {
  proof: "Proof strength",
  skillDepth: "Skill depth",
  impact: "Quantified impact",
  consistency: "Consistency",
  clarity: "Clarity",
};

export function componentBreakdown(result: ScoreResult): { key: keyof ScoreComponents; label: string; percent: number }[] {
  return (Object.keys(COMPONENT_LABELS) as (keyof ScoreComponents)[]).map((key) => ({
    key,
    label: COMPONENT_LABELS[key],
    percent: pct(result.components[key]),
  }));
}
