import {
  pgTable,
  pgEnum,
  boolean,
  real,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const referralStatusEnum = pgEnum("referral_status", [
  "PENDING",
  "PAID",
  "VOIDED",
]);

export const referralsTable = pgTable("referrals", {
  id: uuid("id").primaryKey().defaultRandom(),
  referrerId: uuid("referrer_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  referredUserId: uuid("referred_user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  // Legacy reference: the project this referral bonus paid out on. Projects
  // were archived in the Jobs pivot; the raw id stays so the money trail
  // remains readable, but it is no longer a foreign key.
  projectId: uuid("project_id"),
  status: referralStatusEnum("status").default("PENDING").notNull(),
  rewardAmount: real("reward_amount").default(500).notNull(),
  zeroCommissionApplied: boolean("zero_commission_applied")
    .default(false)
    .notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Referral = typeof referralsTable.$inferSelect;
