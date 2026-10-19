// Idempotent DDL for prep_ tables. Mirrors the existing bootstrap pattern in
// src/index.ts (CREATE ... IF NOT EXISTS, safe to run on every boot) but lives
// under src/prep/ so src/index.ts is never touched. No existing table or enum
// is altered — migrations here are additive only.

import { pool } from "../db";
import { logger } from "../lib/logger";
import { deleteFromSupabase } from "../lib/storage";
import { APTITUDE_BANK } from "./aptitude-bank";
import { INTERVIEW_BANK } from "./interview-bank";

export const PREP_DDL = `
CREATE TABLE IF NOT EXISTS prep_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(160) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  domain VARCHAR(200),
  website TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  verified_claimed_by UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS prep_companies_name_idx ON prep_companies (LOWER(name));
CREATE INDEX IF NOT EXISTS prep_companies_domain_idx ON prep_companies (LOWER(domain));
CREATE TABLE IF NOT EXISTS prep_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES prep_companies(id),
  role VARCHAR(120),
  user_type VARCHAR(40),
  sections JSONB NOT NULL DEFAULT '{}',
  ai_summary TEXT,
  ai_model VARCHAR(80),
  source_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS prep_reports_company_idx ON prep_reports (company_id, created_at DESC);
CREATE TABLE IF NOT EXISTS prep_aptitude_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(64) NOT NULL UNIQUE,
  topic VARCHAR(40) NOT NULL,
  difficulty VARCHAR(10) NOT NULL DEFAULT 'medium',
  question TEXT NOT NULL,
  options TEXT[] NOT NULL,
  correct_idx INTEGER NOT NULL CHECK (correct_idx >= 0 AND correct_idx < array_length(options, 1)),
  explanation TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS prep_aptitude_topic_idx ON prep_aptitude_questions (topic);
CREATE TABLE IF NOT EXISTS prep_interview_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(64) NOT NULL UNIQUE,
  track VARCHAR(30) NOT NULL,
  category VARCHAR(30) NOT NULL,
  difficulty VARCHAR(10) NOT NULL DEFAULT 'medium',
  question TEXT NOT NULL,
  guidance TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS prep_interview_track_idx ON prep_interview_questions (track, category);
CREATE TABLE IF NOT EXISTS prep_proof_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES prep_companies(id),
  kind VARCHAR(40) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  file_path TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  review_note TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  submitted_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  file_deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS prep_proof_status_idx ON prep_proof_submissions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS prep_proof_company_idx ON prep_proof_submissions (company_id, status);
CREATE INDEX IF NOT EXISTS prep_proof_expiry_idx ON prep_proof_submissions (expires_at) WHERE file_path IS NOT NULL;
CREATE TABLE IF NOT EXISTS prep_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  kind VARCHAR(40) NOT NULL DEFAULT 'PREP_PRO',
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  price_paid_inr INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS prep_entitlements_active_uniq
  ON prep_entitlements (user_id, kind) WHERE status = 'ACTIVE';
CREATE TABLE IF NOT EXISTS prep_credit_awards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  reason VARCHAR(160) NOT NULL,
  amount_inr INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS prep_credit_awards_reason_uniq ON prep_credit_awards (reason);
CREATE TABLE IF NOT EXISTS prep_ai_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  role_key VARCHAR(160) NOT NULL DEFAULT '',
  plan JSONB NOT NULL,
  model VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS prep_ai_plans_key_uniq ON prep_ai_plans (company_id, role_key);
CREATE TABLE IF NOT EXISTS prep_ai_plan_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS prep_ai_plan_requests_user_idx ON prep_ai_plan_requests (user_id, created_at DESC);
`;

/** Raw evidence is deleted after 30 days (spec): drop the stored file, keep
 * only the de-identified metadata row. Retention runs on an interval and
 * retries failed deletes next sweep (file_path stays set until removal). */
export async function runEvidenceRetention(): Promise<number> {
  const { rows } = await pool.query<{ id: string; file_path: string }>(
    `SELECT id, file_path FROM prep_proof_submissions
     WHERE file_path IS NOT NULL AND expires_at < NOW()`,
  );
  let removed = 0;
  for (const row of rows) {
    try {
      await deleteFromSupabase(row.file_path);
      await pool.query(
        `UPDATE prep_proof_submissions SET file_path = NULL, file_deleted_at = NOW() WHERE id = $1`,
        [row.id],
      );
      removed++;
    } catch (err) {
      logger.warn({ err, id: row.id }, "[prep] evidence retention delete failed — will retry next sweep");
    }
  }
  if (removed > 0) logger.info({ removed }, "[prep] evidence retention removed expired files");
  return removed;
}

/** Idempotent seed of the original aptitude bank (ON CONFLICT DO NOTHING). */
async function seedAptitudeBank(): Promise<void> {
  for (const q of APTITUDE_BANK) {
    await pool.query(
      `INSERT INTO prep_aptitude_questions (code, topic, difficulty, question, options, correct_idx, explanation)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (code) DO NOTHING`,
      [q.code, q.topic, q.difficulty, q.question, q.options, q.correctIdx, q.explanation],
    );
  }
}

/** Idempotent seed of the original interview bank. */
async function seedInterviewBank(): Promise<void> {
  for (const q of INTERVIEW_BANK) {
    await pool.query(
      `INSERT INTO prep_interview_questions (code, track, category, difficulty, question, guidance)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) DO NOTHING`,
      [q.code, q.track, q.category, q.difficulty, q.question, q.guidance],
    );
  }
}

let ensured: Promise<void> | null = null;

export function ensurePrepDb(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await pool.query(PREP_DDL);
      await seedAptitudeBank();
      await seedInterviewBank();
      logger.info("[prep] prep_ tables ensured");
      // 6-hourly evidence retention sweep; guarded so restarts/retries never
      // stack timers (ensurePrepDb resolves once per process).
      const timer = setInterval(() => {
        runEvidenceRetention().catch((err: unknown) =>
          logger.warn({ err }, "[prep] evidence retention sweep failed"),
        );
      }, 6 * 60 * 60 * 1000);
      timer.unref?.();
    })().catch((err: unknown) => {
      ensured = null; // retry on next call
      throw err;
    });
  }
  return ensured;
}
