// Shared skill helpers for the Jobs pivot. Skills are free-form TEXT[] columns
// across users, jobs and squads; this module keeps input normalization and the
// curated suggestion taxonomy in one place so every surface agrees.

export const SKILLS_TAXONOMY: readonly string[] = [
  "React", "Next.js", "Node.js", "TypeScript", "JavaScript", "Python", "Django",
  "Flask", "Java", "Spring Boot", "Go", "Rust", "PHP", "Laravel", "Ruby on Rails",
  "Flutter", "React Native", "Android", "iOS", "Swift", "Kotlin",
  "HTML/CSS", "Tailwind CSS", "WordPress", "Webflow", "Shopify",
  "UI Design", "UX Research", "Figma", "Adobe Photoshop", "Adobe Illustrator",
  "Video Editing", "Adobe Premiere Pro", "After Effects", "DaVinci Resolve",
  "Content Writing", "Copywriting", "Technical Writing", "SEO", "Email Marketing",
  "Social Media Marketing", "Performance Marketing", "Google Ads", "Meta Ads",
  "Graphic Design", "Logo Design", "Motion Graphics", "3D Modeling",
  "Data Analysis", "SQL", "Power BI", "Tableau", "Excel", "Machine Learning",
  "Data Engineering", "DevOps", "Docker", "Kubernetes", "AWS", "Azure", "GCP",
  "CI/CD", "Linux", "Cybersecurity", "Blockchain", "Solidity",
  "Product Management", "Project Management", "Business Analysis", "QA Testing",
  "Automation Testing", "Customer Support", "Accounting", "GST Filing",
  "Legal Consulting", "HR Recruiting", "Sales", "Photography", "Music Production",
  "Translation", "Tutoring", "Voice Over",
] as const;

export const JOB_TYPES = ["Full-time", "Part-time", "Contract", "Internship", "Remote"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const MAX_JOB_SKILLS = 10;
export const MAX_TITLE_LEN = 140;
export const MAX_DESCRIPTION_LEN = 5000;

/** Trim, drop empties, de-dupe case-insensitively (keeping first casing), cap. */
export function normalizeSkillInput(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const v = item.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v.slice(0, 60));
    if (out.length >= MAX_JOB_SKILLS) break;
  }
  return out;
}

/** Sanitize GET /jobs query params into a plain filter object. */
export function parseJobListQuery(query: Record<string, unknown>): {
  q?: string;
  skill?: string;
  type?: string;
  location?: string;
} {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : undefined);
  const out: { q?: string; skill?: string; type?: string; location?: string } = {};
  const q = str(query.q);
  const skill = str(query.skill);
  const location = str(query.location);
  let type = str(query.type);
  if (type && !(JOB_TYPES as readonly string[]).includes(type)) type = undefined;
  if (q) out.q = q;
  if (skill) out.skill = skill;
  if (type) out.type = type;
  if (location) out.location = location;
  return out;
}

/** Poster or admin/moderator may manage a job (edit, close, review applicants). */
export function canManageJob(
  job: { postedById: string | null },
  user: { id: string; role: string },
): boolean {
  if (user.role === "ADMIN" || user.role === "MODERATOR") return true;
  return Boolean(job.postedById) && job.postedById === user.id;
}

export function isValidJobType(v: unknown): v is JobType {
  return typeof v === "string" && (JOB_TYPES as readonly string[]).includes(v);
}
