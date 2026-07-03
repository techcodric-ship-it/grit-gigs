// ================================================================
// Grit&Gigs — one-time database setup (ES Module version)
// Run from your swiftexchange folder:  node create-tables.mjs
// ================================================================
import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (dotenv may not be available as ESM)
const envPath = resolve(__dirname, '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('\nERROR: DATABASE_URL is not set in your .env file.');
  console.error('Open .env and make sure it has: DATABASE_URL=postgres://...\n');
  process.exit(1);
}

// Dynamic import works for both ESM and CJS packages
const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: url });

const SQL = `
DO $$ BEGIN CREATE TYPE user_role AS ENUM ('USER','ADMIN','MODERATOR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE transaction_type AS ENUM ('CREDIT_PURCHASE','CREDIT_WITHDRAWAL','SERVICE_PAYMENT','SERVICE_EARNING','COMMISSION','REFUND'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE txn_status AS ENUM ('PENDING','COMPLETED','FAILED','REFUNDED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE withdrawal_status AS ENUM ('PENDING','PROCESSING','COMPLETED','FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE barter_status AS ENUM ('ACTIVE','MATCHED','IN_PROGRESS','COMPLETED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE match_status AS ENUM ('PENDING','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELLED','REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE service_status AS ENUM ('ACTIVE','PAUSED','DELETED','PENDING_REVIEW'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE order_status AS ENUM ('PENDING','ACCEPTED','IN_PROGRESS','DELIVERED','REVISION_REQUESTED','COMPLETED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE project_status AS ENUM ('OPEN','IN_PROGRESS','COMPLETED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE bid_status AS ENUM ('PENDING','ACCEPTED','REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE, phone VARCHAR(20) UNIQUE,
  password_hash TEXT NOT NULL, first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL, profile_photo TEXT, bio TEXT,
  city VARCHAR(100), country VARCHAR(100) NOT NULL DEFAULT 'India',
  tagline VARCHAR(150), skills_offered TEXT[] NOT NULL DEFAULT '{}',
  skills_needed TEXT[] NOT NULL DEFAULT '{}', languages TEXT[] NOT NULL DEFAULT '{}',
  is_available BOOLEAN NOT NULL DEFAULT true, hourly_rate INTEGER,
  portfolio_links JSONB NOT NULL DEFAULT '[]', social_links JSONB NOT NULL DEFAULT '{}',
  plan_id VARCHAR(20) NOT NULL DEFAULT 'free', plan_activated_at TIMESTAMP, plan_expires_at TIMESTAMP,
  reputation_score INTEGER NOT NULL DEFAULT 0, email_verified BOOLEAN NOT NULL DEFAULT false,
  phone_verified BOOLEAN NOT NULL DEFAULT false, kyc_verified BOOLEAN NOT NULL DEFAULT false,
  role user_role NOT NULL DEFAULT 'USER', is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE, expires_at TIMESTAMP NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS password_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE, expires_at TIMESTAMP NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL,
  link_url TEXT, is_read BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS freelance_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance REAL NOT NULL DEFAULT 0, total_earned REAL NOT NULL DEFAULT 0,
  total_spent REAL NOT NULL DEFAULT 0, total_withdrawn REAL NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES freelance_wallets(id),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount REAL NOT NULL, bank_name TEXT NOT NULL, account_number TEXT NOT NULL,
  ifsc_code TEXT NOT NULL, account_name TEXT NOT NULL,
  status withdrawal_status NOT NULL DEFAULT 'PENDING',
  processed_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  type transaction_type NOT NULL, amount REAL NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR', credits_amount REAL,
  status txn_status NOT NULL DEFAULT 'PENDING', payment_method VARCHAR(50),
  gateway_txn_id TEXT, description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS barter_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_offered TEXT NOT NULL, skill_needed TEXT NOT NULL,
  offer_category TEXT, need_category TEXT, description TEXT,
  timeline TEXT NOT NULL DEFAULT 'Flexible', city TEXT,
  is_remote BOOLEAN NOT NULL DEFAULT true, image_url TEXT,
  status barter_status NOT NULL DEFAULT 'ACTIVE', view_count INTEGER NOT NULL DEFAULT 0,
  is_paused BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS barter_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request1_id UUID NOT NULL REFERENCES barter_requests(id),
  request2_id UUID NOT NULL REFERENCES barter_requests(id),
  user1_id UUID NOT NULL REFERENCES users(id), user2_id UUID NOT NULL REFERENCES users(id),
  status match_status NOT NULL DEFAULT 'PENDING',
  confirmed_by_user1 BOOLEAN NOT NULL DEFAULT false, confirmed_by_user2 BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, category TEXT NOT NULL, subcategory TEXT, description TEXT NOT NULL,
  images TEXT[] NOT NULL DEFAULT '{}', tags TEXT[] NOT NULL DEFAULT '{}',
  status service_status NOT NULL DEFAULT 'ACTIVE', view_count INTEGER NOT NULL DEFAULT 0,
  order_count INTEGER NOT NULL DEFAULT 0, rating_avg REAL NOT NULL DEFAULT 0, review_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS service_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  package_type TEXT NOT NULL, price_credits REAL NOT NULL, description TEXT NOT NULL,
  delivery_days INTEGER NOT NULL, revisions INTEGER NOT NULL DEFAULT 2, features TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES services(id), package_id UUID NOT NULL REFERENCES service_packages(id),
  buyer_id UUID NOT NULL REFERENCES users(id), seller_id UUID NOT NULL REFERENCES users(id),
  price_credits REAL NOT NULL, requirements JSONB, status order_status NOT NULL DEFAULT 'PENDING',
  delivery_date TIMESTAMP, completed_at TIMESTAMP, cancelled_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  files TEXT[] NOT NULL DEFAULT '{}', message TEXT, revision_number INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id UUID NOT NULL REFERENCES users(id), reviewee_id UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, service_id UUID REFERENCES services(id),
  order_id UUID UNIQUE REFERENCES orders(id), barter_match_id UUID,
  rating INTEGER NOT NULL, review_text TEXT, seller_response TEXT,
  helpful_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
  skills TEXT, budget_min INTEGER, budget_max INTEGER, deadline TIMESTAMP,
  image_url TEXT,
  status project_status NOT NULL DEFAULT 'OPEN', accepted_bid_id UUID,
  created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_bids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL, proposal TEXT NOT NULL, delivery_days INTEGER,
  status bid_status NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user1_id UUID NOT NULL REFERENCES users(id), user2_id UUID NOT NULL REFERENCES users(id),
  order_id UUID UNIQUE REFERENCES orders(id), match_id UUID UNIQUE REFERENCES barter_matches(id),
  last_message_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  sender_id UUID NOT NULL REFERENCES users(id),
  message_text TEXT NOT NULL, attachments TEXT[] NOT NULL DEFAULT '{}',
  read_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT now()
);
`;

console.log('\n🔌 Connecting to database...');
const client = await pool.connect();
try {
  console.log('✅ Connected!\n🏗️  Creating all tables...\n');
  await client.query(SQL);
  console.log('✅ All tables created successfully!');
  console.log('\n👉 Now restart your server:  npm start');
  console.log('👉 Try posting a project — it will work!\n');
} catch (err) {
  console.error('\n❌ Error:', err.message);
  console.error('Check your DATABASE_URL in .env and make sure PostgreSQL is running.\n');
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
