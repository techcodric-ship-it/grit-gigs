import { createClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

let supabase: ReturnType<typeof createClient> | null = null;

if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  logger.info("Supabase client initialized");
} else {
  logger.warn("Supabase not configured — set SUPABASE_URL and SUPABASE_ANON_KEY in .env");
}

export function getSupabase() {
  return supabase;
}

export async function verifySupabaseToken(accessToken: string): Promise<{
  id: string;
  email: string | null;
  phone: string | null;
  user_metadata: Record<string, any> | null;
} | null> {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data.user) {
      logger.error({ err: error }, "Supabase token verification failed");
      return null;
    }

    return {
      id: data.user.id,
      email: data.user.email ?? null,
      phone: data.user.phone ?? null,
      user_metadata: data.user.user_metadata ?? null,
    };
  } catch (err) {
    logger.error({ err }, "Supabase token verification error");
    return null;
  }
}
