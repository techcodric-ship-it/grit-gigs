// Pure aptitude quiz logic: selection, stateless signed quiz tokens (JWT with
// the server's JWT_SECRET), and server-side scoring. No DB/network imports so
// the module is fully unit-testable; the router owns persistence.

import jwt from "jsonwebtoken";
import { APTITUDE_BANK, type BankQuestion } from "./aptitude-bank";

export const QUIZ_DEFAULT_COUNT = 10;
export const QUIZ_TOKEN_TTL_SEC = 600; // 10 minutes to complete

export interface QuizQuestionPublic {
  id: string;
  code: string;
  topic: string;
  difficulty: string;
  question: string;
  options: string[];
}

export interface QuizPayload {
  ids: string[]; // question ids in display order
  topic: string | null;
}

export interface QuizAnswerResult {
  id: string;
  question: string;
  options: string[];
  yourAnswer: number | null;
  correctIdx: number;
  correct: boolean;
  explanation: string;
}

export interface QuizScore {
  score: number;
  total: number;
  results: QuizAnswerResult[];
}

/** Deterministic shuffle with an injectable RNG (crypto-agnostic for tests). */
export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function clampCount(count: unknown, max: number): number {
  const n = Number(count);
  if (!Number.isFinite(n) || n < 1) return Math.min(QUIZ_DEFAULT_COUNT, max);
  return Math.min(Math.floor(n), max);
}

/** Pick a quiz from rows: shuffled, bounded by available rows. */
export function pickQuiz<T>(rows: T[], count: number, rng: () => number = Math.random): T[] {
  return shuffle(rows, rng).slice(0, Math.max(1, count));
}

export function toPublicQuestion(row: {
  id: string;
  code: string;
  topic: string;
  difficulty: string;
  question: string;
  options: string[];
}): QuizQuestionPublic {
  return {
    id: row.id,
    code: row.code,
    topic: row.topic,
    difficulty: row.difficulty,
    question: row.question,
    options: row.options,
  };
}

/** Sign the ordered id list so submit can verify what was served. */
export function signQuizToken(payload: QuizPayload, secret: string): string {
  return jwt.sign(payload, secret, { expiresIn: QUIZ_TOKEN_TTL_SEC });
}

export function verifyQuizToken(token: string, secret: string): QuizPayload | null {
  try {
    const decoded = jwt.verify(token, secret) as QuizPayload;
    if (!decoded || !Array.isArray(decoded.ids) || decoded.ids.length === 0) return null;
    if (decoded.ids.length > 50) return null;
    return { ids: decoded.ids, topic: decoded.topic ?? null };
  } catch {
    return null;
  }
}

/** Server-side scoring: correct answers are never known to the client before submit. */
export function scoreQuiz(
  rowsInTokenOrder: (QuizQuestionPublic & { correctIdx: number; explanation: string })[],
  answers: Record<string, number>,
  tokenIds: string[],
): QuizScore {
  const byId = new Map(rowsInTokenOrder.map((r) => [r.id, r]));
  const results: QuizAnswerResult[] = [];
  let score = 0;
  for (const id of tokenIds) {
    const row = byId.get(id);
    if (!row) continue; // id not in bank anymore — skip, do not award
    const raw = answers[id];
    const yourAnswer = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < row.options.length ? raw : null;
    const correct = yourAnswer !== null && yourAnswer === row.correctIdx;
    if (correct) score++;
    results.push({
      id: row.id,
      question: row.question,
      options: row.options,
      yourAnswer,
      correctIdx: row.correctIdx,
      correct,
      explanation: row.explanation,
    });
  }
  return { score, total: results.length, results };
}

/** Bank-only fallback used by tests and topic counts (no DB). */
export function bankByTopic(topic?: string | null): BankQuestion[] {
  if (!topic) return APTITUDE_BANK;
  return APTITUDE_BANK.filter((q) => q.topic === topic);
}
