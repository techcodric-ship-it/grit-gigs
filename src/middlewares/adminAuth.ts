import type { Request, Response, NextFunction } from "express";

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-admin-key"] as string | undefined;
  if (!key || key !== process.env.ADMIN_API_KEY) {
    res.status(401).json({ success: false, message: "Invalid or missing admin key" });
    return;
  }
  next();
}
