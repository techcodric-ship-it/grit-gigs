import express, { type Express, type Request, type Response, type NextFunction } from "express";
import compression from "compression";
import cors from "cors";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(
  cors({
    origin: "*",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  }),
);
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Rate limiting — 200 requests/min per IP, 500 for API routes
app.use("/api", rateLimit({ windowMs: 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

// Request timeout — 30s for API, 2min for static files
app.use("/api", (_req, _res, next) => { _req.setTimeout(30000); next(); });

// Serve uploaded files
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

app.use("/api", router);

// Serve frontend static files (public/ folder next to server)
const publicPath = path.join(process.cwd(), "public");
app.use(express.static(publicPath));

// SPA fallback — send index.html for any non-API route
app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    res.status(404).json({ success: false, message: "Route not found" });
    return;
  }
  res.sendFile(path.join(publicPath, "index.html"));
});

// Global JSON error handler — must be last, after all routes
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err, url: req.url, method: req.method }, "Unhandled error");
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode
    ?? 500;
  const safe = (() => {
    if (status < 500) return err.message;
    if (err.message?.toLowerCase().includes("insufficient balance")) return err.message;
    return "Something went wrong. Please try again.";
  })();
  res.status(status).json({ success: false, message: safe });
});

export default app;
