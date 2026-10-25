import type { Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { verifyAccessToken } from "./auth";
import { db, usersTable, conversationsTable, conversationParticipantsTable, messagesTable, notificationsTable, focusRoomsTable, focusRoomParticipantsTable, focusRoomMessagesTable } from "../db";
import { eq, and, ne, isNull } from "drizzle-orm";
import { logger } from "./logger";

export function setupSocket(httpServer: HttpServer): SocketServer {
  const io = new SocketServer(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : true, methods: ["GET", "POST"], credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const token =
        (socket.handshake.auth as Record<string, string>).token ??
        socket.handshake.headers.authorization?.split(" ")[1];
      if (!token) return next(new Error("Authentication required"));

      const decoded = verifyAccessToken(token);
      const [user] = await db
        .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, isActive: usersTable.isActive })
        .from(usersTable)
        .where(eq(usersTable.id, decoded.userId));

      if (!user?.isActive) return next(new Error("User not found or inactive"));
      (socket as unknown as { user: typeof user }).user = user;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  const onlineUsers = new Map<string, Set<string>>();
  (io as unknown as { onlineUsers: Map<string, Set<string>> }).onlineUsers = onlineUsers;

  // ── Focus Rooms live presence ─────────────────────────────────────────
  // roomId -> (socketId -> participant info)
  type FocusEntry = { userId: string; firstName: string; lastName: string; profilePhoto: string | null; cameraOn: boolean; joinedAt: number };
  const focusRooms = new Map<string, Map<string, FocusEntry>>();

  // Distinct participants (by userId) currently in a room.
  function focusPresence(roomId: string) {
    const seen = new Map<string, FocusEntry>();
    for (const entry of focusRooms.get(roomId)?.values() ?? []) {
      if (!seen.has(entry.userId)) seen.set(entry.userId, entry);
    }
    return [...seen.values()].map((e) => ({
      userId: e.userId,
      firstName: e.firstName,
      lastName: e.lastName,
      profilePhoto: e.profilePhoto,
      cameraOn: e.cameraOn,
    }));
  }

  function broadcastPresence(roomId: string) {
    io.to(`focus:${roomId}`).emit("focus:presence", { roomId, participants: focusPresence(roomId) });
  }

  // Accumulate focus time for a user leaving a focus room.
  async function closeFocusParticipation(roomId: string, userId: string) {
    try {
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
    } catch (err) {
      logger.error({ err, roomId, userId }, "focus: closeFocusParticipation error");
    }
  }

  io.on("connection", (socket) => {
    const sockWithUser = socket as unknown as { user: { id: string; firstName: string } };
    const userId = sockWithUser.user.id;

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId)!.add(socket.id);

    socket.join(`user:${userId}`);
    socket.broadcast.emit("user:online", { userId, firstName: sockWithUser.user.firstName });

    db.select({ count: notificationsTable.id })
      .from(notificationsTable)
      .where(and(eq(notificationsTable.userId, userId), eq(notificationsTable.isRead, false)))
      .then((rows) => socket.emit("notification:count", { count: rows.length }))
      .catch(() => {});

    socket.on("conversation:join", async ({ conversationId }: { conversationId: string }) => {
      const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
      if (!conv) { socket.emit("error", { message: "Access denied" }); return; }
      if (conv.isGroup) {
        const [part] = await db.select({ id: conversationParticipantsTable.id }).from(conversationParticipantsTable)
          .where(and(eq(conversationParticipantsTable.conversationId, conversationId), eq(conversationParticipantsTable.userId, userId)))
          .limit(1);
        if (!part) { socket.emit("error", { message: "Access denied" }); return; }
      } else if (conv.user1Id !== userId && conv.user2Id !== userId) {
        socket.emit("error", { message: "Access denied" });
        return;
      }
      socket.join(`conv:${conversationId}`);
      socket.emit("conversation:joined", { conversationId });
    });

    socket.on("conversation:leave", ({ conversationId }: { conversationId: string }) => {
      socket.leave(`conv:${conversationId}`);
    });

    socket.on("typing", ({ conversationId, isTyping }: { conversationId: string; isTyping?: boolean }) => {
      if (!conversationId) return;
      socket.to(`conv:${conversationId}`).emit("typing", {
        conversationId,
        userId,
        firstName: sockWithUser.user.firstName,
        isTyping: isTyping !== false,
      });
    });

    socket.on("message:send", async ({ conversationId, messageText }: { conversationId: string; messageText: string }) => {
      if (!messageText?.trim()) return;
      try {
        const contactPattern = /(?:\b\d{7,}\b)|(?:\+?\d{1,3}[-.\s]?\d{7,})|(?:[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
        const censoredText = messageText.trim().replace(contactPattern, "[hidden]");

        const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
        if (!conv) return;
        if (conv.isGroup) {
          const [part] = await db.select({ id: conversationParticipantsTable.id }).from(conversationParticipantsTable)
            .where(and(eq(conversationParticipantsTable.conversationId, conversationId), eq(conversationParticipantsTable.userId, userId)))
            .limit(1);
          if (!part) return;
        } else if (conv.user1Id !== userId && conv.user2Id !== userId) return;

        const [message] = await db
          .insert(messagesTable)
          .values({ conversationId, senderId: userId, messageText: censoredText })
          .returning();

        await db.update(conversationsTable).set({ lastMessageAt: new Date() }).where(eq(conversationsTable.id, conversationId));

        const recipientId = conv.isGroup ? null : (conv.user1Id === userId ? conv.user2Id : conv.user1Id);
        let otherParts: { userId: string }[] = [];
        if (conv.isGroup) {
          otherParts = await db
            .select({ userId: conversationParticipantsTable.userId })
            .from(conversationParticipantsTable)
            .where(and(eq(conversationParticipantsTable.conversationId, conversationId), ne(conversationParticipantsTable.userId, userId)));
          if (otherParts.length) {
            await db.insert(notificationsTable).values(otherParts.map(p => ({
              userId: p.userId,
              type: "NEW_MESSAGE",
              title: `${sockWithUser.user.firstName} in ${conv.groupName ?? "Circle"}`,
              message: censoredText.slice(0, 80),
              linkUrl: "/dashboard#inbox",
            })));
          }
        } else if (recipientId) {
          await db.insert(notificationsTable).values({
            userId: recipientId,
            type: "NEW_MESSAGE",
            title: `New message from ${sockWithUser.user.firstName}`,
            message: censoredText.slice(0, 80),
            linkUrl: "/dashboard#inbox",
          });
        }

        const [sender] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
        if (sender) {
          io.to(`conv:${conversationId}`).emit("message:new", { ...message, sender });
          if (conv.isGroup) {
            otherParts.forEach(p => io.to(`user:${p.userId}`).emit("notification:new", {
              type: "NEW_MESSAGE",
              title: `${sockWithUser.user.firstName} in ${conv.groupName ?? "Circle"}`,
              message: censoredText.slice(0, 60),
              conversationId,
            }));
          } else if (recipientId) {
            io.to(`user:${recipientId}`).emit("notification:new", {
              type: "NEW_MESSAGE",
              title: sockWithUser.user.firstName,
              message: censoredText.slice(0, 60),
              conversationId,
            });
          }
        }
      } catch (err) {
        logger.error({ err, conversationId }, "Socket message:send error");
      }
    });

    socket.on("focus:join", async ({ roomId }: { roomId: string }) => {
      if (!roomId) return;
      try {
        const [room] = await db.select().from(focusRoomsTable).where(eq(focusRoomsTable.id, roomId)).limit(1);
        if (!room || room.status !== "LIVE") {
          socket.emit("focus:error", { roomId, message: "Room not available" });
          return;
        }
        // Ensure a participant row exists (REST join usually already made one).
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

        const map = focusRooms.get(roomId) ?? new Map<string, FocusEntry>();
        const peersBefore = focusPresence(roomId);
        map.set(socket.id, {
          userId,
          firstName: sockWithUser.user.firstName,
          lastName: (sockWithUser.user as { lastName?: string }).lastName ?? "",
          profilePhoto: (sockWithUser.user as { profilePhoto?: string | null }).profilePhoto ?? null,
          cameraOn: false,
          joinedAt: Date.now(),
        });
        focusRooms.set(roomId, map);
        socket.join(`focus:${roomId}`);

        socket.emit("focus:joined", { roomId, participants: focusPresence(roomId) });
        socket.emit("focus:timer", {
          roomId,
          elapsedSeconds: room.timerElapsedSeconds + (room.timerRunning ? Math.floor((Date.now() - new Date(room.timerStartedAt).getTime()) / 1000) : 0),
          running: room.timerRunning,
          startedAt: room.timerStartedAt,
          focusMinutes: room.focusMinutes,
          breakMinutes: room.breakMinutes,
        });
        // Tell existing peers to open a connection toward the newcomer.
        socket.to(`focus:${roomId}`).emit("focus:peer-joined", {
          roomId,
          user: { userId, firstName: sockWithUser.user.firstName, lastName: (sockWithUser.user as { lastName?: string }).lastName ?? "", profilePhoto: (sockWithUser.user as { profilePhoto?: string | null }).profilePhoto ?? null },
          existingPeers: peersBefore,
        });
        broadcastPresence(roomId);
      } catch (err) {
        logger.error({ err, roomId }, "focus:join error");
      }
    });

    socket.on("focus:leave", async ({ roomId }: { roomId: string }) => {
      if (!roomId) return;
      const map = focusRooms.get(roomId);
      if (map) {
        map.delete(socket.id);
        if (map.size === 0) focusRooms.delete(roomId);
      }
      socket.leave(`focus:${roomId}`);
      socket.to(`focus:${roomId}`).emit("focus:peer-left", { roomId, userId, socketId: socket.id });
      broadcastPresence(roomId);
      await closeFocusParticipation(roomId, userId);
    });

    socket.on("focus:camera", async ({ roomId, cameraOn }: { roomId: string; cameraOn: boolean }) => {
      if (!roomId) return;
      const map = focusRooms.get(roomId);
      const entry = map?.get(socket.id);
      if (entry) entry.cameraOn = cameraOn !== false;
      broadcastPresence(roomId);
      try {
        await db
          .update(focusRoomParticipantsTable)
          .set({ cameraOn: cameraOn !== false, lastSeenAt: new Date() })
          .where(and(eq(focusRoomParticipantsTable.roomId, roomId), eq(focusRoomParticipantsTable.userId, userId)));
      } catch {}
    });

    socket.on("focus:chat", async ({ roomId, content }: { roomId: string; content: string }) => {
      if (!roomId || !content?.trim()) return;
      try {
        const [message] = await db
          .insert(focusRoomMessagesTable)
          .values({ roomId, userId, content: content.trim().slice(0, 600) })
          .returning();
        io.to(`focus:${roomId}`).emit("focus:chat:new", {
          ...message,
          firstName: sockWithUser.user.firstName,
          profilePhoto: (sockWithUser.user as { profilePhoto?: string | null }).profilePhoto ?? null,
        });
      } catch (err) {
        logger.error({ err, roomId }, "focus:chat error");
      }
    });

    // Generic WebRTC signaling relay (offer / answer / ice candidate).
    socket.on("focus:signal", ({ roomId, to, data }: { roomId: string; to: string; data: unknown }) => {
      if (!roomId || !to || !data) return;
      io.to(`user:${to}`).emit("focus:signal", { roomId, from: userId, data });
    });

    socket.on("disconnect", () => {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          socket.broadcast.emit("user:offline", { userId });
        }
      }
      // Clean up any focus rooms this socket was in.
      for (const [roomId, map] of focusRooms) {
        if (map.has(socket.id)) {
          map.delete(socket.id);
          if (map.size === 0) focusRooms.delete(roomId);
          socket.to(`focus:${roomId}`).emit("focus:peer-left", { roomId, userId, socketId: socket.id });
          broadcastPresence(roomId);
          void closeFocusParticipation(roomId, userId);
        }
      }
      logger.debug({ userId }, "Socket disconnected");
    });
  });

  return io;
}
