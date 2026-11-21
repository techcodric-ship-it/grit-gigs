import { describe, expect, it } from "vitest";
import {
  CARD_TEMPLATES,
  CARD_TEMPLATE_IDS,
  DEFAULT_CARD_TEMPLATE,
  DEPTH_CAPS,
  EVIDENCE_VALUE,
  GRITSCORE_PRO,
  SCORE_ENGINE_VERSION,
  depthCapForItemCount,
  isCardTemplate,
  normaliseCardTemplate,
} from "./config";

describe("card templates", () => {
  it("offers exactly one free design and five Pro designs", () => {
    const free = CARD_TEMPLATES.filter((t) => !t.pro);
    expect(free).toHaveLength(1);
    expect(free[0].id).toBe(DEFAULT_CARD_TEMPLATE);
    expect(CARD_TEMPLATES.filter((t) => t.pro)).toHaveLength(5);
    expect(CARD_TEMPLATE_IDS).toEqual(["violet", "gold", "spider", "carbon", "space", "arctic"]);
  });

  it("keeps ids unique and URL-safe", () => {
    expect(new Set(CARD_TEMPLATE_IDS).size).toBe(CARD_TEMPLATE_IDS.length);
    for (const id of CARD_TEMPLATE_IDS) expect(id).toMatch(/^[a-z]+$/);
  });

  it("accepts only known template ids", () => {
    for (const id of CARD_TEMPLATE_IDS) expect(isCardTemplate(id)).toBe(true);
    expect(isCardTemplate("neon")).toBe(false);
    expect(isCardTemplate(null)).toBe(false);
    expect(isCardTemplate(42)).toBe(false);
  });

  it("moves retired designs to the closest live design", () => {
    expect(normaliseCardTemplate("ink")).toBe("gold");
    expect(normaliseCardTemplate("paper")).toBe("arctic");
    expect(normaliseCardTemplate("ocean")).toBe("space");
    expect(normaliseCardTemplate("ember")).toBe("carbon");
    expect(normaliseCardTemplate("mono")).toBe("carbon");
    expect(normaliseCardTemplate("gold")).toBe("gold");
    expect(normaliseCardTemplate("neon")).toBe(DEFAULT_CARD_TEMPLATE);
    expect(normaliseCardTemplate(undefined)).toBe(DEFAULT_CARD_TEMPLATE);
  });

  it("keeps GritScore Pro separate from the platform Pro price", () => {
    expect(GRITSCORE_PRO.priceInr).toBe(99);
    expect(GRITSCORE_PRO.scope).toBe("gritscore");
  });

  it("values platform-recorded barter evidence without changing the score scale", () => {
    expect(EVIDENCE_VALUE.barter_completion).toBe(1.0);
    expect(EVIDENCE_VALUE.barter_review).toBe(0.7);
    // Existing evidence values are untouched.
    expect(EVIDENCE_VALUE.liveLink).toBe(1.0);
    expect(EVIDENCE_VALUE.file).toBe(0.7);
    expect(EVIDENCE_VALUE.screenshot).toBe(0.5);
    expect(EVIDENCE_VALUE.none).toBe(0.1);
  });

  it("strictly ceilings thin cards and unlocks full range at four scored works", () => {
    expect(depthCapForItemCount(0)).toBe(300);
    expect(depthCapForItemCount(1)).toBe(500);
    expect(depthCapForItemCount(2)).toBe(650);
    expect(depthCapForItemCount(3)).toBe(750);
    expect(depthCapForItemCount(4)).toBeNull();
    expect(depthCapForItemCount(8)).toBeNull();
    expect(DEPTH_CAPS[DEPTH_CAPS.length - 1]).toBe(750);
  });

  it("has a version stamp so rule changes refresh stored cards automatically", () => {
    expect(SCORE_ENGINE_VERSION).toBeGreaterThanOrEqual(2);
  });
});
