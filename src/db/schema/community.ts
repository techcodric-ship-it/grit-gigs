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
]);

export const communityPostsTable = pgTable("community_posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  kind: postKindEnum("kind").default("POST").notNull(),
  content: text("content").notNull(),
  media: jsonb("media").$type<{ type: "image" | "embed"; url: string }[]>().default([]).notNull(),
  tags: text("tags").array().default([]).notNull(),
  // GIG / BARTER extras
  priceInr: integer("price_inr"),
  deliveryDays: integer("delivery_days"),
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

export type CommunityPost = typeof communityPostsTable.$inferSelect;
export type CommunityLike = typeof communityLikesTable.$inferSelect;
export type CommunityComment = typeof communityCommentsTable.$inferSelect;
export type CommunityFollow = typeof communityFollowsTable.$inferSelect;