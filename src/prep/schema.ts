// Prep (Company Report) — new prep_-prefixed tables only.
// Phase 1: company records. Later phases add reports, evidence, aptitude, etc.
// These tables are defined here (not in src/db/schema) so the shared schema
// index and the in-progress Focus Rooms wiring never need to change.

import {
  pgTable,
  uuid,
  varchar,
  text,
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
