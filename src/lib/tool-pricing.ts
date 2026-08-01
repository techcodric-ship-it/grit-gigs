// ── Rate & Budget Calculator — shared pricing logic ────────────────────────
// Used by the API route (to compute + email results) so the number shown to
// the user and the number in the email always match.

export const TOOL_SKILLS: Record<string, number> = {
  "Web Development": 500,
  "App Development": 800,
  "UI/UX Design": 700,
  "Graphic Design": 400,
  "Logo & Branding": 450,
  "Illustration": 450,
  "Content Writing": 350,
  "Copywriting": 450,
  "Translation": 350,
  "SEO & Marketing": 500,
  "Digital Marketing": 500,
  "Social Media": 350,
  "Video Editing": 400,
  "Photography": 500,
  "Data Entry & Admin": 200,
  "Business Consulting": 900,
  "Finance & Accounting": 600,
  "Other": 400,
};

export const TOOL_EXPERIENCE_MULTIPLIER: Record<string, number> = {
  "0-2 years": 0.7,
  "3-5 years": 1.0,
  "5+ years": 1.5,
};

const roundTo = (n: number, step: number): number => Math.round(n / step) * step;

export interface FreelancerResult {
  role: "freelancer";
  hourlyLow: number;
  hourlyHigh: number;
  projectLow: number;
  projectHigh: number;
  monthlyLow: number;
  monthlyHigh: number;
}

export interface ClientResult {
  role: "client";
  budgetLow: number;
  budgetHigh: number;
  hourlyLow: number;
  hourlyHigh: number;
  tip: string;
}

export type ToolResult = FreelancerResult | ClientResult;

export function calcFreelancer(service: string, experience: string, hours: number): FreelancerResult {
  const base = TOOL_SKILLS[service] ?? TOOL_SKILLS["Other"];
  const mult = TOOL_EXPERIENCE_MULTIPLIER[experience] ?? 1.0;
  const hourlyLow = roundTo(base * mult * 0.85, 25);
  const hourlyHigh = roundTo(base * mult * 1.25, 25);
  const projectLow = roundTo(hourlyLow * hours * 1.1, 250);
  const projectHigh = roundTo(hourlyHigh * hours * 1.2, 250);
  const monthlyLow = roundTo(hourlyLow * 160 * 0.8, 500);
  const monthlyHigh = roundTo(hourlyHigh * 160 * 1.1, 500);
  return { role: "freelancer", hourlyLow, hourlyHigh, projectLow, projectHigh, monthlyLow, monthlyHigh };
}

export function calcClient(service: string, hours: number): ClientResult {
  const base = TOOL_SKILLS[service] ?? TOOL_SKILLS["Other"];
  const hourlyLow = roundTo(base * 0.8, 25);
  const hourlyHigh = roundTo(base * 1.3, 25);
  const budgetLow = roundTo(hourlyLow * hours, 250);
  const budgetHigh = roundTo(hourlyHigh * hours, 250);
  const tip =
    hours <= 10
      ? "For a small task like this, compare 2-3 freelancers and pick a fixed price rather than hourly."
      : "For a project this size, ask for a fixed-price quote with a clear deadline and revision policy.";
  return { role: "client", budgetLow, budgetHigh, hourlyLow, hourlyHigh, tip };
}

export function formatINR(n: number): string {
  return "₹" + n.toLocaleString("en-IN");
}
