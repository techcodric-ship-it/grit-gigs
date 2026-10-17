// Interview Prep question bank — pure data + helpers, no db imports.

export interface PrepQuestion {
  id: string;
  track: PrepTrack;
  text: string;
}

export const PREP_TRACKS = [
  { id: "general", label: "General" },
  { id: "frontend", label: "Frontend" },
  { id: "backend", label: "Backend" },
  { id: "data", label: "Data" },
  { id: "marketing", label: "Marketing" },
  { id: "design", label: "Design" },
] as const;

export type PrepTrack = (typeof PREP_TRACKS)[number]["id"];

const BANK: PrepQuestion[] = [
  { id: "general-1", track: "general", text: "Tell me about yourself in two minutes." },
  { id: "general-2", track: "general", text: "Describe a time you disagreed with a teammate. How did you handle it?" },
  { id: "general-3", track: "general", text: "Why are you interested in this role?" },
  { id: "general-4", track: "general", text: "Tell me about a mistake you made and what you learned." },
  { id: "general-5", track: "general", text: "Where do you want to be in three years?" },
  { id: "frontend-1", track: "frontend", text: "How do you decide between client-side and server-side rendering?" },
  { id: "frontend-2", track: "frontend", text: "Walk through how you would debug a slow React render." },
  { id: "frontend-3", track: "frontend", text: "What makes a component accessible? Give concrete examples." },
  { id: "frontend-4", track: "frontend", text: "How do you manage state across a large app?" },
  { id: "frontend-5", track: "frontend", text: "Describe your approach to responsive layout and CSS architecture." },
  { id: "backend-1", track: "backend", text: "Design a REST API for a job board. What endpoints would you build?" },
  { id: "backend-2", track: "backend", text: "How do database indexes speed up queries, and when do they hurt?" },
  { id: "backend-3", track: "backend", text: "Explain idempotency and where it matters in API design." },
  { id: "backend-4", track: "backend", text: "How would you handle authentication and session expiry?" },
  { id: "backend-5", track: "backend", text: "Walk through debugging a 500 error that only happens in production." },
  { id: "data-1", track: "data", text: "How would you measure whether a new feature is working?" },
  { id: "data-2", track: "data", text: "Explain the difference between correlation and causation with an example." },
  { id: "data-3", track: "data", text: "How do you clean a messy dataset before analysis?" },
  { id: "data-4", track: "data", text: "Describe a dashboard you would build for a small business." },
  { id: "data-5", track: "data", text: "How do you explain a statistical result to a non-technical manager?" },
  { id: "marketing-1", track: "marketing", text: "How would you plan a launch campaign for a new app in India?" },
  { id: "marketing-2", track: "marketing", text: "Which metrics matter most for a paid social campaign, and why?" },
  { id: "marketing-3", track: "marketing", text: "How do you write ad copy that does not feel like hype?" },
  { id: "marketing-4", track: "marketing", text: "How would you grow an email list without buying contacts?" },
  { id: "marketing-5", track: "marketing", text: "Tell me about a brand you admire and what they do well." },
  { id: "design-1", track: "design", text: "Walk me through your process for a new design brief." },
  { id: "design-2", track: "design", text: "How do you take and apply critical design feedback?" },
  { id: "design-3", track: "design", text: "How do you decide on a type scale and spacing system?" },
  { id: "design-4", track: "design", text: "Describe how you design for accessibility from the start." },
  { id: "design-5", track: "design", text: "How do you balance business goals with user needs?" },
];

export function isPrepTrack(v: unknown): v is PrepTrack {
  return typeof v === "string" && PREP_TRACKS.some((t) => t.id === v);
}

export function questionsForTrack(track: unknown): PrepQuestion[] {
  const t = isPrepTrack(track) ? track : "general";
  return BANK.filter((q) => q.track === t);
}

export function findQuestion(id: unknown): PrepQuestion | undefined {
  if (typeof id !== "string") return undefined;
  return BANK.find((q) => q.id === id);
}

export const MAX_ANSWER_LEN = 4000;
export const MIN_ANSWER_LEN = 40;

/** Offline fallback feedback when no LLM is configured. Scores stay null and
 *  the source label is platform_checklist — never pretend a model scored it. */
export function checklistFeedback(answer: string): { feedback: string; score: null; source: "platform_checklist" } {
  const len = answer.trim().length;
  const sentences = answer.split(/[.!?]+/).filter((s) => s.trim().length > 8).length;
  const tips: string[] = [];
  if (len < 120) tips.push("Try a longer answer with a clear start, middle and end.");
  if (sentences < 3) tips.push("Use short sentences: situation, action, result.");
  if (!/\b(I|my)\b/i.test(answer)) tips.push("Answer in first person — interviewers want your specific actions.");
  if (/^.{0,40}(responsible for|duties included)/i.test(answer.trim())) tips.push("Lead with outcomes you drove, not just duties.");
  if (!tips.length) tips.push("Solid structure. Practise trimming to under two minutes out loud.");
  return {
    feedback: `Self-check (not an AI score): ${len} characters, ~${sentences} sentences. ${tips.join(" ")}`,
    score: null,
    source: "platform_checklist",
  };
}

export interface ParsedCoach {
  score: number | null;
  strengths: string[];
  improvements: string[];
  tip: string;
}

/** Parse a coach-model JSON payload defensively. */
export function parseCoachJson(raw: string): ParsedCoach | null {
  try {
    let text = raw.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const num = typeof obj.score === "number" ? obj.score : typeof obj.score === "string" ? Number(obj.score) : null;
    const score = num !== null && Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : null;
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 4) : []);
    return {
      score,
      strengths: arr(obj.strengths),
      improvements: arr(obj.improvements),
      tip: typeof obj.tip === "string" ? obj.tip.slice(0, 400) : "",
    };
  } catch {
    return null;
  }
}
