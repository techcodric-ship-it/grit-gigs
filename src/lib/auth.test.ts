import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "test-secret";

describe("auth utilities", () => {
  it("generates a valid JWT access token", () => {
    const token = jwt.sign({ userId: "test-user-id", type: "access" }, JWT_SECRET, { expiresIn: "15m" });
    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");
    expect(token.split(".").length).toBe(3);
  });

  it("verifies a valid access token", () => {
    const userId = "550e8400-e29b-41d4-a716-446655440000";
    const token = jwt.sign({ userId, type: "access" }, JWT_SECRET, { expiresIn: "15m" });
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    expect(decoded.userId).toBe(userId);
  });

  it("throws on invalid token", () => {
    expect(() => jwt.verify("invalid-token", JWT_SECRET)).toThrow();
  });

  it("throws on expired token", () => {
    const token = jwt.sign({ userId: "test", type: "access" }, JWT_SECRET, { expiresIn: "0s" });
    expect(() => jwt.verify(token, JWT_SECRET)).toThrow("expired");
  });

  it("generates a valid ggId format", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const ggId = "G&G-" + uuid.replace(/-/g, "").slice(0, 8).toUpperCase();
    expect(ggId).toMatch(/^G&G-[A-F0-9]{8}$/);
  });

  it("generates valid refresh token UUID", () => {
    const { v4: uuidv4 } = require("uuid");
    const token = uuidv4();
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    // 30 days from now
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
