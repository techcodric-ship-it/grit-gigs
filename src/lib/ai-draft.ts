import { JOB_TYPES, MAX_DESCRIPTION_LEN, MAX_TITLE_LEN, isValidJobType, normalizeSkillInput } from "./skills";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

export interface DraftedJob {
  title: string;
  company: string;
  location: string | null;
  type: string;
  salaryRange: string | null;
  description: string;
  skills: string[];
}

export interface DraftJobsInput {
  skill: string;
  company?: string | null;
  location?: string | null;
  count?: number;
}

function buildPrompt(input: DraftJobsInput): string {
  const count = Math.min(3, Math.max(1, input.count ?? 1));
  const company = input.company?.trim() || "Confidential";
  const location = input.location?.trim() || "Remote (India)";
  return [
    `You draft honest, realistic job listings for Grit&Gigs, an Indian jobs and skill marketplace.`,
    `Create exactly ${count} job posting${count > 1 ? "s" : ""} for the skill/topic: "${input.skill.trim()}".`,
    `Company for all of them: ${company}. Location: ${location}.`,
    `Allowed job types: ${JOB_TYPES.join(", ")}. Pick the best fit per listing.`,
    `Rules:`,
    `- Return ONLY a JSON array. No markdown, no commentary.`,
    `- Each item: {"title": string (max ${MAX_TITLE_LEN} chars), "company": string, "location": string, "type": string (one of the allowed types), "salaryRange": string (realistic INR range, e.g. "₹6-9 LPA"), "description": string (120-250 words: role, responsibilities, requirements, how to apply; plain text with \\n between paragraphs; no HTML), "skills": string[] (3-8 relevant skills)}`,
    `- India market context. Realistic salary bands. No fake claims like "10x growth", no invented company metrics, no emoji.`,
    `- Descriptions must be honest role summaries a small employer could plausibly post.`,
  ].join("\n");
}

function extractJsonArray(raw: string): unknown {
  const text = String(raw || "").trim();
  const unfenced = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("[");
    const end = unfenced.lastIndexOf("]");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error("AI returned an unreadable response. Try again.");
  }
}

function sanitizeDraft(raw: unknown, fallbackCompany: string): DraftedJob | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.trim().slice(0, MAX_TITLE_LEN) : "";
  const description =
    typeof r.description === "string" ? r.description.trim().slice(0, MAX_DESCRIPTION_LEN) : "";
  if (!title || !description) return null;
  const company =
    typeof r.company === "string" && r.company.trim()
      ? r.company.trim().slice(0, 120)
      : fallbackCompany.slice(0, 120);
  const type = isValidJobType(r.type) ? r.type : "Full-time";
  return {
    title,
    company,
    location: typeof r.location === "string" && r.location.trim() ? r.location.trim().slice(0, 120) : null,
    type,
    salaryRange: typeof r.salaryRange === "string" && r.salaryRange.trim() ? r.salaryRange.trim().slice(0, 80) : null,
    description,
    skills: normalizeSkillInput(r.skills).slice(0, 10),
  };
}

async function callGemini(prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.8, responseMimeType: "application/json" },
    }),
  });
  const payload = (await resp.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    error?: { message?: string };
  } | null;
  const text = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!resp.ok || !text) {
    throw new Error(payload?.error?.message ? `Gemini: ${payload.error.message}` : "Gemini returned no content.");
  }
  return text;
}

async function callGroq(prompt: string): Promise<string> {
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + GROQ_API_KEY },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.8,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You only output a valid JSON array of job postings." },
        { role: "user", content: prompt },
      ],
    }),
  });
  const payload = (await resp.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const text = payload?.choices?.[0]?.message?.content || "";
  if (!resp.ok || !text) throw new Error("Groq returned no content.");
  return text;
}

/**
 * Drafts job listings. Uses Gemini when GEMINI_API_KEY is configured, otherwise
 * falls back to the existing Groq integration. Throws a friendly error when
 * neither provider is available.
 */
export async function draftJobs(input: DraftJobsInput): Promise<DraftedJob[]> {
  const prompt = buildPrompt(input);
  let raw: string;
  if (GEMINI_API_KEY) {
    raw = await callGemini(prompt);
  } else if (GROQ_API_KEY) {
    raw = await callGroq(prompt);
  } else {
    throw new Error("AI drafting is not configured on this server (set GEMINI_API_KEY or GROQ_API_KEY).");
  }

  const parsed = extractJsonArray(raw);
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { jobs?: unknown }).jobs)
      ? ((parsed as { jobs: unknown[] }).jobs)
      : [];
  const fallbackCompany = input.company?.trim() || "Confidential";
  const drafts = items
    .map((it) => sanitizeDraft(it, fallbackCompany))
    .filter((d): d is DraftedJob => d !== null)
    .slice(0, Math.min(3, Math.max(1, input.count ?? 1)));
  if (!drafts.length) throw new Error("AI returned no usable job drafts. Try again.");
  return drafts;
}
