import {
  pgTable,
  pgEnum,
  text,
  boolean,
  integer,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const barterStatusEnum = pgEnum("barter_status", [
  "ACTIVE",
  "MATCHED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
]);

export const matchStatusEnum = pgEnum("match_status", [
  "PENDING",
  "ACCEPTED",
  "IN_PROGRESS",
  "DELIVERED",
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
]);

export const barterRequestsTable = pgTable("barter_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  skillOffered: text("skill_offered").notNull(),
  skillNeeded: text("skill_needed").notNull(),
  offerCategory: text("offer_category"),
  needCategory: text("need_category"),
  description: text("description"),
  timeline: text("timeline").default("Flexible").notNull(),
  city: text("city"),
  isRemote: boolean("is_remote").default(true).notNull(),
  imageUrl: text("image_url"),
  status: barterStatusEnum("status").default("ACTIVE").notNull(),
  viewCount: integer("view_count").default(0).notNull(),
  isPaused: boolean("is_paused").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const barterMatchesTable = pgTable("barter_matches", {
  id: uuid("id").primaryKey().defaultRandom(),
  request1Id: uuid("request1_id")
    .notNull()
    .references(() => barterRequestsTable.id),
  request2Id: uuid("request2_id")
    .notNull()
    .references(() => barterRequestsTable.id),
  user1Id: uuid("user1_id")
    .notNull()
    .references(() => usersTable.id),
  user2Id: uuid("user2_id")
    .notNull()
    .references(() => usersTable.id),
  status: matchStatusEnum("status").default("PENDING").notNull(),
  confirmedByUser1: boolean("confirmed_by_user1").default(false).notNull(),
  confirmedByUser2: boolean("confirmed_by_user2").default(false).notNull(),
  deliveredByUser1: boolean("delivered_by_user1").default(false).notNull(),
  deliveredByUser2: boolean("delivered_by_user2").default(false).notNull(),
  acceptedByUser1: boolean("accepted_by_user1").default(false).notNull(),
  acceptedByUser2: boolean("accepted_by_user2").default(false).notNull(),
  revisedByUser1: boolean("revised_by_user1").default(false).notNull(),
  revisedByUser2: boolean("revised_by_user2").default(false).notNull(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const barterDeliveriesTable = pgTable("barter_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  matchId: uuid("match_id")
    .notNull()
    .references(() => barterMatchesTable.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  deliveryNote: text("delivery_note"),
  link: text("link"),
  revisionNumber: integer("revision_number").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type BarterRequest = typeof barterRequestsTable.$inferSelect;
export type BarterMatch = typeof barterMatchesTable.$inferSelect;
export type BarterDelivery = typeof barterDeliveriesTable.$inferSelect;
