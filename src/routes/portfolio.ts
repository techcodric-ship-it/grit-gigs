import { Router, type IRouter } from "express";
import { db, usersTable, servicesTable } from "../db";
import { pool } from "../db";
import { eq, desc, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/portfolio/featured", async (_req, res): Promise<void> => {
  try {
    const items: any[] = [];

    // Completed projects (freelancer won via accepted bid)
    try {
      const projRes = await pool.query(
        `SELECT p.id, p.title, p.description, p.category, p.skills, p.budget_min, p.budget_max,
                p.created_at, pb.user_id AS freelancer_id, pb.amount AS bid_amount,
                pr.rating AS review_rating, pr.comment AS review_comment
         FROM projects p
         LEFT JOIN project_bids pb ON pb.id = p.accepted_bid_id
         LEFT JOIN project_reviews pr ON pr.project_id = p.id AND pr.reviewee_id = pb.user_id
         WHERE p.status = 'COMPLETED' AND pb.user_id IS NOT NULL
         ORDER BY p.created_at DESC LIMIT 20`
      );
      for (const x of projRes.rows) {
        items.push({
          type: "project",
          id: x.id,
          title: x.title,
          description: x.description,
          category: x.category,
          skills: x.skills,
          budgetMin: x.budget_min,
          budgetMax: x.budget_max,
          bidAmount: x.bid_amount,
          createdAt: x.created_at,
          reviewRating: x.review_rating ? Number(x.review_rating) : null,
          reviewComment: x.review_comment || null,
          freelancerId: x.freelancer_id,
        });
      }
    } catch {}

    // Completed service orders
    try {
      const orderRes = await pool.query(
        `SELECT o.id, o.price_inr, o.created_at, o.completed_at,
                o.seller_id, o.buyer_id,
                s.title AS service_title, s.category AS service_category,
                r.rating AS review_rating, r.review_text AS review_comment
         FROM orders o
         LEFT JOIN services s ON s.id = o.service_id
         LEFT JOIN reviews r ON r.order_id = o.id
         WHERE o.status = 'COMPLETED'
         ORDER BY o.completed_at DESC NULLS LAST, o.created_at DESC LIMIT 20`
      );
      for (const x of orderRes.rows) {
        items.push({
          type: "order",
          id: x.id,
          title: x.service_title || "Service order",
          category: x.service_category || null,
          priceInr: x.price_inr,
          createdAt: x.created_at,
          completedAt: x.completed_at,
          reviewRating: x.review_rating ? Number(x.review_rating) : null,
          reviewComment: x.review_comment || null,
          freelancerId: x.seller_id,
        });
      }
    } catch {}

    // Completed barter exchanges
    try {
      const barterRes = await pool.query(
        `SELECT bm.id, bm.completed_at, bm.user1_id, bm.user2_id,
                br1.title AS offering1, br1.category AS category1,
                br2.title AS offering2, br2.category AS category2,
                brv.rating AS review_rating, brv.comment AS review_comment
         FROM barter_matches bm
         LEFT JOIN barter_requests br1 ON br1.id = bm.request1_id
         LEFT JOIN barter_requests br2 ON br2.id = bm.request2_id
         LEFT JOIN barter_reviews brv ON brv.match_id = bm.id
         WHERE bm.status = 'COMPLETED'
         ORDER BY bm.completed_at DESC NULLS LAST LIMIT 20`
      );
      for (const x of barterRes.rows) {
        items.push({
          type: "barter",
          id: x.id,
          title: x.offering1 || x.offering2 || "Skill exchange",
          category: x.category1 || x.category2 || null,
          completedAt: x.completed_at,
          reviewRating: x.review_rating ? Number(x.review_rating) : null,
          reviewComment: x.review_comment || null,
          freelancerId: x.user1_id,
        });
      }
    } catch {}

    // Sort all by date, most recent first, pick top 6
    items.sort((a: any, b: any) => {
      const da = new Date(a.completedAt || a.createdAt || 0).getTime();
      const db2 = new Date(b.completedAt || b.createdAt || 0).getTime();
      return db2 - da;
    });
    const featured = items.slice(0, 6);

    // Attach freelancer names
    const freelancerIds = [...new Set(featured.map((i: any) => i.freelancerId).filter(Boolean))];
    const freelancers: Record<string, any> = {};
    if (freelancerIds.length) {
      const rows = await db
        .select({
          id: usersTable.id,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          profilePhoto: usersTable.profilePhoto,
        })
        .from(usersTable)
        .where(sql`${usersTable.id} = ANY(${freelancerIds})`);
      for (const u of rows) {
        freelancers[u.id] = {
          id: u.id,
          firstName: u.firstName,
          lastName: u.lastName ?? "",
          profilePhoto: u.profilePhoto ?? null,
        };
      }
    }

    const result = featured.map((item: any) => ({
      ...item,
      freelancer: item.freelancerId ? freelancers[item.freelancerId] ?? null : null,
    }));

    res.json({ success: true, data: { items: result } });
  } catch (err) {
    console.error("GET /portfolio/featured error:", err);
    res.json({ success: true, data: { items: [] } });
  }
});

export default router;