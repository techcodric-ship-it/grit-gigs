import {
  pgTable,
  pgEnum,
  text,
  boolean,
  integer,
  timestamp,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const postKindEnum = pgEnum("post_kind", [
  "POST",
  "GIG",
  "BARTER",
  "WIN",
  "TIPS",
  "REEL",
  "PROJECT",
]);

export const communityPostsTable = pgTable("community_posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  kind: postKindEnum("kind").default("POST").notNull(),
  content: text("content").notNull(),
  media: jsonb("media").$type<{ type: "image" | "video" | "embed"; url: string }[]>().default([]).notNull(),
  coverUrl: text("cover_url"),
  tags: text("tags").array().default([]).notNull(),
  // GIG / BARTER / PROJECT extras
  priceInr: integer("price_inr"),
  priceMaxInr: integer("price_max_inr"),
  deliveryDays: integer("delivery_days"),
  revisions: integer("revisions").default(0).notNull(),
  wantInr: integer("want_inr"),
  wantText: text("want_text"),
  location: text("location"),
  isRemote: boolean("is_remote").default(true).notNull(),
  status: text("status").default("ACTIVE").notNull(), // ACTIVE | CLOSED | SOLD
  likeCount: integer("like_count").default(0).notNull(),
  commentCount: integer("comment_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const communityLikesTable = pgTable(
  "community_likes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => communityPostsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    postUserUnique: { name: "community_likes_post_user_unique", columns: [t.postId, t.userId], type: "unique" as const },
  }),
);

export const communityCommentsTable = pgTable("community_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  postId: uuid("post_id")
    .notNull()
    .references(() => communityPostsTable.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const communityFollowsTable = pgTable(
  "community_follows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    followerId: uuid("follower_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    followingId: uuid("following_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    followUnique: { name: "community_follows_unique", columns: [t.followerId, t.followingId], type: "unique" as const },
  }),
);

export const communityOrderStatusEnum = pgEnum("community_order_status", [
  "PENDING",
  "IN_PROGRESS",
  "DELIVERED",
  "REVISION",
  "COMPLETED",
  "CANCELLED",
]);

export const communityOrderKindEnum = pgEnum("community_order_kind", ["GIG", "PROJECT", "BARTER"]);

export const communityOrdersTable = pgTable("community_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  postId: uuid("post_id")
    .notNull()
    .references(() => communityPostsTable.id, { onDelete: "cascade" }),
  buyerId: uuid("buyer_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  sellerId: uuid("seller_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  kind: communityOrderKindEnum("kind").notNull(),
  status: communityOrderStatusEnum("status").default("PENDING").notNull(),
  requirements: text("requirements").notNull(),
  amount: integer("amount"),
  revisionsUsed: integer("revisions_used").default(0).notNull(),
  shippingNote: text("shipping_note"),
  deliveredAt: timestamp("delivered_at"),
  completedAt: timestamp("completed_at"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const communityOrderDeliveriesTable = pgTable("community_order_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => communityOrdersTable.id, { onDelete: "cascade" }),
  senderId: uuid("sender_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  note: text("note"),
  files: jsonb("files").$type<{ name?: string; url: string; type?: string }[]>().default([]).notNull(),
  isRevision: boolean("is_revision").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const communityQuotasTable = pgTable("community_quotas", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  gigPostsUsed: integer("gig_posts_used").default(0).notNull(),
  gigPostsBonus: integer("gig_posts_bonus").default(0).notNull(),
  proposalsUsed: integer("proposals_used").default(0).notNull(),
  proposalsBonus: integer("proposals_bonus").default(0).notNull(),
  resetAt: timestamp("reset_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type CommunityPost = typeof communityPostsTable.$inferSelect;
export type CommunityLike = typeof communityLikesTable.$inferSelect;
export type CommunityComment = typeof communityCommentsTable.$inferSelect;
export type CommunityFollow = typeof communityFollowsTable.$inferSelect;
export type CommunityOrder = typeof communityOrdersTable.$inferSelect;
export type CommunityOrderDelivery = typeof communityOrderDeliveriesTable.$inferSelect;