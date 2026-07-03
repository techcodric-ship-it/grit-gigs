import {
  pgTable,
  pgEnum,
  text,
  boolean,
  integer,
  timestamp,
  uuid,
  numeric,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const projectStatusEnum = pgEnum("project_status", [
  "OPEN",
  "IN_PROGRESS",
  "DELIVERED",
  "REVISION_REQUESTED",
  "COMPLETED",
  "CANCELLED",
]);

export const bidStatusEnum = pgEnum("bid_status", [
  "PENDING",
  "ACCEPTED",
  "REJECTED",
]);

export const projectsTable = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  skills: text("skills"),
  budgetMin: integer("budget_min"),
  budgetMax: integer("budget_max"),
  deadline: timestamp("deadline"),
  imageUrl: text("image_url"),
  status: projectStatusEnum("status").default("OPEN").notNull(),
  acceptedBidId: uuid("accepted_bid_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const projectBidsTable = pgTable("project_bids", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  amount: integer("amount").notNull(),
  proposal: text("proposal").notNull(),
  deliveryDays: integer("delivery_days"),
  status: bidStatusEnum("status").default("PENDING").notNull(),
  isHighlighted: boolean("is_highlighted").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const projectDeliveriesTable = pgTable("project_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  deliveryNote: text("delivery_note"),
  link: text("link"),
  revisionNumber: integer("revision_number").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Project = typeof projectsTable.$inferSelect;
export type ProjectBid = typeof projectBidsTable.$inferSelect;
export type ProjectDelivery = typeof projectDeliveriesTable.$inferSelect;
