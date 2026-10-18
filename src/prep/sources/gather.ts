// Source gathering orchestrator: runs every adapter independently (one
// failure never aborts the pipeline), de-duplicates by URL, caps the total,
// and caches results briefly so report refreshes don't hammer sources.

import { makeOfficialAdapter } from "./official";
import { makeNewsAdapter } from "./news";
import type { SourceAdapter, SourceAdapterResult, SourceDocument } from "./types";

export interface CompanyRef {
  name: string;
  domain: string | null;
  website: string | null;
}

export const GATHER_CACHE_TTL_MS = 5 * 60 * 1000;
export const MAX_DOCS_TOTAL = 12;

export interface GatheredSources extends SourceAdapterResult {
  documents: SourceDocument[];
  adaptersRun: string[];
}

function cacheKey(company: CompanyRef): string {
  return `${company.name.toLowerCase().trim()}|${(company.domain ?? "").toLowerCase()}|${(company.website ?? "").toLowerCase()}`;
}

export class SourceCache {
  private store = new Map<string, { at: number; value: GatheredSources }>();
  constructor(private ttlMs = GATHER_CACHE_TTL_MS) {}
  get(key: string): GatheredSources | null {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }
  set(key: string, value: GatheredSources): void {
    this.store.set(key, { at: Date.now(), value });
    // Bounded cache: keep it tiny (per-company only).
    if (this.store.size > 50) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }
}

export const defaultSourceCache = new SourceCache();

export function makeDefaultAdapters(): SourceAdapter[] {
  return [makeOfficialAdapter(), makeNewsAdapter()];
}

export async function gatherSources(
  company: CompanyRef,
  adapters: SourceAdapter[] = makeDefaultAdapters(),
  cache: SourceCache = defaultSourceCache,
): Promise<GatheredSources> {
  const key = cacheKey(company);
  const cached = cache.get(key);
  if (cached) return cached;

  const documents: SourceDocument[] = [];
  const errors: string[] = [];
  const adaptersRun: string[] = [];

  await Promise.all(
    adapters.map(async (adapter) => {
      adaptersRun.push(adapter.name);
      try {
        const result = await adapter.collect(company);
        documents.push(...result.documents);
        errors.push(...result.errors.map((e) => `${adapter.name}:${e}`));
      } catch (err) {
        errors.push(`${adapter.name}:adapter-crashed:${(err as Error).message?.slice(0, 120)}`);
      }
    }),
  );

  // Deterministic order: label priority, then fetchedAt desc.
  const labelRank: Record<string, number> = { OFFICIAL: 0, NEWS: 1, MEMBER_REPORTED: 2, VERIFIED_DOCUMENT: 3, AI_ESTIMATE: 4 };
  documents.sort(
    (a, b) =>
      (labelRank[a.label] ?? 9) - (labelRank[b.label] ?? 9) ||
      b.fetchedAt.localeCompare(a.fetchedAt) ||
      a.url.localeCompare(b.url),
  );
  // De-dupe by URL, cap total.
  const seen = new Set<string>();
  const deduped: SourceDocument[] = [];
  for (const doc of documents) {
    if (seen.has(doc.url)) continue;
    seen.add(doc.url);
    deduped.push(doc);
    if (deduped.length >= MAX_DOCS_TOTAL) break;
  }

  const gathered: GatheredSources = {
    documents: deduped,
    errors: errors.slice(0, 40),
    adaptersRun: [...new Set(adaptersRun)].sort(),
  };
  cache.set(key, gathered);
  return gathered;
}
