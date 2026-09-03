-- ============================================================
-- Grit&Gigs - Project type migration (individual vs squad)
-- Adds a project_type enum column so clients can choose whether
-- a project posts as a squad service or a normal freelancer.
--
-- Idempotent: safe to run multiple times.
--   - Creates the project_type enum if it does not exist.
--   - Adds the project_type column (default 'INDIVIDUAL') if missing.
--   - Backfills existing rows to 'INDIVIDUAL'.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_type') THEN
    CREATE TYPE project_type AS ENUM ('INDIVIDUAL', 'SQUAD');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'projects' AND column_name = 'project_type') THEN
    ALTER TABLE projects ADD COLUMN project_type project_type DEFAULT 'INDIVIDUAL' NOT NULL;
  END IF;
END $$;
