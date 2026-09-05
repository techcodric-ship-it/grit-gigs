import "dotenv/config";
import http from "http";
import app from "./app";
import { setupSocket } from "./lib/socket";
import { logger } from "./lib/logger";
import { pool, db, toolLeadsTable } from "./db";
import { lte, eq, and } from "drizzle-orm";
import { ensureBucket } from "./lib/storage";
import { sendToolFollowupEmail } from "./lib/email";

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

// ── Free tool follow-up emails (lead magnet nurture sequence) ─────────────
// Every 30 min, send the next nurture email to calculator leads that are due.
const APP_URL = (process.env.APP_URL || "https://www.gritandgigs.in").trim();

const TOOL_FOLLOWUP_STEPS = [
  // stage 1 (sent ~day 2)
  {
    stage: 1,
    days: 3,
    subject: "The #1 mistake freelancers make (and how to avoid it)",
    body: (firstName: string | undefined) => `
      <h1>Most freelancers underprice themselves</h1>
      <p>Hi${firstName ? " " + firstName : ""},</p>
      <p>When you used the <strong>Grit&Gigs Rate Calculator</strong>, you got a market-based number. The #1 mistake we see is charging <em>below</em> that — because it feels safer. It isn't. Low prices attract price-shoppers, not good clients.</p>
      <p>Instead:</p>
      <table style="width:100%;margin-bottom:20px;">
        <tr><td style="padding:6px 0;font-size:0.9rem;color:#555;">✅ Show your past work in a portfolio</td></tr>
        <tr><td style="padding:6px 0;font-size:0.9rem;color:#555;">✅ Charge a fixed project price, not hourly</td></tr>
        <tr><td style="padding:6px 0;font-size:0.9rem;color:#555;">✅ Get a couple of client reviews early — they compound</td></tr>
      </table>
      <p style="text-align:center;margin:20px 0;"><a href="${APP_URL}/signup" class="btn">Start earning on Grit&Gigs →</a></p>`,
  },
  // stage 2 (sent ~day 5)
  {
    stage: 2,
    days: 4,
    subject: "Your next client could already be waiting",
    body: (firstName: string | undefined) => `
      <h1>Clients are hiring right now</h1>
      <p>Hi${firstName ? " " + firstName : ""},</p>
      <p>On Grit&Gigs, freelancers create a service listing and Indian clients hire them directly — no bidding, no fees to browse.</p>
      <p>Three things that make a listing get hired fast:</p>
      <table style="width:100%;margin-bottom:20px;">
        <tr><td style="padding:6px 0;font-size:0.9rem;color:#555;">1️⃣ A clear title with your skill + outcome</td></tr>
        <tr><td style="padding:6px 0;font-size:0.9rem;color:#555;">2️⃣ 3 example photos or links of past work</td></tr>
        <tr><td style="padding:6px 0;font-size:0.9rem;color:#555;">3️⃣ Fast delivery time (2-5 days works best)</td></tr>
      </table>
      <p style="text-align:center;margin:20px 0;"><a href="${APP_URL}/dashboard" class="btn">Create your free listing →</a></p>`,
  },
  // stage 3 (sent ~day 9)
  {
    stage: 3,
    days: 0,
    subject: "One last thing — a special offer for you",
    body: (firstName: string | undefined) => `
      <h1>Your first project on us</h1>
      <p>Hi${firstName ? " " + firstName : ""},</p>
      <p>Because you used our calculator, here's a head start: <strong>your first project on Grit&Gigs comes with 0% commission</strong> — you keep 100% of what you earn.</p>
      <p>It takes 2 minutes to set up your profile and post your first service. That's it.</p>
      <p style="text-align:center;margin:20px 0;"><a href="${APP_URL}/signup" class="btn">Claim your 0% commission →</a></p>`,
  },
];

async function processToolFollowups(): Promise<void> {
  try {
    const due = await db
      .select()
      .from(toolLeadsTable)
      .where(and(eq(toolLeadsTable.unsubscribed, false), lte(toolLeadsTable.nextFollowupAt, new Date())))
      .limit(50);

    for (const lead of due) {
      const step = TOOL_FOLLOWUP_STEPS.find((s) => s.stage === lead.followupStage + 1);
      if (!step) {
        await db.update(toolLeadsTable).set({ nextFollowupAt: null }).where(eq(toolLeadsTable.id, lead.id));
        continue;
      }
      const sent = await sendToolFollowupEmail(lead.email, lead.firstName ?? undefined, step.subject, step.body(lead.firstName ?? undefined));
      await db
        .update(toolLeadsTable)
        .set({
          followupStage: step.stage,
          nextFollowupAt: step.days > 0 ? new Date(Date.now() + step.days * 24 * 60 * 60 * 1000) : null,
        })
        .where(eq(toolLeadsTable.id, lead.id));
      if (sent) logger.info({ leadId: lead.id, stage: step.stage }, "Tool follow-up email sent");
    }
  } catch (err) {
    logger.error({ err }, "Tool follow-up processing failed");
  }
}

function startToolFollowUpCron(): void {
  setTimeout(() => processToolFollowups(), 60 * 1000);
  setInterval(() => processToolFollowups(), 30 * 60 * 1000).unref();
}

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
          DO $$ BEGIN CREATE TYPE transaction_type AS ENUM ('CREDIT_PURCHASE','CREDIT_WITHDRAWAL','SUBSCRIPTION','SERVICE_PAYMENT','SERVICE_EARNING','COMMISSION','REFUND'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'SUBSCRIPTION';
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
          DO $$ BEGIN CREATE TYPE plan_id AS ENUM ('starter','pro','squad'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE dispute_status AS ENUM ('OPEN','UNDER_REVIEW','RESOLVED_BUYER','RESOLVED_SELLER','CLOSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE saved_item_type AS ENUM ('SERVICE','PROJECT','BARTER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE dispute_target AS ENUM ('ORDER','PROJECT','BARTER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE invite_target_type AS ENUM ('PROJECT','SERVICE','BARTER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE invite_status AS ENUM ('PENDING','ACCEPTED','DECLINED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE report_target_type AS ENUM ('USER','SERVICE','BARTER','PROJECT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE report_status AS ENUM ('OPEN','RESOLVED','DISMISSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE kyc_status AS ENUM ('PENDING','APPROVED','REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE referral_status AS ENUM ('PENDING','PAID','VOIDED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE job_application_status AS ENUM ('PENDING','REVIEWED','ACCEPTED','REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE squad_role AS ENUM ('LEADER','MEMBER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE squad_invite_status AS ENUM ('PENDING','ACCEPTED','DECLINED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE squad_service_status AS ENUM ('ACTIVE','PAUSED','DELETED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          DO $$ BEGIN CREATE TYPE squad_join_request_status AS ENUM ('PENDING','ACCEPTED','DECLINED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
          ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'REFERRAL_REWARD';
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
            plan_id plan_id NOT NULL DEFAULT 'starter',
            started_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            expires_at TIMESTAMPTZ,
            proposal_credits_remaining INTEGER NOT NULL DEFAULT 2,
            featured_proposals_remaining INTEGER NOT NULL DEFAULT 0,
            credits_reset_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            bids_reset_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );
          ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS bids_reset_at TIMESTAMPTZ DEFAULT NOW() NOT NULL;

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

          CREATE TABLE IF NOT EXISTS project_reviews (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            reviewee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
            comment TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_project_reviews_project ON project_reviews(project_id);

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
            revisions INTEGER DEFAULT 2 NOT NULL,
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
            is_group BOOLEAN DEFAULT FALSE NOT NULL,
            group_name TEXT,
            group_id UUID REFERENCES squads(id) ON DELETE CASCADE,
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

          CREATE TABLE IF NOT EXISTS conversation_participants (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            joined_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
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

          CREATE TABLE IF NOT EXISTS referrals (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            referred_user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
            status referral_status DEFAULT 'PENDING' NOT NULL,
            reward_amount NUMERIC(12,2) DEFAULT 500 NOT NULL,
            zero_commission_applied BOOLEAN DEFAULT FALSE NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
          CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

          CREATE TABLE IF NOT EXISTS tool_leads (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email TEXT NOT NULL,
            first_name TEXT,
            role TEXT NOT NULL,
            service TEXT NOT NULL,
            experience TEXT,
            hours INTEGER,
            result JSONB DEFAULT '{}',
            followup_stage INTEGER DEFAULT 0 NOT NULL,
            next_followup_at TIMESTAMPTZ,
            unsubscribed BOOLEAN DEFAULT FALSE NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_tool_leads_next_followup ON tool_leads(next_followup_at);
          CREATE INDEX IF NOT EXISTS idx_tool_leads_email ON tool_leads(email);

          CREATE TABLE IF NOT EXISTS jobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            title TEXT NOT NULL,
            company TEXT NOT NULL,
            location TEXT,
            type TEXT DEFAULT 'Full-time' NOT NULL,
            salary_range TEXT,
            description TEXT NOT NULL,
            skills TEXT[] DEFAULT '{}',
            link TEXT,
            posted_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
            is_active BOOLEAN DEFAULT TRUE NOT NULL,
            application_deadline TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );
          ALTER TABLE jobs ADD COLUMN IF NOT EXISTS link TEXT;

          CREATE TABLE IF NOT EXISTS job_applications (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            applicant_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message TEXT,
            status job_application_status DEFAULT 'PENDING' NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_jobs_active_created ON jobs(is_active, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_job_applications_job ON job_applications(job_id);
          CREATE INDEX IF NOT EXISTS idx_job_applications_applicant ON job_applications(applicant_id);

          CREATE TABLE IF NOT EXISTS squads (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name TEXT NOT NULL,
            tagline TEXT,
            category TEXT,
            description TEXT,
            avatar TEXT,
            skills TEXT[] DEFAULT '{}',
            leader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            is_active BOOLEAN DEFAULT TRUE NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );
          CREATE TABLE IF NOT EXISTS squad_members (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            squad_id UUID NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role squad_role DEFAULT 'MEMBER' NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            UNIQUE (squad_id, user_id)
          );
          CREATE TABLE IF NOT EXISTS squad_invites (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            squad_id UUID NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
            invited_email TEXT NOT NULL,
            invited_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            message TEXT,
            status squad_invite_status DEFAULT 'PENDING' NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            responded_at TIMESTAMPTZ
          );
          CREATE TABLE IF NOT EXISTS squad_services (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            squad_id UUID NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            category TEXT,
            cover_image TEXT,
            price_inr INTEGER NOT NULL,
            delivery_days INTEGER DEFAULT 7 NOT NULL,
            revisions INTEGER DEFAULT 2 NOT NULL,
            order_count INTEGER DEFAULT 0 NOT NULL,
            skills TEXT[] DEFAULT '{}',
            status squad_service_status DEFAULT 'ACTIVE' NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );
          CREATE TABLE IF NOT EXISTS squad_orders (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            squad_id UUID NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
            service_id UUID NOT NULL REFERENCES squad_services(id) ON DELETE CASCADE,
            buyer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            price_inr INTEGER NOT NULL,
            revisions INTEGER DEFAULT 2 NOT NULL,
            requirements TEXT,
            status order_status DEFAULT 'PENDING' NOT NULL,
            delivery_date TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            cancelled_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );
          CREATE TABLE IF NOT EXISTS squad_order_deliveries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            order_id UUID NOT NULL REFERENCES squad_orders(id) ON DELETE CASCADE,
            note TEXT,
            link TEXT,
            files TEXT[] DEFAULT '{}',
            revision_number INTEGER DEFAULT 0 NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
          );
          CREATE TABLE IF NOT EXISTS squad_join_requests (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            squad_id UUID NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            status squad_join_request_status DEFAULT 'PENDING' NOT NULL,
            message TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            responded_at TIMESTAMPTZ
          );
          CREATE INDEX IF NOT EXISTS idx_squad_members_squad ON squad_members(squad_id);
          CREATE INDEX IF NOT EXISTS idx_squad_members_user ON squad_members(user_id);
          CREATE INDEX IF NOT EXISTS idx_squad_invites_squad ON squad_invites(squad_id);
          CREATE INDEX IF NOT EXISTS idx_squad_invites_user ON squad_invites(invited_user_id);
          CREATE INDEX IF NOT EXISTS idx_squad_services_squad ON squad_services(squad_id);
        `);
      } catch (e: unknown) {
        logger.error({ err: e }, "migrate: table creation failed");
        throw e;
      }
      logger.info("migrate: tables ready");

      // ── Column additions for old table versions (safe to run repeatedly) ──
      async function col(sql: string) { try { await client.query(sql) } catch (e: unknown) { logger.warn({ err: (e as Error).message, sql: sql.slice(0, 80) }, "migrate: column addition skipped") } }
      await col(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS upi_id TEXT`);
      await col(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS gateway_txn_id TEXT`);
      await col(`ALTER TABLE withdrawal_requests ALTER COLUMN bank_name DROP NOT NULL`);
      await col(`ALTER TABLE withdrawal_requests ALTER COLUMN account_number DROP NOT NULL`);
      await col(`ALTER TABLE withdrawal_requests ALTER COLUMN ifsc_code DROP NOT NULL`);
      await col(`ALTER TABLE withdrawal_requests ALTER COLUMN account_name DROP NOT NULL`);
      await col(`ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS otp TEXT`);

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
      await col(`ALTER TABLE order_deliveries ADD COLUMN IF NOT EXISTS revision_number INTEGER DEFAULT 0 NOT NULL`);

      // ── Referral program columns ────────────────────────────────────────────
      await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20)`);
      await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id) ON DELETE SET NULL`);
      await col(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)`);
      await col(`ALTER TABLE freelance_wallets ADD COLUMN IF NOT EXISTS bonus_balance NUMERIC(12,2) DEFAULT 0 NOT NULL`);
      await col(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS zero_commission BOOLEAN DEFAULT FALSE NOT NULL`);

      // ── Monthly creation quota columns (gigs/projects created per 30-day cycle) ──
      await col(`ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS gigs_created_this_cycle INTEGER DEFAULT 0 NOT NULL`);
      await col(`ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS projects_created_this_cycle INTEGER DEFAULT 0 NOT NULL`);

      // ── Table column fixes (Drizzle schema vs raw migration mismatches) ───
      await col(`ALTER TABLE freelance_wallets ADD COLUMN IF NOT EXISTS total_spent NUMERIC(12,2) DEFAULT 0 NOT NULL`);
      await col(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'INR' NOT NULL`);
      await col(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50)`);
      await col(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS gateway_txn_id TEXT`);
      await col(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link_url TEXT`);
      await col(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notifications' AND column_name='read') THEN ALTER TABLE notifications RENAME COLUMN "read" TO is_read; ELSE ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE; END IF; END $$`);
      await col(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_group BOOLEAN DEFAULT FALSE NOT NULL`);
      await col(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS group_name TEXT`);
      await col(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES squads(id) ON DELETE CASCADE`);
      await col(`ALTER TABLE squad_services ADD COLUMN IF NOT EXISTS cover_image TEXT`);
      await col(`ALTER TABLE squad_services ADD COLUMN IF NOT EXISTS revisions INTEGER DEFAULT 2 NOT NULL`);
      await col(`ALTER TABLE squad_services ADD COLUMN IF NOT EXISTS order_count INTEGER DEFAULT 0 NOT NULL`);
      await col(`ALTER TABLE project_bids ADD COLUMN IF NOT EXISTS revisions INTEGER DEFAULT 2 NOT NULL`);
      await col(`ALTER TABLE squad_orders ADD COLUMN IF NOT EXISTS revisions INTEGER DEFAULT 2 NOT NULL`);
      await col(`ALTER TABLE squad_order_deliveries ADD COLUMN IF NOT EXISTS revision_number INTEGER DEFAULT 0 NOT NULL`);
      await col(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS squad_order_id UUID REFERENCES squad_orders(id) ON DELETE CASCADE`);
      await col(`ALTER TABLE squads ADD COLUMN IF NOT EXISTS rating_avg REAL DEFAULT 0 NOT NULL`);
      await col(`ALTER TABLE squads ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0 NOT NULL`);
      await col(`
        CREATE TABLE IF NOT EXISTS squad_reviews (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          squad_id UUID NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
          reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL,
          review_text TEXT,
          source TEXT NOT NULL,
          project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
          squad_order_id UUID REFERENCES squad_orders(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_squad_reviews_project ON squad_reviews(project_id) WHERE project_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_squad_reviews_order ON squad_reviews(squad_order_id) WHERE squad_order_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_squad_reviews_squad ON squad_reviews(squad_id);
      `);
      await col(`
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conversation_participants' AND column_name='id') THEN
    ALTER TABLE conversation_participants ADD COLUMN id UUID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conversation_participants' AND column_name='joined_at') THEN
    ALTER TABLE conversation_participants ADD COLUMN joined_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='conversation_participants'::regclass AND contype='p' AND pg_get_constraintdef(oid) ILIKE '%(conversation_id, user_id)%') THEN
    ALTER TABLE conversation_participants DROP CONSTRAINT conversation_participants_pkey;
  END IF;
  UPDATE conversation_participants SET id = gen_random_uuid() WHERE id IS NULL;
  UPDATE conversation_participants SET joined_at = NOW() WHERE joined_at IS NULL;
  ALTER TABLE conversation_participants ALTER COLUMN id SET DEFAULT gen_random_uuid();
  ALTER TABLE conversation_participants ALTER COLUMN id SET NOT NULL;
  ALTER TABLE conversation_participants ADD CONSTRAINT conversation_participants_id_pkey PRIMARY KEY (id);
END
$mig$
      `);

      // ── Ensure every squad member is in the squad's group chat ────────────
      await col(`
        DO $gchat$
        DECLARE
          s RECORD;
          starter UUID;
          gid UUID;
        BEGIN
          FOR s IN SELECT DISTINCT squad_id FROM squad_members LOOP
            SELECT leader_id INTO starter FROM squads WHERE id = s.squad_id;
            IF starter IS NULL THEN
              SELECT user_id INTO starter FROM squad_members WHERE squad_id = s.squad_id LIMIT 1;
            END IF;
            IF starter IS NULL THEN CONTINUE; END IF;
            SELECT id INTO gid FROM conversations WHERE group_id = s.squad_id AND is_group = TRUE LIMIT 1;
            IF gid IS NULL THEN
              INSERT INTO conversations (user1_id, user2_id, is_group, group_name, group_id, last_message_at)
              VALUES (starter, starter, TRUE, (SELECT name FROM squads WHERE id = s.squad_id), s.squad_id, NOW())
              RETURNING id INTO gid;
            END IF;
            INSERT INTO conversation_participants (conversation_id, user_id, joined_at)
            SELECT gid, user_id, NOW() FROM squad_members WHERE squad_id = s.squad_id
              AND NOT EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = gid AND cp.user_id = squad_members.user_id);
          END LOOP;
        END
        $gchat$
      `);

      // ── Backfill a buyer+squad conversation for every existing squad order ──
      await col(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_squad_order ON conversations(squad_order_id) WHERE squad_order_id IS NOT NULL`);
      await col(`
        DO $sorder$
        DECLARE
          o RECORD;
          gid UUID;
        BEGIN
          FOR o IN
            SELECT so.id, so.squad_id, so.buyer_id, so.service_id
            FROM squad_orders so
            WHERE NOT EXISTS (
              SELECT 1 FROM conversations c WHERE c.squad_order_id = so.id
            )
            AND so.status NOT IN ('CANCELLED')
          LOOP
            INSERT INTO conversations (user1_id, user2_id, is_group, group_name, group_id, squad_order_id, last_message_at)
            VALUES (
              o.buyer_id, o.buyer_id, TRUE,
              COALESCE((SELECT title FROM squad_services WHERE id = o.service_id), 'Squad Order') || ' · Order',
              o.squad_id, o.id, NOW()
            )
            RETURNING id INTO gid;
            INSERT INTO conversation_participants (conversation_id, user_id, joined_at)
            SELECT gid, user_id, NOW() FROM squad_members WHERE squad_id = o.squad_id
              AND NOT EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = gid AND cp.user_id = squad_members.user_id);
            INSERT INTO conversation_participants (conversation_id, user_id, joined_at)
            SELECT gid, o.buyer_id, NOW()
              WHERE NOT EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = gid AND cp.user_id = o.buyer_id);
          END LOOP;
        END
        $sorder$
      `);

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
    startToolFollowUpCron();
  });
})();

httpServer.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
