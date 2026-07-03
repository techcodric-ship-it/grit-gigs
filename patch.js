#!/usr/bin/env node
// ============================================================
// SwiftExchange / Grit&Gigs — one-time fix script
// Run from your project folder:  node patch.js
// Then restart the server:       npm start
// ============================================================
const fs   = require('fs');
const path = require('path');

// ── Find dist/index.mjs wherever we are ──────────────────────
const candidates = [
  path.join(process.cwd(), 'dist', 'index.mjs'),
  path.join(process.cwd(), 'swiftexchange', 'dist', 'index.mjs'),
];
let target = null;
for (const c of candidates) {
  if (fs.existsSync(c)) { target = c; break; }
}
if (!target) {
  console.error('\n❌  Could not find dist/index.mjs');
  console.error('   Make sure you run this script from inside your swiftexchange project folder.\n');
  process.exit(1);
}
console.log('\n📂  Found:', target);

let code = fs.readFileSync(target, 'utf8');
let changed = 0;

// ── PATCH 1: POST /projects — explicit timestamps + real PG error ──
const OLD1_A = `deadline: req.body.deadline ? new Date(req.body.deadline) : null
    }).returning();
    res.status(201).json({ success: true, data: { project: inserted[0] } });
  } catch(e) { res.status(500).json({ success: false, message: String(e.message) }); }
});`;

// already has date-fix IIFE but still old catch
const OLD1_B = /deadline: \(function\(\)\{[^}]+return null; \}\(\)\)\s*\}\)\.returning\(\);\s*res\.status\(201\)\.json[^}]+\} catch\(e\) \{ res\.status\(500\)\.json\(\{ success: false, message: String\(e\.message\) \}\); \}\s*\}\);/;

const NEW1_SUFFIX = `deadline: _deadline,
      createdAt: _now,
      updatedAt: _now
    }).returning();
    res.status(201).json({ success: true, data: { project: inserted[0] } });
  } catch(e) { var _em=(e.cause&&e.cause.message)?'DB: '+e.cause.message:String(e.message); res.status(500).json({ success: false, message: _em }); }
});`;

const DATE_FN = `var _now = new Date();
    var _deadline = (function(){ var _dl=req.body.deadline; if(!_dl||typeof _dl!=='string'||!_dl.trim()||_dl==='dd-mm-yyyy'||_dl==='mm/dd/yyyy'||_dl==='dd/mm/yyyy'||_dl==='yyyy-mm-dd') return null; var _d1=new Date(_dl.trim()); if(!isNaN(_d1.getTime())) return _d1; var _m=_dl.trim().match(/^(\\d{2})-(\\d{2})-(\\d{4})$/); if(_m){var _d2=new Date(_m[3]+'-'+_m[2]+'-'+_m[1]); if(!isNaN(_d2.getTime())) return _d2;} return null; }());`;

if (code.includes(OLD1_A)) {
  // Old compiled file — has raw new Date(req.body.deadline)
  code = code.replace(OLD1_A,
    DATE_FN + '\n    ' + NEW1_SUFFIX);
  changed++;
  console.log('✅  Patch 1a: fixed date parsing + timestamps + error reporting');
} else if (OLD1_B.test(code)) {
  // Has date-fix IIFE but still needs timestamps + error fix
  code = code.replace(OLD1_B, (match) => {
    // inject _now and _deadline before the .values block
    const valStart = match.indexOf('deadline:');
    const before = match.slice(0, valStart);
    const insertBefore = before.includes('_now') ? '' : DATE_FN + '\n    ';
    return insertBefore + 'deadline: _deadline,\n      createdAt: _now,\n      updatedAt: _now\n    }).returning();\n    res.status(201).json({ success: true, data: { project: inserted[0] } });\n  } catch(e) { var _em=(e.cause&&e.cause.message)?\'DB: \'+e.cause.message:String(e.message); res.status(500).json({ success: false, message: _em }); }\n});';
  });
  changed++;
  console.log('✅  Patch 1b: added explicit timestamps + real error reporting');
} else if (!code.includes('createdAt: _now')) {
  console.log('⚠️   Patch 1: could not locate projects POST route — skipping');
} else {
  console.log('ℹ️   Patch 1: already applied');
}

// ── PATCH 2: Auto-migration on startup ───────────────────────────────────────
if (code.includes('_autoMigrate')) {
  console.log('ℹ️   Patch 2: auto-migration already injected');
} else {
  const OLD_START = `httpServer.listen(port, () => {
  logger.info({ port }, "SwiftExchange API server listening");
});`;

  if (!code.includes(OLD_START)) {
    console.log('⚠️   Patch 2: could not find server listen call — skipping');
  } else {
    const SQL = `DO $$ BEGIN CREATE TYPE user_role AS ENUM ('USER','ADMIN','MODERATOR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;DO $$ BEGIN CREATE TYPE transaction_type AS ENUM ('CREDIT_PURCHASE','CREDIT_WITHDRAWAL','SERVICE_PAYMENT','SERVICE_EARNING','COMMISSION','REFUND'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;DO $$ BEGIN CREATE TYPE txn_status AS ENUM ('PENDING','COMPLETED','FAILED','REFUNDED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;DO $$ BEGIN CREATE TYPE withdrawal_status AS ENUM ('PENDING','PROCESSING','COMPLETED','FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;DO $$ BEGIN CREATE TYPE barter_status AS ENUM ('ACTIVE','MATCHED','IN_PROGRESS','COMPLETED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;DO $$ BEGIN CREATE TYPE match_status AS ENUM ('PENDING','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELLED','REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;DO $$ BEGIN CREATE TYPE service_status AS ENUM ('ACTIVE','PAUSED','DELETED','PENDING_REVIEW'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;DO $$ BEGIN CREATE TYPE order_status AS ENUM ('PENDING','ACCEPTED','IN_PROGRESS','DELIVERED','REVISION_REQUESTED','COMPLETED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;DO $$ BEGIN CREATE TYPE project_status AS ENUM ('OPEN','IN_PROGRESS','COMPLETED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;DO $$ BEGIN CREATE TYPE bid_status AS ENUM ('PENDING','ACCEPTED','REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;CREATE TABLE IF NOT EXISTS users(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),email VARCHAR(255) NOT NULL UNIQUE,phone VARCHAR(20) UNIQUE,password_hash TEXT NOT NULL,first_name VARCHAR(100) NOT NULL,last_name VARCHAR(100) NOT NULL,profile_photo TEXT,bio TEXT,city VARCHAR(100),country VARCHAR(100) NOT NULL DEFAULT 'India',tagline VARCHAR(150),skills_offered TEXT[] NOT NULL DEFAULT '{}',skills_needed TEXT[] NOT NULL DEFAULT '{}',languages TEXT[] NOT NULL DEFAULT '{}',is_available BOOLEAN NOT NULL DEFAULT true,hourly_rate INTEGER,portfolio_links JSONB NOT NULL DEFAULT '[]',social_links JSONB NOT NULL DEFAULT '{}',plan_id VARCHAR(20) NOT NULL DEFAULT 'free',plan_activated_at TIMESTAMP,plan_expires_at TIMESTAMP,reputation_score INTEGER NOT NULL DEFAULT 0,email_verified BOOLEAN NOT NULL DEFAULT false,phone_verified BOOLEAN NOT NULL DEFAULT false,kyc_verified BOOLEAN NOT NULL DEFAULT false,role user_role NOT NULL DEFAULT 'USER',is_active BOOLEAN NOT NULL DEFAULT true,last_login_at TIMESTAMP,created_at TIMESTAMP NOT NULL DEFAULT now(),updated_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS refresh_tokens(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,token TEXT NOT NULL UNIQUE,expires_at TIMESTAMP NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS password_resets(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,token TEXT NOT NULL UNIQUE,expires_at TIMESTAMP NOT NULL,used BOOLEAN NOT NULL DEFAULT false,created_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS notifications(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,type VARCHAR(50) NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,link_url TEXT,is_read BOOLEAN NOT NULL DEFAULT false,created_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS freelance_wallets(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,balance REAL NOT NULL DEFAULT 0,total_earned REAL NOT NULL DEFAULT 0,total_spent REAL NOT NULL DEFAULT 0,total_withdrawn REAL NOT NULL DEFAULT 0,updated_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS withdrawal_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),wallet_id UUID NOT NULL REFERENCES freelance_wallets(id),user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,amount REAL NOT NULL,bank_name TEXT NOT NULL,account_number TEXT NOT NULL,ifsc_code TEXT NOT NULL,account_name TEXT NOT NULL,status withdrawal_status NOT NULL DEFAULT 'PENDING',processed_at TIMESTAMP,created_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS transactions(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES users(id),type transaction_type NOT NULL,amount REAL NOT NULL,currency VARCHAR(10) NOT NULL DEFAULT 'INR',credits_amount REAL,status txn_status NOT NULL DEFAULT 'PENDING',payment_method VARCHAR(50),gateway_txn_id TEXT,description TEXT,created_at TIMESTAMP NOT NULL DEFAULT now(),updated_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS barter_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,skill_offered TEXT NOT NULL,skill_needed TEXT NOT NULL,offer_category TEXT,need_category TEXT,description TEXT,timeline TEXT NOT NULL DEFAULT 'Flexible',city TEXT,is_remote BOOLEAN NOT NULL DEFAULT true,image_url TEXT,status barter_status NOT NULL DEFAULT 'ACTIVE',view_count INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMP NOT NULL DEFAULT now(),updated_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS barter_matches(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),request1_id UUID NOT NULL REFERENCES barter_requests(id),request2_id UUID NOT NULL REFERENCES barter_requests(id),user1_id UUID NOT NULL REFERENCES users(id),user2_id UUID NOT NULL REFERENCES users(id),status match_status NOT NULL DEFAULT 'PENDING',confirmed_by_user1 BOOLEAN NOT NULL DEFAULT false,confirmed_by_user2 BOOLEAN NOT NULL DEFAULT false,completed_at TIMESTAMP,created_at TIMESTAMP NOT NULL DEFAULT now(),updated_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS services(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,category TEXT NOT NULL,subcategory TEXT,description TEXT NOT NULL,images TEXT[] NOT NULL DEFAULT '{}',tags TEXT[] NOT NULL DEFAULT '{}',status service_status NOT NULL DEFAULT 'ACTIVE',view_count INTEGER NOT NULL DEFAULT 0,order_count INTEGER NOT NULL DEFAULT 0,rating_avg REAL NOT NULL DEFAULT 0,review_count INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMP NOT NULL DEFAULT now(),updated_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS service_packages(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,package_type TEXT NOT NULL,price_credits REAL NOT NULL,description TEXT NOT NULL,delivery_days INTEGER NOT NULL,revisions INTEGER NOT NULL DEFAULT 2,features TEXT[] NOT NULL DEFAULT '{}');CREATE TABLE IF NOT EXISTS orders(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),service_id UUID NOT NULL REFERENCES services(id),package_id UUID NOT NULL REFERENCES service_packages(id),buyer_id UUID NOT NULL REFERENCES users(id),seller_id UUID NOT NULL REFERENCES users(id),price_credits REAL NOT NULL,requirements JSONB,status order_status NOT NULL DEFAULT 'PENDING',delivery_date TIMESTAMP,completed_at TIMESTAMP,cancelled_at TIMESTAMP,created_at TIMESTAMP NOT NULL DEFAULT now(),updated_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS order_deliveries(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),order_id UUID NOT NULL REFERENCES orders(id),files TEXT[] NOT NULL DEFAULT '{}',message TEXT,revision_number INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS reviews(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),reviewer_id UUID NOT NULL REFERENCES users(id),reviewee_id UUID NOT NULL REFERENCES users(id),type TEXT NOT NULL,service_id UUID REFERENCES services(id),order_id UUID UNIQUE REFERENCES orders(id),barter_match_id UUID,rating INTEGER NOT NULL,review_text TEXT,seller_response TEXT,helpful_count INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS projects(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,skills TEXT,budget_min INTEGER,budget_max INTEGER,deadline TIMESTAMP,status project_status NOT NULL DEFAULT 'OPEN',accepted_bid_id UUID,created_at TIMESTAMP NOT NULL DEFAULT now(),updated_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS project_bids(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,amount INTEGER NOT NULL,proposal TEXT NOT NULL,delivery_days INTEGER,status bid_status NOT NULL DEFAULT 'PENDING',created_at TIMESTAMP NOT NULL DEFAULT now(),updated_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS conversations(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user1_id UUID NOT NULL REFERENCES users(id),user2_id UUID NOT NULL REFERENCES users(id),order_id UUID UNIQUE REFERENCES orders(id),match_id UUID UNIQUE REFERENCES barter_matches(id),last_message_at TIMESTAMP,created_at TIMESTAMP NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS messages(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id UUID NOT NULL REFERENCES conversations(id),sender_id UUID NOT NULL REFERENCES users(id),message_text TEXT NOT NULL,attachments TEXT[] NOT NULL DEFAULT '{}',read_at TIMESTAMP,created_at TIMESTAMP NOT NULL DEFAULT now());`;

    const escaped = SQL.replace(/\\/g,'\\\\').replace(/`/g,'\\`').replace(/\${/g,'\\${');
    const NEW_START = `(async function _autoMigrate(){
  try {
    var _mc=await pool.connect();
    try { await _mc.query(\`${escaped}\`); console.log('[migrate] All tables ready'); }
    catch(_me){ console.error('[migrate] ERROR:', _me.message); }
    finally { _mc.release(); }
  } catch(_ce){ console.error('[migrate] DB connect failed:', _ce.message); }
  httpServer.listen(port, () => {
    logger.info({ port }, "SwiftExchange API server listening");
  });
})();`;

    code = code.replace(OLD_START, NEW_START);
    changed++;
    console.log('✅  Patch 2: auto-migration injected');
  }
}

// ── Write ─────────────────────────────────────────────────────────────────────
if (changed === 0) {
  console.log('\nℹ️   No changes needed — all patches already applied.\n');
} else {
  fs.writeFileSync(target, code, 'utf8');
  console.log(`\n✅  ${changed} patch(es) applied → ${target}`);
  console.log('\n👉  Now restart your server:  npm start\n');
}
