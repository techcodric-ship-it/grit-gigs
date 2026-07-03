import { createClient } from "@supabase/supabase-js";
import path from "path";
import { v4 as uuid } from "uuid";
import { logger } from "./logger";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

if (supabase) {
  logger.info("Storage: Supabase client ready");
} else {
  logger.warn("Storage: Supabase not configured — uploads fall back to local disk");
}

export const UPLOADS_BUCKET = "uploads";

export async function ensureBucket(): Promise<void> {
  if (!supabase) return;
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.find((b) => b.name === UPLOADS_BUCKET)) {
      const { error } = await supabase.storage.createBucket(UPLOADS_BUCKET, {
        public: true,
      });
      if (error) {
        logger.error({ err: error }, "Storage: failed to create bucket");
      } else {
        logger.info(`Storage: bucket "${UPLOADS_BUCKET}" created`);
      }
    }
  } catch (err: unknown) {
    logger.error({ err }, "Storage: ensureBucket threw — uploads fall back to local disk");
  }
}

export async function uploadToSupabase(
  buffer: Buffer,
  originalName: string,
  subfolder: string,
): Promise<string | null> {
  if (!supabase) return null;

  try {
    const ext = path.extname(originalName) || ".bin";
    const fileName = `${subfolder}/${Date.now()}-${uuid().slice(0, 8)}${ext}`;

    const { error } = await supabase.storage
      .from(UPLOADS_BUCKET)
      .upload(fileName, buffer, {
        contentType: "application/octet-stream",
        upsert: false,
      });

    if (error) {
      logger.error({ err: error }, "Storage: upload failed");
      return null;
    }

    const { data: publicUrl } = supabase.storage
      .from(UPLOADS_BUCKET)
      .getPublicUrl(fileName);

    return publicUrl?.publicUrl || null;
  } catch (err: unknown) {
    logger.error({ err }, "Storage: upload threw");
    return null;
  }
}

export async function deleteFromSupabase(fileUrl: string): Promise<void> {
  if (!supabase) return;

  try {
    const parts = fileUrl.split(`/storage/v1/object/public/${UPLOADS_BUCKET}/`);
    if (parts.length !== 2) return;

    const filePath = parts[1];
    const { error } = await supabase.storage
      .from(UPLOADS_BUCKET)
      .remove([filePath]);

    if (error) {
      logger.error({ err: error }, "Storage: delete failed");
    }
  } catch (err: unknown) {
    logger.error({ err }, "Storage: delete threw");
  }
}
