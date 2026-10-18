// Aptitude: bank integrity, quiz core (selection/tokens/scoring), and
// source-level wiring checks for the API + page.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { APTITUDE_BANK } from "./aptitude-bank";
import {
  shuffle,
  pickQuiz,
  clampCount,
  signQuizToken,
  verifyQuizToken,
  scoreQuiz,
  toPublicQuestion,
  QUIZ_TOKEN_TTL_SEC,
} from "./aptitude";
import { APTITUDE_TOPICS } from "./schema";

const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const SECRET = "test-quiz-secret";

describe("question bank integrity", () => {
  it("has unique stable codes", () => {
    const codes = APTITUDE_BANK.map((q) => q.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
  it("every question is well-formed", () => {
    for (const q of APTITUDE_BANK) {
      expect(q.question.length).toBeGreaterThan(10);
      expect(q.options).toHaveLength(4);
      expect(new Set(q.options).size).toBe(4); // no duplicate options
      expect(q.correctIdx).toBeGreaterThanOrEqual(0);
      expect(q.correctIdx).toBeLessThan(4);
      expect(q.explanation.length).toBeGreaterThan(10);
      expect(APTITUDE_TOPICS as readonly string[]).toContain(q.topic);
      expect(["easy", "medium", "hard"]).toContain(q.difficulty);
    }
  });
  it("covers every topic with at least 10 questions", () => {
    for (const t of APTITUDE_TOPICS) {
      expect(APTITUDE_BANK.filter((q) => q.topic === t).length).toBeGreaterThanOrEqual(10);
    }
  });
});

describe("selection", () => {
  it("shuffle is deterministic with a seeded rng and keeps all items", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    let s = 42;
    const rng = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const a = shuffle(items, rng);
    s = 42;
    const b = shuffle(items, rng);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(items);
  });
  it("pickQuiz bounds by count and by available rows", () => {
    const rows = APTITUDE_BANK.filter((q) => q.topic === "quant");
    expect(pickQuiz(rows, 10)).toHaveLength(10);
    expect(pickQuiz(rows, 999)).toHaveLength(rows.length);
    expect(pickQuiz(rows, 3)).toHaveLength(3);
  });
  it("clampCount sanitizes input", () => {
    expect(clampCount("10", 20)).toBe(10);
    expect(clampCount("999", 20)).toBe(20);
    expect(clampCount("abc", 20)).toBe(10);
    expect(clampCount(0, 20)).toBe(10);
    expect(clampCount(-5, 20)).toBe(10);
  });
});

describe("quiz token", () => {
  const payload = { ids: ["a", "b", "c"], topic: "quant" };
  it("round-trips", () => {
    const token = signQuizToken(payload, SECRET);
    expect(verifyQuizToken(token, SECRET)).toEqual(payload);
  });
  it("rejects tampering, wrong secret and garbage", () => {
    const token = signQuizToken(payload, SECRET);
    expect(verifyQuizToken(token + "x", SECRET)).toBeNull();
    expect(verifyQuizToken(token, "other-secret")).toBeNull();
    expect(verifyQuizToken("not-a-token", SECRET)).toBeNull();
    expect(verifyQuizToken("", SECRET)).toBeNull();
  });
  it("rejects oversized id lists", () => {
    const big = { ids: Array.from({ length: 51 }, (_, i) => `q${i}`), topic: null };
    const token = signQuizToken(big, SECRET);
    expect(verifyQuizToken(token, SECRET)).toBeNull();
  });
  it("uses a 10-minute expiry", () => {
    expect(QUIZ_TOKEN_TTL_SEC).toBe(600);
  });
});

describe("scoreQuiz", () => {
  const row = (id: string, correctIdx: number) => ({
    ...toPublicQuestion({ id, code: id, topic: "quant", difficulty: "easy", question: `Q ${id}?`, options: ["a", "b", "c", "d"] }),
    correctIdx,
    explanation: "because",
  });
  const rows = [row("r1", 1), row("r2", 3), row("r3", 0)];
  it("scores against server-side correct answers", () => {
    const s = scoreQuiz(rows, { r1: 1, r2: 0, r3: 0 }, ["r1", "r2", "r3"]);
    expect(s.score).toBe(2);
    expect(s.total).toBe(3);
    expect(s.results.map((r) => r.correct)).toEqual([true, false, true]);
    expect(s.results[1]!.correctIdx).toBe(3); // correct answer revealed only post-submit
  });
  it("treats missing and out-of-range answers as wrong, never crashes", () => {
    const s = scoreQuiz(rows, { r1: 99, r2: -1, r3: 1.5 as unknown as number }, ["r1", "r2", "r3"]);
    expect(s.score).toBe(0);
    expect(s.results.every((r) => r.yourAnswer === null)).toBe(true);
  });
  it("skips ids that no longer exist in the bank", () => {
    const s = scoreQuiz(rows, { r1: 1, ghost: 0 }, ["r1", "ghost"]);
    expect(s.total).toBe(1);
    expect(s.score).toBe(1);
  });
  it("preserves token display order", () => {
    const s = scoreQuiz(rows, {}, ["r3", "r1", "r2"]);
    expect(s.results.map((r) => r.id)).toEqual(["r3", "r1", "r2"]);
  });
  it("never exposes correctIdx to the public question shape", () => {
    const pub = toPublicQuestion({
      id: "x", code: "x", topic: "quant", difficulty: "easy", question: "Q?", options: ["a", "b", "c", "d"],
    });
    expect(pub).not.toHaveProperty("correctIdx");
    expect(pub).not.toHaveProperty("explanation");
  });
});

describe("aptitude wiring (source-level)", () => {
  const router = read("src/prep/router.ts");
  it("exposes topics, quiz and submit endpoints behind the flag gate", () => {
    expect(router).toContain('prepRouter.get("/aptitude/topics"');
    expect(router).toContain('prepRouter.get("/aptitude/quiz"');
    expect(router).toContain('prepRouter.post("/aptitude/submit"');
    const gateIdx = router.indexOf("prepRouter.use(");
    const topicsIdx = router.indexOf('prepRouter.get("/aptitude/topics"');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(topicsIdx).toBeGreaterThan(gateIdx); // gate registered first
  });
  it("rate-limits the quiz endpoints and verifies the token before scoring", () => {
    expect(router).toMatch(/aptitudeLimiter/);
    expect(router).toMatch(/verifyQuizToken\(parsed\.data\.token/);
  });

  const page = read("public/prep/aptitude.html");
  it("aptitude page is noindex and posts token+answers", () => {
    expect(page).toContain('<meta name="robots" content="noindex"/>');
    expect(page).toContain("/api/prep/aptitude/quiz");
    expect(page).toContain("/api/prep/aptitude/submit");
    expect(page).toContain("token: token, answers: answers");
  });
  it("escapes rendered question content", () => {
    expect(page).toContain("function esc(s)");
    expect(page).toContain("esc(q.question)");
    expect(page).toContain("esc(r.explanation)");
  });
  const pages = read("src/prep/pages.ts");
  it("pages middleware serves aptitude.html extensionlessly", () => {
    expect(pages).toContain('${rel}.html');
  });
});
