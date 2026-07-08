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
const FROM_EMAIL = process.env.EMAIL_FROM || "noreply@gritandgigs.in";

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
}

async function sendResend({ to, subject, html }: EmailOptions): Promise<boolean> {
  if (!RESEND_API_KEY) {
    logger.warn({ to, subject }, "Email skipped — no RESEND_API_KEY set");
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
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
    subject: "Welcome to Grit&Gigs!",
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h1>Welcome, ${htmlEscape(firstName)}!</h1>
      <p>You've joined Grit&Gigs — the freelance marketplace where skills meet opportunity.</p>
      <p>Get started by setting up your profile and exploring services, projects, and skill exchanges.</p>
      <p><a href="${(process.env.APP_URL || 'https://www.gritandgigs.in').trim()}/dashboard" style="background:#6C63FF;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">Go to Dashboard</a></p>
    </div>`,
  });
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<boolean> {
  const resetUrl = `${(process.env.APP_URL || 'https://www.gritandgigs.in').trim()}/reset-password?token=${token}`;
  return sendResend({
    to,
    subject: "Reset your Grit&Gigs password",
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h1>Password Reset</h1>
      <p>Click the button below to reset your password. This link expires in 1 hour.</p>
      <p><a href="${resetUrl}" style="background:#6C63FF;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">Reset Password</a></p>
      <p>If you didn't request this, you can ignore this email.</p>
    </div>`,
  });
}

export async function sendEmailVerificationEmail(to: string, token: string): Promise<boolean> {
  const verifyUrl = `${(process.env.APP_URL || 'https://www.gritandgigs.in').trim()}/verify-email?token=${token}`;
  return sendResend({
    to,
    subject: "Verify your email address",
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h1>Verify your email</h1>
      <p>Click the button below to verify your email address.</p>
      <p><a href="${verifyUrl}" style="background:#6C63FF;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">Verify Email</a></p>
    </div>`,
  });
}

export async function sendOtpEmail(to: string, otp: string): Promise<boolean> {
  return sendResend({
    to,
    subject: "Your Grit&Gigs verification code",
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h1>Your verification code</h1>
      <p style="font-size:2rem;font-weight:700;text-align:center;letter-spacing:8px;background:#f5f5f7;padding:20px;border-radius:12px;">${otp}</p>
      <p>Enter this code to verify your email address. It expires in 10 minutes.</p>
      <p style="color:#888;font-size:0.85rem;">If you didn't request this, you can ignore this email.</p>
    </div>`,
  });
}

export async function sendNotificationEmail(to: string, title: string, message: string, linkUrl?: string): Promise<boolean> {
  return sendResend({
    to,
    subject: title,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2>${htmlEscape(title)}</h2>
      <p>${htmlEscape(message)}</p>
      ${linkUrl ? `<p><a href="${htmlEscape(linkUrl)}" style="background:#6C63FF;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">View</a></p>` : ''}
    </div>`,
  });
}
