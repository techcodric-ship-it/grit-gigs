import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(`ALTER TYPE project_status ADD VALUE IF NOT EXISTS 'DELIVERED'`);
} catch { await pool.query(`CREATE TYPE project_status AS ENUM('OPEN','IN_PROGRESS','DELIVERED','COMPLETED','CANCELLED')`); }
await pool.query(`
  CREATE TABLE IF NOT EXISTS project_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    delivery_note TEXT,
    link TEXT,
    revision_number INTEGER DEFAULT 0 NOT NULL,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  )
`);
console.log('OK');
await pool.end();
