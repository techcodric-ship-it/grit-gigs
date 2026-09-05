import { Router, type Request, type Response } from "express";
import { authenticate } from "../middlewares/authenticate";
import { pool, db, notificationsTable } from "../db";

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
      const isClientReviewing = project.user_id === userId;
      if (isClientReviewing) {
        // Client is reviewing the freelancer/team — find them via accepted_bid
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

      if (isClientReviewing) {
        // Route the client's review to the squad when the accepted bidder is in an active Grit Circle
        const squadRes = await client.query(
          `SELECT s.id AS squad_id, s.name FROM squad_members sm INNER JOIN squads s ON s.id = sm.squad_id WHERE sm.user_id = $1 AND s.is_active = TRUE LIMIT 1`,
          [revieweeId]
        );
        if (squadRes.rows.length > 0) {
          const squadId = squadRes.rows[0].squad_id as string;
          const existingSquad = await client.query(
            `SELECT id FROM squad_reviews WHERE project_id = $1`,
            [projectId]
          );
          if (existingSquad.rows.length > 0) {
            res.status(400).json({ success: false, message: "You have already reviewed this squad for this project" });
            return;
          }
          await client.query(
            `INSERT INTO squad_reviews (squad_id, reviewer_id, rating, review_text, source, project_id)
             VALUES ($1, $2, $3, $4, 'PROJECT', $5)`,
            [squadId, userId, rating, reviewText || "", projectId]
          );
          await client.query(
            `UPDATE squads
             SET rating_avg = ROUND(COALESCE((SELECT AVG(rating)::float FROM squad_reviews WHERE squad_id = $1), 0)::numeric, 2),
                 review_count = (SELECT COUNT(*) FROM squad_reviews WHERE squad_id = $1),
                 updated_at = NOW()
             WHERE id = $1`,
            [squadId]
          );
          const members = await client.query(
            `SELECT user_id FROM squad_members WHERE squad_id = $1`,
            [squadId]
          );
          const notif = {
            type: "SQUAD_REVIEW",
            title: "Your circle was rated!",
            message: `A client rated ${squadRes.rows[0].name} ${rating}★ after completing the project.`,
            linkUrl: "/dashboard#grit-circle",
          };
          for (const m of members.rows) {
            await db.insert(notificationsTable).values({ userId: String(m.user_id), ...notif });
          }
          try { req.app?.get("io")?.emit("grit-circle:updated", { squadId }); } catch {}

          res.json({ success: true, message: "Review submitted" });
          return;
        }
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
