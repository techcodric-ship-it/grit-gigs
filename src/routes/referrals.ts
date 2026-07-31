import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc } from "drizzle-orm";
import { db, usersTable, referralsTable } from "../db";
import { authenticate } from "../middlewares/authenticate";
import { generateReferralCode, REFERRAL_REWARD } from "../lib/referrals";

const router: IRouter = Router();

router.get("/referrals/mine", authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.id;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) return res.status(404).json({ success: false, message: "User not found" });

  let code = user.referralCode;
  if (!code) {
    code = await generateReferralCode();
    await db.update(usersTable).set({ referralCode: code, updatedAt: new Date() }).where(eq(usersTable.id, userId));
  }

  const referred = await db
    .select()
    .from(referralsTable)
    .where(eq(referralsTable.referrerId, userId))
    .orderBy(desc(referralsTable.createdAt));

  const enriched = await Promise.all(
    referred.map(async (r) => {
      const [ru] = await db
        .select({
          id: usersTable.id,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          profilePhoto: usersTable.profilePhoto,
          email: usersTable.email,
          createdAt: usersTable.createdAt,
        })
        .from(usersTable)
        .where(eq(usersTable.id, r.referredUserId))
        .limit(1);
      return { ...r, referredUser: ru || null };
    })
  );

  const paid = enriched.filter((r) => r.status === "PAID");
  const totalEarned = paid.reduce((sum, r) => sum + (Number(r.rewardAmount) || REFERRAL_REWARD), 0);

  let myReferrer: { id: string; firstName: string; lastName: string } | null = null;
  if (user.referredBy) {
    const [ref] = await db
      .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName })
      .from(usersTable)
      .where(eq(usersTable.id, user.referredBy))
      .limit(1);
    if (ref) myReferrer = ref;
  }

  const appUrl = process.env.APP_URL || "https://www.gritandgigs.in";

  res.json({
    success: true,
    data: {
      referralCode: code,
      referralLink: `${appUrl}/?ref=${code}`,
      rewardAmount: REFERRAL_REWARD,
      referredCount: enriched.length,
      paidCount: paid.length,
      pendingCount: enriched.length - paid.length,
      totalEarned,
      referred: enriched,
      myReferrer,
    },
  });
});

export default router;
