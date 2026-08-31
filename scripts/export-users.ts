import 'dotenv/config';
import fs from 'fs';
import { pool } from '../src/db';

async function main() {
  const result = await pool.query(
    'SELECT email, first_name, last_name, email_verified FROM users WHERE email IS NOT NULL ORDER BY created_at'
  );
  const rows = result.rows;
  const lines = ['Email,First Name,Last Name,Email Verified'];
  for (const r of rows) {
    const first = (r.first_name || '').replace(/,/g, ' ').trim();
    const last = (r.last_name || '').replace(/,/g, ' ').trim();
    lines.push(`${r.email},${first},${last},${r.email_verified ? 'Yes' : 'No'}`);
  }
  const out = 'users-export.csv';
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  console.log('Total users:', rows.length);
  console.log('Wrote', out);
  console.log('--- EMAILS ---');
  console.log(rows.map((r: any) => r.email).join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
