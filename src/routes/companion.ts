import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { optionalAuth } from "../middlewares/authenticate";
import { companionDisplayName, companionSystemPrompt } from "../lib/companion";

const router: IRouter = Router();

const companionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, message: "Too many AI requests. Please wait a moment and try again." },
});

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// POST /companion/chat — the docked companion's chat endpoint. Works signed-in
// (personalised greeting) and signed-out. Never mutates account state.
router.post("/companion/chat", optionalAuth, companionLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const { message, history } = req.body || {};
    const text = typeof message === "string" ? message.trim() : "";
    if (!text) {
      res.status(400).json({ success: false, message: "Please type a message." });
      return;
    }
    if (text.length > 2000) {
      res.status(400).json({ success: false, message: "Message is too long (max 2000 characters)." });
      return;
    }
    if (!GROQ_API_KEY) {
      res.status(503).json({ success: false, message: "The AI assistant is not configured yet. Please try again later." });
      return;
    }

    const sys: ChatMessage = { role: "system", content: companionSystemPrompt() };
    const historyMsgs: ChatMessage[] = Array.isArray(history)
      ? history
          .filter((m: unknown): m is { role: string; content: string } => {
            const o = m as { role?: unknown; content?: unknown };
            return (
              !!o &&
              (o.role === "user" || o.role === "assistant") &&
              typeof o.content === "string" &&
              o.content.length > 0 &&
              o.content.length <= 4000
            );
          })
          .slice(-12)
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
      : [];

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [sys, ...historyMsgs, { role: "user", content: text }],
        max_tokens: 600,
        temperature: 0.4,
      }),
    });

    if (!r.ok) {
      const body = await r.text();
      console.error({ status: r.status, body }, "Companion Groq error");
      res.status(502).json({ success: false, message: "The AI assistant had a problem. Try again in a moment." });
      return;
    }

    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const reply = data.choices?.[0]?.message?.content?.trim() || "I don't have an answer for that yet.";
    res.json({
      success: true,
      data: { reply, assistant: companionDisplayName(), isAi: true },
    });
  } catch (err) {
    console.error({ err }, "Companion chat failed");
    res.status(500).json({ success: false, message: "Something went wrong. Try again." });
  }
});

export default router;
