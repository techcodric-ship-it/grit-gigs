// Resume vs target role gap check: parsing contract + honesty rules in the
// prompt. Source-level (no DB, no network) — the router owns persistence.

import { describe, it, expect } from "vitest";
import { RESUME_SYSTEM_PROMPT, parseResumeCheckResponse } from "./ai";

describe("resume check parsing", () => {
  const full = JSON.stringify({
    readiness: "Needs work",
    overview: "Solid base but the target-role skills are mostly implied, not evidenced.",
    strengths: ["Shipped a capstone project", "Clear education section"],
    gaps: [
      { skill: "SQL", why: "No query work listed", fix: "Add one bullet with the DB you used and the result" },
    ],
    rewrites: [{ before: "Worked on a website", after: "Built a 5-page catalogue site; cut page load from 4s to 1.2s" }],
    nextSteps: ["Add a skills line", "Quantify the project bullet"],
  });

  it("accepts a full result and clamps lengths", () => {
    const parsed = parseResumeCheckResponse(full);
    expect(parsed).not.toBeNull();
    expect(parsed!.readiness).toBe("Needs work");
    expect(parsed!.gaps[0]!.skill).toBe("SQL");
    expect(parsed!.rewrites[0]!.after).toContain("1.2s");
    expect(parsed!.nextSteps.length).toBe(2);
  });

  it("defaults an omitted/unknown band to the honest middle", () => {
    const parsed = parseResumeCheckResponse(
      JSON.stringify({ overview: "Thin.", strengths: ["one"], gaps: [{ skill: "x", why: "y", fix: "z" }] }),
    );
    expect(parsed!.readiness).toBe("Needs work");
  });

  it("tolerates fenced JSON and rejects garbage or empty results", () => {
    expect(parseResumeCheckResponse("```json\n" + full + "\n```")).not.toBeNull();
    expect(parseResumeCheckResponse("not json")).toBeNull();
    expect(parseResumeCheckResponse("{}")).toBeNull();
    expect(parseResumeCheckResponse(JSON.stringify({ overview: "x" }))).toBeNull(); // no strengths/gaps
  });
});

describe("resume prompt: coaching, not guarantees", () => {
  it("demands STRICT JSON and untrusted-data handling", () => {
    expect(RESUME_SYSTEM_PROMPT).toContain("STRICT JSON only");
    expect(RESUME_SYSTEM_PROMPT).toContain("untrusted data");
  });
  it("forbids invented facts/numbers, outcome promises and fraud talk", () => {
    expect(RESUME_SYSTEM_PROMPT).toContain("Never invent skills");
    expect(RESUME_SYSTEM_PROMPT).toContain("never add facts or numbers");
    expect(RESUME_SYSTEM_PROMPT).toContain("never promise interviews");
    expect(RESUME_SYSTEM_PROMPT).toContain("fraud, scams, or legality");
  });
  it("keeps readiness honest when the resume is thin", () => {
    expect(RESUME_SYSTEM_PROMPT).toContain("too thin to assess");
    expect(RESUME_SYSTEM_PROMPT).toContain('"readiness": "Strong" | "Needs work" | "Thin"');
  });
});
