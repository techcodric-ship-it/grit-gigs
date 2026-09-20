import { pgTable, text, timestamp, integer, uuid } from "drizzle-orm/pg-core";

// ── Launch waitlist ────────────────────────────────────────────────────────
// Captures emails from people eager for the community-platform rebuild so we
// can notify them the moment it opens and seed the launch with early users.
export const waitlistLeadsTable = pgTable("waitlist_leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  firstName: text("first_name"),
  position: integer("position"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type WaitlistLead = typeof waitlistLeadsTable.$inferSelect;