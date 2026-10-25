import {
  pgTable,
  pgEnum,
  text,
  boolean,
  integer,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// STUDY = calm co-studying rooms, WORK = energetic co-working rooms.
export const focusRoomModeEnum = pgEnum("focus_room_mode", ["STUDY", "WORK"]);
export const focusRoomStatusEnum = pgEnum("focus_room_status", ["LIVE", "ENDED"]);

export const focusRoomsTable = pgTable("focus_rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  mode: focusRoomModeEnum("mode").default("STUDY").notNull(),
  // Short "what we're doing right now" line (e.g. "DSA practice", "Editing reels").
  goal: text("goal"),
  // Subject / project tag shown on the card.
  topic: text("topic"),
  coverUrl: text("cover_url"),
  isPrivate: boolean("is_private").default(false).notNull(),
  isCameraSuggested: boolean("is_camera_suggested").default(false).notNull(),
  // Shared Pomodoro cycle.
  focusMinutes: integer("focus_minutes").default(25).notNull(),
  breakMinutes: integer("break_minutes").default(5).notNull(),
  maxParticipants: integer("max_participants").default(6).notNull(),
  status: focusRoomStatusEnum("status").default("LIVE").notNull(),
  // ── Shared timer state ──────────────────────────────────────────────
  // Effective elapsed = timerElapsedSeconds + (timerRunning ? now - timerStartedAt : 0)
  timerElapsedSeconds: integer("timer_elapsed_seconds").default(0).notNull(),
  timerRunning: boolean("timer_running").default(true).notNull(),
  timerStartedAt: timestamp("timer_started_at").defaultNow().notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
  peakParticipants: integer("peak_participants").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const focusRoomParticipantsTable = pgTable(
  "focus_room_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => focusRoomsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    isHost: boolean("is_host").default(false).notNull(),
    cameraOn: boolean("camera_on").default(false).notNull(),
    // Accumulated focused seconds across all visits to this room.
    focusSeconds: integer("focus_seconds").default(0).notNull(),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
    leftAt: timestamp("left_at"),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  },
  (t) => ({
    roomUserUnique: {
      name: "focus_room_participants_room_user_unique",
      columns: [t.roomId, t.userId],
      type: "unique" as const,
    },
  }),
);

export const focusRoomMessagesTable = pgTable("focus_room_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  roomId: uuid("room_id")
    .notNull()
    .references(() => focusRoomsTable.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type FocusRoom = typeof focusRoomsTable.$inferSelect;
export type FocusRoomParticipant = typeof focusRoomParticipantsTable.$inferSelect;
export type FocusRoomMessage = typeof focusRoomMessagesTable.$inferSelect;
