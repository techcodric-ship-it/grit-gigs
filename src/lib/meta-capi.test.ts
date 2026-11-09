import { describe, it, expect } from "vitest";
import { buildPurchasePayload, cookieValue, hashPii, metaDatasetId, metaPixelId } from "./meta-capi";
import { buildMetaPixelScript } from "./meta-pixel-script";

// These guard the two things that silently break paid attribution: an event
// id that does not match between browser and server (so every sale counts
// twice), and an unhashed email (so Meta rejects the match entirely).

describe("meta conversions api", () => {
  it("hashes email as lowercased sha-256 hex", () => {
    const hashed = hashPii("  Buyer@Example.COM ");
    expect(hashed).toMatch(/^[a-f0-9]{64}$/);
    expect(hashed).toBe(hashPii("buyer@example.com"));
    expect(hashed).not.toBe(hashPii("buyer2@example.com"));
  });

  it("returns null for empty pii instead of hashing a blank string", () => {
    expect(hashPii("")).toBeNull();
    expect(hashPii("   ")).toBeNull();
    expect(hashPii(null)).toBeNull();
  });

  it("refuses to send a purchase with no matchable user signal", () => {
    expect(buildPurchasePayload({ eventId: "pay_1", value: 199 })).toBeNull();
  });

  it("builds a purchase event with the shared event id and hashed email", () => {
    const payload = buildPurchasePayload({
      eventId: "pay_ABC123",
      value: 199,
      currency: "inr",
      email: "buyer@example.com",
      eventTime: 1_700_000_000,
    });
    expect(payload).not.toBeNull();
    const event = payload!.data[0];
    expect(event.event_name).toBe("Purchase");
    expect(event.event_id).toBe("pay_ABC123");
    expect(event.event_time).toBe(1_700_000_000);
    expect(event.action_source).toBe("website");
    expect(event.user_data).toMatchObject({ em: [hashPii("buyer@example.com")] });
    expect(event.custom_data).toEqual({ currency: "INR", value: 199 });
  });

  it("keeps fbp/fbc when there is no email", () => {
    const payload = buildPurchasePayload({
      eventId: "pay_2",
      value: 199,
      fbp: "fb.1.1700000000.123",
      fbc: "fb.1.1700000000.456",
    });
    expect(payload).not.toBeNull();
    expect(payload!.data[0].user_data).toMatchObject({
      fbp: "fb.1.1700000000.123",
      fbc: "fb.1.1700000000.456",
    });
  });

  it("parses cookies without a parser dependency", () => {
    const header = "se_token=abc; _fbp=fb.1.1700000000.123; _fbc=fb.1.1.2";
    expect(cookieValue(header, "_fbp")).toBe("fb.1.1700000000.123");
    expect(cookieValue(header, "_fbc")).toBe("fb.1.1.2");
    expect(cookieValue(header, "_ga")).toBeNull();
    expect(cookieValue(undefined, "_fbp")).toBeNull();
  });

  it("ships the confirmed pixel and dataset ids as defaults", () => {
    expect(metaPixelId()).toBe("4550145695221450");
    expect(metaDatasetId()).toBe("1694905348640933");
  });
});

describe("meta pixel loader", () => {
  it("initialises the pixel and fires a pageview", () => {
    const js = buildMetaPixelScript("4550145695221450");
    expect(js).toContain('"4550145695221450"');
    expect(js).toContain('window.fbq("init", PIXEL_ID)');
    expect(js).toContain('window.fbq("track", "PageView")');
  });

  it("still defines PrepTrack when no pixel id is configured", () => {
    const js = buildMetaPixelScript("");
    expect(js).toContain("window.PrepTrack");
    // No id means the loader bails before touching fbq, so nothing is sent.
    expect(js).toContain('var PIXEL_ID = "";');
    expect(js).toContain("if (!PIXEL_ID || typeof window.fbq");
  });

  it("dedupes purchases by event id", () => {
    const js = buildMetaPixelScript("4550145695221450");
    expect(js).toContain("eventID: String(eventId)");
    expect(js).toContain("purchase: function (eventId, value)");
  });
});
