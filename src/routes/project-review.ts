import { Router, type Request, type Response } from "express";
import { authenticate } from "../middlewares/authenticate";
import { pool } from "../db";

const router = Router();

router.post("/projects/:id/review", authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const projectId = req.params["id"];
    const { rating, reviewText } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      res.status(400).json({ success: false, message: "Rating must be between 1 and 5" });
      return;
    }

    const client = await pool.connect();
    try {
      const projRes = await client.query(
        `SELECT id, user_id, status, accepted_bid_id FROM projects WHERE id = $1`,
        [projectId]
      );
      if (projRes.rows.length === 0) {
        res.status(404).json({ success: false, message: "Project not found" });
        return;
      }

      const project = projRes.rows[0];
      if (project.status !== "COMPLETED") {
        res.status(400).json({ success: false, message: "Project must be completed before reviewing" });
        return;
      }

      let revieweeId: string;
      if (project.user_id === userId) {
        // Client is reviewing the freelancer — find them via accepted_bid
        const bidRes = await client.query(
          `SELECT user_id FROM project_bids WHERE id = $1`,
          [project.accepted_bid_id]
        );
        if (bidRes.rows.length === 0) {
          res.status(400).json({ success: false, message: "Accepted bid not found" });
          return;
        }
        revieweeId = bidRes.rows[0].user_id;
      } else {
        // Freelancer is reviewing the client
        revieweeId = project.user_id;
      }

      const existing = await client.query(
        `SELECT id FROM project_reviews WHERE project_id = $1 AND reviewer_id = $2`,
        [projectId, userId]
      );
      if (existing.rows.length > 0) {
        res.status(400).json({ success: false, message: "You have already reviewed this project" });
        return;
      }

      await client.query(
        `INSERT INTO project_reviews (project_id, reviewer_id, reviewee_id, rating, comment)
         VALUES ($1, $2, $3, $4, $5)`,
        [projectId, userId, revieweeId, rating, reviewText || ""]
      );

      try { req.app?.get("io")?.emit("profile:updated", { userId: revieweeId }); } catch {}

      res.json({ success: true, message: "Review submitted" });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Project review error:", err);
    res.status(500).json({ success: false, message: "Failed to submit review" });
  }
});

export default router;
