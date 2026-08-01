import { pgTable, text, integer, boolean, jsonb, timestamp, uuid } from "drizzle-orm/pg-core";

// ── Lead magnet: free Rate & Budget Calculator leads ──────────────────────
// Captures emails from people who use the free tool so we can follow up
// with helpful content and eventually convert them into platform users.
export const toolLeadsTable = pgTable("tool_leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  firstName: text("first_name"),
  role: text("role").notNull(), // 'freelancer' | 'client'
  service: text("service").notNull(),
  experience: text("experience"),
  hours: integer("hours"),
  result: jsonb("result").default({}),
  followupStage: integer("followup_stage").default(0).notNull(),
  nextFollowupAt: timestamp("next_followup_at"),
  unsubscribed: boolean("unsubscribed").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type ToolLead = typeof toolLeadsTable.$inferSelect;
