import { describe, expect, it } from "vitest";
import { canShowExactScore } from "./verify";

describe("canShowExactScore", () => {
  it("shows the number when the owner allows it, even with thin proof", () => {
    expect(canShowExactScore({ showExactScore: true, score: 300 })).toBe(true);
  });

  it("never overrides the owner turning the number off", () => {
    expect(canShowExactScore({ showExactScore: false, score: 742 })).toBe(false);
  });

  it("falls back to the tier when no score has been computed yet", () => {
    expect(canShowExactScore({ showExactScore: true, score: null })).toBe(false);
  });
});
