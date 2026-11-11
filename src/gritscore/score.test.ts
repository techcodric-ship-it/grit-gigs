import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, EVIDENCE_VALUE } from "./config";
import {
  buildTips,
  componentBreakdown,
  computeScore,
  dateCoherence,
  scoreTier,
  skillsCoherence,
  toMonthIndex,
  type ScoreItemInput,
} from "./score";

const strong = (over: Partial<ScoreItemInput> = {}): ScoreItemInput => ({
  evidenceType: "liveLink",
  complexity: 5,
  clarity: 5,
  hasQuantifiedImpact: true,
  skills: ["typescript", "react", "postgres"],
  startDate: "2023-01",
  endDate: "2023-12",
  ...over,
});

const weak = (over: Partial<ScoreItemInput> = {}): ScoreItemInput => ({
  evidenceType: "none",
  complexity: 1,
  clarity: 1,
  hasQuantifiedImpact: false,
  skills: [],
  ...over,
});

describe("computeScore", () => {
  it("returns the floor for an empty card, never NaN", () => {
    const r = computeScore({ items: [], verificationTier: "self_reported" });
    expect(r.score).toBe(300);
    expect(r.tier).toBe("Starter");
    expect(r.weightedSum).toBe(0);
    expect(Number.isFinite(r.score)).toBe(true);
  });

  it("no evidence, vague work stays in Starter and is capped", () => {
    const r = computeScore({
      items: [weak(), weak()],
      verificationTier: "self_reported",
    });
    expect(r.components.proof).toBeCloseTo(EVIDENCE_VALUE.none, 5);
    expect(r.components.impact).toBe(0);
    expect(r.score).toBeLessThan(500);
    expect(r.tier).toBe("Starter");
  });

  it("all strong evidence produces an Elite/Legend score", () => {
    const items = [strong(), strong(), strong(), strong()];
    const r = computeScore({ items, verificationTier: "evidence_checked" });
    expect(r.components.proof).toBe(1);
    expect(r.components.impact).toBe(1);
    expect(r.components.clarity).toBe(1);
    expect(r.score).toBeGreaterThanOrEqual(850);
    expect(r.tier).toBe("Legend");
    expect(r.capped).toBe(false);
  });

  it("mixed evidence lands in the middle of the scale", () => {
    const items = [
      strong(),
      strong({ evidenceType: "file", complexity: 3, clarity: 4, hasQuantifiedImpact: false }),
      weak({ evidenceType: "screenshot", complexity: 3, clarity: 4, skills: ["typescript"] }),
    ];
    const r = computeScore({ items, verificationTier: "evidence_checked" });
    expect(r.score).toBeGreaterThanOrEqual(500);
    expect(r.score).toBeLessThan(850);
  });

  it("caps self-reported cards at 600 even when the arithmetic is higher", () => {
    const items = [strong(), strong(), strong(), strong()];
    const r = computeScore({ items, verificationTier: "self_reported" });
    expect(r.rawScore).toBeGreaterThan(600);
    expect(r.score).toBe(600);
    expect(r.capped).toBe(true);
    expect(r.tier).toBe("Rising");
  });

  it("lets a referee lift the cap on the same evidence", () => {
    const items = [strong(), strong(), strong(), strong()];
    const self = computeScore({ items, verificationTier: "self_reported" });
    const confirmed = computeScore({ items, verificationTier: "third_party_confirmed" });
    expect(self.score).toBe(600);
    expect(confirmed.score).toBe(self.rawScore);
    expect(confirmed.score).toBeGreaterThan(600);
  });

  it("skill depth saturates: two strong items beat ten weak ones", () => {
    const deep = computeScore({ items: [strong(), strong()], verificationTier: "evidence_checked" });
    const wide = computeScore({
      items: Array.from({ length: 10 }, () => weak()),
      verificationTier: "evidence_checked",
    });
    expect(deep.components.skillDepth).toBeGreaterThan(wide.components.skillDepth);
  });

  it("clamps out-of-range complexity and clarity instead of producing nonsense", () => {
    const r = computeScore({
      items: [strong({ complexity: 99, clarity: -4 })],
      verificationTier: "evidence_checked",
    });
    expect(r.components.skillDepth).toBeLessThanOrEqual(1);
    expect(r.components.clarity).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(900);
  });

  it("never exceeds the 900 ceiling", () => {
    const items = Array.from({ length: 8 }, () => strong());
    const r = computeScore({ items, verificationTier: "third_party_confirmed" });
    expect(r.score).toBeLessThanOrEqual(900);
  });

  it("respects weight overrides without touching the pure function", () => {
    const items = [strong()];
    const proofHeavy = computeScore(
      { items, verificationTier: "evidence_checked" },
      { ...DEFAULT_CONFIG, weights: { proof: 1, skillDepth: 0, impact: 0, consistency: 0, clarity: 0 } },
    );
    const clarityHeavy = computeScore(
      { items: [weak({ clarity: 5 })], verificationTier: "evidence_checked" },
      { ...DEFAULT_CONFIG, weights: { proof: 0, skillDepth: 0, impact: 0, consistency: 0, clarity: 1 } },
    );
    expect(proofHeavy.score).toBe(900);
    expect(clarityHeavy.score).toBe(900);
  });
});

describe("tier cutoffs", () => {
  it.each([
    [300, "Starter"],
    [499, "Starter"],
    [500, "Rising"],
    [649, "Rising"],
    [650, "Solid"],
    [749, "Solid"],
    [750, "Elite"],
    [849, "Elite"],
    [850, "Legend"],
    [900, "Legend"],
  ] as const)("%i → %s", (score, tier) => {
    expect(scoreTier(score)).toBe(tier);
  });
});

describe("date parsing and coherence", () => {
  it("parses year, year-month and full dates", () => {
    expect(toMonthIndex("2024")).toBe(2024 * 12);
    expect(toMonthIndex("2024-06")).toBe(2024 * 12 + 5);
    expect(toMonthIndex("2024-06-15")).toBe(2024 * 12 + 5);
    expect(toMonthIndex("not a date")).toBeNull();
    expect(toMonthIndex("1800-01")).toBeNull();
    expect(toMonthIndex("2024-13")).toBeNull();
  });

  it("scores a continuous timeline above a gappy one", () => {
    const continuous = dateCoherence([
      { ...weak(), startDate: "2021-01", endDate: "2021-12" },
      { ...weak(), startDate: "2022-01", endDate: "2022-12" },
      { ...weak(), startDate: "2023-01", endDate: "2023-12" },
    ]);
    const gappy = dateCoherence([
      { ...weak(), startDate: "2015-01", endDate: "2015-02" },
      { ...weak(), startDate: "2024-01", endDate: "2024-02" },
    ]);
    expect(continuous).toBeGreaterThan(gappy);
  });

  it("penalises impossible ranges", () => {
    const ok = dateCoherence([{ ...weak(), startDate: "2023-01", endDate: "2023-12" }]);
    const bad = dateCoherence([{ ...weak(), startDate: "2023-12", endDate: "2023-01" }]);
    expect(bad).toBeLessThan(ok);
  });

  it("does not crash on undated items", () => {
    expect(dateCoherence([weak()])).toBe(0.4);
  });
});

describe("skills coherence", () => {
  it("rewards overlapping skills and breadth", () => {
    const coherent = skillsCoherence([
      { ...weak(), skills: ["react", "typescript"] },
      { ...weak(), skills: ["react", "node"] },
    ]);
    const scattered = skillsCoherence([
      { ...weak(), skills: ["react"] },
      { ...weak(), skills: ["welding"] },
    ]);
    expect(coherent).toBeGreaterThan(scattered);
  });

  it("returns a neutral baseline when no skills are listed", () => {
    expect(skillsCoherence([weak()])).toBe(0.4);
  });
});

describe("tips and breakdown", () => {
  it("prioritises missing proof and quantifiable impact", () => {
    const items = [weak(), weak()];
    const r = computeScore({ items, verificationTier: "self_reported" });
    const tips = buildTips(r, items);
    expect(tips.length).toBeGreaterThan(0);
    expect(tips.length).toBeLessThanOrEqual(5);
    expect(tips.join(" ").toLowerCase()).toMatch(/proof|link|quantify|hard part/);
  });

  it("explains the self-reported cap instead of hiding it", () => {
    const items = [strong(), strong(), strong(), strong()];
    const r = computeScore({ items, verificationTier: "self_reported" });
    const tips = buildTips(r, items);
    expect(tips[0]).toMatch(/capped at 600/i);
  });

  it("never exposes a numeric formula in the breakdown", () => {
    const r = computeScore({ items: [strong()], verificationTier: "evidence_checked" });
    const breakdown = componentBreakdown(r);
    expect(breakdown).toHaveLength(5);
    expect(JSON.stringify(breakdown)).not.toMatch(/0\.3|weightedSum|300 \+ 600/);
  });
});
