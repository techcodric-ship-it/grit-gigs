import {
  pgTable,
  pgEnum,
  integer,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const planIdEnum = pgEnum("plan_id", ["free", "starter", "pro", "elite"]);

export const userSubscriptionsTable = pgTable("user_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  planId: planIdEnum("plan_id").default("free").notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  // null expiresAt = free plan (never expires). Paid plans expire 30 days
  // after subscribing and silently fall back to "free" once past due.
  expiresAt: timestamp("expires_at"),
  proposalCreditsRemaining: integer("proposal_credits_remaining").default(3).notNull(),
  featuredProposalsRemaining: integer("featured_proposals_remaining").default(0).notNull(),
  // When the monthly allowance was last topped up — used to auto-refresh
  // proposalCreditsRemaining/featuredProposalsRemaining every 30 days
  // without needing a cron job.
  creditsResetAt: timestamp("credits_reset_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserSubscription = typeof userSubscriptionsTable.$inferSelect;
