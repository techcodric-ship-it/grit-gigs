import {
  pgTable,
  pgEnum,
  text,
  real,
  integer,
  timestamp,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { servicesTable, servicePackagesTable } from "./services";

export const orderStatusEnum = pgEnum("order_status", [
  "PENDING",
  "ACCEPTED",
  "IN_PROGRESS",
  "DELIVERED",
  "REVISION_REQUESTED",
  "COMPLETED",
  "CANCELLED",
  "DISPUTED",
]);

export const ordersTable = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceId: uuid("service_id")
    .notNull()
    .references(() => servicesTable.id),
  packageId: uuid("package_id")
    .notNull()
    .references(() => servicePackagesTable.id),
  buyerId: uuid("buyer_id")
    .notNull()
    .references(() => usersTable.id),
  sellerId: uuid("seller_id")
    .notNull()
    .references(() => usersTable.id),
  priceInr: real("price_inr").notNull(),
  requirements: jsonb("requirements"),
  status: orderStatusEnum("status").default("PENDING").notNull(),
  deliveryDate: timestamp("delivery_date"),
  completedAt: timestamp("completed_at"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const orderDeliveriesTable = pgTable("order_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => ordersTable.id),
  files: text("files").array().default([]).notNull(),
  message: text("message"),
  revisionNumber: integer("revision_number").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const reviewsTable = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  reviewerId: uuid("reviewer_id")
    .notNull()
    .references(() => usersTable.id),
  revieweeId: uuid("reviewee_id")
    .notNull()
    .references(() => usersTable.id),
  type: text("type").notNull(),
  serviceId: uuid("service_id").references(() => servicesTable.id),
  orderId: uuid("order_id").unique().references(() => ordersTable.id),
  barterMatchId: uuid("barter_match_id"),
  rating: integer("rating").notNull(),
  reviewText: text("review_text"),
  sellerResponse: text("seller_response"),
  helpfulCount: integer("helpful_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Order = typeof ordersTable.$inferSelect;
export type OrderDelivery = typeof orderDeliveriesTable.$inferSelect;
export type Review = typeof reviewsTable.$inferSelect;
