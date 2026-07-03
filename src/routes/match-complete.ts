import { Router, Request, Response } from "express";
import { db } from "../db";
import {
  barterMatchesTable,
  barterDeliveriesTable,
} from "../db/schema/barter";
import { conversationsTable, messagesTable } from "../db/schema/messages";
import { notificationsTable } from "../db/schema/users";
import { authenticate } from "../middlewares/authenticate";
import { eq, desc, and } from "drizzle-orm";

const router = Router();

// PUT /barter/matches/:id/complete
// Either party marks their side done.
router.put("/barter/matches/:id/complete", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const matchId = String(req.params.id);

  const [match] = await db
    .select()
    .from(barterMatchesTable)
    .where(eq(barterMatchesTable.id, matchId))
    .limit(1);

  if (!match) {
    res.status(404).json({ success: false, message: "Match not found" });
    return;
  }

  const isUser1 = match.user1Id === userId;
  if (!isUser1 && match.user2Id !== userId) {
    res.status(403).json({ success: false, message: "Forbidden" });
    return;
  }

  if (!["ACCEPTED", "IN_PROGRESS"].includes(match.status)) {
    res.status(400).json({ success: false, message: "Match cannot be completed in current state" });
    return;
  }

  const updates: Record<string, unknown> = {
    ...((isUser1 ? { confirmedByUser1: true } : { confirmedByUser2: true }) as Record<string, unknown>),
    updatedAt: new Date(),
  };

  const newConfirmed1 = isUser1 ? true : match.confirmedByUser1;
  const newConfirmed2 = isUser1 ? match.confirmedByUser2 : true;

  if (newConfirmed1 && newConfirmed2) {
    updates.status = "IN_PROGRESS";
  }

  const [updated] = await db
    .update(barterMatchesTable)
    .set(updates)
    .where(eq(barterMatchesTable.id, matchId))
    .returning();

  // Send a message to the conversation
  const [conv] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.matchId, matchId))
    .limit(1);

  const partnerId = isUser1 ? match.user2Id : match.user1Id;
  const waiting = !newConfirmed1 || !newConfirmed2;

  const app = req.app;
  const io = app.get("io");

  if (conv) {
    if (waiting) {
      await db.insert(messagesTable).values({
        conversationId: conv.id,
        senderId: userId,
        messageText: "I've completed my part of the exchange!",
      });
      await db.insert(notificationsTable).values({
        userId: partnerId,
        type: "EXCHANGE_DELIVERABLE",
        title: "Partner completed their part!",
        message: `${req.user!.firstName} has completed their part of the exchange. Please confirm from your side.`,
        linkUrl: "/dashboard#my-exchanges",
      });
      if (io) {
        io.to(`user:${partnerId}`).emit("exchange:updated", { matchId, status: "IN_PROGRESS" });
        io.to(`user:${partnerId}`).emit("notification:new", {
          type: "EXCHANGE_DELIVERABLE",
          title: "Partner completed their part!",
          message: `${req.user!.firstName} has completed their part. Please confirm.`,
          linkUrl: "/dashboard#my-exchanges",
        });
      }
    } else {
      await db.insert(messagesTable).values([
        {
          conversationId: conv.id,
          senderId: userId,
          messageText: "I've completed my part of the exchange!",
        },
        {
          conversationId: conv.id,
          senderId: userId,
          messageText: "\u2060\u2060\u2060Both sides have completed their part! Please deliver the project.",
        },
      ]);
    }
    await db
      .update(conversationsTable)
      .set({ lastMessageAt: new Date() })
      .where(eq(conversationsTable.id, conv.id));
  }

  if (!waiting) {
    for (const uid of [match.user1Id, match.user2Id]) {
      await db.insert(notificationsTable).values({
        userId: uid,
        type: "EXCHANGE_DELIVERABLE",
        title: "Both sides ready!",
        message: "Both parties have completed their exchange. Please deliver the project now.",
        linkUrl: "/dashboard#my-exchanges",
      });
    }
    if (io) {
      io.to(`user:${match.user1Id}`).emit("exchange:updated", { matchId, status: "IN_PROGRESS" });
      io.to(`user:${match.user2Id}`).emit("exchange:updated", { matchId, status: "IN_PROGRESS" });
    }
  }

  res.json({
    success: true,
    message: waiting
      ? "Marked as done. Waiting for your partner to confirm."
      : "Both sides confirmed! Time to deliver the project.",
    data: { match: updated, bothDone: !waiting },
  });
});

// POST /barter/matches/:id/deliver
// Submit a deliverable. Tracks per-user. When both have delivered, status becomes DELIVERED.
router.post("/barter/matches/:id/deliver", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const matchId = String(req.params.id);
  const { deliveryNote, link } = req.body;

  const [match] = await db
    .select()
    .from(barterMatchesTable)
    .where(eq(barterMatchesTable.id, matchId))
    .limit(1);

  if (!match) {
    res.status(404).json({ success: false, message: "Match not found" });
    return;
  }

  if (match.user1Id !== userId && match.user2Id !== userId) {
    res.status(403).json({ success: false, message: "Forbidden" });
    return;
  }

  if (match.status !== "IN_PROGRESS" && match.status !== "DELIVERED") {
    res.status(400).json({ success: false, message: "Exchange is not ready for delivery" });
    return;
  }

  const isUser1 = match.user1Id === userId;
  const myDelivered = isUser1 ? match.deliveredByUser1 : match.deliveredByUser2;

  // Check if user already delivered
  if (myDelivered) {
    res.status(400).json({ success: false, message: "You have already submitted your deliverable" });
    return;
  }

  // Count existing deliveries by this user for revision number
  const userDeliveries = await db
    .select()
    .from(barterDeliveriesTable)
    .where(and(eq(barterDeliveriesTable.matchId, matchId), eq(barterDeliveriesTable.userId, userId)));

  const revisionNumber = userDeliveries.length;

  const [delivery] = await db
    .insert(barterDeliveriesTable)
    .values({
      matchId,
      userId,
      deliveryNote: deliveryNote || null,
      link: link || null,
      revisionNumber,
    })
    .returning();

  // Update delivered flag + clear any revision flags against this user
  const updates: Record<string, unknown> = {
    ...(isUser1 ? { deliveredByUser1: true, revisedByUser2: false } : { deliveredByUser2: true, revisedByUser1: false }),
    updatedAt: new Date(),
  };

  const newDelivered1 = isUser1 ? true : match.deliveredByUser1;
  const newDelivered2 = isUser1 ? match.deliveredByUser2 : true;
  const bothDelivered = newDelivered1 && newDelivered2;

  if (bothDelivered) {
    updates.status = "DELIVERED";
  }

  await db
    .update(barterMatchesTable)
    .set(updates)
    .where(eq(barterMatchesTable.id, matchId));

  // Notifications
  const partnerId = isUser1 ? match.user2Id : match.user1Id;
  const newStatus = bothDelivered ? "DELIVERED" : "IN_PROGRESS";

  if (bothDelivered) {
    for (const uid of [match.user1Id, match.user2Id]) {
      await db.insert(notificationsTable).values({
        userId: uid,
        type: "EXCHANGE_DELIVERABLE",
        title: "Both delivered!",
        message: "Both parties have submitted their deliverables. Please review each other's work.",
        linkUrl: "/dashboard#my-exchanges",
      });
    }
  } else {
    await db.insert(notificationsTable).values({
      userId: partnerId,
      type: "EXCHANGE_DELIVERABLE",
      title: "Project delivered!",
      message: "Your exchange partner has submitted their deliverable. Please review and submit yours too.",
      linkUrl: "/dashboard#my-exchanges",
    });
  }

  // Send delivery details as inbox message
  const [conv] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.matchId, matchId))
    .limit(1);
  if (conv) {
    const msgStart = revisionNumber > 0 ? "🔄 *Project Re-delivered!*" : "📦 *Project Delivered!*";
    const inboxMsg = `${msgStart}\n\n${deliveryNote || "No description provided."}${link ? `\n\n🔗 Deliverable: ${link}` : ""}\n\n_Please review the delivery and respond._`;
    await db.insert(messagesTable).values({
      conversationId: conv.id,
      senderId: userId,
      messageText: inboxMsg,
      attachments: [],
    });
    await db
      .update(conversationsTable)
      .set({ lastMessageAt: new Date() })
      .where(eq(conversationsTable.id, conv.id));
  }

  const app = req.app;
  const io = app.get("io");
  if (io) {
    io.to(`user:${match.user1Id}`).emit("exchange:updated", { matchId, status: newStatus });
    io.to(`user:${match.user2Id}`).emit("exchange:updated", { matchId, status: newStatus });
    if (bothDelivered) {
      io.to(`user:${match.user1Id}`).emit("notification:new", {
        type: "EXCHANGE_DELIVERABLE",
        title: "Both delivered!",
        message: "Both parties have submitted. Review each other's deliverables now.",
        linkUrl: "/dashboard#my-exchanges",
      });
      io.to(`user:${match.user2Id}`).emit("notification:new", {
        type: "EXCHANGE_DELIVERABLE",
        title: "Both delivered!",
        message: "Both parties have submitted. Review each other's deliverables now.",
        linkUrl: "/dashboard#my-exchanges",
      });
    }
  }

  res.json({
    success: true,
    message: bothDelivered
      ? "Both deliverables submitted! Review each other's work."
      : "Deliverable submitted! Waiting for your partner to submit theirs.",
    data: { delivery, bothDelivered },
  });
});

// PUT /barter/matches/:id/accept-delivery
// Accept the OTHER user's delivery. Each user's delivery is tracked independently.
// Only moves to COMPLETED when both have accepted each other's delivery.
router.put("/barter/matches/:id/accept-delivery", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const matchId = String(req.params.id);

  const [match] = await db
    .select()
    .from(barterMatchesTable)
    .where(eq(barterMatchesTable.id, matchId))
    .limit(1);

  if (!match) {
    res.status(404).json({ success: false, message: "Match not found" });
    return;
  }

  if (match.user1Id !== userId && match.user2Id !== userId) {
    res.status(403).json({ success: false, message: "Forbidden" });
    return;
  }

  const isUser1 = match.user1Id === userId;
  const otherDelivered = isUser1 ? match.deliveredByUser2 : match.deliveredByUser1;

  if (!otherDelivered) {
    res.status(400).json({ success: false, message: "Your partner hasn't submitted their deliverable yet." });
    return;
  }

  const alreadyAccepted = isUser1 ? match.acceptedByUser1 : match.acceptedByUser2;

  if (alreadyAccepted) {
    res.status(400).json({ success: false, message: "You have already accepted their deliverable" });
    return;
  }

  // Mark this user's acceptance + clear revision flag for the deliverer (their delivery is now accepted, no need for revision)
  const acceptUpdate = isUser1 ? { acceptedByUser1: true, revisedByUser1: false } : { acceptedByUser2: true, revisedByUser2: false };
  const newAccepted1 = isUser1 ? true : match.acceptedByUser1;
  const newAccepted2 = isUser1 ? match.acceptedByUser2 : true;
  const bothAccepted = newAccepted1 && newAccepted2;

  const updates: Record<string, unknown> = {
    ...acceptUpdate,
    updatedAt: new Date(),
  };
  if (bothAccepted) {
    updates.status = "COMPLETED";
    updates.completedAt = new Date();
  }

  const [updated] = await db
    .update(barterMatchesTable)
    .set(updates)
    .where(eq(barterMatchesTable.id, matchId))
    .returning();

  const partnerId = isUser1 ? match.user2Id : match.user1Id;
  const newStatus = bothAccepted ? "COMPLETED" : match.status;

  if (bothAccepted) {
    // Both accepted — notifications + system message
    for (const uid of [match.user1Id, match.user2Id]) {
      await db.insert(notificationsTable).values({
        userId: uid,
        type: "EXCHANGE_COMPLETED",
        title: "Exchange completed!",
        message: "Both parties have accepted. Please leave a review for your exchange partner.",
        linkUrl: "/dashboard#my-exchanges",
      });
    }

    const [aConv] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.matchId, matchId))
      .limit(1);
    if (aConv) {
      await db.insert(messagesTable).values({
        conversationId: aConv.id,
        senderId: userId,
        messageText: "\u2060\u2060\u2060Exchange completed! Leave a review for your partner.",
      });
      await db
        .update(conversationsTable)
        .set({ lastMessageAt: new Date() })
        .where(eq(conversationsTable.id, aConv.id));
    }
  } else {
    // Only one accepted — notify partner
    await db.insert(notificationsTable).values({
      userId: partnerId,
      type: "EXCHANGE_DELIVERABLE",
      title: "Your deliverable was accepted!",
      message: `${req.user!.firstName} has accepted your deliverable. Waiting for you to accept theirs.`,
      linkUrl: "/dashboard#my-exchanges",
    });

    const [aConv] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.matchId, matchId))
      .limit(1);
    if (aConv) {
      await db.insert(messagesTable).values({
        conversationId: aConv.id,
        senderId: userId,
        messageText: "\u2060\u2060\u2060I've accepted your deliverable! Waiting for you to accept mine.",
      });
      await db
        .update(conversationsTable)
        .set({ lastMessageAt: new Date() })
        .where(eq(conversationsTable.id, aConv.id));
    }
  }

  const app = req.app;
  const io = app.get("io");
  if (io) {
    io.to(`user:${match.user1Id}`).emit("exchange:updated", { matchId, status: newStatus });
    io.to(`user:${match.user2Id}`).emit("exchange:updated", { matchId, status: newStatus });
    if (bothAccepted) {
      io.to(`user:${match.user1Id}`).emit("notification:new", {
        type: "EXCHANGE_COMPLETED",
        title: "Exchange completed!",
        message: "Both parties accepted. Leave a review!",
        linkUrl: "/dashboard#my-exchanges",
      });
      io.to(`user:${match.user2Id}`).emit("notification:new", {
        type: "EXCHANGE_COMPLETED",
        title: "Exchange completed!",
        message: "Both parties accepted. Leave a review!",
        linkUrl: "/dashboard#my-exchanges",
      });
    }
  }

  res.json({
    success: true,
    message: bothAccepted
      ? "Exchange completed!"
      : "You accepted their deliverable. Waiting for them to accept yours.",
    data: { match: updated, bothAccepted },
  });
});

// PUT /barter/matches/:id/request-revision
// Request revision on the OTHER user's delivery. Tracks independently per-user.
// Sets revisedByUser flags so the frontend can show correct context.
router.put("/barter/matches/:id/request-revision", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const matchId = String(req.params.id);
  const { revisionNote } = req.body;

  const [match] = await db
    .select()
    .from(barterMatchesTable)
    .where(eq(barterMatchesTable.id, matchId))
    .limit(1);

  if (!match) {
    res.status(404).json({ success: false, message: "Match not found" });
    return;
  }

  if (match.user1Id !== userId && match.user2Id !== userId) {
    res.status(403).json({ success: false, message: "Forbidden" });
    return;
  }

  if (match.status === "COMPLETED") {
    res.status(400).json({ success: false, message: "Exchange is already completed. Cannot request revision." });
    return;
  }

  const isUser1 = match.user1Id === userId;
  const otherDelivered = isUser1 ? match.deliveredByUser2 : match.deliveredByUser1;
  if (!otherDelivered) {
    res.status(400).json({ success: false, message: "Nothing to revise — the other party hasn't submitted yet." });
    return;
  }

  // The other user is the one who needs to re-deliver — reset their delivery flag
  // and set the revision flag so the frontend can show "Re-deliver" vs "Deliver" context.
  const delivererId = isUser1 ? match.user2Id : match.user1Id;
  const resetFlags: Record<string, unknown> = {};
  if (delivererId === match.user1Id) {
    resetFlags.deliveredByUser1 = false;
    resetFlags.revisedByUser2 = true;  // User 2 revised User 1's delivery
  } else {
    resetFlags.deliveredByUser2 = false;
    resetFlags.revisedByUser1 = true;  // User 1 revised User 2's delivery
  }

  // If the requester had already accepted, reset that acceptance too (they're now requesting changes)
  if (match.user1Id === userId && match.acceptedByUser1) {
    resetFlags.acceptedByUser1 = false;
  }
  if (match.user2Id === userId && match.acceptedByUser2) {
    resetFlags.acceptedByUser2 = false;
  }

  const [updated] = await db
    .update(barterMatchesTable)
    .set({ status: "IN_PROGRESS", ...resetFlags, updatedAt: new Date() })
    .where(eq(barterMatchesTable.id, matchId))
    .returning();

  // Send a revision request message
  const [conv] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.matchId, matchId))
    .limit(1);

  if (conv) {
    const msgText = `\u2060\u2060\u2060🔄 Revision requested${revisionNote ? `: ${revisionNote}` : ""}`;
    await db.insert(messagesTable).values({
      conversationId: conv.id,
      senderId: userId,
      messageText: msgText,
    });
    await db
      .update(conversationsTable)
      .set({ lastMessageAt: new Date() })
      .where(eq(conversationsTable.id, conv.id));
  }

  // Notify deliverer
  await db.insert(notificationsTable).values({
    userId: delivererId,
    type: "EXCHANGE_DELIVERABLE",
    title: "Revision requested",
    message: revisionNote ? `"${revisionNote}"` : "Your partner has requested a revision on your deliverable.",
    linkUrl: "/dashboard#my-exchanges",
  });

  const app = req.app;
  const io = app.get("io");
  if (io) {
    io.to(`user:${match.user1Id}`).emit("exchange:updated", { matchId, status: "IN_PROGRESS" });
    io.to(`user:${match.user2Id}`).emit("exchange:updated", { matchId, status: "IN_PROGRESS" });
    io.to(`user:${delivererId}`).emit("notification:new", {
      type: "EXCHANGE_DELIVERABLE",
      title: "Revision requested",
      message: revisionNote ? `"${revisionNote}"` : "Your partner has requested a revision.",
      linkUrl: "/dashboard#my-exchanges",
    });
  }

  res.json({
    success: true,
    message: "Revision requested. They will need to re-deliver.",
    data: { match: updated },
  });
});

// PUT /barter/matches/:id/cancel
// Cancel an exchange before work starts (status must be ACCEPTED). Either user can cancel.
router.put("/barter/matches/:id/cancel", authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const matchId = String(req.params.id);

  const [match] = await db
    .select()
    .from(barterMatchesTable)
    .where(eq(barterMatchesTable.id, matchId))
    .limit(1);

  if (!match) {
    res.status(404).json({ success: false, message: "Match not found" });
    return;
  }

  if (match.user1Id !== userId && match.user2Id !== userId) {
    res.status(403).json({ success: false, message: "Forbidden" });
    return;
  }

  if (match.status !== "ACCEPTED") {
    res.status(400).json({ success: false, message: "Can only cancel before work starts (status must be ACCEPTED)" });
    return;
  }

  await db
    .update(barterMatchesTable)
    .set({
      status: "CANCELLED",
      confirmedByUser1: false,
      confirmedByUser2: false,
      deliveredByUser1: false,
      deliveredByUser2: false,
      acceptedByUser1: false,
      acceptedByUser2: false,
      revisedByUser1: false,
      revisedByUser2: false,
      updatedAt: new Date(),
    })
    .where(eq(barterMatchesTable.id, matchId));

  const partnerId = match.user1Id === userId ? match.user2Id : match.user1Id;

  await db.insert(notificationsTable).values({
    userId: partnerId,
    type: "EXCHANGE_CANCELLED",
    title: "Exchange cancelled",
    message: `${req.user!.firstName} has cancelled the exchange.`,
    linkUrl: "/dashboard#my-exchanges",
  });

  const [conv] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.matchId, matchId))
    .limit(1);
  if (conv) {
    await db.insert(messagesTable).values({
      conversationId: conv.id,
      senderId: userId,
      messageText: "🚫 Exchange cancelled.",
    });
    await db
      .update(conversationsTable)
      .set({ lastMessageAt: new Date() })
      .where(eq(conversationsTable.id, conv.id));
  }

  const app = req.app;
  const io = app.get("io");
  if (io) {
    io.to(`user:${match.user1Id}`).emit("exchange:updated", { matchId, status: "CANCELLED" });
    io.to(`user:${match.user2Id}`).emit("exchange:updated", { matchId, status: "CANCELLED" });
    io.to(`user:${partnerId}`).emit("notification:new", {
      type: "EXCHANGE_CANCELLED",
      title: "Exchange cancelled",
      message: `${req.user!.firstName} has cancelled the exchange.`,
      linkUrl: "/dashboard#my-exchanges",
    });
  }

  res.json({ success: true, message: "Exchange cancelled", data: { match } });
});

export default router;
