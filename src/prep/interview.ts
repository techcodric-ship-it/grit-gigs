// Pure interview-prep helpers: browse filtering, mock selection (reuses the
// signed-token machinery from aptitude), and post-mock self-assessment
// feedback. No DB/network imports — the router owns persistence.

import { clampCount, shuffle, signQuizToken, verifyQuizToken } from "./aptitude";
import { INTERVIEW_BANK, type InterviewBankQuestion, type InterviewTrack, type InterviewCategory } from "./interview-bank";

export const INTERVIEW_TRACKS: InterviewTrack[] = ["general", "engineering", "data", "business"];
export const INTERVIEW_CATEGORIES: InterviewCategory[] = ["behavioral", "technical", "hr"];
export const MOCK_DEFAULT_COUNT = 5;

/** Free public sample: one question per category, universally asked, with the
 * guidance that sells Prep Pro. Codes are stable for tests and seeding. */
export const SAMPLE_QUESTION_CODES = ["iv-gen-b1", "iv-gen-t1", "iv-gen-h1"] as const;

export function sampleInterviewQuestions(bank: InterviewBankQuestion[] = INTERVIEW_BANK): InterviewBankQuestion[] {
  const byCode = new Map(bank.map((q) => [q.code, q]));
  return SAMPLE_QUESTION_CODES.map((c) => byCode.get(c)).filter((q): q is InterviewBankQuestion => !!q);
}

export interface InterviewQuestionPublic {
  id: string;
  code: string;
  track: string;
  category: string;
  difficulty: string;
  question: string;
}

export interface MockFeedbackItem extends InterviewQuestionPublic {
  rating: number | null; // self-rating 1-5, null when unanswered
  guidance: string;
}

export interface MockFeedback {
  avgConfidence: number | null; // 1-5, one decimal, null if nothing rated
  weakestCategory: string | null;
  answered: number;
  total: number;
  items: MockFeedbackItem[];
}

export function isValidTrack(v: unknown): v is InterviewTrack {
  return typeof v === "string" && (INTERVIEW_TRACKS as string[]).includes(v);
}

export function isValidCategory(v: unknown): v is InterviewCategory {
  return typeof v === "string" && (INTERVIEW_CATEGORIES as string[]).includes(v);
}

export function toPublicInterviewQuestion(row: {
  id: string;
  code: string;
  track: string;
  category: string;
  difficulty: string;
  question: string;
}): InterviewQuestionPublic {
  return {
    id: row.id,
    code: row.code,
    track: row.track,
    category: row.category,
    difficulty: row.difficulty,
    question: row.question,
  };
}

/** Browse-mode filtering (also used against the in-repo bank in tests). */
export function filterInterviewBank(bank: InterviewBankQuestion[], track?: string | null, category?: string | null): InterviewBankQuestion[] {
  return bank.filter(
    (q) =>
      (!track || q.track === track) &&
      (!category || q.category === category),
  );
}

export function pickMock<T>(rows: T[], count: unknown, rng: () => number = Math.random): T[] {
  const wanted = count === undefined || count === null || count === "" ? MOCK_DEFAULT_COUNT : count;
  const n = clampCount(wanted, Math.max(1, rows.length));
  return shuffle(rows, rng).slice(0, Math.min(n, rows.length));
}

export function signInterviewMock(ids: string[], track: string | null, secret: string): string {
  return signQuizToken({ ids, topic: track }, secret);
}

export function verifyInterviewMock(token: string, secret: string): { ids: string[]; track: string | null } | null {
  const payload = verifyQuizToken(token, secret);
  if (!payload) return null;
  return { ids: payload.ids, track: payload.topic ?? null };
}

/** Self-assessment feedback: ratings are client input, guidance is server truth. */
export function aggregateFeedback(
  rows: (InterviewQuestionPublic & { guidance: string })[],
  ratings: Record<string, number>,
  tokenIds: string[],
): MockFeedback {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items: MockFeedbackItem[] = [];
  const categoryScores = new Map<string, number[]>();
  let ratingSum = 0;
  let ratingCount = 0;

  for (const id of tokenIds) {
    const row = byId.get(id);
    if (!row) continue;
    const raw = ratings[id];
    const rating = typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 5 ? raw : null;
    if (rating !== null) {
      ratingSum += rating;
      ratingCount++;
      const list = categoryScores.get(row.category) ?? [];
      list.push(rating);
      categoryScores.set(row.category, list);
    }
    items.push({ ...row, rating, guidance: row.guidance });
  }

  let weakest: string | null = null;
  let weakestAvg = Number.POSITIVE_INFINITY;
  for (const [category, scores] of [...categoryScores.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avg < weakestAvg || (avg === weakestAvg && weakest !== null && category < weakest)) {
      weakestAvg = avg;
      weakest = category;
    }
  }

  return {
    avgConfidence: ratingCount ? Math.round((ratingSum / ratingCount) * 10) / 10 : null,
    weakestCategory: ratingCount ? weakest : null,
    answered: ratingCount,
    total: items.length,
    items,
  };
}

export { INTERVIEW_BANK };
