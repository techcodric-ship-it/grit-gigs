import { Router, type IRouter } from "express";
import { uploadToSupabase, isSupabaseConfigured } from "../lib/storage";
import { PROJECT_ROOT } from "../lib/root";
import multer from "multer";
import path from "path";
import fs from "fs";
import {
  db,
  pool,
  conversationsTable,
  messagesTable,
  usersTable,
  notificationsTable,
  barterMatchesTable,
  ordersTable,
  projectBidsTable,
  projectsTable,
} from "../db";
import { eq, or, and, desc, ne, inArray, sql } from "drizzle-orm";
import { authenticate } from "../middlewares/authenticate";
import { attachPlanBadge, attachPlanBadges } from "../lib/planBadge";

const uploadsDir = path.join(PROJECT_ROOT, "uploads", "messages");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + "-" + Math.random().toString(36).slice(2) + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

const router: IRouter = Router();

router.post("/messages/upload", authenticate, upload.array("files", 10), async (req, res): Promise<void> => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) {
    res.status(400).json({ success: false, message: "No files uploaded" });
    return;
  }
  const result: { name: string; url: string; size: number; mimeType: string }[] = [];
  for (const f of files) {
    const supabaseUrl = await uploadToSupabase(fs.readFileSync(f.path), f.originalname, "messages");
    if (!supabaseUrl) {
      if (isSupabaseConfigured()) {
        res.status(500).json({ success: false, message: "File upload failed" });
        return;
      }
      result.push({ name: f.originalname, url: `/uploads/messages/${f.filename}`, size: f.size, mimeType: f.mimetype });
    } else {
      result.push({ name: f.originalname, url: supabaseUrl, size: f.size, mimeType: f.mimetype });
    }
  }
  res.json({ success: true, data: { files: result } });
});

router.get("/messages/admin-id", async (_req, res): Promise<void> => {
  const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
  res.json({ success: true, data: { adminId: admin?.id ?? null } });
});

router.get("/messages/online-users", authenticate, async (req, res): Promise<void> => {
  const io = req.app.get("io") as unknown as { onlineUsers?: Map<string, Set<string>> };
  const map = io?.onlineUsers;
  const onlineIds: string[] = [];
  if (map) {
    for (const [userId, sockets] of map) {
      if (sockets.size > 0) onlineIds.push(userId);
    }
  }
  const myRole = req.user!.role;
  const myId = req.user!.id;
  const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
  const adminId = admin?.id ?? null;
  let result: string[];
  if (myRole === "ADMIN" || myId === adminId) {
    result = onlineIds;
  } else {
    result = onlineIds.filter(id => id !== adminId);
  }
  res.json({ success: true, data: { onlineUserIds: result } });
});

router.get("/messages/conversations", authenticate, async (req, res): Promise<void> => {
  const conversations = await db
    .select()
    .from(conversationsTable)
    .where(
      or(
        eq(conversationsTable.user1Id, req.user!.id),
        eq(conversationsTable.user2Id, req.user!.id),
      ),
    )
    .orderBy(desc(conversationsTable.lastMessageAt));

  if (!conversations.length) { res.json({ success: true, data: { conversations: [] } }); return; }

  const myId = req.user!.id;
  const otherIds = conversations.map(c => c.user1Id === myId ? c.user2Id : c.user1Id);
  const convIds = conversations.map(c => c.id);

  const [users, lastMsgs, unreadCounts] = await Promise.all([
    db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, kycVerified: usersTable.kycVerified, role: usersTable.role })
      .from(usersTable).where(inArray(usersTable.id, otherIds)),
    (async () => {
      const res = await pool.query(
        `SELECT DISTINCT ON (conversation_id) conversation_id AS "conversationId", id, sender_id AS "senderId", message_text AS "messageText", created_at AS "createdAt", attachments
         FROM messages WHERE conversation_id = ANY($1::uuid[])
         ORDER BY conversation_id, created_at DESC`,
        [convIds],
      );
      return res.rows;
    })(),
    (async () => {
      const res = await pool.query(
        `SELECT conversation_id, COUNT(*)::int AS cnt
         FROM messages WHERE conversation_id = ANY($1::uuid[]) AND sender_id != $2 AND read = FALSE
         GROUP BY conversation_id`,
        [convIds, myId],
      );
      return res.rows;
    })(),
  ]);

  const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
  const adminId2 = admin?.id ?? "";
  const userMap = new Map(users.map(u => [u.id, u]));
  const lastMsgMap = new Map((lastMsgs || []).map(m => [m.conversationId, m]));
  const unreadMap = new Map((unreadCounts || []).map(r => [r.conversation_id, r.cnt]));

  const result = conversations.map(c => {
    const otherId = c.user1Id === myId ? c.user2Id : c.user1Id;
    let other = userMap.get(otherId) ?? null;
    const isAdminConv = (other && adminId2 && (other as any).id === adminId2) || (other && (other as any).role === "ADMIN") || false;
    if (isAdminConv) other = { ...(other as any), firstName: "Grit&Gigs", lastName: "Admin" };
    return { ...c, otherUser: other, isAdminConv, lastMessage: lastMsgMap.get(c.id) ?? null, unreadCount: unreadMap.get(c.id) ?? 0 };
  });

  const convUsers = result.map(c => c.otherUser).filter(Boolean);
  await attachPlanBadges(convUsers);

  res.json({ success: true, data: { conversations: result } });
});

router.post("/messages/conversations/with/:userId", authenticate, async (req, res): Promise<void> => {
  const otherId = String(req.params.userId);
  if (otherId === req.user!.id) {
    res.status(400).json({ success: false, message: "Cannot message yourself" });
    return;
  }

  const { orderId: reqOrderId, matchId: reqMatchId, projectBidId: reqBidId } = req.body as { orderId?: string; matchId?: string; projectBidId?: string };

  // If a specific work context is provided, look for a conversation with THAT EXACT context first
  if (reqOrderId) {
    const [byOrder] = await db.select().from(conversationsTable).where(eq(conversationsTable.orderId, reqOrderId)).limit(1);
    if (byOrder) { res.json({ success: true, data: { conversation: byOrder } }); return; }
    // Has orderId context but no conversation yet — will create new one below (don't reuse old user conv)
  }
  if (reqMatchId) {
    const [byMatch] = await db.select().from(conversationsTable).where(eq(conversationsTable.matchId, reqMatchId)).limit(1);
    if (byMatch) { res.json({ success: true, data: { conversation: byMatch } }); return; }
    // Has matchId context but no conversation yet — will create new one below
  }

  // Only look for existing generic conversation if NO specific context was provided
  const [existing] = (!reqOrderId && !reqMatchId && !reqBidId) ? await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        or(
          and(eq(conversationsTable.user1Id, req.user!.id), eq(conversationsTable.user2Id, otherId)),
          and(eq(conversationsTable.user1Id, otherId), eq(conversationsTable.user2Id, req.user!.id)),
        ),
        // Only match generic conversations with no context attached
        sql`${conversationsTable.orderId} IS NULL AND ${conversationsTable.matchId} IS NULL AND ${conversationsTable.projectBidId} IS NULL`,
      ),
    )
    .limit(1) : [null];

  if (existing) {
    res.json({ success: true, data: { conversation: existing } });
    return;
  }

  // When a specific context is provided, look up or verify the relationship
  if (reqBidId) {
    const [byBid] = await db.select().from(conversationsTable).where(eq(conversationsTable.projectBidId, reqBidId)).limit(1);
    if (byBid) { res.json({ success: true, data: { conversation: byBid } }); return; }

    const [bid] = await db
      .select()
      .from(projectBidsTable)
      .where(and(eq(projectBidsTable.id, reqBidId), eq(projectBidsTable.status, "ACCEPTED")))
      .limit(1);
    if (!bid) { res.status(403).json({ success: false, message: "Invalid or unaccepted bid" }); return; }
    const [proj] = await db
      .select({ userId: projectsTable.userId })
      .from(projectsTable)
      .where(eq(projectsTable.id, bid.projectId))
      .limit(1);
    if (!proj) { res.status(403).json({ success: false, message: "Project not found" }); return; }
    if (!((bid.userId === req.user!.id && proj.userId === otherId) || (bid.userId === otherId && proj.userId === req.user!.id))) {
      res.status(403).json({ success: false, message: "You are not involved in this bid" }); return;
    }
  }

  // Determine context for the new conversation
  const matchId = reqMatchId ?? null;
  const orderId = reqOrderId ?? null;
  const projectBidId = reqBidId ?? null;

  const [conv] = await db
    .insert(conversationsTable)
    .values({
      user1Id: req.user!.id,
      user2Id: otherId,
      matchId,
      orderId,
      projectBidId,
      lastMessageAt: new Date(),
    })
    .returning();

  res.status(201).json({ success: true, data: { conversation: conv } });
});

// ── Create or get admin support conversation for the current user ──
router.post("/messages/admin-conversation", authenticate, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
  if (!admin) { res.status(500).json({ success: false, message: "Admin user not found" }); return; }
  const [existing] = await db.select().from(conversationsTable).where(
    and(
      or(
        and(eq(conversationsTable.user1Id, admin.id), eq(conversationsTable.user2Id, userId)),
        and(eq(conversationsTable.user1Id, userId), eq(conversationsTable.user2Id, admin.id)),
      ),
      sql`${conversationsTable.orderId} IS NULL AND ${conversationsTable.matchId} IS NULL AND ${conversationsTable.projectBidId} IS NULL`,
    ),
  ).limit(1);
  if (existing) { res.json({ success: true, data: { conversation: existing, created: false } }); return; }
  const [conv] = await db.insert(conversationsTable).values({
    user1Id: admin.id, user2Id: userId, lastMessageAt: new Date(),
  }).returning();
  await db.insert(messagesTable).values({
    conversationId: conv.id, senderId: admin.id,
    messageText: "Welcome to Grit&Gigs Support! 👋 Feel free to ask any questions about the platform, your account, or how things work. We're here to help!",
    attachments: [],
  });
  res.status(201).json({ success: true, data: { conversation: conv, created: true } });
});

router.get("/messages/conversations/:conversationId/messages", authenticate, async (req, res): Promise<void> => {
  const convId = String(req.params.conversationId);
  const { page = "1", limit = "50" } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, convId));
  if (!conv) { res.status(404).json({ success: false, message: "Conversation not found" }); return; }
  if (conv.user1Id !== req.user!.id && conv.user2Id !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }

  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, convId))
    .orderBy(messagesTable.createdAt)
    .limit(parseInt(limit))
    .offset(skip);

  const senderIds = [...new Set(messages.map(m => m.senderId))];
  const senders = senderIds.length ? await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, kycVerified: usersTable.kycVerified })
    .from(usersTable)
    .where(inArray(usersTable.id, senderIds)) : [];
  const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
  const senderMap = new Map(senders.map(s => [s.id, admin && s.id === admin.id ? { ...s, firstName: "Grit&Gigs", lastName: "Admin" } : s]));
  const result = messages.map(m => ({ ...m, sender: senderMap.get(m.senderId) ?? null }));

  db.update(messagesTable)
    .set({ readAt: new Date() })
    .where(and(eq(messagesTable.conversationId, convId), ne(messagesTable.senderId, req.user!.id)))
    .catch(() => {});

  const otherUserId = conv.user1Id === req.user!.id ? conv.user2Id : conv.user1Id;
  res.json({ success: true, data: { messages: result, page: parseInt(page), otherUserId } });
});

router.post("/messages/conversations/:conversationId/messages", authenticate, async (req, res): Promise<void> => {
  const convId = String(req.params.conversationId);
  const { messageText, attachments } = req.body;

  if (!messageText?.trim()) { res.status(400).json({ success: false, message: "Message cannot be empty" }); return; }

  // Auto-censor contact info (email, phone) before saving
  const contactPattern = /(?:\b\d{7,}\b)|(?:\+?\d{1,3}[-.\s]?\d{7,})|(?:[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const censoredText = messageText.trim().replace(contactPattern, '[hidden]');

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, convId));
  if (!conv) { res.status(404).json({ success: false, message: "Conversation not found" }); return; }
  if (conv.user1Id !== req.user!.id && conv.user2Id !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }

  const [message] = await db.insert(messagesTable).values({
    conversationId: convId,
    senderId: req.user!.id,
    messageText: censoredText,
    attachments: attachments ?? [],
  }).returning();

  await db.update(conversationsTable).set({ lastMessageAt: new Date() }).where(eq(conversationsTable.id, convId));

  const recipientId = conv.user1Id === req.user!.id ? conv.user2Id : conv.user1Id;
  await db.insert(notificationsTable).values({
    userId: recipientId,
    type: "NEW_MESSAGE",
    title: `New message from ${req.user!.firstName}`,
    message: censoredText.slice(0, 80),
    linkUrl: "/dashboard#inbox",
  });

  const app = req.app;
  const io = app.get("io");
  if (io) {
    const [sender] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, kycVerified: usersTable.kycVerified }).from(usersTable).where(eq(usersTable.id, req.user!.id));
    await attachPlanBadge(sender);
    io.to(`conv:${convId}`).emit("message:new", { ...message, sender });
    io.to(`user:${recipientId}`).emit("notification:new", {
      type: "NEW_MESSAGE",
      title: req.user!.firstName,
      message: censoredText.slice(0, 60),
      conversationId: convId,
    });
  }

  res.status(201).json({ success: true, data: { message } });
});

router.put("/messages/conversations/:conversationId/read", authenticate, async (req, res): Promise<void> => {
  const convId = String(req.params.conversationId);
  await db.update(messagesTable)
    .set({ readAt: new Date() })
    .where(and(eq(messagesTable.conversationId, convId), ne(messagesTable.senderId, req.user!.id)));
  res.json({ success: true, message: "Messages marked as read" });
});

export default router;
