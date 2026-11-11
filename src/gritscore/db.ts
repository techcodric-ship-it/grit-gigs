// Idempotent DDL + DB helpers for GritScore. Mirrors the prep pattern: additive
// CREATE ... IF NOT EXISTS on first use, so production never depends on a
// migration having been run before deploy.

import { and, asc, count, desc, eq, gt, gte, sql } from "drizzle-orm";
import { db, pool, notificationsTable, transactionsTable } from "../db";
import { logger } from "../lib/logger";
import { deleteFromSupabase } from "../lib/storage";
import {
  DEFAULT_CONFIG,
  DEFAULT_WEIGHTS,
  GRITSCORE_PRO,
  type ScoreConfig,
  type ScoreWeights,
} from "./config";
import {
  gritscoreConfigTable,
  gritscoreEntitlementsTable,
  gritscoreItemsTable,
  gritscoreRefereesTable,
  gritscoreReviewsTable,
  gritscoreScansTable,
  type GritScoreEntitlement,
  type GritScoreReview,
  type GritScoreScan,
} from "./schema";

export const GRITSCORE_DDL = `
CREATE TABLE IF NOT EXISTS gritscore_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  slug VARCHAR(80) NOT NULL UNIQUE,
  display_name VARCHAR(120),
  headline VARCHAR(200),
  status VARCHAR(20) NOT NULL DEFAULT 'READY',
  resume_text TEXT,
  resume_stored BOOLEAN NOT NULL DEFAULT FALSE,
  extracted JSONB,
  summary TEXT,
  score INTEGER,
  raw_score INTEGER,
  tier VARCHAR(20),
  verification_tier VARCHAR(30) NOT NULL DEFAULT 'self_reported',
  components JSONB,
  tips JSONB,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  show_exact_score BOOLEAN NOT NULL DEFAULT FALSE,
  template VARCHAR(30) NOT NULL DEFAULT 'violet',
  ai_used BOOLEAN NOT NULL DEFAULT FALSE,
  abuse_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gritscore_scans_user_idx ON gritscore_scans (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gritscore_scans_public_idx ON gritscore_scans (is_public) WHERE is_public = TRUE;

CREATE TABLE IF NOT EXISTS gritscore_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL REFERENCES gritscore_scans(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  role VARCHAR(160),
  start_date VARCHAR(10),
  end_date VARCHAR(10),
  evidence_type VARCHAR(20) NOT NULL DEFAULT 'none',
  proof_url TEXT,
  proof_file_url TEXT,
  proof_file_name VARCHAR(255),
  evidence_status VARCHAR(20) NOT NULL DEFAULT 'unchecked',
  evidence_note VARCHAR(200),
  skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  has_quantified_impact BOOLEAN NOT NULL DEFAULT FALSE,
  impact_notes TEXT,
  complexity INTEGER NOT NULL DEFAULT 1,
  clarity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gritscore_items_scan_idx ON gritscore_items (scan_id, position);

CREATE TABLE IF NOT EXISTS gritscore_referees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL REFERENCES gritscore_scans(id) ON DELETE CASCADE,
  item_id UUID REFERENCES gritscore_items(id) ON DELETE CASCADE,
  token VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(120),
  email VARCHAR(255),
  phone VARCHAR(30),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gritscore_referees_scan_idx ON gritscore_referees (scan_id);

CREATE TABLE IF NOT EXISTS gritscore_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL REFERENCES gritscore_scans(id) ON DELETE CASCADE,
  reviewer_user_id UUID,
  reviewer_name VARCHAR(120) NOT NULL,
  reviewer_email VARCHAR(255),
  stars INTEGER NOT NULL,
  comment TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'VISIBLE',
  ip_hash VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gritscore_reviews_scan_idx ON gritscore_reviews (scan_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS gritscore_reviews_user_uniq
  ON gritscore_reviews (scan_id, reviewer_user_id) WHERE reviewer_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS gritscore_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  kind VARCHAR(40) NOT NULL DEFAULT 'GRITSCORE_PRO',
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  price_paid_inr INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS gritscore_entitlements_active_uniq
  ON gritscore_entitlements (user_id, kind) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS gritscore_config (
  id VARCHAR(20) PRIMARY KEY,
  weights JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

let ensured: Promise<void> | null = null;

export function ensureGritScoreDb(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await pool.query(GRITSCORE_DDL);
      logger.info("[gritscore] tables ensured");
    })().catch((err: unknown) => {
      ensured = null;
      throw err;
    });
  }
  return ensured;
}

// ---- Entitlement -----------------------------------------------------------

export function isProActive(row: Pick<GritScoreEntitlement, "status" | "expiresAt"> | null | undefined, now: Date = new Date()): boolean {
  if (!row || row.status !== "ACTIVE") return false;
  const expires = row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
  return expires.getTime() > now.getTime();
}

export function proExpiryFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + GRITSCORE_PRO.days * 24 * 60 * 60 * 1000);
}

export async function getActiveGritScorePro(userId: string): Promise<GritScoreEntitlement | null> {
  const rows = await db
    .select()
    .from(gritscoreEntitlementsTable)
    .where(
      and(
        eq(gritscoreEntitlementsTable.userId, userId),
        eq(gritscoreEntitlementsTable.kind, "GRITSCORE_PRO"),
        eq(gritscoreEntitlementsTable.status, "ACTIVE"),
        gt(gritscoreEntitlementsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function countUserScans(userId: string): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(gritscoreScansTable)
    .where(eq(gritscoreScansTable.userId, userId));
  return Number(rows[0]?.c ?? 0);
}

export async function countScansLastHour(userId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const rows = await db
    .select({ c: count() })
    .from(gritscoreScansTable)
    .where(and(eq(gritscoreScansTable.userId, userId), gte(gritscoreScansTable.createdAt, since)));
  return Number(rows[0]?.c ?? 0);
}

export type GritScoreOrderRow = {
  id: string;
  userId: string;
  amount: number;
  status: string;
  description: string | null;
};

export async function createGritScorePendingOrder(userId: string, gatewayOrderId: string): Promise<void> {
  await db.insert(transactionsTable).values({
    userId,
    type: "SUBSCRIPTION",
    amount: GRITSCORE_PRO.priceInr,
    paymentMethod: "razorpay",
    description: `GRITSCORE_PRO:${GRITSCORE_PRO.name} - ${GRITSCORE_PRO.days} days`,
    status: "PENDING",
    gatewayOrderId,
    gatewayTxnId: gatewayOrderId,
  });
}

export async function findGritScoreOrder(gatewayOrderId: string, userId: string): Promise<GritScoreOrderRow | null> {
  const rows = await db
    .select({
      id: transactionsTable.id,
      userId: transactionsTable.userId,
      amount: transactionsTable.amount,
      status: transactionsTable.status,
      description: transactionsTable.description,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.gatewayOrderId, gatewayOrderId),
        eq(transactionsTable.userId, userId),
        eq(transactionsTable.type, "SUBSCRIPTION"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || !row.description || !row.description.startsWith("GRITSCORE_PRO:")) return null;
  return row;
}

export async function completeGritScoreOrder(
  userId: string,
  gatewayOrderId: string,
  gatewayTxnId: string,
): Promise<{ ok: true; entitlement: GritScoreEntitlement } | { ok: false; reason: "already-active" | "stale-order" }> {
  const markCompleted = async (tx: typeof db): Promise<boolean> => {
    const done = await tx
      .update(transactionsTable)
      .set({ status: "COMPLETED", gatewayTxnId })
      .where(
        and(
          eq(transactionsTable.gatewayOrderId, gatewayOrderId),
          eq(transactionsTable.userId, userId),
          eq(transactionsTable.status, "PENDING"),
        ),
      )
      .returning();
    return done.length > 0;
  };
  try {
    return await db.transaction(async (tx): Promise<
      { ok: true; entitlement: GritScoreEntitlement } | { ok: false; reason: "already-active" | "stale-order" }
    > => {
      if (!(await markCompleted(tx as unknown as typeof db))) return { ok: false, reason: "stale-order" };
      const now = new Date();
      const inserted = await tx
        .insert(gritscoreEntitlementsTable)
        .values({
          userId,
          kind: "GRITSCORE_PRO",
          status: "ACTIVE",
          pricePaidInr: GRITSCORE_PRO.priceInr,
          startedAt: now,
          expiresAt: proExpiryFrom(now),
        })
        .returning();
      const entitlement = inserted[0];
      if (!entitlement) return { ok: false, reason: "already-active" };
      return { ok: true, entitlement };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      await db
        .update(transactionsTable)
        .set({ status: "COMPLETED", gatewayTxnId })
        .where(
          and(
            eq(transactionsTable.gatewayOrderId, gatewayOrderId),
            eq(transactionsTable.userId, userId),
            eq(transactionsTable.status, "PENDING"),
          ),
        );
      return { ok: false, reason: "already-active" };
    }
    throw err;
  }
}

export async function notifyGritScorePro(userId: string, expiresAt: Date): Promise<void> {
  await db.insert(notificationsTable).values({
    userId,
    type: "GRITSCORE_PRO",
    title: "GritScore Pro is active",
    message: `Your scorecards are now watermark-free with full breakdowns until ${expiresAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}.`,
    linkUrl: "/gritscore",
  });
}

// ---- Weights config --------------------------------------------------------

const WEIGHT_KEYS: (keyof ScoreWeights)[] = ["proof", "skillDepth", "impact", "consistency", "clarity"];

/** Accept a stored override only when every weight is a finite, non-negative
 *  number and the five sum to 1. Anything else silently keeps the defaults so
 *  a bad admin write can never produce scores outside 300-900. */
export function mergeWeights(stored: Record<string, unknown> | null | undefined): ScoreWeights {
  if (!stored) return { ...DEFAULT_WEIGHTS };
  const out = {} as ScoreWeights;
  let sum = 0;
  for (const key of WEIGHT_KEYS) {
    const value = Number(stored[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1) return { ...DEFAULT_WEIGHTS };
    out[key] = value;
    sum += value;
  }
  if (Math.abs(sum - 1) > 0.001) return { ...DEFAULT_WEIGHTS };
  return out;
}

let configCache: { at: number; config: ScoreConfig } | null = null;

export async function getScoreConfig(): Promise<ScoreConfig> {
  if (configCache && Date.now() - configCache.at < 60_000) return configCache.config;
  let weights: ScoreWeights = { ...DEFAULT_WEIGHTS };
  try {
    const [row] = await db.select().from(gritscoreConfigTable).where(eq(gritscoreConfigTable.id, "default")).limit(1);
    weights = mergeWeights(row?.weights ?? null);
  } catch (err) {
    logger.warn({ err }, "[gritscore] config read failed, using defaults");
  }
  const config: ScoreConfig = { ...DEFAULT_CONFIG, weights };
  configCache = { at: Date.now(), config };
  return config;
}

/** Strict validation for an admin write. Returns null instead of silently
 *  substituting defaults, so the API can answer 400 with a useful message. */
export function validateWeights(raw: unknown): ScoreWeights | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const out = {} as ScoreWeights;
  for (const key of WEIGHT_KEYS) {
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1) return null;
    out[key] = value;
  }
  const sum = WEIGHT_KEYS.reduce((acc, key) => acc + out[key], 0);
  if (Math.abs(sum - 1) > 0.001) return null;
  return out;
}

export async function saveScoreWeights(weights: ScoreWeights): Promise<ScoreWeights> {
  const clean: Record<string, number> = { proof: weights.proof, skillDepth: weights.skillDepth, impact: weights.impact, consistency: weights.consistency, clarity: weights.clarity };
  await db
    .insert(gritscoreConfigTable)
    .values({ id: "default", weights: clean, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: gritscoreConfigTable.id,
      set: { weights: clean, updatedAt: new Date() },
    });
  configCache = null;
  return weights;
}

// ---- Queries ---------------------------------------------------------------

export async function findScanBySlug(slug: string): Promise<GritScoreScan | null> {
  const rows = await db.select().from(gritscoreScansTable).where(eq(gritscoreScansTable.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function findScanById(id: string): Promise<GritScoreScan | null> {
  const rows = await db.select().from(gritscoreScansTable).where(eq(gritscoreScansTable.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listItems(scanId: string) {
  return db
    .select()
    .from(gritscoreItemsTable)
    .where(eq(gritscoreItemsTable.scanId, scanId))
    .orderBy(asc(gritscoreItemsTable.position));
}

export async function listScansForUser(userId: string) {
  return db
    .select()
    .from(gritscoreScansTable)
    .where(eq(gritscoreScansTable.userId, userId))
    .orderBy(desc(gritscoreScansTable.createdAt));
}

export async function listReferees(scanId: string) {
  return db
    .select()
    .from(gritscoreRefereesTable)
    .where(eq(gritscoreRefereesTable.scanId, scanId))
    .orderBy(asc(gritscoreRefereesTable.createdAt));
}

export async function countConfirmedReferees(scanId: string): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(gritscoreRefereesTable)
    .where(and(eq(gritscoreRefereesTable.scanId, scanId), eq(gritscoreRefereesTable.status, "CONFIRMED")));
  return Number(rows[0]?.c ?? 0);
}

export async function listVisibleReviews(scanId: string): Promise<GritScoreReview[]> {
  return db
    .select()
    .from(gritscoreReviewsTable)
    .where(and(eq(gritscoreReviewsTable.scanId, scanId), eq(gritscoreReviewsTable.status, "VISIBLE")))
    .orderBy(desc(gritscoreReviewsTable.createdAt))
    .limit(50);
}

export async function reviewStats(scanId: string): Promise<{ count: number; average: number }> {
  const rows = await db
    .select({ c: count(), avg: sql<number>`COALESCE(AVG(${gritscoreReviewsTable.stars}), 0)` })
    .from(gritscoreReviewsTable)
    .where(and(eq(gritscoreReviewsTable.scanId, scanId), eq(gritscoreReviewsTable.status, "VISIBLE")));
  const row = rows[0];
  return { count: Number(row?.c ?? 0), average: Math.round(Number(row?.avg ?? 0) * 10) / 10 };
}

/** Remove every trace of a scan: proof files first, then the row (FK cascades
 *  items, referees and reviews). Resume text lives on the row and goes with it. */
export async function deleteScanData(scan: GritScoreScan): Promise<void> {
  const items = await listItems(scan.id);
  for (const item of items) {
    if (item.proofFileUrl) {
      try {
        await deleteFromSupabase(item.proofFileUrl);
      } catch {
        /* local file or already gone */
      }
    }
  }
  await db.delete(gritscoreScansTable).where(eq(gritscoreScansTable.id, scan.id));
}
