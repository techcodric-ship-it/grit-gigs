import { Router, type IRouter } from "express";
import { z } from "zod";

// Inlined locally — this used to come from a "@workspace/api-zod" package that
// only existed in the original monorepo and was never included in this export.
const HealthCheckResponse = z.object({ status: z.string() });

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
