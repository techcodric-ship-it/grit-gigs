import { pgTable, text, integer, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Interview Prep sessions. `source` is a provenance label: "ai_estimate" when
// a model scored the answer, "platform_checklist" for the offline fallback.
export const prepSessionsTable = pgTable("prep_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  track: varchar("track", { length: 40 }).notNull(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  feedback: text("feedback"),
  score: integer("score"),
  source: varchar("source", { length: 30 }).default("ai_estimate").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PrepSession = typeof prepSessionsTable.$inferSelect;
