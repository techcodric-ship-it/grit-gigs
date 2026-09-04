import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { ordersTable } from "./orders";
import { barterMatchesTable } from "./barter";
import { projectBidsTable } from "./projects";
import { squadsTable } from "./squads";
import { squadOrdersTable } from "./squads";

export const conversationsTable = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  user1Id: uuid("user1_id")
    .notNull()
    .references(() => usersTable.id),
  user2Id: uuid("user2_id")
    .notNull()
    .references(() => usersTable.id),
  isGroup: boolean("is_group").default(false).notNull(),
  groupName: text("group_name"),
  groupId: uuid("group_id").references(() => squadsTable.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").unique().references(() => ordersTable.id),
  squadOrderId: uuid("squad_order_id").unique().references(() => squadOrdersTable.id, { onDelete: "cascade" }),
  matchId: uuid("match_id").unique().references(() => barterMatchesTable.id),
  projectBidId: uuid("project_bid_id").references(() => projectBidsTable.id),
  lastMessageAt: timestamp("last_message_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const conversationParticipantsTable = pgTable("conversation_participants", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversationsTable.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
});

export const messagesTable = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversationsTable.id, { onDelete: "cascade" }),
  senderId: uuid("sender_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  messageText: text("message_text").notNull(),
  attachments: jsonb("attachments").default([]).notNull(),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Conversation = typeof conversationsTable.$inferSelect;
export type Message = typeof messagesTable.$inferSelect;
export type ConversationParticipant = typeof conversationParticipantsTable.$inferSelect;
