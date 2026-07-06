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

// Trust Railway proxy so rate-limiter doesn't complain about X-Forwarded-For
app.set("trust proxy", 1);

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
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  }),
);
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Rate limiting — 500 requests/min for API, 200 for everything else
// Register the general limiter first with a skip function for /api routes
app.use(rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false, skip: (req) => req.path.startsWith("/api") }));
app.use("/api", rateLimit({ windowMs: 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false }));

// Request timeout — 30s for API, 2min for static files
app.use("/api", (_req, _res, next) => { _req.setTimeout(30000); next(); });

// Serve uploaded files — with noindex to block Google Images
const rootDir = path.resolve(__dirname, "..");
app.use("/uploads", (_req, res, next) => { res.set("X-Robots-Tag", "noindex"); next(); });
app.use("/uploads", express.static(path.join(rootDir, "uploads")));

app.use("/api", router);

// Serve frontend static files (public/ folder next to server)
const publicPath = path.join(rootDir, "public");

// Clean URL redirect — redirect .html to extensionless URL BEFORE static serves it
app.use((req, res, next) => {
  if (req.path.endsWith(".html")) {
    const clean = req.path.replace(/\.html$/, "");
    const qs = req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : "";
    res.redirect(301, clean + qs);
    return;
  }
  next();
});

app.use(express.static(publicPath));

// Clean URL fallback — serve .html for extensionless requests
app.use((req, res, next) => {
  if (req.path.startsWith("/api") || req.path.includes(".") || req.path === "/") return next();
  const htmlPath = path.join(publicPath, req.path + ".html");
  res.sendFile(htmlPath, (err) => {
    if (err) next();
  });
});

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
