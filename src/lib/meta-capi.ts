// Meta (Facebook / Instagram) Conversions API — server-side events.
//
// The browser pixel proves intent. The Conversions API proves the money: iOS
// Safari, the Instagram in-app browser and ad blockers routinely drop the
// browser Purchase event, so the paid conversion is also sent from the server
// the moment Razorpay confirms the capture.
//
// Deduplication: both halves must carry the same `event_id`. We use the
// Razorpay payment id, which is unique per capture. Meta keeps the first event
// it sees and discards the duplicate, so a sale is counted exactly once.
//
// The pixel and dataset ids are public — they ship in the page source — so a
// built-in default is fine and means no server config is required to start
// collecting events. The access token is a secret and only ever comes from env.

import { createHash } from "node:crypto";
import { logger } from "./logger";

export const DEFAULT_META_PIXEL_ID = "4550145695221450";
export const DEFAULT_META_DATASET_ID = "1694905348640933";
export const META_GRAPH_VERSION = "v21.0";
export const META_DEFAULT_SOURCE_URL = "https://www.gritandgigs.in/prep";

export interface PurchaseEventInput {
  /** Unique per sale. Razorpay payment id — shared with the browser event. */
  eventId: string;
  value: number;
  currency?: string;
  email?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  /** `_fbp` / `_fbc` cookies, read from the request when present. */
  fbp?: string | null;
  fbc?: string | null;
  sourceUrl?: string | null;
  /** Unix seconds. Defaults to now. */
  eventTime?: number;
}

export function metaPixelId(): string {
  return (process.env.META_PIXEL_ID || DEFAULT_META_PIXEL_ID).trim();
}

export function metaDatasetId(): string {
  return (process.env.META_DATASET_ID || DEFAULT_META_DATASET_ID || metaPixelId()).trim();
}

function metaCapiToken(): string {
  return (process.env.META_CAPI_TOKEN || "").trim();
}

/** Meta requires lowercased, trimmed PII hashed as SHA-256 hex. */
export function hashPii(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  return createHash("sha256").update(v).digest("hex");
}

/** Read a single cookie from a raw Cookie header without a parser dependency. */
export function cookieValue(cookieHeader: string | undefined | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

/**
 * Build the Conversions API body. Returns null when there is nothing Meta can
 * match on — sending an event with no user signals only pollutes the dataset.
 */
export function buildPurchasePayload(
  input: PurchaseEventInput,
): { data: Record<string, unknown>[] } | null {
  const emailHash = hashPii(input.email);
  const fbp = input.fbp || null;
  const fbc = input.fbc || null;
  if (!emailHash && !fbp && !fbc) return null;

  const userData: Record<string, unknown> = {};
  if (emailHash) userData.em = [emailHash];
  if (input.clientIp) userData.client_ip_address = input.clientIp;
  if (input.userAgent) userData.client_user_agent = input.userAgent;
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  return {
    data: [
      {
        event_name: "Purchase",
        event_time: input.eventTime ?? Math.floor(Date.now() / 1000),
        event_id: input.eventId,
        action_source: "website",
        event_source_url: input.sourceUrl || META_DEFAULT_SOURCE_URL,
        user_data: userData,
        custom_data: {
          currency: (input.currency || "INR").toUpperCase(),
          value: input.value,
        },
      },
    ],
  };
}

export function capiConfigured(): boolean {
  return !!(metaCapiToken() && metaDatasetId());
}

/**
 * Fire-and-forget. Never throws and never blocks the payment response: a
 * tracking failure must not turn a successful purchase into an error.
 */
export async function trackPurchase(input: PurchaseEventInput): Promise<void> {
  if (!capiConfigured()) return;
  const payload = buildPurchasePayload(input);
  if (!payload) return;

  const url =
    `https://graph.facebook.com/${META_GRAPH_VERSION}/` +
    `${encodeURIComponent(metaDatasetId())}/events` +
    `?access_token=${encodeURIComponent(metaCapiToken())}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: body.slice(0, 300) },
        "meta capi purchase rejected",
      );
    }
  } catch (err) {
    logger.warn({ err }, "meta capi purchase failed");
  }
}
