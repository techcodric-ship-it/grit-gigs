/**
 * Short but real skill acronyms. A generic length floor would drop these, and
 * they are exactly the terms people search for.
 */
const SPOT_ACRONYMS = new Set(["ai", "hr", "ui", "ux", "seo", "pr", "3d", "2d", "ad", "it"]);

/** True when two terms differ by a single keystroke, e.g. a typo of each other. */
function isNearDuplicate(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  if (Math.abs(x.length - y.length) > 1) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    j++;
  }
  return true;
}

/**
 * Turns raw search-log rows into clean keyword suggestions for the boost dialog.
 *
 * Search logs are free text typed by humans, so one row can be a whole phrase
 * ("operation, communication, strategy"), contain a typo ("profreading"), or
 * repeat a word already offered on its own. Surfacing those raw inside a
 * payment dialog makes the page look careless and erodes trust, so terms are
 * split on punctuation and de-duplicated across the whole list.
 *
 * `terms` is expected ordered by search count, so the most-searched spelling
 * wins when a term and its typo compete for the same slot.
 */
export function spotSuggestions(terms: { term: string; n: number }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    // One suggestion = one short keyword. Anything longer is a phrase, not a tag.
    const t = String(raw)
      .toLowerCase()
      .replace(/^#+/, "")
      .replace(/[^a-z0-9+ -]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (t.length > 24) return;
    if (t.length < 3 && !SPOT_ACRONYMS.has(t)) return;
    // Reject multi-word entries unless they read like one skill ("logo design").
    if (t.split(" ").length > 2) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    const kept = [...seen];
    // Drop a term already covered by one we kept ("operation" vs "operations").
    if (kept.some((s) => (key.length > 3 && s.includes(key)) || (s.length > 3 && key.includes(s)))) return;
    // Drop a single-keystroke typo of one we kept.
    if (kept.some((s) => isNearDuplicate(key, s))) return;
    seen.add(key);
    out.push(t);
  };
  for (const row of terms) {
    // Split on commas and slashes so a multi-intent query yields each intent.
    for (const part of String(row.term).split(/[,/|;&+]/)) add(part);
    if (out.length >= 12) break;
  }
  return out;
}

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
  day3: { id: "day3", hours: 72, priceInr: 199, label: "Best for active searches", duration: "3 days" },
  week: { id: "week", hours: 168, priceInr: 499, label: "Longest runway", duration: "7 days" },
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

/**
 * Effective ₹ per day, used in pack copy so the discount is visible.
 * Rounded to whole rupees for display: a payment screen showing "₹66.33/day"
 * looks broken and invites distrust over a few paisa.
 */
export function packPerDay(pack: SpotlightPack): number {
  return Math.round(pack.priceInr / (pack.hours / 24));
}

/**
 * Round-trips a price for display without float artefacts, e.g. 199 stays 199.
 * Kept separate from packPerDay so the API can still publish exact numbers.
 */
export function formatInr(amount: number | null | undefined): string {
  return String(Math.round(Number(amount) || 0));
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
  // Clamp the ratio so a stray data problem can't render an absurd "400% opened".
  const rawCtr = input.impressions > 0 ? (input.clicks / input.impressions) * 100 : 0;
  const ctr = Math.min(100, Math.round(rawCtr));
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