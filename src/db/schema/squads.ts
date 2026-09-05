import { pgTable, pgEnum, text, boolean, integer, real, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { orderStatusEnum } from "./orders";
import { projectsTable } from "./projects";

export const squadRoleEnum = pgEnum("squad_role", ["LEADER", "MEMBER"]);
export const squadInviteStatusEnum = pgEnum("squad_invite_status", ["PENDING", "ACCEPTED", "DECLINED"]);
export const squadServiceStatusEnum = pgEnum("squad_service_status", ["ACTIVE", "PAUSED", "DELETED"]);
export const squadJoinRequestStatusEnum = pgEnum("squad_join_request_status", ["PENDING", "ACCEPTED", "DECLINED"]);

export const squadsTable = pgTable("squads", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  tagline: text("tagline"),
  category: text("category"),
  description: text("description"),
  avatar: text("avatar"),
  skills: text("skills").array().default([]).notNull(),
  leaderId: uuid("leader_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  isActive: boolean("is_active").default(true).notNull(),
  ratingAvg: real("rating_avg").default(0).notNull(),
  reviewCount: integer("review_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const squadMembersTable = pgTable("squad_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  squadId: uuid("squad_id")
    .notNull()
    .references(() => squadsTable.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  role: squadRoleEnum("role").default("MEMBER").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const squadInvitesTable = pgTable("squad_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  squadId: uuid("squad_id")
    .notNull()
    .references(() => squadsTable.id, { onDelete: "cascade" }),
  invitedEmail: text("invited_email").notNull(),
  invitedUserId: uuid("invited_user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  message: text("message"),
  status: squadInviteStatusEnum("status").default("PENDING").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  respondedAt: timestamp("responded_at"),
});

export const squadServicesTable = pgTable("squad_services", {
  id: uuid("id").primaryKey().defaultRandom(),
  squadId: uuid("squad_id")
    .notNull()
    .references(() => squadsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull(),
  category: text("category"),
  coverImage: text("cover_image"),
  priceInr: integer("price_inr").notNull(),
  deliveryDays: integer("delivery_days").default(7).notNull(),
  revisions: integer("revisions").default(2).notNull(),
  orderCount: integer("order_count").default(0).notNull(),
  skills: text("skills").array().default([]).notNull(),
  status: squadServiceStatusEnum("status").default("ACTIVE").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const squadOrdersTable = pgTable("squad_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  squadId: uuid("squad_id")
    .notNull()
    .references(() => squadsTable.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id")
    .notNull()
    .references(() => squadServicesTable.id, { onDelete: "cascade" }),
  buyerId: uuid("buyer_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  priceInr: integer("price_inr").notNull(),
  revisions: integer("revisions").default(2).notNull(),
  requirements: text("requirements"),
  status: orderStatusEnum("status").default("PENDING").notNull(),
  deliveryDate: timestamp("delivery_date"),
  completedAt: timestamp("completed_at"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const squadOrderDeliveriesTable = pgTable("squad_order_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => squadOrdersTable.id, { onDelete: "cascade" }),
  note: text("note"),
  link: text("link"),
  files: text("files").array().default([]).notNull(),
  revisionNumber: integer("revision_number").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const squadJoinRequestsTable = pgTable("squad_join_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  squadId: uuid("squad_id")
    .notNull()
    .references(() => squadsTable.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  status: squadJoinRequestStatusEnum("status").default("PENDING").notNull(),
  message: text("message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  respondedAt: timestamp("responded_at"),
});

export const squadReviewsTable = pgTable("squad_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  squadId: uuid("squad_id")
    .notNull()
    .references(() => squadsTable.id, { onDelete: "cascade" }),
  reviewerId: uuid("reviewer_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(),
  reviewText: text("review_text"),
  source: text("source").notNull(),
  projectId: uuid("project_id")
    .unique()
    .references(() => projectsTable.id, { onDelete: "set null" }),
  squadOrderId: uuid("squad_order_id")
    .unique()
    .references(() => squadOrdersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Squad = typeof squadsTable.$inferSelect;
export type SquadMember = typeof squadMembersTable.$inferSelect;
export type SquadInvite = typeof squadInvitesTable.$inferSelect;
export type SquadService = typeof squadServicesTable.$inferSelect;
export type SquadOrder = typeof squadOrdersTable.$inferSelect;
export type SquadOrderDelivery = typeof squadOrderDeliveriesTable.$inferSelect;
export type SquadJoinRequest = typeof squadJoinRequestsTable.$inferSelect;
export type SquadReview = typeof squadReviewsTable.$inferSelect;