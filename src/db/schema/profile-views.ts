import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// One row per recorded profile view. viewer_id is null for signed-out visitors.
export const profileViewsTable = pgTable("profile_views", {
  id: uuid("id").primaryKey().defaultRandom(),
  viewerId: uuid("viewer_id").references(() => usersTable.id, { onDelete: "set null" }),
  viewedId: uuid("viewed_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ProfileView = typeof profileViewsTable.$inferSelect;
