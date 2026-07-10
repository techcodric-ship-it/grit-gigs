import { createClient } from "@supabase/supabase-js";
import path from "path";
import { v4 as uuid } from "uuid";
import { logger } from "./logger";

function sanitizeSubfolder(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// Admin client for bucket management (needs service_role key)
const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

if (supabase) {
  logger.info("Storage: Supabase client ready");
} else {
  logger.warn("Storage: Supabase not configured — uploads fall back to local disk");
}

export const UPLOADS_BUCKET = "uploads";

export function isSupabaseConfigured(): boolean {
  return !!SUPABASE_URL && !!SUPABASE_ANON_KEY;
}

let _bucketKnown = false;

export async function ensureBucket(): Promise<void> {
  const client = supabaseAdmin || supabase;
  if (!client) return;
  try {
    const { data: buckets } = await client.storage.listBuckets();
    if (!buckets?.find((b) => b.name === UPLOADS_BUCKET)) {
      if (!supabaseAdmin) {
        logger.warn(`Storage: bucket "${UPLOADS_BUCKET}" not found and SUPABASE_SERVICE_ROLE_KEY not set — create it manually in Supabase dashboard`);
        return;
      }
      const { error } = await client.storage.createBucket(UPLOADS_BUCKET, { public: true });
      if (error) {
        logger.error({ err: error }, "Storage: failed to create bucket");
      } else {
        logger.info(`Storage: bucket "${UPLOADS_BUCKET}" created`);
        _bucketKnown = true;
      }
    } else {
      _bucketKnown = true;
    }
  } catch (err: unknown) {
    logger.error({ err }, "Storage: ensureBucket threw");
  }
}

export async function ensureBucketExists(): Promise<boolean> {
  if (_bucketKnown) return true;
  if (!supabase) return false;
  await ensureBucket();
  return _bucketKnown;
}

export async function uploadToSupabase(
  buffer: Buffer,
  originalName: string,
  subfolder: string,
  retried = false,
): Promise<string | null> {
  const client = supabaseAdmin || supabase;
  if (!client) return null;

  try {
    const ext = path.extname(originalName) || ".bin";
    const fileName = `${sanitizeSubfolder(subfolder)}/${Date.now()}-${uuid().slice(0, 8)}${ext}`;

    const { error } = await client.storage
      .from(UPLOADS_BUCKET)
      .upload(fileName, buffer, {
        contentType: "application/octet-stream",
        upsert: false,
      });

    if (error) {
      logger.error({ err: error, bucket: UPLOADS_BUCKET, fileName }, "Storage: upload failed");
      // If bucket might not exist, try to ensure it and retry once
      if (!_bucketKnown && !retried) {
        await ensureBucket();
        return uploadToSupabase(buffer, originalName, subfolder, true);
      }
      return null;
    }

    const { data: publicUrl } = client.storage
      .from(UPLOADS_BUCKET)
      .getPublicUrl(fileName);

    return publicUrl?.publicUrl || `https://${SUPABASE_URL!.replace(/^https?:\/\//, "")}/storage/v1/object/public/${UPLOADS_BUCKET}/${fileName}`;
  } catch (err: unknown) {
    logger.error({ err }, "Storage: upload threw");
    return null;
  }
}

export async function deleteFromSupabase(fileUrl: string): Promise<void> {
  const client = supabaseAdmin || supabase;
  if (!client) return;

  try {
    const parts = fileUrl.split(`/storage/v1/object/public/${UPLOADS_BUCKET}/`);
    if (parts.length !== 2) return;

    const filePath = parts[1];
    const { error } = await client.storage
      .from(UPLOADS_BUCKET)
      .remove([filePath]);

    if (error) {
      logger.error({ err: error }, "Storage: delete failed");
    }
  } catch (err: unknown) {
    logger.error({ err }, "Storage: delete threw");
  }
}
