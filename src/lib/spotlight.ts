export interface SpotlightPack {
  id: string;
  hours: number;
  priceInr: number;
  label: string;
  /** Human-readable duration, e.g. "24 hours" / "3 days". */
  duration: string;
}

/**
 * Boost packs. `day1` is the original flat ₹50/24h pin and stays first so the
 * default modal option never changes price for existing buyers.
 *
 * NOTE: the current prices are duration tiers, NOT a volume discount — ₹199/3d
 * works out to ₹66/day and ₹499/7d to ₹71/day, both above ₹50/day. So the UI
 * must never claim longer packs are cheaper per day or show a "save" badge.
 * `packPerDay` exists to publish that arithmetic honestly, and to catch it if
 * the tiers are ever repriced into a real discount.
 */
export const SPOTLIGHT_PACKS: Record<string, SpotlightPack> = {
  day1: { id: "day1", hours: 24, priceInr: 50, label: "Quick boost", duration: "24 hours" },
  day3: { id: "day3", hours: 72, priceInr: 199, label: "3 days", duration: "3 days" },
  week: { id: "week", hours: 168, priceInr: 499, label: "1 week", duration: "7 days" },
};

export const SPOTLIGHT_DEFAULT_PACK = "day1";

export const SPOTLIGHT_PACK_LIST: SpotlightPack[] = [
  SPOTLIGHT_PACKS.day1,
  SPOTLIGHT_PACKS.day3,
  SPOTLIGHT_PACKS.week,
];

export function getSpotlightPack(id: unknown): SpotlightPack {
  const key = String(id ?? "");
  return SPOTLIGHT_PACKS[key] ?? SPOTLIGHT_PACKS[SPOTLIGHT_DEFAULT_PACK];
}

export function isKnownSpotlightPack(id: unknown): boolean {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(SPOTLIGHT_PACKS, id);
}

/** Effective ₹ per day, used in pack copy so the discount is visible. */
export function packPerDay(pack: SpotlightPack): number {
  return Math.round((pack.priceInr / (pack.hours / 24)) * 100) / 100;
}

/**
 * Stats shape returned to the buyer. Reach is unique viewers, impressions are
 * render events, so a refresh cannot inflate the headline number.
 */
export interface SpotlightStats {
  planId: string;
  planLabel: string;
  pricePaid: number;
  hoursLeft: number;
  isActive: boolean;
  reach: number;
  impressions: number;
  clicks: number;
  clickThroughRate: number;
  perDay: number;
  startedAt: string;
  expiresAt: string;
}

export function buildSpotlightStats(input: {
  planId: string;
  amount: number;
  reach: number;
  impressions: number;
  clicks: number;
  startsAt: Date;
  expiresAt: Date;
  now?: number;
}): SpotlightStats {
  const now = input.now ?? Date.now();
  const pack = getSpotlightPack(input.planId);
  const msLeft = input.expiresAt.getTime() - now;
  const hoursLeft = Math.max(0, Math.ceil(msLeft / 3600e3));
  const ctr = input.impressions > 0 ? Math.round((input.clicks / input.impressions) * 1000) / 10 : 0;
  return {
    planId: pack.id,
    planLabel: pack.label,
    pricePaid: Math.round(Number(input.amount) || 0),
    hoursLeft,
    isActive: msLeft > 0,
    reach: Number(input.reach) || 0,
    impressions: Number(input.impressions) || 0,
    clicks: Number(input.clicks) || 0,
    clickThroughRate: ctr,
    perDay: packPerDay(pack),
    startedAt: input.startsAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };
}