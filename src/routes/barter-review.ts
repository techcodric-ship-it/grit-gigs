import { Router, type Request, type Response } from "express";
import { authenticate } from "../middlewares/authenticate";
import { pool } from "../db";

const router = Router();

// POST /api/barter/matches/:id/review
router.post("/barter/matches/:id/review", authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const matchId = req.params["id"];
    const { rating, reviewText } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      res.status(400).json({ success: false, message: "Rating must be between 1 and 5" });
      return;
    }

    const client = await pool.connect();
    try {
      // Verify match exists, is completed, and user is part of it
      const matchRes = await client.query(
        `SELECT id, user1_id, user2_id, status FROM barter_matches WHERE id = $1`,
        [matchId]
      );
      if (matchRes.rows.length === 0) {
        res.status(404).json({ success: false, message: "Match not found" });
        return;
      }

      const match = matchRes.rows[0];
      if (match.status !== "COMPLETED") {
        res.status(400).json({ success: false, message: "Exchange must be completed before reviewing" });
        return;
      }

      const isUser1 = match.user1_id === userId;
      const isUser2 = match.user2_id === userId;
      if (!isUser1 && !isUser2) {
        res.status(403).json({ success: false, message: "You are not part of this exchange" });
        return;
      }

      const revieweeId = isUser1 ? match.user2_id : match.user1_id;

      // Check for duplicate review
      const existing = await client.query(
        `SELECT id FROM barter_reviews WHERE match_id = $1 AND reviewer_id = $2`,
        [matchId, userId]
      );
      if (existing.rows.length > 0) {
        res.status(400).json({ success: false, message: "You have already reviewed this exchange" });
        return;
      }

      // Insert review
      await client.query(
        `INSERT INTO barter_reviews (match_id, reviewer_id, reviewee_id, rating, comment)
         VALUES ($1, $2, $3, $4, $5)`,
        [matchId, userId, revieweeId, rating, reviewText || ""]
      );

      // Update reviewee's reputation score
      const avgRes = await client.query(
        `SELECT AVG(rating) as avg_rating FROM barter_reviews WHERE reviewee_id = $1`,
        [revieweeId]
      );
      const avgRating = avgRes.rows[0]?.avg_rating
        ? parseFloat(avgRes.rows[0].avg_rating)
        : rating;
      await client.query(
        `UPDATE users SET reputation_score = $1 WHERE id = $2`,
        [Math.round(avgRating * 100) / 100, revieweeId]
      );

      try { req.app?.get("io")?.emit("profile:updated", { userId: revieweeId }); } catch {}

      res.json({ success: true, message: "Review submitted" });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Review error:", err);
    res.status(500).json({ success: false, message: "Failed to submit review" });
  }
});

export default router;
