-- ============================================================
-- Grit&Gigs - Project escrow migration
-- Holds the agreed amount in the client's wallet at bid-accept time
-- instead of only checking the balance, so a client cannot accept
-- several bids they cannot all pay for.
--
-- Idempotent: safe to run multiple times.
--   - Adds projects.escrow_amount (0 = nothing held).
--   - Adds projects.escrow_held_at (NULL = nothing held).
--   - Backfills nothing: rows accepted before this change never had
--     funds held, so they keep escrow_amount = 0 and release-payment
--     continues to deduct at release time exactly as before.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'projects' AND column_name = 'escrow_amount') THEN
    ALTER TABLE projects ADD COLUMN escrow_amount integer DEFAULT 0 NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'projects' AND column_name = 'escrow_held_at') THEN
    ALTER TABLE projects ADD COLUMN escrow_held_at timestamp;
  END IF;
END $$;
