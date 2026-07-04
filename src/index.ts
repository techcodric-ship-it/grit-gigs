import "dotenv/config";
import http from "http";
import app from "./app";
import { setupSocket } from "./lib/socket";
import { logger } from "./lib/logger";
import { pool } from "./db";
import { ensureBucket } from "./lib/storage";

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection — exiting");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — exiting");
  process.exit(1);
});

function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down gracefully");
  httpServer.close(() => {
    logger.info("HTTP server closed");
    pool.end().then(() => {
      logger.info("DB pool closed");
      process.exit(0);
    }).catch((err) => {
      logger.error({ err }, "Error closing DB pool");
      process.exit(1);
    });
  });
  // Force exit after 10s if graceful shutdown hangs
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const rawPort = process.env["PORT"];
if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = http.createServer(app);
const io = setupSocket(httpServer);
app.set("io", io);

(async function _autoMigrate() {
  try {
    const client = await pool.connect();
    try {
        // ── ENUMs ──────────────────────────────────────────────────────────────
        logger.info("migrate: creating enums...");
        await client.query(`
          DO $$ BEGIN CREATE TYPE user_role AS ENUM ('USER','ADMIN','MODERATOR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE transaction_type AS ENUM ('CREDIT_PURCHASE','CREDIT_WITHDRAWAL','SERVICE_PAYMENT','SERVICE_EARNING','COMMISSION','REFUND'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE txn_status AS ENUM ('PENDING','COMPLETED','FAILED','REFUNDED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE withdrawal_status AS ENUM ('PENDING','PROCESSING','COMPLETED','FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE barter_status AS ENUM ('ACTIVE','MATCHED','IN_PROGRESS','COMPLETED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE match_status AS ENUM ('PENDING','ACCEPTED','IN_PROGRESS','DELIVERED','COMPLETED','CANCELLED','REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE service_status AS ENUM ('ACTIVE','PAUSED','DELETED','PENDING_REVIEW'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE order_status AS ENUM ('PENDING','ACCEPTED','IN_PROGRESS','DELIVERED','REVISION_REQUESTED','COMPLETED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE project_status AS ENUM ('OPEN','IN_PROGRESS','DELIVERED','REVISION_REQUESTED','COMPLETED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          ALTER TYPE project_status ADD VALUE IF NOT EXISTS 'DELIVERED';
          ALTER TYPE project_status ADD VALUE IF NOT EXISTS 'REVISION_REQUESTED';
          DO $$ BEGIN CREATE TYPE bid_status AS ENUM ('PENDING','ACCEPTED','REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE plan_id AS ENUM ('free','starter','pro','elite'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE dispute_status AS ENUM ('OPEN','UNDER_REVIEW','RESOLVED_BUYER','RESOLVED_SELLER','CLOSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE saved_item_type AS ENUM ('SERVICE','PROJECT','BARTER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE dispute_target AS ENUM ('ORDER','PROJECT','BARTER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE invite_target_type AS ENUM ('PROJECT','SERVICE','BARTER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE invite_status AS ENUM ('PENDING','ACCEPTED','DECLINED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE report_target_type AS ENUM ('USER','SERVICE','BARTER','PROJECT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE report_status AS ENUM ('OPEN','RESOLVED','DISMISSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE kyc_status AS ENUM ('PENDING','APPROVED','REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        `);
        logger.info("migrate: enums ready");

      // ── TABLES (all IF NOT EXISTS — safe to run repeatedly) ───────────────
      logger.info("migrate: creating tables...");
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role user_role NOT NULL DEFAULT 'USER',
            profile_photo TEXT,
            bio TEXT,
            tagline TEXT,
            city TEXT,
            country TEXT,
            skills_offered TEXT[] DEFAULT '{}',
            skills_needed TEXT[] DEFAULT '{}',
            languages TEXT[] DEFAULT '{}',
            is_available BOOLEAN DEFAULT TRUE,
            hourly_rate NUMERIC(10,2),
            portfolio_links TEXT[] DEFAULT '{}',
            social_links JSONB DEFAULT '{}',
            reputation_score NUMERIC(4,2) DEFAULT 0,
            email_verified BOOLEAN DEFAULT FALSE,
            kyc_verified BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS refresh_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token TEXT NOT NULL UNIQUE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS password_resets (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token TEXT NOT NULL UNIQUE,
            expires_at TIMESTAMPTZ NOT NULL,
            used BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS notifications (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            data JSONB DEFAULT '{}',
            read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS user_subscriptions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            plan_id plan_id NOT NULL DEFAULT 'free',
            started_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            expires_at TIMESTAMPTZ,
            proposal_credits_remaining INTEGER NOT NULL DEFAULT 3,
            featured_proposals_remaining INTEGER NOT NULL DEFAULT 0,
            credits_reset_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS freelance_wallets (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            balance NUMERIC(12,2) NOT NULL DEFAULT 0,
            total_earned NUMERIC(12,2) NOT NULL DEFAULT 0,
            total_withdrawn NUMERIC(12,2) NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS withdrawal_requests (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            amount NUMERIC(12,2) NOT NULL,
            status withdrawal_status NOT NULL DEFAULT 'PENDING',
            upi_id TEXT,
            bank_account JSONB,
            notes TEXT,
            processed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS transactions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type transaction_type NOT NULL,
            amount NUMERIC(12,2) NOT NULL,
            status txn_status NOT NULL DEFAULT 'PENDING',
            reference_id TEXT,
            description TEXT,
            metadata JSONB DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS services (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            category TEXT NOT NULL,
            subcategory TEXT,
            tags TEXT[] DEFAULT '{}',
            thumbnail TEXT,
            gallery TEXT[] DEFAULT '{}',
            status service_status NOT NULL DEFAULT 'ACTIVE',
            delivery_days INTEGER NOT NULL DEFAULT 3,
            revision_count INTEGER NOT NULL DEFAULT 1,
            starting_price NUMERIC(10,2),
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS service_packages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT,
            price NUMERIC(10,2) NOT NULL,
            delivery_days INTEGER NOT NULL,
            revision_count INTEGER NOT NULL DEFAULT 1,
            features TEXT[] DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS orders (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            service_id UUID REFERENCES services(id) ON DELETE SET NULL,
            package_id UUID REFERENCES service_packages(id) ON DELETE SET NULL,
            buyer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            status order_status NOT NULL DEFAULT 'PENDING',
            price NUMERIC(10,2) NOT NULL,
            requirements TEXT,
            deadline TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            cancelled_at TIMESTAMPTZ,
            cancel_reason TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS order_deliveries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            message TEXT,
            files TEXT[] DEFAULT '{}',
            is_final BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS reviews (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
            reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            reviewee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
            comment TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS barter_reviews (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            match_id UUID NOT NULL REFERENCES barter_matches(id) ON DELETE CASCADE,
            reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            reviewee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
            comment TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS client_reviews (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
            reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            reviewee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
            comment TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS projects (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            client_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            category TEXT NOT NULL,
            skills_required TEXT[] DEFAULT '{}',
            budget_min NUMERIC(10,2),
            budget_max NUMERIC(10,2),
            deadline TIMESTAMPTZ,
            status project_status NOT NULL DEFAULT 'OPEN',
            hired_freelancer_id UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS project_bids (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            freelancer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            amount NUMERIC(10,2) NOT NULL,
            delivery_days INTEGER NOT NULL,
            proposal TEXT NOT NULL,
            status bid_status NOT NULL DEFAULT 'PENDING',
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS barter_requests (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            skill_offered TEXT NOT NULL,
            skill_needed TEXT NOT NULL,
            offer_category TEXT,
            need_category TEXT,
            description TEXT,
            timeline TEXT NOT NULL DEFAULT 'Flexible',
            city TEXT,
            is_remote BOOLEAN NOT NULL DEFAULT TRUE,
            image_url TEXT,
            status barter_status NOT NULL DEFAULT 'ACTIVE',
            view_count INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS barter_matches (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            request1_id UUID NOT NULL REFERENCES barter_requests(id) ON DELETE CASCADE,
            request2_id UUID NOT NULL REFERENCES barter_requests(id) ON DELETE CASCADE,
            user1_id UUID NOT NULL REFERENCES users(id),
            user2_id UUID NOT NULL REFERENCES users(id),
            status match_status NOT NULL DEFAULT 'PENDING',
            confirmed_by_user1 BOOLEAN NOT NULL DEFAULT FALSE,
            confirmed_by_user2 BOOLEAN NOT NULL DEFAULT FALSE,
            delivered_by_user1 BOOLEAN NOT NULL DEFAULT FALSE,
            delivered_by_user2 BOOLEAN NOT NULL DEFAULT FALSE,
            accepted_by_user1 BOOLEAN NOT NULL DEFAULT FALSE,
            accepted_by_user2 BOOLEAN NOT NULL DEFAULT FALSE,
            revised_by_user1 BOOLEAN NOT NULL DEFAULT FALSE,
            revised_by_user2 BOOLEAN NOT NULL DEFAULT FALSE,
            completed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS barter_deliveries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            match_id UUID NOT NULL REFERENCES barter_matches(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            delivery_note TEXT,
            link TEXT,
            revision_number INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS conversations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user1_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            user2_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
            match_id UUID REFERENCES barter_matches(id) ON DELETE SET NULL,
            project_bid_id UUID REFERENCES project_bids(id) ON DELETE SET NULL,
            last_message_at TIMESTAMPTZ DEFAULT NOW(),
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            UNIQUE(user1_id, user2_id)
          );

          CREATE TABLE IF NOT EXISTS messages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message_text TEXT,
            file_url TEXT,
            file_name TEXT,
            read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS saved_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            service_id UUID REFERENCES services(id) ON DELETE CASCADE,
            project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS project_invites (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            client_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            freelancer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS project_milestones (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            description TEXT,
            amount NUMERIC(10,2),
            due_date TIMESTAMPTZ,
            completed BOOLEAN DEFAULT FALSE,
            completed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS disputes (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
            raised_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            against UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            reason TEXT NOT NULL,
            status dispute_status NOT NULL DEFAULT 'OPEN',
            resolution TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS kyc_documents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            document_type TEXT NOT NULL,
            document_url TEXT NOT NULL,
            status kyc_status NOT NULL DEFAULT 'PENDING',
            reviewed_at TIMESTAMPTZ,
            notes TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS saved_searches (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            query TEXT NOT NULL,
            filters JSONB DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS invites (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            target_type invite_target_type NOT NULL,
            target_id UUID NOT NULL,
            from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message TEXT,
            status invite_status DEFAULT 'PENDING' NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );

          CREATE TABLE IF NOT EXISTS reports (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            target_type report_target_type NOT NULL,
            target_id UUID NOT NULL,
            reported_by_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            reason TEXT NOT NULL,
            status report_status DEFAULT 'OPEN' NOT NULL,
            admin_notes TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );
          CREATE TABLE IF NOT EXISTS microequity_waitlist (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );
        `);
      } catch (e: unknown) {
        logger.error({ err: e }, "migrate: table creation failed");
        throw e;
      }
      logger.info("migrate: tables ready");

      // ── Column additions for old table versions (safe to run repeatedly) ──
      async function col(sql: string) { try { await client.query(sql) } catch (e: unknown) { logger.warn({ err: (e as Error).message, sql: sql.slice(0, 80) }, "migrate: column addition skipped") } }
      await col(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS read BOOLEAN DEFAULT FALSE`);
      await col(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ`);
      await col(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb NOT NULL`);
      await col(`UPDATE messages SET attachments = COALESCE(attachments, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('url', file_url, 'name', file_name)) WHERE file_url IS NOT NULL AND (attachments IS NULL OR attachments = '[]'::jsonb OR attachments = '[{}]'::jsonb)`);
      await col(`ALTER TABLE barter_requests ADD COLUMN IF NOT EXISTS skill_needed TEXT`);
      await col(`ALTER TABLE barter_requests ADD COLUMN IF NOT EXISTS offer_category TEXT`);
      await col(`ALTER TABLE barter_requests ADD COLUMN IF NOT EXISTS need_category TEXT`);
      await col(`ALTER TABLE barter_requests ADD COLUMN IF NOT EXISTS timeline TEXT DEFAULT 'Flexible'`);
      await col(`ALTER TABLE barter_requests ADD COLUMN IF NOT EXISTS city TEXT`);
      await col(`ALTER TABLE barter_requests ADD COLUMN IF NOT EXISTS is_remote BOOLEAN DEFAULT TRUE`);
      await col(`ALTER TABLE barter_requests ADD COLUMN IF NOT EXISTS image_url TEXT`);
      await col(`ALTER TABLE barter_requests ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0`);
      await col(`ALTER TABLE barter_matches ADD COLUMN IF NOT EXISTS user1_id UUID REFERENCES users(id)`);
      await col(`ALTER TABLE barter_matches ADD COLUMN IF NOT EXISTS user2_id UUID REFERENCES users(id)`);
      await col(`ALTER TABLE barter_matches ADD COLUMN IF NOT EXISTS confirmed_by_user1 BOOLEAN DEFAULT FALSE`);
      await col(`ALTER TABLE barter_matches ADD COLUMN IF NOT EXISTS confirmed_by_user2 BOOLEAN DEFAULT FALSE`);
      await col(`ALTER TABLE barter_matches ADD COLUMN IF NOT EXISTS delivered_by_user1 BOOLEAN DEFAULT FALSE`);
      await col(`ALTER TABLE barter_matches ADD COLUMN IF NOT EXISTS delivered_by_user2 BOOLEAN DEFAULT FALSE`);
      await col(`ALTER TABLE barter_matches ADD COLUMN IF NOT EXISTS accepted_by_user1 BOOLEAN DEFAULT FALSE`);
      await col(`ALTER TABLE barter_matches ADD COLUMN IF NOT EXISTS accepted_by_user2 BOOLEAN DEFAULT FALSE`);
      await col(`ALTER TABLE barter_matches ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
      await col(`ALTER TABLE barter_matches ADD COLUMN IF NOT EXISTS revised_by_user1 BOOLEAN DEFAULT FALSE`);
      await col(`ALTER TABLE barter_matches ADD COLUMN IF NOT EXISTS revised_by_user2 BOOLEAN DEFAULT FALSE`);
      await col(`ALTER TABLE project_bids ADD COLUMN IF NOT EXISTS is_highlighted BOOLEAN DEFAULT FALSE NOT NULL`);
      await col(`ALTER TABLE barter_requests ADD COLUMN IF NOT EXISTS is_paused BOOLEAN DEFAULT FALSE NOT NULL`);

      // ── Table column fixes (Drizzle schema vs raw migration mismatches) ───
      await col(`ALTER TABLE freelance_wallets ADD COLUMN IF NOT EXISTS total_spent NUMERIC(12,2) DEFAULT 0 NOT NULL`);
      await col(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'INR' NOT NULL`);
      await col(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50)`);
      await col(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS gateway_txn_id TEXT`);
      await col(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link_url TEXT`);
      await col(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notifications' AND column_name='read') THEN ALTER TABLE notifications RENAME COLUMN "read" TO is_read; ELSE ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE; END IF; END $$`);

      // ── Service images column (Drizzle uses `images` not `thumbnail`/`gallery`) ──
      await col(`ALTER TABLE services ADD COLUMN IF NOT EXISTS images TEXT[] DEFAULT '{}' NOT NULL`);
      // ── Service packages columns (Drizzle uses `package_type`, `price_inr`, `revisions`) ──
      await col(`ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS package_type TEXT NOT NULL DEFAULT 'basic'`);
      await col(`ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS price_inr REAL NOT NULL DEFAULT 0`);
      await col(`ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS revisions INTEGER NOT NULL DEFAULT 2`);
      // ── Client reviews: Drizzle uses `review_text`, migration had `comment` ──
      await col(`ALTER TABLE client_reviews ADD COLUMN IF NOT EXISTS review_text TEXT DEFAULT ''`);
      // ── Saved items: Drizzle uses generic `item_type`+`item_id`, migration had per-type columns ──
      await col(`ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS item_type saved_item_type`);
      await col(`ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS item_id UUID`);
      // ── Admin: is_active column on users (used for ban/unban) ──
      await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE NOT NULL`);
      // ── Unique DiceBear avatar for every user (based on UUID id) ─────────
      // Replaces old name-based DiceBear avatars and fills missing ones.
      // Custom uploaded photos (non-DiceBear URLs) are left untouched.
      await col(`UPDATE users SET profile_photo = 'https://api.dicebear.com/7.x/adventurer/svg?seed=' || REPLACE(id::text, '-', '')
        WHERE profile_photo IS NULL
           OR profile_photo = ''
           OR profile_photo LIKE 'https://api.dicebear.com/%'
      `);

      // ── INDEXES ──────────────────────────────────────────────────────────
      await col(`
        CREATE INDEX IF NOT EXISTS idx_barter_requests_user_id ON barter_requests(user_id);
        CREATE INDEX IF NOT EXISTS idx_barter_requests_status ON barter_requests(status);
        CREATE INDEX IF NOT EXISTS idx_barter_requests_status_created ON barter_requests(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_barter_matches_user1 ON barter_matches(user1_id);
        CREATE INDEX IF NOT EXISTS idx_barter_matches_user2 ON barter_matches(user2_id);
        CREATE INDEX IF NOT EXISTS idx_barter_matches_req1 ON barter_matches(request1_id);
        CREATE INDEX IF NOT EXISTS idx_barter_matches_req2 ON barter_matches(request2_id);
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(conversation_id, sender_id, read);
        CREATE INDEX IF NOT EXISTS idx_conversations_user1 ON conversations(user1_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_user2 ON conversations(user2_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_match ON conversations(match_id);
        CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
        CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);
        CREATE INDEX IF NOT EXISTS idx_orders_buyer_status ON orders(buyer_id, status);
        CREATE INDEX IF NOT EXISTS idx_orders_seller_status ON orders(seller_id, status);
        CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
        CREATE INDEX IF NOT EXISTS idx_services_seller ON services(seller_id);
        CREATE INDEX IF NOT EXISTS idx_reviews_service ON reviews(service_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
        CREATE INDEX IF NOT EXISTS idx_barter_deliveries_match ON barter_deliveries(match_id);
        CREATE INDEX IF NOT EXISTS idx_barter_reviews_match ON barter_reviews(match_id);
        -- Additional missing indexes
        CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
        CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
        CREATE INDEX IF NOT EXISTS idx_project_bids_project ON project_bids(project_id);
        CREATE INDEX IF NOT EXISTS idx_project_bids_freelancer ON project_bids(freelancer_id);
        CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_id);
        CREATE INDEX IF NOT EXISTS idx_disputes_raised_by ON disputes(raised_by);
        CREATE INDEX IF NOT EXISTS idx_disputes_against ON disputes(against);
        CREATE INDEX IF NOT EXISTS idx_kyc_documents_user ON kyc_documents(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user ON user_subscriptions(user_id);
        CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user ON withdrawal_requests(user_id);
        CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
        CREATE INDEX IF NOT EXISTS idx_saved_items_user ON saved_items(user_id);
        CREATE INDEX IF NOT EXISTS idx_project_invites_freelancer ON project_invites(freelancer_id);
        CREATE INDEX IF NOT EXISTS idx_project_deliveries_project ON project_deliveries(project_id);
      `);

      // ── ENUM additions for old versions ──
      await col(`ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'DISPUTED'`);

      // ── UNIQUE constraints (safe to run repeatedly) ──
      try { await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_items_user_item ON saved_items(user_id, COALESCE(item_type, ''), COALESCE(item_id, ''))`); } catch {}

      logger.info("DB auto-migration: all tables ready");
    } catch (_me: unknown) {
      logger.error({ err: _me instanceof Error ? _me : new Error(String(_me)) }, "DB migration error (continuing)");
    } finally {
      client.release();
    }
  } catch (_ce: unknown) {
    logger.error({ err: _ce instanceof Error ? _ce : new Error(String(_ce)) }, "DB connection/migration error (continuing)");
  }

  await ensureBucket();

  httpServer.listen(port, () => {
    logger.info({ port }, "SwiftExchange API server listening");
  });
})();

httpServer.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
