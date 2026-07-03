// ================================================================
// Grit&Gigs — migration: add project_bid_id to conversations
// Run from your swiftexchange folder:  node add-project-conv-column.mjs
// ================================================================
import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
  console.error('\nERROR: DATABASE_URL is not set in your .env file.\n');
  process.exit(1);
}

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: url });
const client = await pool.connect();

try {
  console.log('\n🔌 Connected! Running migration...\n');
  await client.query(`
    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS project_bid_id UUID REFERENCES project_bids(id) ON DELETE SET NULL;
  `);
  console.log('✅  Added project_bid_id column to conversations table.\n');
} catch (err) {
  console.error('❌  Migration failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
