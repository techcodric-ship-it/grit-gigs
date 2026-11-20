/** Portfolio links shown in the GritScore card's Links section.
 *
 * These are submitted explicitly by the card owner. They are deliberately
 * separate from work-item proof links: a proof URL can also appear as a
 * button on its item, but it never silently becomes a portfolio link. */

import { proofLabel } from "./evidence";

export interface PublicLink {
  url: string;
  label: string;
}

export interface LinkSourceScan {
  extracted: { links?: string[] | null } | null;
  portfolioLinks?: string[] | null;
}

export interface LinkSourceItem {
  proofUrl?: string | null;
}

const MAX_LINKS = 8;
const MAX_LINK_LENGTH = 600;

function linkKey(value: string): string {
  return value.toLowerCase().replace(/\/+$/, "");
}

function cleanUrl(raw: unknown): string | null {
  let value = String(raw ?? "").trim();
  // People paste "github.com/you" far more often than the full URL. Accept a
  // bare hostname and store it as https:// — never anything nontrivial.
  if (!/^https?:\/\//i.test(value)) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value)) return null;
    value = `https://${value}`;
  }
  return value.slice(0, MAX_LINK_LENGTH);
}

/** Owner input is a plain list of URLs. Ignore junk, cap length, dedupe. */
export function normalisePortfolioLinks(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : [raw];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of values) {
    const url = cleanUrl(entry);
    if (!url) continue;
    const key = linkKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/** Explicit owner links first, then links found in the resume. Work-item
 *  proof URLs are excluded from the resume bucket so the Links section can
 *  only be populated by the owner's own submission (or their resume text). */
export function publicLinks(scan: LinkSourceScan, items: LinkSourceItem[]): PublicLink[] {
  const seen = new Set<string>();
  const out: PublicLink[] = [];
  const push = (raw: unknown) => {
    const url = cleanUrl(raw);
    if (!url) return;
    const key = linkKey(url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, label: proofLabel(url) });
  };

  for (const url of normalisePortfolioLinks(scan.portfolioLinks)) push(url);

  const proofKeys = new Set(
    items.map((item) => cleanUrl(item.proofUrl)).filter((url): url is string => !!url).map(linkKey),
  );
  for (const link of scan.extracted?.links ?? []) {
    const url = cleanUrl(link);
    if (url && proofKeys.has(linkKey(url))) continue;
    push(url);
  }
  return out.slice(0, MAX_LINKS);
}
