// Welcome message for Gurfateh Bedi
// Run: node scripts/welcome-gurfateh-bedi.js

import { sendEmail } from '../src/lib/email.js';
import { db } from '../src/db/index.js';
import { users } from '../src/db/schema/users.js';
import { eq } from 'drizzle-orm';

const USER_EMAIL = 'gurfatehbedu760@gmail.com';
const USER_NAME = 'Gurfateh Bedi';

async function main() {
  const user = await db.select().from(users).where(eq(users.email, USER_EMAIL)).limit(1);
  if (!user.length) {
    console.log('User not found in DB yet. Run again after they confirm email.');
    return;
  }

  // 1. Send welcome email
  await sendEmail({
    to: USER_EMAIL,
    subject: 'Welcome to Grit&Gigs, Gurfateh!',
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <h2 style="color:#6C3FE8;">Welcome to Grit&Gigs, Gurfateh! 🎉</h2>
        <p>Hey Gurfateh,</p>
        <p>Thanks for joining <strong>Grit&Gigs</strong> — India's platform for freelancing, skill barter & MicroEquity.</p>
        <p>You're now part of a growing community of <strong>200+ freelancers and businesses</strong> across India.</p>
        <h3>Here's what you can do right now:</h3>
        <ul>
          <li><strong>Find Freelancing Projects</strong> — Browse jobs and start earning</li>
          <li><strong>Build Your Profile</strong> — Add your skills, portfolio & rates</li>
          <li><strong>Start a Skill Barter</strong> — Trade skills without spending money</li>
        </ul>
        <p><strong>Your next step:</strong></p>
        <a href="https://www.gritandgigs.in/dashboard" style="display:inline-block;background:#6C3FE8;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Go to Dashboard →</a>
        <br><br>
        <p>Need help? Just reply to this email or message us on WhatsApp.</p>
        <p>Best,<br><strong>Team Grit&Gigs</strong></p>
      </div>
    `
  });
  console.log('✅ Welcome email sent to', USER_EMAIL);

  // 2. Create in-app notification
  await db.insert(notifications).values({
    userId: user[0].id,
    title: 'Welcome to Grit&Gigs!',
    message: 'Hey Gurfateh! Thanks for joining. Complete your profile to start getting projects. We\'re here if you need any help!',
    linkUrl: '/profile',
    isRead: false,
  });
  console.log('✅ In-app notification created');

  console.log('\nDone! WhatsApp message for you to send manually:');
  console.log(`
Hey Gurfateh 👋

Welcome to Grit&Gigs! 🎉

Thanks for joining India's platform for freelancing, skill barter & MicroEquity.

You can now:
✅ Find freelance projects
✅ Build your profile  
✅ Start skill bartering

Dashboard: https://www.gritandgigs.in/dashboard

Need help? Just reply here!
— Team Grit&Gigs
  `);
}

main().catch(console.error);
