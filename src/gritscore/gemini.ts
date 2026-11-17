// Minimal Gemini generateContent client for GritScore extraction.
//
// GritScore used to borrow the Prep AI transport. Prep is gone, so the one
// function it needs lives here: a single request/response pair with a bounded
// token budget and a hard timeout. The model is still only a reader (see
// ai.ts) - it never decides a score.

const GEMINI_TIMEOUT_MS = 12_000;
const GEMINI_UA = "GritAndGigs-GritScore/1.0 (+https://www.gritandgigs.in)";

function geminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

export type GeminiFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const defaultFetch: GeminiFetch = (url, init) => fetch(url, init as RequestInit);

/** System messages ride as systemInstruction, user messages as one turn. */
export async function geminiChat(
  messages: { role: "system" | "user"; content: string }[],
  fetchImpl: GeminiFetch = defaultFetch,
  maxOutputTokens = 1400,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || "";
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");

  const res = await fetchImpl(geminiUrl(model), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
      "user-agent": GEMINI_UA,
    },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens },
    }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });

  const payload = (await res.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  const content = parts.map((p) => p.text ?? "").join("");
  if (!res.ok || !content) {
    throw new Error(`Gemini error ${res.status}`);
  }
  return content;
}
