import type { Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { verifyAccessToken } from "./auth";
import { db, usersTable, conversationsTable, messagesTable, notificationsTable } from "../db";
import { eq, and } from "drizzle-orm";
import { logger } from "./logger";

export function setupSocket(httpServer: HttpServer): SocketServer {
  const io = new SocketServer(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
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
      if (!conv || (conv.user1Id !== userId && conv.user2Id !== userId)) {
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

      const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
      if (!conv || (conv.user1Id !== userId && conv.user2Id !== userId)) return;

      const [message] = await db
        .insert(messagesTable)
        .values({ conversationId, senderId: userId, messageText: messageText.trim() })
        .returning();

      await db.update(conversationsTable).set({ lastMessageAt: new Date() }).where(eq(conversationsTable.id, conversationId));

      const recipientId = conv.user1Id === userId ? conv.user2Id : conv.user1Id;
      await db.insert(notificationsTable).values({
        userId: recipientId,
        type: "NEW_MESSAGE",
        title: `New message from ${sockWithUser.user.firstName}`,
        message: messageText.slice(0, 80),
        linkUrl: "/dashboard#inbox",
      });

      const [sender] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto }).from(usersTable).where(eq(usersTable.id, userId));
      io.to(`conv:${conversationId}`).emit("message:new", { ...message, sender });
      io.to(`user:${recipientId}`).emit("notification:new", {
        type: "NEW_MESSAGE",
        title: sockWithUser.user.firstName,
        message: messageText.slice(0, 60),
        conversationId,
      });
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
