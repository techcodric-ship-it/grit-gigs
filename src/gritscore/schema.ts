import { boolean, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import type { Extraction } from "./ai";
import type { EvidenceType, TierName, VerificationTier } from "./config";
import type { ScoreComponents } from "./score";

export interface StoredItemAi {
  skills: string[];
  hasQuantifiedImpact: boolean;
  impactNotes: string;
  complexity: number;
  clarity: number;
}

export interface StoredTips {
  tips: string[];
}

export const gritscoreScansTable = pgTable("gritscore_scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  slug: varchar("slug", { length: 80 }).notNull().unique(),
  displayName: varchar("display_name", { length: 120 }),
  headline: varchar("headline", { length: 200 }),
  status: varchar("status", { length: 20 }).notNull().default("READY"),
  /** Only persisted when the user explicitly opts in to keeping the resume. */
  resumeText: text("resume_text"),
  resumeStored: boolean("resume_stored").notNull().default(false),
  extracted: jsonb("extracted").$type<Extraction | null>(),
  summary: text("summary"),
  score: integer("score"),
  rawScore: integer("raw_score"),
  tier: varchar("tier", { length: 20 }).$type<TierName | null>(),
  verificationTier: varchar("verification_tier", { length: 30 })
    .$type<VerificationTier>()
    .notNull()
    .default("self_reported"),
  components: jsonb("components").$type<ScoreComponents | null>(),
  tips: jsonb("tips").$type<string[] | null>(),
  isPublic: boolean("is_public").notNull().default(false),
  showExactScore: boolean("show_exact_score").notNull().default(false),
  template: varchar("template", { length: 30 }).notNull().default("violet"),
  aiUsed: boolean("ai_used").notNull().default(false),
  abuseFlags: jsonb("abuse_flags").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gritscoreItemsTable = pgTable("gritscore_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => gritscoreScansTable.id, { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
  title: varchar("title", { length: 200 }).notNull(),
  description: text("description").notNull(),
  role: varchar("role", { length: 160 }),
  startDate: varchar("start_date", { length: 10 }),
  endDate: varchar("end_date", { length: 10 }),
  evidenceType: varchar("evidence_type", { length: 20 }).$type<EvidenceType>().notNull().default("none"),
  proofUrl: text("proof_url"),
  proofFileUrl: text("proof_file_url"),
  proofFileName: varchar("proof_file_name", { length: 255 }),
  /** unchecked | ok | blocked | dead | invalid | duplicate */
  evidenceStatus: varchar("evidence_status", { length: 20 }).notNull().default("unchecked"),
  evidenceNote: varchar("evidence_note", { length: 200 }),
  skills: jsonb("skills").$type<string[]>().notNull().default([]),
  hasQuantifiedImpact: boolean("has_quantified_impact").notNull().default(false),
  impactNotes: text("impact_notes"),
  complexity: integer("complexity").notNull().default(1),
  clarity: integer("clarity").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gritscoreRefereesTable = pgTable("gritscore_referees", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => gritscoreScansTable.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").references(() => gritscoreItemsTable.id, { onDelete: "cascade" }),
  token: varchar("token", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 120 }),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 30 }),
  status: varchar("status", { length: 20 }).notNull().default("PENDING"),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gritscoreReviewsTable = pgTable("gritscore_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => gritscoreScansTable.id, { onDelete: "cascade" }),
  reviewerUserId: uuid("reviewer_user_id"),
  reviewerName: varchar("reviewer_name", { length: 120 }).notNull(),
  reviewerEmail: varchar("reviewer_email", { length: 255 }),
  stars: integer("stars").notNull(),
  comment: text("comment"),
  status: varchar("status", { length: 20 }).notNull().default("VISIBLE"),
  ipHash: varchar("ip_hash", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gritscoreEntitlementsTable = pgTable("gritscore_entitlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  kind: varchar("kind", { length: 40 }).notNull().default("GRITSCORE_PRO"),
  status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
  pricePaidInr: integer("price_paid_inr").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gritscoreConfigTable = pgTable("gritscore_config", {
  id: varchar("id", { length: 20 }).primaryKey(),
  weights: jsonb("weights").$type<Record<string, number> | null>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GritScoreScan = typeof gritscoreScansTable.$inferSelect;
export type GritScoreItem = typeof gritscoreItemsTable.$inferSelect;
export type GritScoreReferee = typeof gritscoreRefereesTable.$inferSelect;
export type GritScoreReview = typeof gritscoreReviewsTable.$inferSelect;
export type GritScoreEntitlement = typeof gritscoreEntitlementsTable.$inferSelect;
