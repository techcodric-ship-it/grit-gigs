// Original interview-prep question bank (Phase 6). Written in-repo — not
// scraped from prep sites. Codes are stable/unique for idempotent seeding.

export type InterviewTrack = "general" | "engineering" | "data" | "business";
export type InterviewCategory = "behavioral" | "technical" | "hr";

export interface InterviewBankQuestion {
  code: string;
  track: InterviewTrack;
  category: InterviewCategory;
  difficulty: "easy" | "medium" | "hard";
  question: string;
  guidance: string;
}

export const INTERVIEW_BANK: InterviewBankQuestion[] = [
  // ---- General ----
  {
    code: "iv-gen-b1",
    track: "general",
    category: "behavioral",
    difficulty: "easy",
    question: "Tell me about yourself.",
    guidance: "Keep it to ~90 seconds: present role, one relevant achievement with a number, then why this opportunity fits your next step. Skip childhood stories.",
  },
  {
    code: "iv-gen-b2",
    track: "general",
    category: "behavioral",
    difficulty: "medium",
    question: "Describe a time you disagreed with a teammate. How did you handle it?",
    guidance: "Use STAR (Situation, Task, Action, Result). Show you challenged the idea, not the person, and ended with what the team shipped or learned.",
  },
  {
    code: "iv-gen-b3",
    track: "general",
    category: "behavioral",
    difficulty: "medium",
    question: "Tell me about a time you failed or missed a deadline.",
    guidance: "Pick a real but survivable failure. Spend most of the answer on the fix and the process change you made afterwards — interviewers rate accountability, not perfection.",
  },
  {
    code: "iv-gen-h1",
    track: "general",
    category: "hr",
    difficulty: "easy",
    question: "Why do you want to work here?",
    guidance: "Name something specific you verified: the product, the team's tech blog, a recent launch. Generic praise reads as mass-applied.",
  },
  {
    code: "iv-gen-h2",
    track: "general",
    category: "hr",
    difficulty: "easy",
    question: "What are your salary expectations?",
    guidance: "Give a researched range, state you're flexible on the full package, and ask what band is budgeted for the role. Never name your current salary as the floor.",
  },
  {
    code: "iv-gen-t1",
    track: "general",
    category: "technical",
    difficulty: "medium",
    question: "Walk me through how you would plan a project with an ambiguous requirement.",
    guidance: "Show you reduce ambiguity deliberately: list open questions, talk to stakeholders, define a thin slice, ship it, then iterate. Mention how you'd document decisions.",
  },

  // ---- Engineering ----
  {
    code: "iv-eng-t1",
    track: "engineering",
    category: "technical",
    difficulty: "medium",
    question: "How does an HTTP request travel from your browser to a server and back?",
    guidance: "Cover DNS lookup, TCP handshake, TLS, request routing, server handling, response — and be ready to go one level deeper on any step you mention.",
  },
  {
    code: "iv-eng-t2",
    track: "engineering",
    category: "technical",
    difficulty: "medium",
    question: "What is the difference between authentication and authorization?",
    guidance: "Authn = who you are (credentials/session), Authz = what you're allowed to do (roles/permissions). Add a concrete example from a system you've built.",
  },
  {
    code: "iv-eng-t3",
    track: "engineering",
    category: "technical",
    difficulty: "hard",
    question: "A page suddenly takes 8 seconds to load. How do you debug it?",
    guidance: "Name your tools and order: reproduce, check network waterfall, server metrics and logs, database slow queries, recent deploys, then bisect. End with the fix and a regression guard.",
  },
  {
    code: "iv-eng-t4",
    track: "engineering",
    category: "technical",
    difficulty: "hard",
    question: "When would you choose a queue over making a direct API call?",
    guidance: "When work can be deferred: smoothing spikes, retries, fan-out, slow processing. Mention trade-offs — eventual consistency, idempotency, and observability.",
  },
  {
    code: "iv-eng-b1",
    track: "engineering",
    category: "behavioral",
    difficulty: "medium",
    question: "Tell me about a production incident you handled.",
    guidance: "Structure: impact, how you detected, mitigation first, root cause second, prevention after. Quantify downtime or users affected if you can.",
  },
  {
    code: "iv-eng-h1",
    track: "engineering",
    category: "hr",
    difficulty: "easy",
    question: "Where do you want to be in five years?",
    guidance: "Show direction, not a fixed title: depth in a domain, ownership of a system, mentoring others. Tie it to how this role builds that.",
  },

  // ---- Data ----
  {
    code: "iv-dat-t1",
    track: "data",
    category: "technical",
    difficulty: "medium",
    question: "Explain the difference between INNER JOIN and LEFT JOIN.",
    guidance: "INNER keeps matching rows only; LEFT keeps all left rows plus matches. Give a business example (users with and without orders) and the row-count effects.",
  },
  {
    code: "iv-dat-t2",
    track: "data",
    category: "technical",
    difficulty: "medium",
    question: "How do you handle missing values in a dataset?",
    guidance: "Depend on the mechanism: MCAR/MAR/MNAR. Options: drop, impute (mean/median/model), flag as a category. Always say what bias each choice introduces.",
  },
  {
    code: "iv-dat-t3",
    track: "data",
    category: "technical",
    difficulty: "hard",
    question: "A dashboard metric dropped 40% overnight. What do you check first?",
    guidance: "Data pipeline health before business conclusions: freshness, row counts, join keys, schema/ETL changes, timezone boundaries — then segmentation to localize the drop.",
  },
  {
    code: "iv-dat-t4",
    track: "data",
    category: "technical",
    difficulty: "hard",
    question: "What is the difference between correlation and causation? How would you argue for a causal claim?",
    guidance: "Correlation is association; causation needs a mechanism and a design — randomized experiment, natural experiment, or quasi-experimental controls (diff-in-diff, IV). Mention confounders.",
  },
  {
    code: "iv-dat-b1",
    track: "data",
    category: "behavioral",
    difficulty: "medium",
    question: "Tell me about an analysis that changed a decision.",
    guidance: "Frame with decision → options → your analysis → the call made → measured outcome. If nobody changed course, say what you learned about stakeholder alignment.",
  },
  {
    code: "iv-dat-h1",
    track: "data",
    category: "hr",
    difficulty: "easy",
    question: "Which tools are strongest for you, and what are you learning?",
    guidance: "Rank honestly: one core tool you can defend deep (SQL/Python/BI), one you're solid in, plus what you're actively learning and why.",
  },

  // ---- Business ----
  {
    code: "iv-biz-t1",
    track: "business",
    category: "technical",
    difficulty: "medium",
    question: "How would you price a new service in a market you have little data for?",
    guidance: "Talk anchors: competitor pricing, willingness-to-pay interviews, cost floor, value delivered; then a staged rollout with price experiments and clear success metrics.",
  },
  {
    code: "iv-biz-t2",
    track: "business",
    category: "technical",
    difficulty: "medium",
    question: "Walk me through how you'd generate your first 10 B2B clients.",
    guidance: "Narrow ICP, warm network + targeted outreach, a repeatable pitch, fast feedback loop, and a pipeline metric (calls → demos → closes). Mention retention, not just acquisition.",
  },
  {
    code: "iv-biz-t3",
    track: "business",
    category: "technical",
    difficulty: "hard",
    question: "A key client says they're churning next month. What do you do?",
    guidance: "Listen for the real reason, quantify what's at risk, offer a concrete save plan tied to their goal, escalate internally if needed, and log the root cause to prevent repeats.",
  },
  {
    code: "iv-biz-b1",
    track: "business",
    category: "behavioral",
    difficulty: "medium",
    question: "Describe a time you had to influence without authority.",
    guidance: "Show how you built the case with data, aligned incentives of others, and brought people along — then the outcome. This scores seniority more than title.",
  },
  {
    code: "iv-biz-b2",
    track: "business",
    category: "behavioral",
    difficulty: "hard",
    question: "Tell me about a target you missed. What did you do next?",
    guidance: "Own the number, explain the gap honestly (no excuses), show the recovery plan you executed and what you changed in your forecast or process afterwards.",
  },
  {
    code: "iv-biz-h1",
    track: "business",
    category: "hr",
    difficulty: "easy",
    question: "Why should we hire you over other candidates?",
    guidance: "Two proof points matched to the job description's top two requirements, each with a measurable result. Close with the immediate value you'd bring in 90 days.",
  },
];
