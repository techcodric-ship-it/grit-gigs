import { describe, expect, it } from "vitest";
import {
  alignExtraction,
  deterministicExtraction,
  extractProfile,
  harvestSkillsFromResume,
  parseExtraction,
  type ExtractionInput,
} from "./ai";

const input: ExtractionInput = {
  resumeText: "Senior React developer. Built TypeScript services with Node.js and PostgreSQL. Led a team of 6.",
  displayName: "Asha Menon",
  items: [
    {
      title: "Billing rewrite",
      description: "Rebuilt the billing pipeline in TypeScript and PostgreSQL, cutting invoice errors by 38% for 12000 users.",
      role: "Senior Engineer",
      evidenceType: "github",
      proofUrl: "https://github.com/asha/billing",
      userSkills: ["TypeScript", "PostgreSQL"],
    },
    {
      title: "Design system",
      description: "Built a shared design system.",
      role: "Designer",
      evidenceType: "none",
      userSkills: [],
    },
  ],
};

const validJson = JSON.stringify({
  skills: ["typescript", "postgresql", "react"],
  roles: ["Senior Engineer"],
  items: [
    {
      title: "Billing rewrite",
      skills: ["typescript", "postgresql"],
      evidenceType: "github",
      hasQuantifiedImpact: true,
      impactNotes: "cutting invoice errors by 38%",
      complexity: 4.4,
      clarity: 5,
    },
    {
      title: "Design system",
      skills: ["design systems"],
      evidenceType: "none",
      hasQuantifiedImpact: false,
      impactNotes: "",
      complexity: 2,
      clarity: 2,
    },
  ],
  summary: "A senior engineer with billing and design-system work.",
});

describe("parseExtraction", () => {
  it("accepts strict JSON and rounds scores", () => {
    const parsed = parseExtraction(validJson, 2);
    expect(parsed).not.toBeNull();
    expect(parsed!.items[0].complexity).toBe(4);
    expect(parsed!.items[0].clarity).toBe(5);
    expect(parsed!.skills).toContain("typescript");
  });

  it("tolerates code fences and surrounding prose", () => {
    const wrapped = `Here is the JSON:\n\`\`\`json\n${validJson}\n\`\`\`\nDone.`;
    expect(parseExtraction(wrapped, 2)).not.toBeNull();
  });

  it("rejects a wrong item count", () => {
    expect(parseExtraction(validJson, 3)).toBeNull();
  });

  it("rejects missing required fields", () => {
    const broken = JSON.stringify({ skills: [], roles: [], items: [{ title: "x" }], summary: "" });
    expect(parseExtraction(broken, 1)).toBeNull();
  });

  it("rejects non-JSON", () => {
    expect(parseExtraction("I think this person is great.", 2)).toBeNull();
  });
});

describe("deterministic extraction", () => {
  it("infers quantified impact and skills without AI", () => {
    const out = deterministicExtraction(input);
    expect(out.items).toHaveLength(2);
    expect(out.items[0].hasQuantifiedImpact).toBe(true);
    expect(out.items[0].skills).toContain("TypeScript");
    expect(out.items[1].hasQuantifiedImpact).toBe(false);
    expect(out.items[0].complexity).toBeGreaterThan(out.items[1].complexity);
  });

  it("harvests known skills from resume text", () => {
    const skills = harvestSkillsFromResume("React, TypeScript, Node.js, PostgreSQL");
    expect(skills).toContain("react");
    expect(skills).toContain("typescript");
    expect(skills).toContain("postgresql");
  });

  it("produces a summary without inventing an employer", () => {
    const out = deterministicExtraction(input);
    expect(out.summary).toContain("2 documented work items");
    expect(out.summary.toLowerCase()).not.toContain("google");
  });
});

describe("extractProfile", () => {
  it("uses the AI result when validation passes", async () => {
    const result = await extractProfile(input, async () => validJson);
    expect(result.usedAi).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.extraction.items[0].impactNotes).toContain("38%");
  });

  it("retries exactly once and succeeds on the second attempt", async () => {
    let calls = 0;
    const result = await extractProfile(input, async () => {
      calls++;
      return calls === 1 ? "not json" : validJson;
    });
    expect(calls).toBe(2);
    expect(result.usedAi).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("falls back to heuristics after two failures instead of throwing", async () => {
    const result = await extractProfile(input, async () => {
      throw new Error("Gemini error 429");
    });
    expect(result.usedAi).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.error).toContain("429");
    expect(result.extraction.items).toHaveLength(2);
  });

  it("does not accept a model that invents extra items", async () => {
    const threeItems = JSON.parse(validJson);
    threeItems.items.push(threeItems.items[1]);
    const result = await extractProfile(input, async () => JSON.stringify(threeItems));
    expect(result.usedAi).toBe(false);
    expect(result.extraction.items).toHaveLength(2);
  });
});

describe("alignExtraction", () => {
  it("pads missing items from the deterministic pass", () => {
    const partial = deterministicExtraction(input);
    const aligned = alignExtraction(input, { ...partial, items: [partial.items[0]] });
    expect(aligned.items).toHaveLength(2);
    expect(aligned.items[1].title).toBe("Design system");
  });
});
