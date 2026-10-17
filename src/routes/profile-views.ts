import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, profileViewsTable, usersTable } from "../db";
import { authenticate } from "../middlewares/authenticate";
import { PROFILE_VIEW_LIMIT, summarizeProfileViews } from "../lib/profile-views";

const router: IRouter = Router();

// GET /me/profile-views — who looked at the caller's profile, most recent first.
router.get("/me/profile-views", authenticate, async (req: Request, res: Response): Promise<void> => {
  const rows = await db
    .select({
      viewerId: profileViewsTable.viewerId,
      createdAt: profileViewsTable.createdAt,
      viewer: {
        id: usersTable.id,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        profilePhoto: usersTable.profilePhoto,
        city: usersTable.city,
      },
    })
    .from(profileViewsTable)
    .leftJoin(usersTable, eq(profileViewsTable.viewerId, usersTable.id))
    .where(and(eq(profileViewsTable.viewedId, req.user!.id)))
    .orderBy(desc(profileViewsTable.createdAt))
    .limit(PROFILE_VIEW_LIMIT);

  res.json({ success: true, data: summarizeProfileViews(rows) });
});

export default router;
