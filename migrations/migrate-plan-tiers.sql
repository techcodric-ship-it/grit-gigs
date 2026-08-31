-- ============================================================
-- Grit&Gigs — Plan tier migration (4-tier -> 3-tier)
-- Old: free / starter / pro / elite
-- New: starter / pro / squad
--
-- Mapping (no data loss):
--   free    -> starter
--   starter -> pro
--   pro     -> pro
--   elite   -> squad
--
-- Run once against the live database (Neon) before/after deploying
-- the new code. This script is IDEMPOTENT and safe to re-run.
-- ============================================================

BEGIN;

-- 1) Weekly project-bid reset marker column (new plan gating)
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS bids_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 2) Guard: if the type is already the new one (starter/pro/squad), skip.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'plan_id' AND e.enumlabel = 'squad'
  ) THEN
    RAISE NOTICE 'plan_id already migrated';
  ELSE
    -- Transform plan_id enum -> text with the value mapping
    ALTER TABLE user_subscriptions
      ALTER COLUMN plan_id DROP DEFAULT,
      ALTER COLUMN plan_id TYPE TEXT USING
        CASE plan_id
          WHEN 'free'    THEN 'starter'
          WHEN 'starter' THEN 'pro'
          WHEN 'elite'   THEN 'squad'
          ELSE 'pro'
        END;

    -- Rebuild the enum type with the new 3-tier values
    DROP TYPE IF EXISTS plan_id;
    CREATE TYPE plan_id AS ENUM ('starter','pro','squad');

    -- Convert column back to the new enum
    ALTER TABLE user_subscriptions
      ALTER COLUMN plan_id TYPE plan_id USING plan_id::plan_id,
      ALTER COLUMN plan_id SET DEFAULT 'starter';
  END IF;
END $$;

-- 3) Sync credit/counter defaults to the new Starter (free) tier
ALTER TABLE user_subscriptions
  ALTER COLUMN proposal_credits_remaining SET DEFAULT 2;

COMMIT;
