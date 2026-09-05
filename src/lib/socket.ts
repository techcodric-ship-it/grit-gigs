import type { Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { verifyAccessToken } from "./auth";
import { db, usersTable, conversationsTable, conversationParticipantsTable, messagesTable, notificationsTable } from "../db";
import { eq, and, ne } from "drizzle-orm";
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

    socket.on("disconnect", () => {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          socket.broadcast.emit("user:offline", { userId });
        }
      }
      logger.debug({ userId }, "Socket disconnected");
    });
  });

  return io;
}
