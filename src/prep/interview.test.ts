// Interview prep: bank integrity, mock core, feedback aggregation, wiring.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { INTERVIEW_BANK } from "./interview-bank";
import {
  INTERVIEW_TRACKS,
  INTERVIEW_CATEGORIES,
  MOCK_DEFAULT_COUNT,
  SAMPLE_QUESTION_CODES,
  filterInterviewBank,
  pickMock,
  sampleInterviewQuestions,
  signInterviewMock,
  verifyInterviewMock,
  aggregateFeedback,
  toPublicInterviewQuestion,
  isValidTrack,
  isValidCategory,
} from "./interview";

const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const SECRET = "test-iv-secret";

describe("interview bank integrity", () => {
  it("has unique stable codes", () => {
    const codes = INTERVIEW_BANK.map((q) => q.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
  it("every question is well-formed", () => {
    for (const q of INTERVIEW_BANK) {
      expect(q.question.length).toBeGreaterThan(10);
      expect(q.guidance.length).toBeGreaterThan(30); // real guidance, not a stub
      expect(INTERVIEW_TRACKS).toContain(q.track);
      expect(INTERVIEW_CATEGORIES).toContain(q.category);
      expect(["easy", "medium", "hard"]).toContain(q.difficulty);
    }
  });
  it("covers every track and category", () => {
    for (const t of INTERVIEW_TRACKS) {
      expect(INTERVIEW_BANK.filter((q) => q.track === t).length).toBeGreaterThanOrEqual(5);
    }
    for (const c of INTERVIEW_CATEGORIES) {
      expect(INTERVIEW_BANK.filter((q) => q.category === c).length).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("filters and selection", () => {
  it("filters by track and category", () => {
    expect(filterInterviewBank(INTERVIEW_BANK, "engineering", "technical").every((q) => q.track === "engineering" && q.category === "technical")).toBe(true);
    expect(filterInterviewBank(INTERVIEW_BANK, null, "hr")).toHaveLength(INTERVIEW_BANK.filter((q) => q.category === "hr").length);
    expect(filterInterviewBank(INTERVIEW_BANK, null, null)).toEqual(INTERVIEW_BANK);
  });
  it("validates track/category inputs", () => {
    expect(isValidTrack("engineering")).toBe(true);
    expect(isValidTrack("hacker")).toBe(false);
    expect(isValidCategory("hr")).toBe(true);
    expect(isValidCategory("")).toBe(false);
  });
  it("pickMock defaults to 5 and respects bounds", () => {
    expect(MOCK_DEFAULT_COUNT).toBe(5);
    const rows = INTERVIEW_BANK.filter((q) => q.track === "data");
    expect(pickMock(rows, undefined)).toHaveLength(5);
    expect(pickMock(rows, 99)).toHaveLength(rows.length);
    expect(pickMock(rows, 3)).toHaveLength(3);
  });
});

describe("mock session token", () => {
  it("round-trips ids and track", () => {
    const token = signInterviewMock(["q1", "q2"], "data", SECRET);
    expect(verifyInterviewMock(token, SECRET)).toEqual({ ids: ["q1", "q2"], track: "data" });
  });
  it("rejects tampered and foreign tokens", () => {
    const token = signInterviewMock(["q1"], null, SECRET);
    expect(verifyInterviewMock(token + "z", SECRET)).toBeNull();
    expect(verifyInterviewMock(token, "other")).toBeNull();
    expect(verifyInterviewMock("garbage", SECRET)).toBeNull();
  });
});

describe("aggregateFeedback", () => {
  const row = (id: string, category: string) => ({
    ...toPublicInterviewQuestion({ id, code: id, track: "general", category, difficulty: "easy", question: `Q ${id}` }),
    guidance: `guide ${id}`,
  });
  const rows = [row("a", "technical"), row("b", "technical"), row("c", "behavioral")];
  it("computes average confidence and attaches guidance", () => {
    const fb = aggregateFeedback(rows, { a: 4, b: 2, c: 3 }, ["a", "b", "c"]);
    expect(fb.avgConfidence).toBe(3);
    expect(fb.answered).toBe(3);
    expect(fb.total).toBe(3);
    expect(fb.items[0]!.guidance).toBe("guide a");
    expect(fb.weakestCategory).toBe("behavioral"); // tie 3 vs 3 -> alphabetically first
  });
  it("ignores out-of-range and missing ratings", () => {
    const fb = aggregateFeedback(rows, { a: 9, b: 0, c: 2.5 as unknown as number }, ["a", "b", "c"]);
    expect(fb.avgConfidence).toBeNull();
    expect(fb.answered).toBe(0);
    expect(fb.weakestCategory).toBeNull();
    expect(fb.items.every((i) => i.rating === null)).toBe(true);
  });
  it("finds the genuinely weakest category", () => {
    const fb = aggregateFeedback(rows, { a: 1, b: 1, c: 5 }, ["a", "b", "c"]);
    expect(fb.weakestCategory).toBe("technical");
    expect(fb.avgConfidence).toBe(2.3);
  });
  it("skips ids missing from the bank but keeps order of known ids", () => {
    const fb = aggregateFeedback(rows, { a: 5, ghost: 1 }, ["ghost", "c", "a"]);
    expect(fb.total).toBe(2);
    expect(fb.items.map((i) => i.id)).toEqual(["c", "a"]);
  });
  it("public shape never leaks guidance before feedback", () => {
    const pub = toPublicInterviewQuestion({
      id: "x", code: "x", track: "general", category: "hr", difficulty: "easy", question: "Q?",
    });
    expect(pub).not.toHaveProperty("guidance");
  });
});

describe("interview wiring (source-level)", () => {
  const router = read("src/prep/router.ts");
  it("exposes questions, mock and feedback endpoints after the flag gate", () => {
    const gateIdx = router.indexOf("prepRouter.use(");
    for (const route of ["/interview/questions", "/interview/mock", "/interview/mock/submit"]) {
      const idx = router.indexOf(`prepRouter.` + (route.endsWith("submit") ? "post" : "get") + `("${route}"`);
      expect(idx).toBeGreaterThan(gateIdx);
    }
  });
  it("rate-limits interview routes and verifies mock tokens", () => {
    expect(router).toMatch(/interviewLimiter/);
    expect(router).toMatch(/verifyInterviewMock\(parsed\.data\.token/);
  });
  const page = read("public/prep/interview.html");
  it("page is noindex, escaped, and wired to all three endpoints", () => {
    expect(page).toContain('<meta name="robots" content="noindex"/>');
    expect(page).toContain("function esc(s)");
    expect(page).toContain("/api/prep/interview/questions");
    expect(page).toContain("/api/prep/interview/mock");
    expect(page).toContain("/api/prep/interview/mock/submit");
    expect(page).toContain("esc(it.guidance)");
  });
});

describe("free sample (the quality proof that sells Pro)", () => {
  it("picks one question per category, all with guidance", () => {
    const sample = sampleInterviewQuestions();
    expect(sample.length).toBe(3);
    expect(sample.map((q) => q.category).sort()).toEqual(["behavioral", "hr", "technical"]);
    for (const q of sample) {
      expect(q.guidance.length).toBeGreaterThan(40);
      expect(q.question.length).toBeGreaterThan(5);
    }
  });
  it("codes are stable and resolve against the real bank", () => {
    expect([...SAMPLE_QUESTION_CODES]).toEqual(["iv-gen-b1", "iv-gen-t1", "iv-gen-h1"]);
    const codes = new Set(INTERVIEW_BANK.map((q) => q.code));
    for (const c of SAMPLE_QUESTION_CODES) expect(codes.has(c)).toBe(true);
  });
});
