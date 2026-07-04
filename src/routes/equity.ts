import { Router, type Request, type Response } from "express";
import { db } from "../db";
import { pgTable, uuid, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "../db/schema/users";
import { eq, desc } from "drizzle-orm";
import { authenticate } from "../middlewares/authenticate";
import { adminAuth } from "../middlewares/adminAuth";

const router: ReturnType<typeof Router> = Router();

export const waitlistTable = pgTable("microequity_waitlist", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().unique().references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Join waitlist
router.post("/equity/waitlist", authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const existing = await db.select().from(waitlistTable).where(eq(waitlistTable.userId, req.user!.id));
    if (existing.length > 0) {
      res.json({ success: true, data: { alreadyJoined: true } });
      return;
    }
    await db.insert(waitlistTable).values({ userId: req.user!.id });
    res.status(201).json({ success: true, data: { alreadyJoined: false } });
  } catch (err) {
    console.error("equity waitlist error:", err);
    res.status(500).json({ success: false, message: "Failed to join waitlist" });
  }
});

// Check if user is on waitlist
router.get("/equity/waitlist/status", authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const existing = await db.select().from(waitlistTable).where(eq(waitlistTable.userId, req.user!.id));
    res.json({ success: true, data: { joined: existing.length > 0 } });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to check waitlist status" });
  }
});

// Admin: get all waitlist entries with user details
router.get("/admin/equity/waitlist", adminAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const entries = await db
      .select({
        id: waitlistTable.id,
        userId: waitlistTable.userId,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        email: usersTable.email,
        joinedAt: waitlistTable.createdAt,
      })
      .from(waitlistTable)
      .leftJoin(usersTable, eq(waitlistTable.userId, usersTable.id))
      .orderBy(desc(waitlistTable.createdAt));
    res.json({ success: true, data: entries });
  } catch (err) {
    console.error("admin equity waitlist error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch waitlist" });
  }
});

export default router;
