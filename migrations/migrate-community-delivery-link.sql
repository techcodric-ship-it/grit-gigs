-- ============================================================
-- Grit&Gigs - Community delivery link
-- Lets a seller attach a deliverable link (Drive/Dropbox/portfolio)
-- when delivering a community order, separate from the free-text note.
--
-- Idempotent: safe to run multiple times.
--   - Adds the community_order_deliveries.link column if missing.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'community_order_deliveries' AND column_name = 'link') THEN
    ALTER TABLE community_order_deliveries ADD COLUMN link text;
  END IF;
END $$;
