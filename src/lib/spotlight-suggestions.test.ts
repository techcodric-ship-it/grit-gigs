import { describe, it, expect } from "vitest";
import { spotSuggestions } from "./spotlight";

// These are the exact raw search-log rows that used to render inside the boost
// payment dialog. They came straight from production and are the reason the
// keyword chips looked careless: typos, a comma-splat phrase, and a duplicate.
const PROD_ROWS = [
  { term: "data", n: 3 },
  { term: "hr", n: 2 },
  { term: "operation", n: 2 },
  { term: "proofreading", n: 2 },
  { term: "profreading", n: 1 },
  { term: "ai", n: 2 },
  { term: "communication", n: 2 },
  { term: "prompt", n: 1 },
  { term: "operation, communication, strategy", n: 1 },
  { term: "website", n: 1 },
];

describe("spotSuggestions", () => {
  it("never shows a multi-intent phrase as one keyword", () => {
    const out = spotSuggestions(PROD_ROWS);
    expect(out.some((t) => t.includes(","))).toBe(false);
    // The splat query contributed its individual intents instead.
    expect(out).toContain("strategy");
  });

  it("drops a single-keystroke typo when the correct spelling is offered", () => {
    const out = spotSuggestions(PROD_ROWS);
    expect(out).toContain("proofreading");
    expect(out).not.toContain("profreading");
  });

  it("does not repeat a term that already appears on its own", () => {
    const out = spotSuggestions(PROD_ROWS);
    expect(out.filter((t) => t === "operation").length).toBe(1);
    expect(out.filter((t) => t === "communication").length).toBe(1);
  });

  it("keeps short real skill acronyms a naive length filter would drop", () => {
    const out = spotSuggestions(PROD_ROWS);
    expect(out).toContain("ai");
    expect(out).toContain("hr");
  });

  it("produces no duplicates at all for real production input", () => {
    const out = spotSuggestions(PROD_ROWS);
    expect(new Set(out).size).toBe(out.length);
  });

  it("lowercases, strips hashes and trims whitespace", () => {
    expect(spotSuggestions([{ term: "  #Logo Design ", n: 1 }])).toEqual(["logo design"]);
  });

  it("rejects a run-on phrase that is not a single skill", () => {
    expect(spotSuggestions([{ term: "we need a designer for our new brand identity work", n: 1 }])).toEqual([]);
  });

  it("allows a two-word skill but not three", () => {
    expect(spotSuggestions([{ term: "logo design", n: 1 }])).toEqual(["logo design"]);
    expect(spotSuggestions([{ term: "logo design vector", n: 1 }])).toEqual([]);
  });

  it("drops terms too short to be meaningful and too long to be a tag", () => {
    expect(spotSuggestions([{ term: "go", n: 5 }])).toEqual([]);
    expect(spotSuggestions([{ term: "a".repeat(40), n: 5 }])).toEqual([]);
  });

  it("caps the list so the dialog never overflows", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ term: `skill${i} alpha`, n: 60 - i }));
    expect(spotSuggestions(many).length).toBeLessThanOrEqual(12);
  });

  it("survives an empty log without throwing", () => {
    expect(spotSuggestions([])).toEqual([]);
  });

  it("keeps only one spelling when a typo and its correction both rank", () => {
    const out = spotSuggestions([
      { term: "proofreadng", n: 9 },
      { term: "proofreading", n: 1 },
    ]);
    expect(out.length).toBe(1);
  });
});
