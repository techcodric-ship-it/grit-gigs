import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { db, usersTable, notificationsTable, passwordResetsTable, refreshTokensTable, conversationsTable, messagesTable } from "../db";
import { eq, and, gt, sql } from "drizzle-orm";
import {
  generateAccessToken,
  generateRefreshToken,
  rotateRefreshToken,
  deleteAllRefreshTokens,
} from "../lib/auth";
import { authenticate } from "../middlewares/authenticate";
import { sendWelcomeEmail, sendPasswordResetEmail, sendEmailVerificationEmail } from "../lib/email";
import { verifySupabaseToken, getSupabase } from "../lib/supabase";
import { attachPlanBadge, attachPlanBadges } from "../lib/planBadge";

const router: IRouter = Router();

router.post("/auth/register", async (req, res): Promise<void> => {
  const { firstName, lastName, email, password } = req.body;

  if (!firstName || !lastName || !email || !password) {
    res.status(400).json({ success: false, message: "Required fields missing" });
    return;
  }
  const fullName = ((firstName || '') + ' ' + (lastName || '')).trim().toLowerCase();
  if (fullName === 'grit&gigs admin' || fullName.indexOf('grit&gigs admin') !== -1) {
    res.status(400).json({ success: false, message: "This name is reserved for the platform administrator. Please choose a different name." });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    return;
  }

  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email.toLowerCase()));

  if (existing) {
    res.status(400).json({ success: false, message: "An account with this email already exists" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const seed = uuidv4().replace(/-/g, "").slice(0, 12);

  const [user] = await db
    .insert(usersTable)
    .values({
      firstName,
      lastName,
      email: email.toLowerCase(),
      passwordHash,
      city: null,
      profilePhoto: `https://api.dicebear.com/7.x/adventurer/svg?seed=${seed}`,
    })
    .returning();

  await db.insert(notificationsTable).values({
    userId: user.id,
    type: "WELCOME",
    title: "Welcome to Grit&Gigs!",
    message: "Verify your email to get started. Check your inbox for the verification code.",
    linkUrl: null,
  });

  // Auto-create admin support conversation
  try {
    const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, "amuthavananfl@gmail.com")).limit(1);
    if (admin) {
      const [conv] = await db.insert(conversationsTable).values({
        user1Id: admin.id, user2Id: user.id, lastMessageAt: new Date(),
      }).returning();
      await db.insert(messagesTable).values({
        conversationId: conv.id, senderId: admin.id,
        messageText: "Welcome to Grit&Gigs Support! 👋 Feel free to ask any questions about the platform, your account, or how things work. We're here to help!",
        attachments: [],
      });
    }
  } catch (e) { /* non-critical */ }

  // Send OTP via Supabase email
  let otpSent = false;
  const sb = getSupabase();
  if (sb) {
    const { error } = await sb.auth.signInWithOtp({ email: email.toLowerCase() });
    if (!error) otpSent = true;
  }

  const signupToken = uuidv4();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
  await db.insert(passwordResetsTable).values({ userId: user.id, token: signupToken, expiresAt });

  res.status(201).json({
    success: true,
    message: otpSent ? "Verification code sent to your email." : "Account created! (Email service pending)",
    data: { signupToken, email: email.toLowerCase(), otpSent },
  });
});

router.post("/auth/verify-signup", async (req, res): Promise<void> => {
  const { email, otp, signupToken } = req.body;
  if (!email || !otp || !signupToken) {
    res.status(400).json({ success: false, message: "Email, OTP, and signup token required" });
    return;
  }

  const [reset] = await db
    .select()
    .from(passwordResetsTable)
    .where(and(eq(passwordResetsTable.token, signupToken), eq(passwordResetsTable.used, false), gt(passwordResetsTable.expiresAt, new Date())));

  if (!reset) {
    res.status(400).json({ success: false, message: "Invalid or expired signup session. Please try signing up again." });
    return;
  }

  const sb = getSupabase();
  if (!sb) {
    res.status(503).json({ success: false, message: "Email verification service unavailable. Please try again later." });
    return;
  }

  const { error } = await sb.auth.verifyOtp({ email, token: otp, type: 'email' });
  if (error) {
    res.status(400).json({ success: false, message: "Invalid or expired OTP. Please try again." });
    return;
  }

  await db.update(usersTable).set({ emailVerified: true }).where(eq(usersTable.id, reset.userId));
  await db.update(passwordResetsTable).set({ used: true }).where(eq(passwordResetsTable.id, reset.id));

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, reset.userId));
  if (!user) { res.status(500).json({ success: false, message: "User not found" }); return; }

  const accessToken = generateAccessToken(user.id);
  const refreshToken = await generateRefreshToken(user.id);

  res.json({
    success: true,
    message: "Email verified successfully",
    data: {
      accessToken,
      refreshToken,
      user: {
        id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email,
        phone: user.phone, profilePhoto: user.profilePhoto, city: user.city, role: user.role,
        reputationScore: user.reputationScore, emailVerified: true,
        ggId: 'G&G-' + user.id.replace(/-/g, '').slice(0, 8).toUpperCase(),
      },
    },
  });
});

router.post("/auth/resend-otp", async (req, res): Promise<void> => {
  const { email } = req.body;
  if (!email) { res.status(400).json({ success: false, message: "Email required" }); return; }
  const sb = getSupabase();
  if (!sb) { res.status(503).json({ success: false, message: "Email service not configured" }); return; }
  const { error } = await sb.auth.signInWithOtp({ email });
  if (error) { res.status(400).json({ success: false, message: error.message }); return; }
  res.json({ success: true, message: "Code resent" });
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ success: false, message: "Email and password required" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email.toLowerCase()));

  if (!user) {
    res.status(401).json({ success: false, message: "Invalid email or password" });
    return;
  }
  if (!user.isActive) {
    res.status(401).json({ success: false, message: "Account has been deactivated" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ success: false, message: "Invalid email or password" });
    return;
  }

  // Enforce email verification
  if (!user.emailVerified) {
    res.status(403).json({ success: false, message: "Please verify your email first. Check your inbox for the verification code." });
    return;
  }

  await db
    .update(usersTable)
    .set({ lastLoginAt: new Date() })
    .where(eq(usersTable.id, user.id));

  const accessToken = generateAccessToken(user.id);
  const refreshToken = await generateRefreshToken(user.id);

  res.json({
    success: true,
    message: "Login successful",
    data: {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        profilePhoto: user.profilePhoto,
        city: user.city,
        role: user.role,
        reputationScore: user.reputationScore,
        emailVerified: user.emailVerified,
        ggId: 'G&G-' + user.id.replace(/-/g, '').slice(0, 8).toUpperCase(),
      },
    },
  });
});

router.post("/auth/refresh", async (req, res): Promise<void> => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    res.status(400).json({ success: false, message: "Refresh token required" });
    return;
  }

  try {
    const tokens = await rotateRefreshToken(refreshToken);
    const [user] = await db
      .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email, role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, tokens.userId));

    res.json({ success: true, message: "Token refreshed", data: { ...tokens, user } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Invalid refresh token";
    res.status(401).json({ success: false, message: msg });
  }
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await db.delete(refreshTokensTable).where(eq(refreshTokensTable.token, refreshToken));
  }
  res.json({ success: true, message: "Logged out successfully" });
});

router.post("/auth/logout-all", authenticate, async (req, res): Promise<void> => {
  await deleteAllRefreshTokens(req.user!.id);
  res.json({ success: true, message: "Logged out from all devices" });
});

router.get("/auth/me", authenticate, async (req, res): Promise<void> => {
  const [user] = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      email: usersTable.email,
      phone: usersTable.phone,
      profilePhoto: usersTable.profilePhoto,
      bio: usersTable.bio,
      city: usersTable.city,
      country: usersTable.country,
      skillsOffered: usersTable.skillsOffered,
      skillsNeeded: usersTable.skillsNeeded,
      tagline: usersTable.tagline,
      languages: usersTable.languages,
      isAvailable: usersTable.isAvailable,
      hourlyRate: usersTable.hourlyRate,
      portfolioLinks: usersTable.portfolioLinks,
      socialLinks: usersTable.socialLinks,
      reputationScore: usersTable.reputationScore,
      emailVerified: usersTable.emailVerified,
      phoneVerified: usersTable.phoneVerified,
      kycVerified: usersTable.kycVerified,
      role: usersTable.role,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.id));

  await attachPlanBadge(user);
  res.json({
    success: true,
    data: { user },
  });
});

router.post("/auth/forgot-password", async (req, res): Promise<void> => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ success: false, message: "Email required" });
    return;
  }

  const [user] = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.email, email.toLowerCase()));

  if (user) {
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await db.insert(passwordResetsTable).values({ userId: user.id, token, expiresAt });
    sendPasswordResetEmail(user.email, token);
  }

  res.json({ success: true, message: "If that email exists, a reset link has been sent." });
});

router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 8) {
    res.status(400).json({ success: false, message: "Token and password (min 8 chars) required" });
    return;
  }

  const [reset] = await db
    .select()
    .from(passwordResetsTable)
    .where(
      and(
        eq(passwordResetsTable.token, token),
        eq(passwordResetsTable.used, false),
        gt(passwordResetsTable.expiresAt, new Date()),
      ),
    );

  if (!reset) {
    res.status(400).json({ success: false, message: "Invalid or expired reset token" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, reset.userId));
  await db.update(passwordResetsTable).set({ used: true }).where(eq(passwordResetsTable.id, reset.id));
  await deleteAllRefreshTokens(reset.userId);

  res.json({ success: true, message: "Password reset successfully" });
});

router.put("/auth/change-password", authenticate, async (req, res): Promise<void> => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    res.status(400).json({ success: false, message: "Current and new password (min 8 chars) required" });
    return;
  }

  const [user] = await db
    .select({ passwordHash: usersTable.passwordHash })
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.id));

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(400).json({ success: false, message: "Current password is incorrect" });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, req.user!.id));

  res.json({ success: true, message: "Password changed successfully" });
});

// ── Supabase Auth (Google login / Phone OTP) ──────────────────────────────

router.post("/auth/supabase", async (req, res): Promise<void> => {
  const { accessToken } = req.body;
  if (!accessToken) {
    res.status(400).json({ success: false, message: "Supabase access token required" });
    return;
  }

  const supabaseUser = await verifySupabaseToken(accessToken);
  if (!supabaseUser) {
    res.status(401).json({ success: false, message: "Invalid Supabase token" });
    return;
  }

  let email = supabaseUser.email;

  if (!email) {
    // Try to find user by phone
    if (supabaseUser.phone) {
      const [existing] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.phone, supabaseUser.phone));

      if (existing) {
        const accessToken2 = generateAccessToken(existing.id);
        const refreshToken2 = await generateRefreshToken(existing.id);
        res.json({
          success: true,
          message: "Authenticated via phone",
          data: {
            accessToken: accessToken2,
            refreshToken: refreshToken2,
            user: {
              id: existing.id,
              firstName: existing.firstName,
              lastName: existing.lastName,
              email: existing.email,
              profilePhoto: existing.profilePhoto,
              city: existing.city,
              role: existing.role,
              reputationScore: existing.reputationScore,
              ggId: 'G&G-' + existing.id.replace(/-/g, '').slice(0, 8).toUpperCase(),
            },
          },
        });
        return;
      }
    }

    res.status(400).json({ success: false, message: "Email required from Supabase account" });
    return;
  }

  // Find or create user by Supabase email
  let [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email.toLowerCase()));

  if (!user) {
    // Create new user from Supabase social login
    const metadata = supabaseUser.user_metadata || {};
    const firstName = metadata.full_name?.split(" ")[0] || metadata.name || "User";
    const lastName = metadata.full_name?.split(" ").slice(1).join(" ") || "";

    const photo = metadata.avatar_url || metadata.picture || null;
    const randomPass = uuidv4() + uuidv4();
    const seed = uuidv4().replace(/-/g, "").slice(0, 12);

    [user] = await db
      .insert(usersTable)
      .values({
        firstName,
        lastName,
        email: email.toLowerCase(),
        passwordHash: await bcrypt.hash(randomPass, 12),
        profilePhoto: photo || `https://api.dicebear.com/7.x/adventurer/svg?seed=${seed}`,
        emailVerified: true,
      })
      .returning();

    await db.insert(notificationsTable).values({
      userId: user.id,
      type: "WELCOME",
      title: "Welcome to Grit&Gigs!",
      message: "Account created via Google. Complete your profile to get started.",
      linkUrl: "/dashboard",
    });
  } else {
    // Mark email as verified if logging in via Google
    if (!user.emailVerified) {
      await db.update(usersTable).set({ emailVerified: true }).where(eq(usersTable.id, user.id));
    }
  }

  const accessToken2 = generateAccessToken(user.id);
  const refreshToken2 = await generateRefreshToken(user.id);

  res.json({
    success: true,
    message: "Authenticated via Supabase",
    data: {
      accessToken: accessToken2,
      refreshToken: refreshToken2,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profilePhoto: user.profilePhoto,
        city: user.city,
        role: user.role,
        reputationScore: user.reputationScore,
        emailVerified: user.emailVerified,
        ggId: 'G&G-' + user.id.replace(/-/g, '').slice(0, 8).toUpperCase(),
      },
    },
  });
});

// ── Google OAuth (server-side redirect flow) ──────────────────────────────

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || "http://localhost:5000/api/auth/google/callback";

// Shared helper: find or create user from Google profile
async function findOrCreateGoogleUser(email: string, fullName: string, photo: string | null) {
  const emailLower = email.toLowerCase();
  const nameParts = (fullName || emailLower.split("@")[0]).split(" ");
  const firstName = nameParts[0] || "User";
  const lastName = nameParts.slice(1).join(" ") || "";

  let [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, emailLower));

  if (!user) {
    const randomPass = uuidv4() + uuidv4();
    const seed = uuidv4().replace(/-/g, "").slice(0, 12);
    [user] = await db
      .insert(usersTable)
      .values({
        firstName,
        lastName,
        email: emailLower,
        passwordHash: await bcrypt.hash(randomPass, 12),
        profilePhoto: photo || `https://api.dicebear.com/7.x/adventurer/svg?seed=${seed}`,
        emailVerified: true,
      })
      .returning();

    await db.insert(notificationsTable).values({
      userId: user.id,
      type: "WELCOME",
      title: "Welcome to Grit&Gigs!",
      message: "Account created via Google. Complete your profile to get started.",
      linkUrl: "/dashboard",
    });
  } else if (!user.emailVerified) {
    await db.update(usersTable).set({ emailVerified: true }).where(eq(usersTable.id, user.id));
  }

  if (!user.isActive) return null;

  const accessToken = generateAccessToken(user.id);
  const refreshToken = await generateRefreshToken(user.id);

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      profilePhoto: user.profilePhoto,
      city: user.city,
      role: user.role,
      reputationScore: user.reputationScore,
      emailVerified: user.emailVerified,
      ggId: 'G&G-' + user.id.replace(/-/g, '').slice(0, 8).toUpperCase(),
    },
  };
}

// Step 1: Redirect user to Google consent screen
router.get("/auth/google/login", (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    res.status(503).json({ success: false, message: "Google OAuth not configured" });
    return;
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_CALLBACK_URL,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "consent",
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// Step 2: Google redirects here after user consent
router.get("/auth/google/callback", async (req, res): Promise<void> => {
  const { code, error } = req.query as { code?: string; error?: string };

  if (error) {
    res.status(400).send(googleCallbackHtml(null, "Access denied: " + error));
    return;
  }

  if (!code) {
    res.status(400).send(googleCallbackHtml(null, "No authorization code received"));
    return;
  }

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    res.status(503).send(googleCallbackHtml(null, "Google OAuth not configured on server"));
    return;
  }

  try {
    // Exchange authorization code for tokens
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_CALLBACK_URL,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      res.status(400).send(googleCallbackHtml(null, "Token exchange failed: " + errText));
      return;
    }

    const tokenData = await tokenResp.json() as { id_token?: string; access_token?: string };

    // Decode the ID token (it's a JWT) to get user info
    if (!tokenData.id_token) {
      res.status(400).send(googleCallbackHtml(null, "No ID token returned"));
      return;
    }

    // Decode JWT payload (verify with Google's tokeninfo for extra safety)
    const verifyResp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${tokenData.id_token}`);
    if (!verifyResp.ok) {
      res.status(401).send(googleCallbackHtml(null, "Failed to verify Google token"));
      return;
    }

    const payload = await verifyResp.json() as {
      email?: string;
      name?: string;
      picture?: string;
      aud?: string;
    };

    if (payload.aud !== GOOGLE_CLIENT_ID) {
      res.status(401).send(googleCallbackHtml(null, "Token audience mismatch"));
      return;
    }

    if (!payload.email) {
      res.status(400).send(googleCallbackHtml(null, "Google account has no email"));
      return;
    }

    const result = await findOrCreateGoogleUser(payload.email, payload.name || "", payload.picture || null);
    if (!result) {
      res.status(401).send(googleCallbackHtml(null, "Account has been deactivated"));
      return;
    }

    // Send success back via postMessage HTML
    res.send(googleCallbackHtml(result, null));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Google authentication failed";
    res.status(500).send(googleCallbackHtml(null, msg));
  }
});

// Renders an HTML page that posts the result to the opener window
function googleCallbackHtml(data: { accessToken: string; refreshToken: string; user: Record<string, unknown> } | null, errorMsg: string | null) {
  const messageJson = data
    ? JSON.stringify({ success: true, data })
    : JSON.stringify({ success: false, message: errorMsg });

  return `<!DOCTYPE html><html><body><script>
    try {
      if (window.opener) {
        window.opener.postMessage(${messageJson}, window.location.origin);
      } else {
        // No opener — redirect-based flow fallback
        var params = new URLSearchParams();
        if (${data ? "true" : "false"}) {
          var d = ${messageJson};
          params.set('accessToken', d.data.accessToken);
          params.set('refreshToken', d.data.refreshToken);
          params.set('user', JSON.stringify(d.data.user));
        } else {
          params.set('error', ${JSON.stringify(errorMsg || "Unknown error")});
        }
        window.location.href = '/google-callback?' + params.toString();
      }
    } catch(e) {
      document.body.textContent = "Google sign-in " + (${data ? '"complete, you can close this window"' : '"failed: ' + JSON.stringify(errorMsg) + '"'});
    }
    if (${data ? "true" : "false"}) { setTimeout(function(){ window.close(); }, 500); }
  <\/script></body></html>`;
}

// ── Email verification ────────────────────────────────────────────────────

router.post("/auth/send-verification", authenticate, async (req, res): Promise<void> => {
  const user = req.user!;
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.insert(passwordResetsTable).values({ userId: user.id, token, expiresAt });
  sendEmailVerificationEmail(user.email, token);
  res.json({ success: true, message: "Verification email sent" });
});

router.post("/auth/verify-email", async (req, res): Promise<void> => {
  const { token } = req.body;
  if (!token) {
    res.status(400).json({ success: false, message: "Token required" });
    return;
  }

  const [reset] = await db
    .select()
    .from(passwordResetsTable)
    .where(
      and(
        eq(passwordResetsTable.token, token),
        eq(passwordResetsTable.used, false),
        gt(passwordResetsTable.expiresAt, new Date()),
      ),
    );

  if (!reset) {
    res.status(400).json({ success: false, message: "Invalid or expired token" });
    return;
  }

  await db.update(usersTable).set({ emailVerified: true }).where(eq(usersTable.id, reset.userId));
  await db.update(passwordResetsTable).set({ used: true }).where(eq(passwordResetsTable.id, reset.id));

  res.json({ success: true, message: "Email verified successfully" });
});

// ── Phone OTP via Supabase ────────────────────────────────────────────────

router.post("/auth/phone/send-otp", async (req, res): Promise<void> => {
  const { phone } = req.body;
  if (!phone) {
    res.status(400).json({ success: false, message: "Phone number required" });
    return;
  }

  const sb = getSupabase();
  if (!sb) {
    res.status(503).json({ success: false, message: "Supabase not configured" });
    return;
  }

  const { error } = await sb.auth.signInWithOtp({ phone });
  if (error) {
    res.status(400).json({ success: false, message: error.message });
    return;
  }

  res.json({ success: true, message: "OTP sent to phone" });
});

router.post("/auth/phone/verify", async (req, res): Promise<void> => {
  const { phone, otp } = req.body;
  if (!phone || !otp) {
    res.status(400).json({ success: false, message: "Phone and OTP required" });
    return;
  }

  const sb = getSupabase();
  if (!sb) {
    res.status(503).json({ success: false, message: "Supabase not configured" });
    return;
  }

  const { data, error } = await sb.auth.verifyOtp({ phone, token: otp, type: "sms" });
  if (error || !data.user) {
    res.status(400).json({ success: false, message: error?.message || "Invalid OTP" });
    return;
  }

  // Update or create user with this phone number
  let [user] = await db.select().from(usersTable).where(eq(usersTable.phone, phone));

  if (!user) {
    // Create stub user
    const randomPass = uuidv4() + uuidv4();
    [user] = await db
      .insert(usersTable)
      .values({
        firstName: "User",
        lastName: "",
        email: `phone_${phone.replace(/\D/g, "")}@temp.gritandgigs.com`,
        passwordHash: await bcrypt.hash(randomPass, 12),
        phone,
        phoneVerified: true,
      })
      .returning();

    await db.insert(notificationsTable).values({
      userId: user.id,
      type: "WELCOME",
      title: "Welcome to Grit&Gigs!",
      message: "Account created via phone. Complete your profile to continue.",
      linkUrl: "/dashboard",
    });
  } else {
    await db.update(usersTable).set({ phoneVerified: true }).where(eq(usersTable.id, user.id));
  }

  const accessToken = generateAccessToken(user.id);
  const refreshToken = await generateRefreshToken(user.id);

  res.json({
    success: true,
    message: "Phone verified successfully",
    data: {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profilePhoto: user.profilePhoto,
        city: user.city,
        role: user.role,
        phoneVerified: user.phoneVerified,
        ggId: 'G&G-' + user.id.replace(/-/g, '').slice(0, 8).toUpperCase(),
      },
    },
  });
});

export default router;
