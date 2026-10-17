import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { eq, desc } from "drizzle-orm";
import { db, prepSessionsTable } from "../db";
import { authenticate } from "../middlewares/authenticate";
import {
  MAX_ANSWER_LEN,
  PREP_TRACKS,
  checklistFeedback,
  findQuestion,
  isPrepTrack,
  parseCoachJson,
  questionsForTrack,
} from "../lib/prep-questions";

const router: IRouter = Router();

const prepLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, message: "Too many requests. Please wait a moment and try again." },
});

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// GET /prep/tracks — available practice tracks.
router.get("/prep/tracks", (_req: Request, res: Response): void => {
  res.json({ success: true, data: PREP_TRACKS });
});

// GET /prep/questions?track= — the question bank for a track.
router.get("/prep/questions", (req: Request, res: Response): void => {
  const track = isPrepTrack(req.query.track) ? req.query.track : "general";
  res.json({ success: true, data: { track, questions: questionsForTrack(track) } });
});

async function coachWithLlm(question: string, answer: string): Promise<ReturnType<typeof checklistFeedback> | {
  feedback: string;
  score: number | null;
  source: "ai_estimate";
  strengths: string[];
  improvements: string[];
  tip: string;
}> {
  if (!GROQ_API_KEY) return checklistFeedback(answer);
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are an interview coach on Grit&Gigs, an India-focused work platform. Score the candidate's answer from 0-100. Scores are estimates, not guarantees. Be specific and kind. Reply ONLY with JSON: {\"score\": number, \"strengths\": string[2], \"improvements\": string[2], \"tip\": string}.",
          },
          { role: "user", content: `Question: ${question}\n\nAnswer: ${answer}` },
        ],
        max_tokens: 500,
        temperature: 0.3,
      }),
    });
    if (!r.ok) return checklistFeedback(answer);
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = parseCoachJson(data.choices?.[0]?.message?.content || "");
    if (!parsed) return checklistFeedback(answer);
    const parts: string[] = [];
    if (parsed.strengths.length) parts.push(`Strengths: ${parsed.strengths.join(" ")}`);
    if (parsed.improvements.length) parts.push(`Improvements: ${parsed.improvements.join(" ")}`);
    if (parsed.tip) parts.push(`Tip: ${parsed.tip}`);
    parts.push("(Score is an AI estimate, not a guarantee.)");
    return {
      feedback: parts.join("\n"),
      score: parsed.score,
      source: "ai_estimate",
      strengths: parsed.strengths,
      improvements: parsed.improvements,
      tip: parsed.tip,
    };
  } catch {
    return checklistFeedback(answer);
  }
}

// POST /prep/sessions — practise an answer and get feedback (AI when configured).
router.post("/prep/sessions", authenticate, prepLimiter, async (req: Request, res: Response): Promise<void> => {
  const { track, questionId, answer } = req.body || {};
  const q = findQuestion(questionId);
  if (!q) {
    res.status(400).json({ success: false, message: "Pick a question from the practice list." });
    return;
  }
  if (isPrepTrack(track) && track !== q.track) {
    res.status(400).json({ success: false, message: "That question belongs to a different track." });
    return;
  }
  const text = typeof answer === "string" ? answer.trim() : "";
  if (text.length < 40) {
    res.status(400).json({ success: false, message: `Write at least 40 characters — aim for a real spoken-style answer (max ${MAX_ANSWER_LEN}).` });
    return;
  }
  if (text.length > MAX_ANSWER_LEN) {
    res.status(400).json({ success: false, message: `Answer is too long (max ${MAX_ANSWER_LEN} characters).` });
    return;
  }

  const result = await coachWithLlm(q.text, text);
  const [row] = await db
    .insert(prepSessionsTable)
    .values({
      userId: req.user!.id,
      track: q.track,
      question: q.text,
      answer: text,
      feedback: result.feedback,
      score: result.score,
      source: result.source,
    })
    .returning();

  res.status(201).json({
    success: true,
    message: "Answer practised",
    data: {
      sessionId: row.id,
      track: row.track,
      question: row.question,
      score: row.score,
      source: row.source,
      feedback: row.feedback,
    },
  });
});

// GET /prep/sessions — the caller's recent practice history.
router.get("/prep/sessions", authenticate, async (req: Request, res: Response): Promise<void> => {
  const rows = await db
    .select()
    .from(prepSessionsTable)
    .where(eq(prepSessionsTable.userId, req.user!.id))
    .orderBy(desc(prepSessionsTable.createdAt))
    .limit(20);
  res.json({
    success: true,
    data: rows.map((r) => ({
      id: r.id,
      track: r.track,
      question: r.question,
      answer: r.answer,
      score: r.score,
      source: r.source,
      feedback: r.feedback,
      createdAt: r.createdAt,
    })),
  });
});

export default router;
