import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db";
import { refreshTokensTable, usersTable } from "../db";
import { eq, and, gt } from "drizzle-orm";
import { logger } from "./logger";

const JWT_SECRET = process.env["JWT_SECRET"] ?? "fallback-secret-change-me";
const JWT_EXPIRES_IN = process.env["JWT_EXPIRES_IN"] ?? "15m";

export function generateAccessToken(userId: string): string {
  return jwt.sign({ userId, type: "access" }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export async function generateRefreshToken(userId: string): Promise<string> {
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.insert(refreshTokensTable).values({ userId, token, expiresAt });
  return token;
}

export function verifyAccessToken(token: string): { userId: string } {
  return jwt.verify(token, JWT_SECRET) as { userId: string };
}

export async function rotateRefreshToken(
  oldToken: string,
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const [stored] = await db
    .select()
    .from(refreshTokensTable)
    .where(
      and(
        eq(refreshTokensTable.token, oldToken),
        gt(refreshTokensTable.expiresAt, new Date()),
      ),
    );

  if (!stored) {
    await db
      .delete(refreshTokensTable)
      .where(eq(refreshTokensTable.token, oldToken));
    throw new Error("Invalid or expired refresh token");
  }

  await db
    .delete(refreshTokensTable)
    .where(eq(refreshTokensTable.token, oldToken));

  const newToken = await generateRefreshToken(stored.userId);
  const accessToken = generateAccessToken(stored.userId);

  return { accessToken, refreshToken: newToken, userId: stored.userId };
}

export async function deleteAllRefreshTokens(userId: string): Promise<void> {
  await db
    .delete(refreshTokensTable)
    .where(eq(refreshTokensTable.userId, userId));
}
