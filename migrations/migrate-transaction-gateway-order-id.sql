-- ============================================================
-- Grit&Gigs - Gateway order id on transactions
--
-- Why: transactions.gateway_txn_id held the Razorpay ORDER id while a payment
-- was pending, then was OVERWRITTEN with the PAYMENT id the moment the wallet
-- was credited. Every callback and poll looks the row up by the order id, so a
-- perfectly successful top-up came back as "Transaction not found" (and
-- check-order polled forever). The order id was simply gone.
--
-- Fix: a dedicated, never-overwritten gateway_order_id column.
--   - Adds transactions.gateway_order_id (NULL = no gateway order).
--   - Backfills PENDING rows: while a payment is pending gateway_txn_id still
--     holds the order id, so those rows can be recovered exactly.
--   - COMPLETED rows are NOT backfilled: their order id was already overwritten
--     and is unrecoverable from this table. They need no repair because they are
--     already settled and credited, and every lookup below also matches
--     gateway_txn_id so a replayed callback for one still resolves.
--   - An index on gateway_order_id for the lookups.
--
-- Idempotent: safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'transactions' AND column_name = 'gateway_order_id') THEN
    ALTER TABLE transactions ADD COLUMN gateway_order_id text;
  END IF;
END
$$;

-- Recover the order id for anything still awaiting payment.
UPDATE transactions
   SET gateway_order_id = gateway_txn_id
 WHERE gateway_order_id IS NULL
   AND gateway_txn_id LIKE 'order\_%'
   AND status = 'PENDING';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE tablename = 'transactions' AND indexname = 'transactions_gateway_order_id_idx') THEN
    CREATE INDEX transactions_gateway_order_id_idx
      ON transactions (gateway_order_id);
  END IF;
END
$$;
