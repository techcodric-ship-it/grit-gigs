import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, sql, isNull } from "drizzle-orm";
import {
  db,
  usersTable,
  focusRoomsTable,
  focusRoomParticipantsTable,
  focusRoomMessagesTable,
} from "../db";
import { authenticate, optionalAuth } from "../middlewares/authenticate";

const router: IRouter = Router();

const MODES = ["STUDY", "WORK"] as const;
type Mode = (typeof MODES)[number];

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function roomJson(
  room: typeof focusRoomsTable.$inferSelect,
  host: { id: string; firstName: string; lastName: string | null; profilePhoto: string | null } | null,
  extras: Record<string, unknown> = {},
) {
  const cycle = room.focusMinutes + room.breakMinutes;
  const elapsed = room.timerElapsedSeconds + (room.timerRunning ? Math.floor((Date.now() - new Date(room.timerStartedAt).getTime()) / 1000) : 0);
  const position = cycle > 0 ? elapsed % cycle : 0;
  const inBreak = room.breakMinutes > 0 && position >= room.focusMinutes;
  return {
    id: room.id,
    hostId: room.hostId,
    title: room.title,
    mode: room.mode,
    goal: room.goal ?? null,
    topic: room.topic ?? null,
    coverUrl: room.coverUrl ?? null,
    isPrivate: room.isPrivate,
    isCameraSuggested: room.isCameraSuggested,
    focusMinutes: room.focusMinutes,
    breakMinutes: room.breakMinutes,
    maxParticipants: room.maxParticipants,
    status: room.status,
    focusSeconds: room.timerElapsedSeconds,
    timerRunning: room.timerRunning,
    phase: room.timerRunning ? (inBreak ? "BREAK" : "FOCUS") : "PAUSED",
    phaseEndsInSeconds: room.timerRunning ? (inBreak ? cycle - position : room.focusMinutes - position) : 0,
    startedAt: room.startedAt,
    endedAt: room.endedAt ?? null,
    createdAt: room.createdAt,
    host,
    ...extras,
  };
}

async function participantsFor(roomId: string) {
  return db
    .select({
      userId: focusRoomParticipantsTable.userId,
      isHost: focusRoomParticipantsTable.isHost,
      cameraOn: focusRoomParticipantsTable.cameraOn,
      focusSeconds: focusRoomParticipantsTable.focusSeconds,
      joinedAt: focusRoomParticipantsTable.joinedAt,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      profilePhoto: usersTable.profilePhoto,
    })
    .from(focusRoomParticipantsTable)
    .innerJoin(usersTable, eq(focusRoomParticipantsTable.userId, usersTable.id))
    .where(and(eq(focusRoomParticipantsTable.roomId, roomId), isNull(focusRoomParticipantsTable.leftAt)))
    .orderBy(desc(focusRoomParticipantsTable.isHost), focusRoomParticipantsTable.joinedAt);
}

// ── Create a Focus Room ────────────────────────────────────────────────
router.post("/focus/rooms", authenticate, async (req: Request, res: Response): Promise<void> => {
  const hostId = req.user!.id;
  const { title, mode, goal, topic, coverUrl, isPrivate, isCameraSuggested, focusMinutes, breakMinutes, maxParticipants } = req.body || {};

  if (!title || !String(title).trim()) {
    res.status(400).json({ success: false, message: "Give your room a title" });
    return;
  }
  const cleanMode: Mode = MODES.includes(String(mode).toUpperCase() as Mode) ? (String(mode).toUpperCase() as Mode) : "STUDY";

  const [room] = await db
    .insert(focusRoomsTable)
    .values({
      hostId,
      title: String(title).trim().slice(0, 90),
      mode: cleanMode,
      goal: goal ? String(goal).trim().slice(0, 200) : null,
      topic: topic ? String(topic).trim().slice(0, 60) : null,
      coverUrl: coverUrl ? String(coverUrl).trim().slice(0, 500) : null,
      isPrivate: Boolean(isPrivate),
      isCameraSuggested: Boolean(isCameraSuggested),
      focusMinutes: clampInt(focusMinutes, 1, 120, cleanMode === "WORK" ? 50 : 25),
      breakMinutes: clampInt(breakMinutes, 0, 60, cleanMode === "WORK" ? 10 : 5),
      maxParticipants: clampInt(maxParticipants, 2, 12, 6),
    })
    .returning();

  await db.insert(focusRoomParticipantsTable).values({ roomId: room.id, userId: hostId, isHost: true });

  const host = { id: req.user!.id, firstName: req.user!.firstName, lastName: req.user!.lastName, profilePhoto: req.user!.profilePhoto };
  res.status(201).json({
    success: true,
    message: "Room is live",
    data: { room: roomJson(room, host, { participantCount: 1, participants: [] }) },
  });
});

// ── List live rooms (optional ?mode=STUDY|WORK) ────────────────────────
router.get("/focus/rooms", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const modeFilter = String(req.query.mode || "").toUpperCase();
  const conditions = [eq(focusRoomsTable.status, "LIVE")];
  if (MODES.includes(modeFilter as Mode)) conditions.push(eq(focusRoomsTable.mode, modeFilter as Mode));

  const rows = await db
    .select({
      room: focusRoomsTable,
      host: { id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto },
      participantCount: sql<number>`(SELECT count(*) FROM ${focusRoomParticipantsTable} WHERE ${focusRoomParticipantsTable.roomId} = ${focusRoomsTable.id} AND ${focusRoomParticipantsTable.leftAt} IS NULL)`,
    })
    .from(focusRoomsTable)
    .leftJoin(usersTable, eq(focusRoomsTable.hostId, usersTable.id))
    .where(and(...conditions))
    .orderBy(desc(focusRoomsTable.createdAt))
    .limit(60);

  res.json({
    success: true,
    data: rows.map((r) =>
      roomJson(r.room, r.host ? { ...r.host, lastName: r.host.lastName ?? null, profilePhoto: r.host.profilePhoto ?? null } : null, {
        participantCount: Number(r.participantCount),
      }),
    ),
  });
});

// ── Room detail (+ participants, recent chat) ─────────────────────────
router.get("/focus/rooms/:id", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const roomId = String(req.params.id);
  const [row] = await db
    .select({ room: focusRoomsTable, host: { id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto } })
    .from(focusRoomsTable)
    .leftJoin(usersTable, eq(focusRoomsTable.hostId, usersTable.id))
    .where(eq(focusRoomsTable.id, roomId))
    .limit(1);

  if (!row) {
    res.status(404).json({ success: false, message: "Room not found" });
    return;
  }

  const participants = await participantsFor(roomId);
  const messages = await db
    .select({
      id: focusRoomMessagesTable.id,
      userId: focusRoomMessagesTable.userId,
      content: focusRoomMessagesTable.content,
      createdAt: focusRoomMessagesTable.createdAt,
      firstName: usersTable.firstName,
      profilePhoto: usersTable.profilePhoto,
    })
    .from(focusRoomMessagesTable)
    .innerJoin(usersTable, eq(focusRoomMessagesTable.userId, usersTable.id))
    .where(eq(focusRoomMessagesTable.roomId, roomId))
    .orderBy(desc(focusRoomMessagesTable.createdAt))
    .limit(50);

  res.json({
    success: true,
    data: {
      room: roomJson(row.room, row.host ? { ...row.host, lastName: row.host.lastName ?? null, profilePhoto: row.host.profilePhoto ?? null } : null, {
        participantCount: participants.length,
      }),
      participants,
      messages: messages.reverse(),
      isHost: req.user?.id === row.room.hostId,
    },
  });
});

// ── Join a room ────────────────────────────────────────────────────────
router.post("/focus/rooms/:id/join", authenticate, async (req: Request, res: Response): Promise<void> => {
  const roomId = String(req.params.id);
  const userId = req.user!.id;

  const [room] = await db.select().from(focusRoomsTable).where(eq(focusRoomsTable.id, roomId)).limit(1);
  if (!room) {
    res.status(404).json({ success: false, message: "Room not found" });
    return;
  }
  if (room.status !== "LIVE") {
    res.status(400).json({ success: false, message: "This room has ended" });
    return;
  }

  const active = await participantsFor(roomId);
  const alreadyIn = active.some((p) => p.userId === userId);
  if (!alreadyIn && active.length >= room.maxParticipants) {
    res.status(403).json({ success: false, message: "This room is full" });
    return;
  }

  const [existing] = await db
    .select()
    .from(focusRoomParticipantsTable)
    .where(and(eq(focusRoomParticipantsTable.roomId, roomId), eq(focusRoomParticipantsTable.userId, userId)))
    .limit(1);

  if (existing) {
    await db
      .update(focusRoomParticipantsTable)
      .set({ leftAt: null, joinedAt: new Date(), lastSeenAt: new Date() })
      .where(eq(focusRoomParticipantsTable.id, existing.id));
  } else {
    await db.insert(focusRoomParticipantsTable).values({ roomId, userId, isHost: room.hostId === userId });
  }

  const peak = Math.max(room.peakParticipants, active.length + (alreadyIn ? 0 : 1));
  if (peak !== room.peakParticipants) {
    await db.update(focusRoomsTable).set({ peakParticipants: peak }).where(eq(focusRoomsTable.id, roomId));
  }

  res.json({ success: true, message: "Joined", data: { roomId } });
});

// ── Leave a room (accumulates focus time) ─────────────────────────────
router.post("/focus/rooms/:id/leave", authenticate, async (req: Request, res: Response): Promise<void> => {
  const roomId = String(req.params.id);
  const userId = req.user!.id;
  const [existing] = await db
    .select()
    .from(focusRoomParticipantsTable)
    .where(and(eq(focusRoomParticipantsTable.roomId, roomId), eq(focusRoomParticipantsTable.userId, userId)))
    .limit(1);
  if (existing && !existing.leftAt) {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(existing.joinedAt).getTime()) / 1000));
    await db
      .update(focusRoomParticipantsTable)
      .set({ leftAt: new Date(), cameraOn: false, focusSeconds: existing.focusSeconds + seconds })
      .where(eq(focusRoomParticipantsTable.id, existing.id));
  }
  res.json({ success: true, message: "Left" });
});

// ── End a room (host only) ─────────────────────────────────────────────
router.post("/focus/rooms/:id/end", authenticate, async (req: Request, res: Response): Promise<void> => {
  const roomId = String(req.params.id);
  const [room] = await db.select().from(focusRoomsTable).where(eq(focusRoomsTable.id, roomId)).limit(1);
  if (!room) {
    res.status(404).json({ success: false, message: "Room not found" });
    return;
  }
  if (room.hostId !== req.user!.id) {
    res.status(403).json({ success: false, message: "Only the host can end this room" });
    return;
  }
  await db
    .update(focusRoomsTable)
    .set({ status: "ENDED", endedAt: new Date(), timerRunning: false, updatedAt: new Date() })
    .where(eq(focusRoomsTable.id, roomId));
  await db
    .update(focusRoomParticipantsTable)
    .set({ leftAt: new Date(), cameraOn: false })
    .where(and(eq(focusRoomParticipantsTable.roomId, roomId), isNull(focusRoomParticipantsTable.leftAt)));

  try {
    req.app?.get("io")?.to(`focus:${roomId}`).emit("focus:ended", { roomId });
  } catch {}
  res.json({ success: true, message: "Room ended" });
});

// ── Shared timer control (host only) ──────────────────────────────────
router.post("/focus/rooms/:id/timer", authenticate, async (req: Request, res: Response): Promise<void> => {
  const roomId = String(req.params.id);
  const action = String((req.body || {}).action || "").toUpperCase();
  const [room] = await db.select().from(focusRoomsTable).where(eq(focusRoomsTable.id, roomId)).limit(1);
  if (!room) {
    res.status(404).json({ success: false, message: "Room not found" });
    return;
  }
  if (room.hostId !== req.user!.id) {
    res.status(403).json({ success: false, message: "Only the host controls the timer" });
    return;
  }

  const now = Date.now();
  const runningElapsed = room.timerRunning ? Math.floor((now - new Date(room.timerStartedAt).getTime()) / 1000) : 0;
  let elapsed = room.timerElapsedSeconds + runningElapsed;
  let running = room.timerRunning;

  if (action === "PAUSE") {
    running = false;
  } else if (action === "START" || action === "RESUME") {
    running = true;
  } else if (action === "RESET") {
    elapsed = 0;
    running = true;
  } else {
    res.status(400).json({ success: false, message: "action must be START, PAUSE or RESET" });
    return;
  }

  const [updated] = await db
    .update(focusRoomsTable)
    .set({ timerElapsedSeconds: elapsed, timerRunning: running, timerStartedAt: new Date(), updatedAt: new Date() })
    .where(eq(focusRoomsTable.id, roomId))
    .returning();

  const payload = {
    roomId,
    elapsedSeconds: updated.timerElapsedSeconds,
    running: updated.timerRunning,
    startedAt: updated.timerStartedAt,
    focusMinutes: updated.focusMinutes,
    breakMinutes: updated.breakMinutes,
  };
  try {
    req.app?.get("io")?.to(`focus:${roomId}`).emit("focus:timer", payload);
  } catch {}

  const [host] = await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto })
    .from(usersTable)
    .where(eq(usersTable.id, room.hostId))
    .limit(1);
  res.json({ success: true, message: "Timer updated", data: { room: roomJson(updated, host ? { ...host, lastName: host.lastName ?? null, profilePhoto: host.profilePhoto ?? null } : null) } });
});

// ── Chat history ───────────────────────────────────────────────────────
router.get("/focus/rooms/:id/messages", optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const roomId = String(req.params.id);
  const messages = await db
    .select({
      id: focusRoomMessagesTable.id,
      userId: focusRoomMessagesTable.userId,
      content: focusRoomMessagesTable.content,
      createdAt: focusRoomMessagesTable.createdAt,
      firstName: usersTable.firstName,
      profilePhoto: usersTable.profilePhoto,
    })
    .from(focusRoomMessagesTable)
    .innerJoin(usersTable, eq(focusRoomMessagesTable.userId, usersTable.id))
    .where(eq(focusRoomMessagesTable.roomId, roomId))
    .orderBy(desc(focusRoomMessagesTable.createdAt))
    .limit(80);
  res.json({ success: true, data: messages.reverse() });
});

// ── My focus stats (today + streak) ────────────────────────────────────
router.get("/focus/stats/me", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const rows = await db
    .select({ focusSeconds: focusRoomParticipantsTable.focusSeconds, joinedAt: focusRoomParticipantsTable.joinedAt, leftAt: focusRoomParticipantsTable.leftAt })
    .from(focusRoomParticipantsTable)
    .where(eq(focusRoomParticipantsTable.userId, userId));

  let totalSeconds = 0;
  let todaySeconds = 0;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  for (const r of rows) {
    const live = r.focusSeconds + (r.leftAt ? 0 : Math.max(0, Math.floor((Date.now() - new Date(r.joinedAt).getTime()) / 1000)));
    totalSeconds += live;
    if (new Date(r.joinedAt) >= startOfToday) todaySeconds += live;
  }

  res.json({
    success: true,
    data: {
      todayMinutes: Math.floor(todaySeconds / 60),
      totalMinutes: Math.floor(totalSeconds / 60),
      sessions: rows.length,
    },
  });
});

export default router;
