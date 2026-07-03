import {
  pgTable,
  pgEnum,
  text,
  varchar,
  integer,
  real,
  boolean,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { projectsTable, projectBidsTable } from "./projects";
import { ordersTable } from "./orders";
import { barterRequestsTable } from "./barter";

// ── Saved / bookmarked gigs, projects & barters ────────────────────────────
export const savedItemTypeEnum = pgEnum("saved_item_type", ["SERVICE", "PROJECT", "BARTER"]);

export const savedItemsTable = pgTable("saved_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  itemType: savedItemTypeEnum("item_type").notNull(),
  itemId: uuid("item_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Direct project invites (client invites a specific freelancer to bid) ──
export const inviteStatusEnum = pgEnum("invite_status", ["PENDING", "ACCEPTED", "DECLINED"]);

export const projectInvitesTable = pgTable("project_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  freelancerId: uuid("freelancer_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  message: text("message"),
  status: inviteStatusEnum("status").default("PENDING").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Project milestones (split a project's accepted bid into paid stages) ──
export const milestoneStatusEnum = pgEnum("milestone_status", [
  "PENDING",
  "IN_PROGRESS",
  "DELIVERED",
  "APPROVED",
]);

export const projectMilestonesTable = pgTable("project_milestones", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  bidId: uuid("bid_id").notNull().references(() => projectBidsTable.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 200 }).notNull(),
  amount: real("amount").notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  status: milestoneStatusEnum("status").default("PENDING").notNull(),
  deliveryNote: text("delivery_note"),
  deliveredAt: timestamp("delivered_at"),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Disputes (orders, projects or barter) ──────────────────────────────────
export const disputeStatusEnum = pgEnum("dispute_status", ["OPEN", "UNDER_REVIEW", "RESOLVED_BUYER", "RESOLVED_SELLER", "CLOSED"]);
export const disputeTargetEnum = pgEnum("dispute_target", ["ORDER", "PROJECT", "BARTER"]);

export const disputesTable = pgTable("disputes", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetType: disputeTargetEnum("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  raisedById: uuid("raised_by_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  status: disputeStatusEnum("status").default("OPEN").notNull(),
  adminNotes: text("admin_notes"),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Generic invites (project, gig/service, barter) ─────────────────────────
export const inviteTargetTypeEnum = pgEnum("invite_target_type", ["PROJECT", "SERVICE", "BARTER"]);

export const invitesTable = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetType: inviteTargetTypeEnum("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  fromUserId: uuid("from_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  toUserId: uuid("to_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  message: text("message"),
  status: inviteStatusEnum("status").default("PENDING").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Reports (flag users, gigs, barters, projects) ─────────────────────────
export const reportTargetTypeEnum = pgEnum("report_target_type", ["USER", "SERVICE", "BARTER", "PROJECT"]);
export const reportStatusEnum = pgEnum("report_status", ["OPEN", "RESOLVED", "DISMISSED"]);

export const reportsTable = pgTable("reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetType: reportTargetTypeEnum("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  reportedById: uuid("reported_by_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  status: reportStatusEnum("status").default("OPEN").notNull(),
  adminNotes: text("admin_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── KYC document verification ──────────────────────────────────────────────
export const kycStatusEnum = pgEnum("kyc_status", ["PENDING", "APPROVED", "REJECTED"]);

export const kycDocumentsTable = pgTable("kyc_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().unique().references(() => usersTable.id, { onDelete: "cascade" }),
  docType: text("document_type").notNull(),
  fileUrl: text("document_url").notNull(),
  status: kycStatusEnum("status").default("PENDING").notNull(),
  reviewNotes: text("notes"),
  submittedAt: timestamp("created_at").defaultNow().notNull(),
  reviewedAt: timestamp("reviewed_at"),
});

// ── Saved searches (job alerts, checked in-app — no email service exists
// in this project, so "alerts" surface as a notification next time the
// user visits rather than an email) ────────────────────────────────────────
export const savedSearchesTable = pgTable("saved_searches", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  label: varchar("label", { length: 100 }).notNull(),
  category: varchar("category", { length: 100 }),
  q: varchar("q", { length: 200 }),
  budgetMin: integer("budget_min"),
  lastSeenCount: integer("last_seen_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type SavedItem = typeof savedItemsTable.$inferSelect;
export type ProjectInvite = typeof projectInvitesTable.$inferSelect;
export type ProjectMilestone = typeof projectMilestonesTable.$inferSelect;
export type Dispute = typeof disputesTable.$inferSelect;
export type KycDocument = typeof kycDocumentsTable.$inferSelect;
export type SavedSearch = typeof savedSearchesTable.$inferSelect;
