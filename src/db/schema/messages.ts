import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { ordersTable } from "./orders";
import { barterMatchesTable } from "./barter";
import { projectBidsTable } from "./projects";

export const conversationsTable = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  user1Id: uuid("user1_id")
    .notNull()
    .references(() => usersTable.id),
  user2Id: uuid("user2_id")
    .notNull()
    .references(() => usersTable.id),
  orderId: uuid("order_id").unique().references(() => ordersTable.id),
  matchId: uuid("match_id").unique().references(() => barterMatchesTable.id),
  projectBidId: uuid("project_bid_id").references(() => projectBidsTable.id),
  lastMessageAt: timestamp("last_message_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const messagesTable = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversationsTable.id),
  senderId: uuid("sender_id")
    .notNull()
    .references(() => usersTable.id),
  messageText: text("message_text").notNull(),
  attachments: jsonb("attachments").default([]).notNull(),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Conversation = typeof conversationsTable.$inferSelect;
export type Message = typeof messagesTable.$inferSelect;
