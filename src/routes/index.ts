import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import barterRouter from "./barter";
import servicesRouter from "./services";
import projectsRouter from "./projects";
import ordersRouter from "./orders";
import messagesRouter from "./messages";
import subscriptionsRouter from "./subscriptions";
import clientReviewRouter from "./client-review";
import matchCompleteRouter from "./match-complete";
import savedRouter from "./saved";
import invitesRouter from "./invites";
import milestonesRouter from "./milestones";
import disputesRouter from "./disputes";
import kycRouter from "./kyc";
import creditsRouter from "./credits";
import paymentsRouter from "./payments";
import barterReviewRouter from "./barter-review";
import reportsRouter from "./reports";
import invoiceRouter from "./invoice";
import adminRouter from "./admin";
import equityRouter from "./equity";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(barterRouter);
router.use(servicesRouter);
router.use(projectsRouter);
router.use(ordersRouter);
router.use(clientReviewRouter);
router.use(matchCompleteRouter);
router.use(messagesRouter);

router.use(subscriptionsRouter);
router.use(savedRouter);
router.use(invitesRouter);
router.use(milestonesRouter);
router.use(disputesRouter);
router.use(kycRouter);
router.use(barterReviewRouter);
router.use(reportsRouter);
router.use(creditsRouter);
router.use(paymentsRouter);
router.use(invoiceRouter);
router.use(equityRouter);
router.use(adminRouter);

router.use((_req: any, res: any) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

export default router;
