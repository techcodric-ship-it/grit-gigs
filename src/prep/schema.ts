// Prep (Company Report) — new prep_-prefixed tables only.
// Phase 1: company records. Later phases add reports, evidence, aptitude, etc.
// These tables are defined here (not in src/db/schema) so the shared schema
// index and the in-progress Focus Rooms wiring never need to change.

import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

export const PREP_COMPANY_STATUS = ["ACTIVE", "PENDING"] as const;
export type PrepCompanyStatus = (typeof PREP_COMPANY_STATUS)[number];

export const prepCompaniesTable = pgTable("prep_companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 160 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  aliases: text("aliases").array().notNull().default([]),
  domain: varchar("domain", { length: 200 }),
  website: text("website"),
  status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
  verifiedClaimedBy: uuid("verified_claimed_by"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PrepCompany = typeof prepCompaniesTable.$inferSelect;

export const prepReportsTable = pgTable("prep_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => prepCompaniesTable.id),
  role: varchar("role", { length: 120 }),
  userType: varchar("user_type", { length: 40 }),
  sections: jsonb("sections").notNull().default({}),
  aiSummary: text("ai_summary"),
  aiModel: varchar("ai_model", { length: 80 }),
  sourceCount: integer("source_count").notNull().default(0),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PrepReport = typeof prepReportsTable.$inferSelect;

export const APTITUDE_TOPICS = ["quant", "logical", "verbal"] as const;
export type AptitudeTopic = (typeof APTITUDE_TOPICS)[number];

export const prepAptitudeQuestionsTable = pgTable("prep_aptitude_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  topic: varchar("topic", { length: 40 }).notNull(),
  difficulty: varchar("difficulty", { length: 10 }).notNull().default("medium"),
  question: text("question").notNull(),
  options: text("options").array().notNull(),
  correctIdx: integer("correct_idx").notNull(),
  explanation: text("explanation").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PrepAptitudeQuestion = typeof prepAptitudeQuestionsTable.$inferSelect;

export const prepInterviewQuestionsTable = pgTable("prep_interview_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  track: varchar("track", { length: 30 }).notNull(),
  category: varchar("category", { length: 30 }).notNull(),
  difficulty: varchar("difficulty", { length: 10 }).notNull().default("medium"),
  question: text("question").notNull(),
  guidance: text("guidance").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PrepInterviewQuestion = typeof prepInterviewQuestionsTable.$inferSelect;

export const PROOF_KINDS = ["PAY_RECORD", "PLACEMENT_RECORD", "INTERVIEW_EXPERIENCE"] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];

export const PROOF_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type ProofStatus = (typeof PROOF_STATUSES)[number];

export const prepProofSubmissionsTable = pgTable("prep_proof_submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => prepCompaniesTable.id),
  kind: varchar("kind", { length: 40 }).notNull(),
  payload: jsonb("payload").notNull().default({}),
  filePath: text("file_path"),
  status: varchar("status", { length: 20 }).notNull().default("PENDING"),
  reviewNote: text("review_note"),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  submittedBy: uuid("submitted_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  fileDeletedAt: timestamp("file_deleted_at"),
});

export type PrepProofSubmission = typeof prepProofSubmissionsTable.$inferSelect;

export const prepEntitlementsTable = pgTable("prep_entitlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  kind: varchar("kind", { length: 40 }).notNull().default("PREP_PRO"),
  status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
  pricePaidInr: integer("price_paid_inr").notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PrepEntitlement = typeof prepEntitlementsTable.$inferSelect;

// Unique per record: the reason embeds the submission id, so an approved
// proof can never be paid twice even across retries/races.
export const prepCreditAwardsTable = pgTable("prep_credit_awards", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  reason: varchar("reason", { length: 160 }).notNull(),
  amountInr: integer("amount_inr").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PrepCreditAward = typeof prepCreditAwardsTable.$inferSelect;

// Cached AI prep plans: one per company + role key, latest regeneration wins.
export const prepAiPlansTable = pgTable("prep_ai_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  roleKey: varchar("role_key", { length: 160 }).notNull().default(""),
  plan: jsonb("plan").notNull(),
  model: varchar("model", { length: 80 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PrepAiPlanRow = typeof prepAiPlansTable.$inferSelect;

// Per-user daily free-tier AI plan generations (Prep Pro skips the count).
export const prepAiPlanRequestsTable = pgTable("prep_ai_plan_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PrepAiPlanRequest = typeof prepAiPlanRequestsTable.$inferSelect;

// Per-user daily free-tier resume checks (Prep Pro skips the count).
// Usage count ONLY — the resume text itself is analysed in memory and never
// stored, so this table can never become a resume honeypot.
export const prepResumeChecksTable = pgTable("prep_resume_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PrepResumeCheck = typeof prepResumeChecksTable.$inferSelect;

// Per-user daily free-tier AI answer scores (Prep Pro skips the count).
// Usage count ONLY — typed answers are analysed in memory and never stored.
export const prepAnswerScoresTable = pgTable("prep_answer_scores", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PrepAnswerScore = typeof prepAnswerScoresTable.$inferSelect;

// Member-submitted company question packs: the questions candidates say they
// were actually asked. MEMBER_REPORTED and unverified by design — every read
// path must label them as such; status exists for later moderation.
export const prepCompanyQuestionsTable = pgTable("prep_company_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => prepCompaniesTable.id),
  role: varchar("role", { length: 120 }).notNull().default(""),
  category: varchar("category", { length: 30 }).notNull().default("technical"),
  question: text("question").notNull(),
  context: varchar("context", { length: 280 }).notNull().default(""),
  status: varchar("status", { length: 20 }).notNull().default("VISIBLE"),
  submittedBy: uuid("submitted_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PrepCompanyQuestion = typeof prepCompanyQuestionsTable.$inferSelect;
