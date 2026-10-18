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
