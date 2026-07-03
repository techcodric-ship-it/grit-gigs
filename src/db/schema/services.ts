import {
  pgTable,
  pgEnum,
  text,
  real,
  integer,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const serviceStatusEnum = pgEnum("service_status", [
  "ACTIVE",
  "PAUSED",
  "DELETED",
  "PENDING_REVIEW",
]);

export const servicesTable = pgTable("services", {
  id: uuid("id").primaryKey().defaultRandom(),
  sellerId: uuid("seller_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  category: text("category").notNull(),
  subcategory: text("subcategory"),
  description: text("description").notNull(),
  images: text("images").array().default([]).notNull(),
  tags: text("tags").array().default([]).notNull(),
  status: serviceStatusEnum("status").default("ACTIVE").notNull(),
  viewCount: integer("view_count").default(0).notNull(),
  orderCount: integer("order_count").default(0).notNull(),
  ratingAvg: real("rating_avg").default(0).notNull(),
  reviewCount: integer("review_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const servicePackagesTable = pgTable("service_packages", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceId: uuid("service_id")
    .notNull()
    .references(() => servicesTable.id, { onDelete: "cascade" }),
  packageType: text("package_type").notNull(),
  priceInr: real("price_inr").notNull(),
  description: text("description").notNull(),
  deliveryDays: integer("delivery_days").notNull(),
  revisions: integer("revisions").default(2).notNull(),
  features: text("features").array().default([]).notNull(),
});

export type Service = typeof servicesTable.$inferSelect;
export type ServicePackage = typeof servicePackagesTable.$inferSelect;
