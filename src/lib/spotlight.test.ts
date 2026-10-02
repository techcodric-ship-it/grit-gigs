import { describe, it, expect } from "vitest";
import {
  SPOTLIGHT_PACKS,
  SPOTLIGHT_PACK_LIST,
  SPOTLIGHT_DEFAULT_PACK,
  getSpotlightPack,
  isKnownSpotlightPack,
  packPerDay,
  formatInr,
  demandCopy,
  buildSpotlightStats,
} from "./spotlight";

describe("spotlight packs", () => {
  it("sells the three advertised tiers at the agreed prices", () => {
    expect(SPOTLIGHT_PACKS.day1.priceInr).toBe(50);
    expect(SPOTLIGHT_PACKS.day3.priceInr).toBe(199);
    expect(SPOTLIGHT_PACKS.week.priceInr).toBe(499);
  });

  it("sells the requested durations", () => {
    expect(SPOTLIGHT_PACKS.day1.hours).toBe(24);
    expect(SPOTLIGHT_PACKS.day3.hours).toBe(72);
    expect(SPOTLIGHT_PACKS.week.hours).toBe(168);
  });

  it("publishes per-day rates without pretending they are a discount", () => {
    const rates = SPOTLIGHT_PACK_LIST.map(packPerDay);
    // day3 is ₹66/day and week is ₹71/day, both ABOVE day1's ₹50/day.
    // The UI must therefore never show a "save"/"cheaper per day" claim until
    // the tiers are actually repriced into a real volume discount.
    expect(rates).toEqual([50, 66, 71]);
    expect(rates[1]).toBeGreaterThan(rates[0]);
    expect(rates[2]).toBeGreaterThan(rates[1]);
  });

  it("never shows a fractional rupee on the payment screen", () => {
    for (const p of SPOTLIGHT_PACK_LIST) {
      expect(Number.isInteger(packPerDay(p))).toBe(true);
      expect(Number.isInteger(Number(p.priceInr))).toBe(true);
      expect(formatInr(p.priceInr)).toBe(String(p.priceInr));
    }
    expect(formatInr(199)).toBe("199");
    expect(formatInr(66.33)).toBe("66");
    expect(formatInr(49.5)).toBe("50");
    expect(formatInr(NaN)).toBe("0");
    expect(formatInr(undefined)).toBe("0");
  });

  it("gives every pack a distinct label so no row repeats its own duration", () => {
    const labels = SPOTLIGHT_PACK_LIST.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const p of SPOTLIGHT_PACK_LIST) {
      expect(p.label.toLowerCase()).not.toBe(p.duration.toLowerCase());
    }
  });

  it("is cheaper per hour the longer the pack, unlike per-day", () => {
    const perHour = SPOTLIGHT_PACK_LIST.map(
      (p) => Math.round((p.priceInr / p.hours) * 100) / 100,
    );
    expect(perHour).toEqual([2.08, 2.76, 2.97]);
    for (let i = 1; i < perHour.length; i++) {
      expect(perHour[i]).toBeGreaterThan(perHour[i - 1]);
    }
  });

  it("keeps ₹50/24h as the default so existing buyers never see a price jump", () => {
    expect(SPOTLIGHT_DEFAULT_PACK).toBe("day1");
    expect(getSpotlightPack(undefined).id).toBe("day1");
    expect(getSpotlightPack(null).id).toBe("day1");
  });

  it("falls back to the default pack for junk input instead of trusting it", () => {
    expect(getSpotlightPack("free-forever").id).toBe("day1");
    expect(getSpotlightPack(0).id).toBe("day1");
    expect(getSpotlightPack({}).id).toBe("day1");
  });

  it("rejects unknown pack ids for explicit client input", () => {
    expect(isKnownSpotlightPack("day3")).toBe(true);
    expect(isKnownSpotlightPack("week")).toBe(true);
    expect(isKnownSpotlightPack("toString")).toBe(false);
    expect(isKnownSpotlightPack("__proto__")).toBe(false);
    expect(isKnownSpotlightPack(undefined)).toBe(false);
    expect(isKnownSpotlightPack(7)).toBe(false);
  });

  it("always lists every tier in cheapest-to-dearest order", () => {
    expect(SPOTLIGHT_PACK_LIST.map((p) => p.id)).toEqual(["day1", "day3", "week"]);
    for (const p of SPOTLIGHT_PACK_LIST) expect(p.duration).toBeTruthy();
  });
});

describe("buildSpotlightStats", () => {
  const now = Date.parse("2026-03-01T12:00:00.000Z");
  const base = {
    planId: "day3",
    amount: 199,
    reach: 0,
    impressions: 0,
    clicks: 0,
    startsAt: new Date("2026-03-01T00:00:00.000Z"),
    expiresAt: new Date("2026-03-04T00:00:00.000Z"),
    now,
  };

  it("reports real counts instead of inventing a view guarantee", () => {
    const s = buildSpotlightStats({ ...base, reach: 12, impressions: 40, clicks: 5 });
    expect(s.reach).toBe(12);
    expect(s.impressions).toBe(40);
    expect(s.clicks).toBe(5);
    expect(s.clickThroughRate).toBe(13);
    expect(s.pricePaid).toBe(199);
    expect(s.perDay).toBe(66);
    expect(s.planId).toBe("day3");
  });

  it("is honest on a dead boost: zero reach, zero clicks, no divide-by-zero", () => {
    const s = buildSpotlightStats({ ...base, reach: 0, impressions: 0, clicks: 0 });
    expect(s.reach).toBe(0);
    expect(s.clicks).toBe(0);
    expect(s.clickThroughRate).toBe(0);
    expect(s.isActive).toBe(true);
  });

  it("clamps a nonsense ratio instead of rendering an absurd percentage", () => {
    const s = buildSpotlightStats({ ...base, reach: 3, impressions: 4, clicks: 9 });
    expect(s.reach).toBe(3);
    expect(s.impressions).toBe(4);
    expect(s.clicks).toBe(9);
    expect(s.clickThroughRate).toBe(100);
  });

  it("reports demand as searches, never as a view promise", () => {
    const c = demandCopy({ totalSearches: 12, terms: [{ term: "ai", searches: 12 }] });
    expect(c).not.toBeNull();
    expect(c!.headline).toContain("12 searches");
    expect(c!.headline).toContain("7 days");
    // The detail must not imply any guaranteed outcome.
    expect(c!.detail).toContain("varies");
    for (const forbidden of ["guarantee", "guaranteed", "views", "200"]) {
      expect((c!.headline + c!.detail).toLowerCase()).not.toContain(forbidden);
    }
  });

  it("returns null for zero demand so the UI can say nobody is looking", () => {
    expect(demandCopy({ totalSearches: 0, terms: [{ term: "ai", searches: 0 }] })).toBeNull();
  });

  it("names at most two matching keywords", () => {
    const c = demandCopy({
      totalSearches: 9,
      terms: [
        { term: "ai", searches: 5 },
        { term: "hr", searches: 3 },
        { term: "data", searches: 1 },
      ],
    });
    expect(c!.headline).toContain("ai");
    expect(c!.headline).toContain("hr");
    expect(c!.headline).not.toContain("data");
  });

  it("handles a single search without awkward plurals", () => {
    const c = demandCopy({ totalSearches: 1, terms: [{ term: "ai", searches: 1 }] });
    expect(c!.headline).toContain("1 search ");
    expect(c!.headline).not.toContain("1 searches");
  });

  it("counts down remaining hours and flags expiry", () => {
    // base expires 2026-03-04T00:00Z, i.e. 60h after `now`.
    expect(buildSpotlightStats(base).hoursLeft).toBe(60);
    const live = buildSpotlightStats({ ...base, now: now - 30 * 3600e3 });
    expect(live.hoursLeft).toBe(90);
    expect(live.isActive).toBe(true);

    const dead = buildSpotlightStats({ ...base, now: now + 72 * 3600e3 });
    expect(dead.hoursLeft).toBe(0);
    expect(dead.isActive).toBe(false);
  });

  it("treats a legacy boost row with no plan_id as the ₹50/24h tier", () => {
    const s = buildSpotlightStats({
      ...base,
      planId: undefined as unknown as string,
      amount: 50,
    });
    expect(s.planId).toBe("day1");
    expect(s.perDay).toBe(50);
  });

  it("returns zeroed counters when the DB hands back nulls", () => {
    const s = buildSpotlightStats({
      ...base,
      reach: Number.NaN,
      impressions: undefined as unknown as number,
      clicks: null as unknown as number,
    });
    expect(s.reach).toBe(0);
    expect(s.impressions).toBe(0);
    expect(s.clicks).toBe(0);
  });
});