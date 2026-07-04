import pkg from 'pg';
const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/dbname'
});

async function run() {
  // Fix: migration ran twice, values are 100x too large
  console.log('=== Divide freelance_wallets by 100 ===');
  await pool.query('UPDATE freelance_wallets SET balance = (balance / 100)::int, total_earned = (total_earned / 100)::int, total_spent = (total_spent / 100)::int, total_withdrawn = (total_withdrawn / 100)::int');

  console.log('=== Divide service_packages.price_inr by 100 ===');
  await pool.query('UPDATE service_packages SET price_inr = (price_inr / 100)::int');

  console.log('=== Divide orders.price_inr by 100 ===');
  await pool.query('UPDATE orders SET price_inr = (price_inr / 100)::int');

  console.log('=== Final values ===');
  let r = await pool.query('SELECT id, user_id, balance FROM freelance_wallets');
  console.log('Wallets:', JSON.stringify(r.rows));
  r = await pool.query('SELECT id, service_id, package_type, price_inr FROM service_packages');
  console.log('Packages:', JSON.stringify(r.rows));
  r = await pool.query('SELECT id, price_inr, status FROM orders');
  console.log('Orders:', JSON.stringify(r.rows));

  await pool.end();
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
