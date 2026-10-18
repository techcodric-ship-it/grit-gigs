// Idempotent DDL for prep_ tables. Mirrors the existing bootstrap pattern in
// src/index.ts (CREATE ... IF NOT EXISTS, safe to run on every boot) but lives
// under src/prep/ so src/index.ts is never touched. No existing table or enum
// is altered — migrations here are additive only.

import { pool } from "../db";
import { logger } from "../lib/logger";
import { APTITUDE_BANK } from "./aptitude-bank";

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
`;

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

let ensured: Promise<void> | null = null;

export function ensurePrepDb(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await pool.query(PREP_DDL);
      await seedAptitudeBank();
      logger.info("[prep] prep_ tables ensured");
    })().catch((err: unknown) => {
      ensured = null; // retry on next call
      throw err;
    });
  }
  return ensured;
}
