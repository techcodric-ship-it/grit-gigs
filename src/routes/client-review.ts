import { Router } from 'express';
import { db } from '../db';
import { ordersTable, clientReviewsTable, reviewsTable, usersTable } from '../db/schema';
import { eq, and } from 'drizzle-orm';

const router = Router();

// POST /orders/:id/client-review — seller rates the buyer after order is completed
router.post('/orders/:id/client-review', async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { rating, reviewText } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be 1–5' });
    }

    // Find the order and verify caller is the seller
    const order = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, req.params.id),
    });

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.sellerId !== userId) return res.status(403).json({ success: false, message: 'Only the seller can rate the client' });
    if (order.status !== 'COMPLETED') return res.status(400).json({ success: false, message: 'Order must be completed first' });

    // Check if already reviewed
    const existing = await db.query.clientReviewsTable?.findFirst?.({
      where: eq((clientReviewsTable as any).orderId, req.params.id),
    }).catch(() => null);
    if (existing) return res.status(400).json({ success: false, message: 'Client already rated for this order' });

    await db.insert(clientReviewsTable as any).values({
      orderId: req.params.id,
      reviewerId: userId,
      revieweeId: order.buyerId,
      rating,
      reviewText: reviewText || '',
    });

    try { req.app?.get("io")?.emit("profile:updated", { userId: order.buyerId }); } catch {}

    return res.json({ success: true, message: 'Client rated successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export default router;
