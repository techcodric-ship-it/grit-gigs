import { Router, type IRouter } from "express";
import {
  db,
  ordersTable,
  servicePackagesTable,
  servicesTable,
  usersTable,
  notificationsTable,
  orderDeliveriesTable,
  reviewsTable,
  clientReviewsTable,
  conversationsTable,
  messagesTable,
  transactionsTable,
  freelanceWalletsTable,
} from "../db";
import { eq, or, and, desc, count, sql } from "drizzle-orm";
import { authenticate } from "../middlewares/authenticate";
import { getActivePlanForUser } from "../lib/subscriptions";


const router: IRouter = Router();

router.get("/orders", authenticate, async (req, res): Promise<void> => {
  const { role = "buyer", status, page = "1", limit = "10" } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const conditions = [
    role === "buyer"
      ? eq(ordersTable.buyerId, req.user!.id)
      : eq(ordersTable.sellerId, req.user!.id),
  ];
  if (status) conditions.push(eq(ordersTable.status, status as typeof ordersTable.$inferSelect["status"]));

  const orders = await db
    .select()
    .from(ordersTable)
    .where(and(...conditions))
    .orderBy(desc(ordersTable.createdAt))
    .limit(parseInt(limit))
    .offset(skip);

  const result = await Promise.all(
    orders.map(async (o) => {
      const [service] = await db.select({ id: servicesTable.id, title: servicesTable.title, images: servicesTable.images, category: servicesTable.category }).from(servicesTable).where(eq(servicesTable.id, o.serviceId));
      const [pkg] = await db.select().from(servicePackagesTable).where(eq(servicePackagesTable.id, o.packageId));
      const [buyer] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, reputationScore: usersTable.reputationScore, emailVerified: usersTable.emailVerified, createdAt: usersTable.createdAt, kycVerified: usersTable.kycVerified }).from(usersTable).where(eq(usersTable.id, o.buyerId));
      const [seller] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, reputationScore: usersTable.reputationScore, emailVerified: usersTable.emailVerified, createdAt: usersTable.createdAt, kycVerified: usersTable.kycVerified }).from(usersTable).where(eq(usersTable.id, o.sellerId));
      const deliveries = await db.select().from(orderDeliveriesTable).where(eq(orderDeliveriesTable.orderId, o.id)).orderBy(desc(orderDeliveriesTable.createdAt)).limit(1);
      const [review] = await db.select().from(reviewsTable).where(eq(reviewsTable.orderId, o.id));
      // Flatten latest delivery message/link for frontend convenience
      const latestDelivery = deliveries[0] ?? null;
      const rawMsg = latestDelivery?.message ?? '';
      const linkMatch = rawMsg.match(/🔗 Deliverable: (https?:\/\/\S+)/);
      const deliveryLink = linkMatch ? linkMatch[1] : null;
      const deliveryMessage = linkMatch ? rawMsg.replace(/\n\n🔗 Deliverable: https?:\/\/\S+/, '').trim() : rawMsg;
      return { ...o, service, package: pkg, buyer, seller, deliveries, review: review ?? null, deliveryMessage: deliveryMessage || null, deliveryLink };
    }),
  );

  res.json({ success: true, data: { orders: result, page: parseInt(page) } });
});

router.get("/orders/:id", authenticate, async (req, res): Promise<void> => {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, String(req.params.id)));
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.buyerId !== req.user!.id && order.sellerId !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }

  const [service] = await db.select().from(servicesTable).where(eq(servicesTable.id, order.serviceId));
  const [pkg] = await db.select().from(servicePackagesTable).where(eq(servicePackagesTable.id, order.packageId));
  const [buyer] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, city: usersTable.city, kycVerified: usersTable.kycVerified }).from(usersTable).where(eq(usersTable.id, order.buyerId));
  const [seller] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, profilePhoto: usersTable.profilePhoto, city: usersTable.city, kycVerified: usersTable.kycVerified }).from(usersTable).where(eq(usersTable.id, order.sellerId));
  const deliveries = await db.select().from(orderDeliveriesTable).where(eq(orderDeliveriesTable.orderId, order.id)).orderBy(desc(orderDeliveriesTable.createdAt));
  const [review] = await db.select().from(reviewsTable).where(eq(reviewsTable.orderId, order.id));

  res.json({ success: true, data: { order: { ...order, service, package: pkg, buyer, seller, deliveries, review: review ?? null } } });
});

router.post("/orders", authenticate, async (req, res): Promise<void> => {
  const { serviceId, packageId, requirements } = req.body;
  if (!serviceId || !packageId) {
    res.status(400).json({ success: false, message: "serviceId and packageId are required" });
    return;
  }

  const [pkg] = await db.select().from(servicePackagesTable).where(eq(servicePackagesTable.id, packageId));
  if (!pkg) { res.status(404).json({ success: false, message: "Package not found" }); return; }

  const [service] = await db.select().from(servicesTable).where(eq(servicesTable.id, serviceId));
  if (!service || service.status !== "ACTIVE") { res.status(400).json({ success: false, message: "Service is not available" }); return; }
  if (service.sellerId === req.user!.id) { res.status(400).json({ success: false, message: "Cannot buy your own service" }); return; }

  const deliveryDate = new Date();
  deliveryDate.setDate(deliveryDate.getDate() + pkg.deliveryDays);

  let order;
  try {
    [order] = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(ordersTable).where(and(
        eq(ordersTable.buyerId, req.user!.id),
        eq(ordersTable.serviceId, serviceId),
        or(eq(ordersTable.status, 'PENDING'), eq(ordersTable.status, 'ACCEPTED'))
      )).limit(1);
      if (existing) throw new Error("DUPLICATE_ORDER");
      return tx.insert(ordersTable).values({
        serviceId,
        packageId,
        buyerId: req.user!.id,
        sellerId: service.sellerId,
        priceInr: pkg.priceInr,
        deliveryDate,
      }).returning();
    });
  } catch (err: any) {
    if (err.message === "DUPLICATE_ORDER") {
      res.status(400).json({ success: false, message: "You already have a pending order for this service" });
      return;
    }
    throw err;
  }

  await db.update(servicesTable).set({ orderCount: service.orderCount + 1 }).where(eq(servicesTable.id, serviceId));

  await db.insert(conversationsTable).values({
    user1Id: req.user!.id,
    user2Id: service.sellerId,
    orderId: order.id,
    lastMessageAt: new Date(),
  });

  await db.insert(notificationsTable).values({
    userId: service.sellerId,
    type: "NEW_ORDER",
    title: "New order received!",
    message: `${req.user!.firstName} placed an order for "${service.title}"`,
    linkUrl: `/dashboard/orders/${order.id}`,
  });

  res.status(201).json({ success: true, message: "Order placed successfully!", data: { order } });
});

router.put("/orders/:id/accept", authenticate, async (req, res): Promise<void> => {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, String(req.params.id)));
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.sellerId !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
  if (order.status !== "PENDING") { res.status(400).json({ success: false, message: "Order not in pending state" }); return; }

  await db.update(ordersTable).set({ status: "ACCEPTED", updatedAt: new Date() }).where(eq(ordersTable.id, order.id));
  await db.insert(notificationsTable).values({ userId: order.buyerId, type: "ORDER_ACCEPTED", title: "Order accepted!", message: "Your order has been accepted.", linkUrl: `/dashboard/orders/${order.id}` });
  res.json({ success: true, message: "Order accepted" });
});

router.put("/orders/:id/deliver", authenticate, async (req, res): Promise<void> => {
  // Accept both old (message/files) and new (deliveryMessage/deliveryLink) field names
  const deliveryMsg = req.body.deliveryMessage ?? req.body.message ?? "";
  const deliveryLink = req.body.deliveryLink ?? null;
  const files = req.body.files ?? [];
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, String(req.params.id)));
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.sellerId !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }

  // Atomically claim the delivery — only the first request succeeds
  const claimResult = await db.execute(
    sql`UPDATE ${ordersTable} SET ${ordersTable.status} = 'DELIVERED', ${ordersTable.updatedAt} = NOW() WHERE ${ordersTable.id} = ${order.id} AND ${ordersTable.status} IN ('ACCEPTED', 'IN_PROGRESS', 'REVISION_REQUESTED')`
  );
  if (claimResult.rowCount === 0) {
    res.status(400).json({ success: false, message: "Order cannot be delivered in current state" });
    return;
  }

  const [lastDelivery] = await db.select().from(orderDeliveriesTable).where(eq(orderDeliveriesTable.orderId, order.id)).orderBy(desc(orderDeliveriesTable.revisionNumber)).limit(1);
  const revisionNumber = lastDelivery ? lastDelivery.revisionNumber + 1 : 0;

  // Store delivery message including link in the files/message fields
  const fullDeliveryMessage = deliveryMsg + (deliveryLink ? `\n\n🔗 Deliverable: ${deliveryLink}` : "");
  await db.insert(orderDeliveriesTable).values({ orderId: order.id, message: fullDeliveryMessage, files: files ?? [], revisionNumber });
  await db.insert(notificationsTable).values({ userId: order.buyerId, type: "ORDER_DELIVERED", title: "Work delivered!", message: "Your order has been delivered. Please review and accept.", linkUrl: `/dashboard/orders/${order.id}` });

  // Send delivery details as inbox message to buyer
  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.orderId, order.id)).limit(1);
  if (conv) {
    const inboxMsg = `📦 *Work Delivered!*\n\n${deliveryMsg}${deliveryLink ? `\n\n🔗 Deliverable: ${deliveryLink}` : ""}\n\n_Please review and click "Accept & Release Payment" or request a revision._`;
    await db.insert(messagesTable).values({
      conversationId: conv.id,
      senderId: req.user!.id,
      messageText: inboxMsg,
      attachments: [],
    });
    await db.update(conversationsTable).set({ lastMessageAt: new Date() }).where(eq(conversationsTable.id, conv.id));
  }

  res.json({ success: true, message: "Order delivered successfully", data: { deliveryLink } });
});

router.put("/orders/:id/revision", authenticate, async (req, res): Promise<void> => {
  const { revisionNote } = req.body;
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, String(req.params.id)));
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.buyerId !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
  if (order.status !== "DELIVERED") { res.status(400).json({ success: false, message: "Order has not been delivered" }); return; }

  const [pkg] = await db.select().from(servicePackagesTable).where(eq(servicePackagesTable.id, order.packageId));
  if (!pkg) { res.status(400).json({ success: false, message: "Package not found" }); return; }
  const [deliveryCount] = await db.select({ value: count() }).from(orderDeliveriesTable).where(eq(orderDeliveriesTable.orderId, order.id));
  if (deliveryCount.value > pkg.revisions) {
    res.status(400).json({ success: false, message: `Maximum revisions (${pkg.revisions}) reached` });
    return;
  }

  await db.update(ordersTable).set({ status: "REVISION_REQUESTED", updatedAt: new Date() }).where(eq(ordersTable.id, order.id));
  await db.insert(notificationsTable).values({ userId: order.sellerId, type: "REVISION_REQUESTED", title: "Revision requested", message: revisionNote ?? "The buyer requested a revision.", linkUrl: `/dashboard/orders/${order.id}` });

  // Send revision note as inbox message to seller
  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.orderId, order.id)).limit(1);
  if (conv) {
    const revMsg = `🔄 *Revision Requested*\n\n${revisionNote ?? "The buyer has requested a revision. Please check the order for details."}\n\n_Please submit the revised work when ready._`;
    await db.insert(messagesTable).values({
      conversationId: conv.id,
      senderId: req.user!.id,
      messageText: revMsg,
      attachments: [],
    });
    await db.update(conversationsTable).set({ lastMessageAt: new Date() }).where(eq(conversationsTable.id, conv.id));
  }

  res.json({ success: true, message: "Revision requested" });
});

router.put("/orders/:id/complete", authenticate, async (req, res): Promise<void> => {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, String(req.params.id)));
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.buyerId !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
  if (order.status !== "DELIVERED") { res.status(400).json({ success: false, message: "Order has not been delivered" }); return; }

  // Atomically claim the transition — only the first request succeeds
  const claimResult = await db.execute(
    sql`UPDATE ${ordersTable} SET ${ordersTable.status} = 'COMPLETED', ${ordersTable.completedAt} = NOW(), ${ordersTable.updatedAt} = NOW() WHERE ${ordersTable.id} = ${order.id} AND ${ordersTable.status} = 'DELIVERED'`
  );
  if (claimResult.rowCount === 0) {
    res.status(409).json({ success: false, message: "Order already completed" });
    return;
  }

  // Calculate commission based on seller's plan
  const plan = await getActivePlanForUser(order.sellerId);
  const commissionPct = plan.serviceFeePercent;
  const commission = Math.round(order.priceInr * commissionPct / 100);
  const netAmount = order.priceInr - commission;

  // Wallet operations + transaction records in a DB transaction
  try {
    await db.transaction(async (tx) => {
      const deductResult = await tx.execute(
        sql`UPDATE ${freelanceWalletsTable} SET balance = balance - ${order.priceInr}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${order.buyerId} AND balance >= ${order.priceInr}`
      );
      if (deductResult.rowCount === 0) {
        throw new Error("Insufficient funds");
      }

      const creditResult = await tx.execute(
        sql`UPDATE ${freelanceWalletsTable} SET balance = balance + ${netAmount}, total_earned = COALESCE(total_earned, 0) + ${netAmount}, updated_at = NOW() WHERE ${freelanceWalletsTable.userId} = ${order.sellerId}`
      );
      if (creditResult.rowCount === 0) {
        await tx.insert(freelanceWalletsTable).values({
          userId: order.sellerId,
          balance: netAmount,
          totalEarned: netAmount,
          updatedAt: new Date(),
        });
      }

      await tx.insert(transactionsTable).values({
        userId: order.buyerId,
        type: 'SERVICE_PAYMENT',
        amount: order.priceInr,
        description: `Payment for order #${order.id.slice(-8)}`,
        status: 'COMPLETED',
      });

      await tx.insert(transactionsTable).values({
        userId: order.sellerId,
        type: 'SERVICE_EARNING',
        amount: netAmount,
        description: `Payment received for order #${order.id.slice(-8)}`,
        status: 'COMPLETED',
      });
      if (commission > 0) {
        await tx.insert(transactionsTable).values({
          userId: order.sellerId,
          type: 'COMMISSION',
          amount: commission,
          description: `Platform commission (${commissionPct}%) on order #${order.id.slice(-8)}`,
          status: 'COMPLETED',
        });
      }
    });
  } catch (e) {
    // Roll back the order status claim if the transaction failed
    await db.execute(sql`UPDATE ${ordersTable} SET ${ordersTable.status} = 'DELIVERED', ${ordersTable.updatedAt} = NOW() WHERE ${ordersTable.id} = ${order.id}`);
    if (e instanceof Error && e.message === "Insufficient funds") {
      res.status(400).json({ success: false, message: "You don't have enough funds in your wallet. Please add funds and try again." });
    } else {
      res.status(500).json({ success: false, message: "Payment processing failed. Please try again." });
    }
    return;
  }

  await db.insert(notificationsTable).values({
    userId: order.buyerId,
    type: 'PAYMENT_SENT',
    title: 'Payment sent',
    message: `₹${order.priceInr} deducted from your wallet for order #${order.id.slice(-8)}`,
    linkUrl: '/dashboard/orders',
  });
  await db.insert(notificationsTable).values({
    userId: order.sellerId,
    type: "ORDER_COMPLETED",
    title: "Order completed!",
    message: `You received ₹${netAmount} for order #${order.id.slice(-8)} (${commissionPct}% commission: ₹${commission}). Thank you!`,
    linkUrl: "/dashboard/orders",
  });

  res.json({ success: true, message: `Order completed! Seller receives ₹${netAmount} (${commissionPct}% commission: ₹${commission}). Please leave a review.` });
});

router.put("/orders/:id/cancel", authenticate, async (req, res): Promise<void> => {
  const { reason } = req.body;
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, String(req.params.id)));
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.buyerId !== req.user!.id && order.sellerId !== req.user!.id) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
  if (["COMPLETED", "CANCELLED"].includes(order.status)) { res.status(400).json({ success: false, message: "Order cannot be cancelled" }); return; }

  await db.update(ordersTable).set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() }).where(eq(ordersTable.id, order.id));

  const otherUserId = req.user!.id === order.buyerId ? order.sellerId : order.buyerId;
  await db.insert(notificationsTable).values({
    userId: otherUserId, type: "ORDER_CANCELLED", title: "Order cancelled",
    message: reason ?? "An order has been cancelled.",
    linkUrl: "/dashboard/orders",
  });

  res.json({ success: true, message: "Order cancelled" });
});

router.post("/orders/:id/review", authenticate, async (req, res): Promise<void> => {
  const { rating, reviewText } = req.body;
  if (!rating || Number(rating) < 1 || Number(rating) > 5) {
    res.status(400).json({ success: false, message: "Rating must be 1-5" });
    return;
  }

  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, String(req.params.id)));
  if (!order) { res.status(404).json({ success: false, message: "Order not found" }); return; }
  if (order.buyerId !== req.user!.id) { res.status(403).json({ success: false, message: "Only the buyer can review" }); return; }
  if (order.status !== "COMPLETED") { res.status(400).json({ success: false, message: "Order must be completed before reviewing" }); return; }

  const [existing] = await db.select().from(reviewsTable).where(eq(reviewsTable.orderId, order.id));
  if (existing) { res.status(400).json({ success: false, message: "Review already submitted" }); return; }

  const [review] = await db.insert(reviewsTable).values({
    reviewerId: req.user!.id,
    revieweeId: order.sellerId,
    type: "service",
    serviceId: order.serviceId,
    orderId: order.id,
    rating: Number(rating),
    reviewText: reviewText ?? null,
  }).returning();

  const allReviews = await db.select({ rating: reviewsTable.rating }).from(reviewsTable).where(and(eq(reviewsTable.serviceId, order.serviceId), eq(reviewsTable.type, "service")));
  const avgRating = allReviews.length ? allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length : 0;
  await db.update(servicesTable).set({ ratingAvg: avgRating, reviewCount: allReviews.length }).where(eq(servicesTable.id, order.serviceId));

  const [seller] = await db.select({ reputationScore: usersTable.reputationScore }).from(usersTable).where(eq(usersTable.id, order.sellerId));
  if (seller) {
    await db.update(usersTable).set({ reputationScore: seller.reputationScore + (Number(rating) >= 4 ? 3 : 1) }).where(eq(usersTable.id, order.sellerId));
  }

  await db.insert(notificationsTable).values({
    userId: order.sellerId, type: "NEW_REVIEW",
    title: "New review received!", message: `You received a ${rating}-star review.`,
    linkUrl: `/services/${order.serviceId}`,
  });

  try { req.app?.get("io")?.emit("profile:updated", { userId: order.sellerId }); } catch {}

  res.status(201).json({ success: true, message: "Review submitted!", data: { review } });
});

export default router;
