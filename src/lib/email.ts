import { logger } from "./logger";

function htmlEscape(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.EMAIL_FROM || "Grit&Gigs <team@gritandgigs.in>";
const APP_URL = (process.env.APP_URL || "https://www.gritandgigs.in").trim();

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}

function layout(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <style>
    body { margin: 0; padding: 0; background: #f4f4f6; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif; }
    .wrap { max-width: 560px; margin: 0 auto; padding: 24px 16px; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
    .logo { text-align: center; margin-bottom: 32px; }
    .logo svg { width: 140px; height: auto; }
    .divider { height: 1px; background: #e8e8ec; margin: 28px 0; }
    .footer { text-align: center; padding: 20px 16px 0; }
    .footer p { margin: 4px 0; font-size: 0.76rem; color: #999; }
    .footer a { color: #6C3DE0; text-decoration: none; }
    .btn { display: inline-block; background: #6C3DE0; color: #fff !important; font-weight: 600; font-size: 0.9rem; padding: 12px 32px; border-radius: 10px; text-decoration: none; }
    .btn:hover { background: #5B2FC0; }
    h1 { font-size: 1.3rem; font-weight: 700; color: #1a1a2e; margin: 0 0 12px; }
    p { font-size: 0.9rem; color: #555; line-height: 1.65; margin: 0 0 16px; }
    .otp { font-size: 2.2rem; font-weight: 800; text-align: center; letter-spacing: 10px; background: #f4f4f6; color: #1a1a2e; padding: 20px; border-radius: 12px; margin: 20px 0; }
    .meta { font-size: 0.78rem; color: #aaa; }
    .brand { color: #6C3DE0; font-weight: 700; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="logo">
      <svg xmlns="http://www.w3.org/2000/svg" width="140" height="36" viewBox="0 0 140 36">
        <rect width="140" height="36" rx="8" fill="white"/>
        <text x="16" y="25" font-family="Arial,Helvetica,sans-serif" font-weight="900" font-size="22">
          <tspan fill="#0A0A0F">G</tspan><tspan fill="#6C3FE8">&amp;G</tspan>
        </text>
      </svg>
    </div>
    <div class="card">
      ${content}
    </div>
    <div class="divider" style="max-width:560px;margin:28px auto 0;"></div>
    <div class="footer">
      <p><span class="brand">Grit&amp;Gigs</span> — India's skill marketplace</p>
      <p><a href="${APP_URL}">${APP_URL}</a></p>
      <p style="margin-top:8px;">If you didn't request this email, you can safely ignore it.</p>
    </div>
  </div>
</body>
</html>`;
}

async function sendResend({ to, subject, html, replyTo }: EmailOptions): Promise<boolean> {
  if (!RESEND_API_KEY) {
    logger.warn({ to, subject }, "Email skipped — no RESEND_API_KEY set");
    return false;
  }

  try {
    const body = { from: FROM_EMAIL, to, subject, html: layout(html) } as any;
    if (replyTo) body.reply_to = replyTo;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("=== RESEND API ERROR ===", { status: res.status, body: body.substring(0, 500) });
      logger.error({ status: res.status, body }, "Resend API error");
      return false;
    }

    logger.info({ to, subject }, "Email sent");
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to send email via Resend");
    return false;
  }
}

export async function sendWelcomeEmail(to: string, firstName: string): Promise<boolean> {
  return sendResend({
    to,
    subject: "Welcome to Grit&Gigs, " + firstName + "!",
    html: `<h1>Welcome aboard! 🎉</h1>
      <p>Hey ${htmlEscape(firstName)},</p>
      <p>You've joined <strong>Grit&amp;Gigs</strong> — where skills meet opportunity. Whether you're here to freelance, trade skills, or find talent, you're in the right place.</p>
      <p style="margin-bottom:24px;">Here's what to do next:</p>
      <table style="width:100%;margin-bottom:24px;">
        <tr><td style="padding:6px 0;font-size:0.9rem;color:#555;">1️⃣ Set up your profile</td></tr>
        <tr><td style="padding:6px 0;font-size:0.9rem;color:#555;">2️⃣ Explore projects &amp; gigs</td></tr>
        <tr><td style="padding:6px 0;font-size:0.9rem;color:#555;">3️⃣ Post your first service or exchange</td></tr>
      </table>
      <p style="text-align:center;margin-bottom:0;"><a href="${APP_URL}/dashboard" class="btn">Go to Dashboard →</a></p>`,
  });
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<boolean> {
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;
  return sendResend({
    to,
    subject: "Reset your Grit&Gigs password",
    html: `<h1>Password reset requested</h1>
      <p>Someone requested to reset the password for your Grit&amp;Gigs account. Click the button below to set a new one. This link expires in <strong>1 hour</strong>.</p>
      <p style="text-align:center;margin:24px 0;"><a href="${resetUrl}" class="btn">Reset Password →</a></p>
      <div class="meta"><p>If the button doesn't work, copy and paste this link into your browser:</p><p style="word-break:break-all;">${resetUrl}</p></div>
      <p style="margin-top:20px;">If you didn't request this, you can safely ignore this email.</p>`,
  });
}

export async function sendEmailVerificationEmail(to: string, token: string): Promise<boolean> {
  const verifyUrl = `${APP_URL}/verify-email?token=${token}`;
  return sendResend({
    to,
    subject: "Verify your Grit&Gigs email",
    html: `<h1>Verify your email address</h1>
      <p>Thanks for signing up! Please confirm this is your email address by clicking the button below.</p>
      <p style="text-align:center;margin:24px 0;"><a href="${verifyUrl}" class="btn">Verify Email →</a></p>
      <div class="meta"><p>Or paste this link in your browser:</p><p style="word-break:break-all;">${verifyUrl}</p></div>`,
  });
}

export async function sendOtpEmail(to: string, otp: string): Promise<boolean> {
  return sendResend({
    to,
    subject: "Your Grit&Gigs verification code",
    html: `<h1>Verification code</h1>
      <p>Use the code below to verify your email address. It expires in <strong>10 minutes</strong>.</p>
      <div class="otp">${otp}</div>
      <p class="meta" style="text-align:center;">If you didn't request this, you can ignore this email.</p>`,
  });
}

export async function sendNotificationEmail(to: string, title: string, message: string, linkUrl?: string): Promise<boolean> {
  return sendResend({
    to,
    subject: title,
    html: `<h1>${htmlEscape(title)}</h1>
      <p>${htmlEscape(message)}</p>
      ${linkUrl ? `<p style="text-align:center;margin:24px 0;"><a href="${htmlEscape(linkUrl)}" class="btn">View Details →</a></p>` : ''}`,
  });
}

export async function sendAdminEmail(to: string, subject: string, message: string, replyTo?: string): Promise<boolean> {
  return sendResend({
    to,
    subject,
    html: `<p>${htmlEscape(message).replace(/\n/g, "<br/>")}</p>`,
    replyTo,
  });
}
