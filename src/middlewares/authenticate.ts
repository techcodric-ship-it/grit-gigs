import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../lib/auth";
import { db, usersTable } from "../db";
import { eq } from "drizzle-orm";

const _userCache = new Map<string, { user: Express.User; expires: number }>();
const CACHE_TTL = 30_000;

function _ggId(id: string): string {
  return 'G&G-' + id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

declare global {
  namespace Express {
    interface User {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
      role: "USER" | "ADMIN" | "MODERATOR";
      profilePhoto: string | null;
      city: string | null;
      reputationScore: number;
      isActive: boolean;
      ggId: string;
    }
    interface Request {
      user?: User;
    }
  }
}

async function _fetchUser(userId: string): Promise<Express.User | null> {
  const now = Date.now();
  const cached = _userCache.get(userId);
  if (cached && cached.expires > now) return cached.user;
  const [user] = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      email: usersTable.email,
      role: usersTable.role,
      profilePhoto: usersTable.profilePhoto,
      city: usersTable.city,
      reputationScore: usersTable.reputationScore,
      isActive: usersTable.isActive,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user) return null;
  const enriched = { ...user, ggId: _ggId(user.id) };
  _userCache.set(userId, { user: enriched, expires: now + CACHE_TTL });
  return enriched;
}

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return;
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return;
  }

  try {
    const decoded = verifyAccessToken(token);
    const user = await _fetchUser(decoded.userId);

    if (!user) {
      res.status(401).json({ success: false, message: "User not found" });
      return;
    }
    if (!user.isActive) {
      res.status(403).json({ success: false, message: "Account is deactivated" });
      return;
    }

    req.user = user;
    next();
  } catch (err: unknown) {
    const message =
      err instanceof Error && err.name === "TokenExpiredError"
        ? "Token expired"
        : "Invalid token";
    res.status(401).json({ success: false, message });
  }
}

export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    if (token) {
      try {
        const decoded = verifyAccessToken(token);
        const user = await _fetchUser(decoded.userId);
        if (user?.isActive) req.user = user;
      } catch {
        // ignore
      }
    }
  }
  next();
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return;
  }
  if (req.user.role !== "ADMIN") {
    res.status(403).json({ success: false, message: "Admin access required" });
    return;
  }
  next();
}
