// Idempotent DDL for prep_ tables. Mirrors the existing bootstrap pattern in
// src/index.ts (CREATE ... IF NOT EXISTS, safe to run on every boot) but lives
// under src/prep/ so src/index.ts is never touched. No existing table or enum
// is altered — migrations here are additive only.

import { pool } from "../db";
import { logger } from "../lib/logger";

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
`;

let ensured: Promise<void> | null = null;

export function ensurePrepDb(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await pool.query(PREP_DDL);
      logger.info("[prep] prep_ tables ensured");
    })().catch((err: unknown) => {
      ensured = null; // retry on next call
      throw err;
    });
  }
  return ensured;
}
