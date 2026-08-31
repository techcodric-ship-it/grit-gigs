// Run: node scripts/send-profile-email.js
// Sends "Complete your profile + ₹500 referral" email to all active users

const { readFileSync } = require('fs');
const { resolve, dirname } = require('path');
const { Client } = require('pg');

const envPath = resolve(__dirname, '..', '.env');
const env = {};
readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const eq = trimmed.indexOf('=');
  if (eq === -1) return;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  env[key] = val;
});

const RESEND_API_KEY = env.RESEND_API_KEY;
const DATABASE_URL = env.DATABASE_URL;
const FROM_EMAIL = env.EMAIL_FROM || 'Grit&Gigs <team@gritandgigs.in>';
const APP_URL = (env.APP_URL || 'https://www.gritandgigs.in').trim();
const REPLY_TO = env.REPLY_TO_EMAIL || 'gritandgigsofficial@gmail.com';

if (!RESEND_API_KEY) { console.error('RESEND_API_KEY not found'); process.exit(1); }
if (!DATABASE_URL) { console.error('DATABASE_URL not found'); process.exit(1); }

function buildEmailHTML(firstName, referralCode) {
  const name = firstName || 'there';
  const refLink = referralCode ? `${APP_URL}/?ref=${referralCode}` : APP_URL;
  const encodedRef = encodeURIComponent(`Hey! I use Grit&Gigs to find freelance work and trade skills. Check it out: ${refLink}`);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style>
  body{margin:0;padding:0;background:#f4f4f6;font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,sans-serif;}
  .wrap{max-width:560px;margin:0 auto;padding:24px 16px;}
  .card{background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 1px 3px rgba(0,0,0,.06);}
  .logo{text-align:center;margin-bottom:32px;}
  h1{font-size:1.3rem;font-weight:700;color:#1a1a2e;margin:0 0 12px;}
  p{font-size:0.9rem;color:#555;line-height:1.65;margin:0 0 16px;}
  .btn{display:inline-block;background:#6C3DE0;color:#fff!important;font-weight:600;font-size:0.9rem;padding:12px 32px;border-radius:10px;text-decoration:none;}
  .checklist{list-style:none;padding:0;margin:16px 0;}
  .checklist li{padding:10px 0;border-bottom:1px solid #f0f0f2;font-size:0.9rem;color:#555;display:flex;align-items:center;gap:10px;}
  .check-icon{width:24px;height:24px;border-radius:50%;background:#f3f0ff;color:#6C3DE0;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px;font-weight:700;}
  .ref-box{background:linear-gradient(135deg,#f8f6ff,#f0ecff);border:1px solid #e0d8f5;border-radius:12px;padding:24px;margin:24px 0;text-align:center;}
  .ref-box h2{font-size:1.1rem;color:#1a1a2e;margin:0 0 8px;}
  .amount{font-size:2rem;font-weight:800;color:#6C3DE0;margin:8px 0;}
  .ref-link{display:inline-block;background:#fff;border:1.5px dashed #6C3DE0;border-radius:8px;padding:10px 20px;font-size:0.85rem;color:#6C3DE0;font-weight:600;word-break:break-all;margin-bottom:12px;}
  .divider{height:1px;background:#e8e8ec;margin:28px 0;}
  .footer{text-align:center;padding:20px 16px 0;}
  .footer p{margin:4px 0;font-size:0.76rem;color:#999;}
  .footer a{color:#6C3DE0;text-decoration:none;}
  .brand{color:#6C3DE0;font-weight:700;}
</style></head>
<body>
<div class="wrap">
  <div class="logo">
    <svg viewBox="0 0 140 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="140" height="36" rx="8" fill="#6C3DE0"/>
      <text x="10" y="25" font-family="'Segoe UI',sans-serif" font-size="16" font-weight="800" fill="white">Grit&amp;Gigs</text>
    </svg>
  </div>
  <div class="card">
    <h1>Your profile is almost ready, ${name}!</h1>
    <p>Clients are searching for freelancers on Grit&amp;Gigs right now &mdash; but they can't find you yet. Your profile is incomplete.</p>
    <p><strong>Complete it in 5 minutes and get discovered:</strong></p>
    <ul class="checklist">
      <li><span class="check-icon">1</span> Add a profile photo</li>
      <li><span class="check-icon">2</span> List your skills (what you offer)</li>
      <li><span class="check-icon">3</span> Add 2-3 portfolio samples</li>
      <li><span class="check-icon">4</span> Write a short bio</li>
    </ul>
    <p style="text-align:center;margin:24px 0;">
      <a href="${APP_URL}/dashboard" class="btn">Complete my profile &rarr;</a>
    </p>

    <div class="divider"></div>

    <div class="ref-box">
      <h2>Earn &#8377;500 for every referral</h2>
      <p>Share your link with friends who need freelance work done. When they sign up and hire someone, you get &#8377;500.</p>
      <div class="amount">&#8377;500</div>
      <p style="font-size:0.82rem;color:#888;margin-bottom:8px;">per successful referral</p>
      <div class="ref-link">${refLink}</div>
      <p style="font-size:0.82rem;color:#888;">Share on WhatsApp, Instagram, LinkedIn, or anywhere</p>
      <p style="margin-top:12px;"><a href="https://api.whatsapp.com/send?text=${encodedRef}" class="btn" style="background:#25D366;font-size:0.82rem;padding:10px 24px;">Share on WhatsApp</a></p>
    </div>

    <div class="divider"></div>

    <h1>This week's quick wins</h1>
    <ul class="checklist">
      <li><span class="check-icon">&check;</span> Complete your profile (5 mins)</li>
      <li><span class="check-icon">&check;</span> Share your referral link with 5 friends</li>
      <li><span class="check-icon">&check;</span> Post a skill exchange if you need something</li>
    </ul>
    <p>Freelancers with complete profiles get <strong>3x more messages</strong> from clients. Don't miss out.</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${APP_URL}/dashboard" class="btn">Go to dashboard &rarr;</a>
    </p>
  </div>
  <div class="divider" style="max-width:560px;margin:28px auto 0;"></div>
  <div class="footer">
    <p><span class="brand">Grit&amp;Gigs</span> &mdash; India's skill marketplace</p>
    <p><a href="${APP_URL}">${APP_URL}</a></p>
    <p style="margin-top:8px;">If you don't want these emails, you can unsubscribe <a href="${APP_URL}/?unsubscribe=1">here</a>.</p>
  </div>
</div>
</body></html>`;
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('Connected to database');

  const res = await client.query(
    `SELECT email, first_name, referral_code FROM users WHERE is_active = true ORDER BY created_at DESC`
  );
  const users = res.rows;
  console.log(`Found ${users.length} active users. Sending emails...\n`);

  let sent = 0, failed = 0;

  for (const user of users) {
    const html = buildEmailHTML(user.first_name, user.referral_code);
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: user.email,
          subject: "Your profile is 60% complete — clients can't find you yet",
          html,
          reply_to: REPLY_TO,
        }),
      });

      if (r.ok) {
        sent++;
        console.log(`  \u2713 Sent to ${user.email}`);
      } else {
        failed++;
        const err = await r.text();
        console.error(`  \u2717 Failed ${user.email}: ${r.status} - ${err.substring(0, 120)}`);
      }
    } catch (e) {
      failed++;
      console.error(`  \u2717 Error ${user.email}: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nDone! Sent: ${sent} | Failed: ${failed} | Total: ${users.length}`);
  await client.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
