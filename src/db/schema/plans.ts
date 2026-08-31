import {
  pgTable,
  pgEnum,
  integer,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const planIdEnum = pgEnum("plan_id", ["starter", "pro", "squad"]);

export const userSubscriptionsTable = pgTable("user_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  planId: planIdEnum("plan_id").default("starter").notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  // null expiresAt = free/starter plan (never expires). Paid plans expire 30
  // days after subscribing and silently fall back to "starter" once past due.
  expiresAt: timestamp("expires_at"),
  proposalCreditsRemaining: integer("proposal_credits_remaining").default(2).notNull(),
  featuredProposalsRemaining: integer("featured_proposals_remaining").default(0).notNull(),
  // Monthly creation quota counters. Gigs and projects are a monthly
  // allowance (per 30-day cycle), not a concurrent active cap — e.g. a
  // Starter user can CREATE up to 3 gigs and 3 projects per cycle. Existing
  // active items stay; the counters reset to 0 on the monthly refresh.
  gigsCreatedThisCycle: integer("gigs_created_this_cycle").default(0).notNull(),
  projectsCreatedThisCycle: integer("projects_created_this_cycle").default(0).notNull(),
  // When the monthly allowance was last topped up — used to auto-refresh
  // featuredProposalsRemaining and reset the creation counters every 30 days
  // without needing a cron job.
  creditsResetAt: timestamp("credits_reset_at").defaultNow().notNull(),
  // When the weekly project-bid credit bucket was last topped up. Proposal /
  // bid credits are a weekly allowance (per 7-day cycle), independent of the
  // 30-day creation counters above.
  bidsResetAt: timestamp("bids_reset_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserSubscription = typeof userSubscriptionsTable.$inferSelect;
