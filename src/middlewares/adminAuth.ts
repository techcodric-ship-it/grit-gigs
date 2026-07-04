import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-admin-key"] as string | undefined;
  if (!key) {
    res.status(401).json({ success: false, message: "Invalid or missing admin key" });
    return;
  }
  // Backward compat: allow the raw ADMIN_API_KEY
  if (key === process.env.ADMIN_API_KEY) {
    return next();
  }
  // New flow: verify as JWT
  const rawSecret = process.env["JWT_SECRET"];
  if (!rawSecret) {
    res.status(500).json({ success: false, message: "JWT_SECRET not configured" });
    return;
  }
  try {
    const payload = jwt.verify(key, rawSecret) as { role?: string };
    if (payload.role !== "admin") {
      res.status(401).json({ success: false, message: "Invalid or missing admin key" });
      return;
    }
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid or missing admin key" });
  }
}
