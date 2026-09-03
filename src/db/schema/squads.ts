import { pgTable, pgEnum, text, boolean, integer, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

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
  skills: text("skills").array().default([]).notNull(),
  status: squadServiceStatusEnum("status").default("ACTIVE").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
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

export type Squad = typeof squadsTable.$inferSelect;
export type SquadMember = typeof squadMembersTable.$inferSelect;
export type SquadInvite = typeof squadInvitesTable.$inferSelect;
export type SquadService = typeof squadServicesTable.$inferSelect;
export type SquadJoinRequest = typeof squadJoinRequestsTable.$inferSelect;